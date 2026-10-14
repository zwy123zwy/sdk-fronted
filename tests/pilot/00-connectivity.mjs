#!/usr/bin/env node
/**
 * T33 试点接入自检的最小可执行版（**不依赖 Q2**）。
 *
 * 它做的是 **接入方视角的第一步**：用公开 API 装配、上报、然后到接收方查计数。
 * 目的是证明「接入方照 `docs/guides/integration.md` 第 8.3 节做」这条路**真的跑得通**，
 * 并暴露跑不通的地方。
 *
 * 用法：
 *   node tests/pilot/00-connectivity.mjs
 *
 * 口径与断言来源：
 *   - `docs/guides/integration.md` 第 8.3 节「端到端上报自检」；
 *   - `docs/contracts/ingest-protocol.md`（第 13 行：路径是 `/v1/batch`）；
 *   - `docs/contracts/schemas/batch.schema.json`（`commonFields.page_id` 是 `{type: string}`）；
 *   - M01 计数接口 `/__mock/counters`（`tools/mock-receiver/src/counters.ts`）。
 *
 * ## 本脚本对指南的两处**实测偏离**（详见 docs/reports/t33-access-blockers.md）
 *
 * 1. 端点是 `/v1/batch`，**不是** `/ingest`。指南第 8.3 节第 2 步写「把 SDK 的端点指向 M01」，
 *    其第 8.3 节示例与本仓库 T30 脚本用的是 `/ingest`；实测 M01 对 `/ingest` 返回 **404**
 *    （`{"error":"not_found","message":"unknown path: /ingest"}`），真实路径见 M01 CLI 自己
 *    打印的「上报端点：POST /v1/batch」。用 `/ingest` 会让批次**失败且不入库**。
 * 2. 必须显式给出 `pageId`（调 `setPage` 或 `location.pageId`）。不设置时 SDK 产出
 *    `common.page_id: null`，而契约 `commonFields.page_id` 是 `{type: string}`（可选、但不可为
 *    null）→ M01 以 `invalid_structure`（400）拒收，`stored_events` 恒为 0。
 *    见 `docs/reports/t33-access-blockers.md` 的 **D-01（阻断级）**。
 *
 * 本脚本只监听 127.0.0.1、只用占位令牌，不触碰任何真实环境或个人数据。
 */
import { startReceiver } from '../../tools/mock-receiver/dist/index.js';
import { createAssembly } from '../../packages/browser/dist/index.js';

/** 占位令牌：M01 的默认固定比对值，明显是假值（不是任何真实凭据）。 */
const PLACEHOLDER_TOKEN = 'placeholder-write-token-0000';
/** 占位应用名：格式合法（^[a-z0-9][a-z0-9_-]{2,63}$）但显然不是真实应用。 */
const PLACEHOLDER_APP_ID = 'pilot-selfcheck-app';
/** 契约的批次上报路径（`docs/contracts/ingest-protocol.md` 第 13 行）。 */
const BATCH_PATH = '/v1/batch';

const failures = [];
function check(name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures.push(`${name}${detail === undefined ? '' : `：${detail}`}`);
  console.log(`  [${mark}] ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** 位置来源：node 下没有 window.location，装配根支持注入。`pageId` 见文件头第 2 条。 */
const location = { href: 'https://pilot.example.invalid/selfcheck', pageId: '/selfcheck' };

const receiver = await startReceiver({ port: 0, writeToken: PLACEHOLDER_TOKEN });
const endpoint = `http://127.0.0.1:${String(receiver.port)}${BATCH_PATH}`;
console.log(`M01 接收方已启动：http://127.0.0.1:${String(receiver.port)}`);
console.log(`上报端点：${endpoint}（契约路径，非指南示例里的 /ingest）\n`);

try {
  console.log('① 装配（createAssembly）');
  const assembly = createAssembly({
    appId: PLACEHOLDER_APP_ID,
    endpoint,
    token: PLACEHOLDER_TOKEN,
    env: 'staging',
    release: '0.0.0-pilot-selfcheck',
    consent: 'granted',
    target: null, // node 环境无原生事件目标
    location,
  });
  check('createAssembly 返回装配实例', assembly !== undefined && assembly !== null);

  console.log('\n② 初始化与上报（init → track → flush）');
  // 注意：`Assembly` **没有** `track`/`log`/`setUser` 等方法，业务方法都在 `assembly.client` 上。
  // 指南第 8.3 节写的是 `assembly.init()`（这个存在），但没写 `track` 该从哪调 —— 见 D-03。
  check('Assembly 暴露 client 句柄', assembly.client !== undefined);
  assembly.init();
  assembly.client.setPage('/selfcheck');
  assembly.client.track('pilot_selfcheck_event', { dimensions: { step: 'connectivity' } });
  assembly.flush();
  // flush 是异步投递的：立刻查计数会读到 0，这里等一次事件循环 + 网络往返。
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));

  console.log('\n③ 到接收方查计数（对账的第一步）');
  const counters = receiver.counters.snapshot();
  const delivery = assembly.delivery.metrics();
  check('SDK 侧认为批次已发出', delivery.batchesSent >= 1, `batchesSent=${String(delivery.batchesSent)}, batchesFailed=${String(delivery.batchesFailed)}`);
  check('接收方收到批次', counters.received_batches >= 1, `received_batches=${String(counters.received_batches)}`);
  check('接收方入库事件', counters.stored_events >= 1, `stored_events=${String(counters.stored_events)}`);
  check(
    '对账恒等式 received_events - stored_events === duplicate_events',
    counters.received_events - counters.stored_events === counters.duplicate_events,
    `${String(counters.received_events)} - ${String(counters.stored_events)} vs dup=${String(counters.duplicate_events)}`,
  );
  const rejected = Object.entries(counters)
    .filter(([key, value]) => key.startsWith('rejected_') && typeof value === 'number' && value > 0)
    .map(([key, value]) => `${key}=${String(value)}`);
  check('没有批次被拒绝', rejected.length === 0, rejected.join(', ') || '全 0');

  assembly.destroy();
} finally {
  await receiver.stop();
}

console.log(
  failures.length === 0
    ? '\n结论：最小接入自检通过（这条路径接入方照做即可）。'
    : `\n结论：有 ${String(failures.length)} 项未通过：\n${failures.map((line) => `  - ${line}`).join('\n')}`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
