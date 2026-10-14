#!/usr/bin/env node
/**
 * T33 试点对账的**三腿比对**骨架（**不依赖 Q2**）。
 *
 * 口径来源（**不得改动**）：
 *   - `docs/decisions/Q6-migration.md:41`：SDK 发送计数、双写转发计数、接收方入库计数三者
 *     偏差 ≤1%；
 *   - `docs/reports/reliability-reconciliation.md`：D004 三类分列，**不得合并成一个丢失率**；
 *   - `docs/contracts/receiver-requirements.md` RR-05：按 `app_id` + `event_id` 在 ≥7 天窗口去重；
 *   - `docs/guides/integration.md` 第 8.3 节第 5 步：`received_events - stored_events === duplicate_events`。
 *
 * 本脚本用 M01 真跑一遍「三腿」里的**两腿**（SDK 发送腿 + 接收方入库腿），并演示第三腿
 * （双写转发计数）该如何接入：转发计数由 T19 适配器提供，本脚本**不伪造**该数字。
 *
 * ## 两条被本脚本实测踩到、并已规避的坑（详见 docs/reports/t33-access-blockers.md）
 *
 * - **D-01（阻断级）**：不显式给 `pageId` 时 SDK 产出 `common.page_id: null`，契约
 *   `commonFields.page_id` 是 `{type: string}` → M01 以 `invalid_structure` 拒收，入库恒为 0。
 *   故本脚本调 `setPage('/reconcile')`。
 * - **D-02（阻断级）**：装配根上调用**公共 API `client.onEvent()`** 会让内部事件出口被替换，
 *   此后 `flush` 恒为 `empty`、**零投递**（与调用顺序无关）。故本脚本**不调用** `onEvent`，
 *   改从 `delivery.metrics()` 与接收方计数取证。
 * - **禁写规则（T32 教训）**：任何一腿为 0 时**不得**宣称「偏差 0% / 在 1% 内」——
 *   空白不是 0 丢失。本脚本对「无法判定」显式报 `不可判定`。
 *
 * 用法：
 *   node tests/pilot/10-three-leg-reconcile.mjs
 *   node tests/pilot/10-three-leg-reconcile.mjs --repeat 3   # 制造重复送达，验证去重口径
 *
 * 只监听 127.0.0.1、只用占位令牌，不触碰任何真实环境或个人数据。
 */
import { startReceiver } from '../../tools/mock-receiver/dist/index.js';
import { createAssembly } from '../../packages/browser/dist/index.js';

const PLACEHOLDER_TOKEN = 'placeholder-write-token-0000';
const PLACEHOLDER_APP_ID = 'pilot-reconcile-app';
const BATCH_PATH = '/v1/batch';
/** Q6 的偏差阈值（%）。 */
const DEVIATION_LIMIT_PCT = 1;

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next === undefined ? fallback : next;
}
const REPEAT = Number(argValue('--repeat', '1'));

/**
 * 偏差百分比。**两侧任一为 0 时返回 null（不可判定）**——不允许把空白读成达标。
 */
function deviationPct(sent, stored) {
  if (sent <= 0 || stored <= 0) return null;
  return ((stored - sent) / sent) * 100;
}

const receiver = await startReceiver({ port: 0, writeToken: PLACEHOLDER_TOKEN });
const endpoint = `http://127.0.0.1:${String(receiver.port)}${BATCH_PATH}`;

// 腿 ①：SDK 发送计数。真实预发布环境应取 C08 的 `sdk_health` 计数；
// 本脚本用装配根的 delivery 指标（同一份客户端一侧事实）。
const assembly = createAssembly({
  appId: PLACEHOLDER_APP_ID,
  endpoint,
  token: PLACEHOLDER_TOKEN,
  env: 'staging',
  release: '0.0.0-pilot-reconcile',
  consent: 'granted',
  target: null,
  location: { href: 'https://pilot.example.invalid/reconcile', pageId: '/reconcile' },
});
assembly.init();
assembly.client.setPage('/reconcile');
for (let index = 0; index < REPEAT; index += 1) {
  assembly.client.track('pilot_reconcile_event', { dimensions: { round: String(index) } });
  assembly.flush();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
}
await new Promise((resolve) => globalThis.setTimeout(resolve, 1200));

const sentMetrics = assembly.delivery.metrics();
const sentEvents = sentMetrics.eventsSent;
// 腿 ②：接收方去重后入库计数。
const counters = receiver.counters.snapshot();
const receiverStoredEvents = counters.stored_events;
const receiverReceivedEvents = counters.received_events;
// 腿 ③：双写转发计数 —— 由 T19 适配器提供；本脚本不伪造，显式记为「本次未接入」。
const forwardedEvents = null;

const deviation = deviationPct(sentEvents, receiverStoredEvents);

console.log('=== T33 三腿对账（M01 本地演示；**非试点真实数据**） ===\n');
console.log(`占位应用（非真实）：${PLACEHOLDER_APP_ID}；重复轮次：${String(REPEAT)}\n`);
console.log('腿 ① SDK 发送（客户端一侧）');
console.log(`    eventsSent（装配根 delivery 指标）      = ${String(sentEvents)}`);
console.log(`    batchesSent / batchesFailed             = ${String(sentMetrics.batchesSent)} / ${String(sentMetrics.batchesFailed)}`);
console.log('\n腿 ② 接收方（M01，去重后入库为对账口径）');
console.log(`    received_events（去重前）               = ${String(receiverReceivedEvents)}`);
console.log(`    stored_events（去重后，**以此为准**）   = ${String(receiverStoredEvents)}`);
console.log(`    duplicate_events                        = ${String(counters.duplicate_events)}`);
console.log(`    duplicate_rate                          = ${String(counters.duplicate_rate)}`);
console.log(`    恒等式 received - stored === duplicate  = ${String(receiverReceivedEvents - receiverStoredEvents === counters.duplicate_events)}`);
console.log('\n腿 ③ 双写转发计数（T19 适配器）');
console.log(`    ${forwardedEvents === null ? '未接入（本演示不伪造该数字）→ 真实试点时由 T19 适配器导出' : String(forwardedEvents)}`);

console.log('\n=== 偏差判定（Q6：≤1%） ===');
if (deviation === null) {
  console.log(`    腿①=${String(sentEvents)}、腿②=${String(receiverStoredEvents)} → **不可判定**`);
  console.log('    理由：任一腿为 0 时无法计算偏差；**空白不是「0 丢失」，也不是「偏差 0%」**（T32 教训）。');
} else {
  console.log(`    腿① vs 腿② 偏差 = ${deviation.toFixed(4)}%`);
  console.log(`    判定：${Math.abs(deviation) <= DEVIATION_LIMIT_PCT ? '在 1% 内（本演示）' : '超出 1%（须按偏差来源分类表解释）'}`);
}

console.log('\n=== D004 要求的三类分列（**不得合并**） ===');
console.log('    ① 优雅退出路径丢失率        ：本演示未测（需 T29 的优雅路径 harness）');
console.log('    ② 硬杀「已确认落盘」丢失    ：本演示未测（需真实浏览器 + SIGKILL）');
console.log('    ③ 硬杀暴露窗口内未提交      ：本演示未测；窗口须成对引用 observedWindowMs ≤ W ≤ windowMs');
console.log('    说明：本脚本只演示「腿①↔腿②」的对账机械，**不产出任何丢失率结论**。');

assembly.destroy();
await receiver.stop();
process.exitCode = deviation === null ? 1 : 0;
