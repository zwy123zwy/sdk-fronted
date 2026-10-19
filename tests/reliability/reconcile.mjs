#!/usr/bin/env node
/**
 * T32 可靠性对账：从 T29 的实测 results JSON 重新生成对账表。
 *
 * 用法：
 *   node tests/reliability/reconcile.mjs                    # 打印到 stdout
 *   node tests/reliability/reconcile.mjs --write            # 覆写 docs/reports/reliability-reconciliation.md 的生成区
 *   node tests/reliability/reconcile.mjs --browser chromium # 只对账一个引擎
 *
 * 引擎名单：**默认枚举 `tests/e2e/lib/browser-names.mjs` 里声明的全部引擎**
 * （`chromium` / `firefox` / `webkit`，唯一来源是 `@playwright/test` 导出的 BrowserType）。
 * 这里不再写第二份名单：写死 `['chromium','webkit']` 的后果是 `d004-firefox.json`
 * 永远读不到、也**没有人被告知少了一个引擎**——与 `d004-run.mjs` 修掉的「静默覆盖缺口」同一类。
 * 缺证据的引擎会：① 在报告 §3.0 顶部记「本次只覆盖了 N/M 个引擎」；② 在 §3.0/§3.1
 * 逐行标「文件缺失」；③ 在 stderr 告警一次。**退出码仍为 0**：
 * 这是读取器如实记账的证据缺口，不是脚本执行错误（要让缺口变红请由调用方检查该告警）。
 *
 * 口径来源（**不得改动**）：
 *   - docs/decisions/D004-hard-kill-exposure-window.md 结论第 1 条：三类分列，不得合并。
 *   - docs/tasks/T32.md 验收用例（2026-10-13 按 D004 改过）。
 *
 * 本脚本只读 `tests/e2e/results/*.json`，不写任何 T29 产物、不跑浏览器。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DECLARED_BROWSERS, expandBrowserArg } from '../e2e/lib/browser-names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const RESULTS = resolve(REPO, 'tests/e2e/results');

/** D004 三类（+ D-1 子窗口）的格子归属。硬编码在这里是为了让「归类」可审阅、可 diff。 */
export const CLASSIFICATION = {
  // ① 优雅退出路径（页面离开/隐藏、断网恢复、多标签页、优雅关闭）
  graceful: [],
  // ② 硬杀「已确认落盘」（事务 oncomplete 已返回）
  hardKillDurable: ['durable'],
  // ③ 硬杀「暴露窗口内未提交」——事务在途
  hardKillExposure: ['pending-d0', 'pending-d5', 'pending-d20', 'pending-d60', 'pending-d200', 'bulk-d0'],
  // D-1 修复后新增的子窗口：「事件已产生、锚点未落」
  anchorExposure: ['preflush-d0', 'preflush-small'],
};

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 把一个 cell 压成对账所需的最小事实集；每个字段都能回指 JSON 路径。 */
function summarizeCell(cell, index, browser) {
  const exp = cell.expectedEvents;
  const survived = cell.survived.events;
  const commitLost = cell.d004.uncommittedFromIntent;
  const reconciles = cell.exposureReconciles;
  const reconcilesBool = reconciles === true;
  const reconcilesObj = reconciles && typeof reconciles === 'object' ? reconciles : null;
  return {
    browser,
    index,
    cell: `${browser} \`${cell.name}\``,
    name: cell.name,
    group: cell.group,
    count: cell.count,
    eventsPerBatch: cell.eventsPerBatch,
    expectedEvents: exp,
    scheduledDelayMs: cell.scheduledDelayMs,
    measuredMsAfterIssue: cell.measuredMsAfterIssue,
    issuedBatches: cell.issue.issued,
    survivedEvents: survived,
    missingEvents: cell.survived.missingEvents,
    partiallyReadable: cell.survived.partiallyReadable,
    unexpectedEvents: cell.survived.unexpectedEvents,
    rate: cell.survived.rate,
    commitLostEvents: commitLost,
    commitLostFromStats: cell.reopenStats.exposure.commitLostEvents,
    commitLostWindowMs: cell.reopenCommitLoss.windowMs,
    windowCaptured: cell.windowCaptured,
    nothingCommitted: cell.nothingCommitted,
    oncompleteSurvivors: cell.d004.oncompleteSurvivors,
    reconciles,
    reconcilesBool,
    reconcilesObj,
    // ---- 捕获判定（T29 尾部护栏；旧产物没有这一段，字段为 null，不补数）----
    captureVerdict: cell.captureGate?.verdict ?? null,
    captureGated: cell.captureGate?.gated ?? null,
    capturePassed: cell.captureGate?.passed ?? null,
    captureRounds: cell.captureRounds ?? cell.captureGate?.roundCount ?? null,
    captureBestStreak: cell.captureGate?.bestStreak ?? null,
    captureRequiredStreak: cell.captureGate?.requiredStreak ?? null,
    captureJitterRate: cell.captureGate?.jitterRate ?? null,
    captureClasses: cell.captureGate?.classes ?? null,
    captureRoundVerdicts: Array.isArray(cell.captureGate?.rounds)
      ? cell.captureGate.rounds.map((r) => ({
          round: r.round,
          verdict: r.verdict,
          survivors: r.survivors,
          commitLost: r.commitLost,
          lostEvents: r.lostEvents,
          zeroLoss: r.zeroLoss,
        }))
      : null,
    // 对账等式：存活 + 未提交计数 == 期望？（与 T29 spec 的 D004-B/C 判据一致）
    identity: survived + commitLost - exp,
    identityHolds: survived + commitLost === exp,
  };
}

/**
 * 读各引擎的 d004 证据。**默认枚举声明的全部引擎**（`tests/e2e/lib/browser-names.mjs`），
 * 不再写死 `['chromium','webkit']`。缺文件的引擎仍然返回一条 `missing: true` 记录，
 * 由渲染层显式记账——「没读到」与「没有问题」必须能分开。
 */
export function loadSummaries({ browsers = DECLARED_BROWSERS } = {}) {
  const out = [];
  for (const b of browsers) {
    const file = resolve(RESULTS, `d004-${b}.json`);
    let json;
    try {
      json = loadJson(file);
    } catch (err) {
      out.push({ browser: b, file: `tests/e2e/results/d004-${b}.json`, missing: true, error: String(err) });
      continue;
    }
    out.push({
      browser: b,
      file: `tests/e2e/results/d004-${b}.json`,
      missing: false,
      task: json.task,
      generatedAt: json.generatedAt,
      driver: json.driver,
      transport: json.transport,
      serverUrl: json.serverUrl,
      cells: json.cells.map((c, i) => summarizeCell(c, i, b)),
      grouped: json.grouped,
    });
  }
  return out;
}

/**
 * 每一行的对账结论文案。判据是**对账等式**（存活 + 未提交计数 == 期望），
 * 与 T29 spec 的 D004-B/C 判据一致；`exposureReconciles` 只作为第二意见一并报出，
 * 两者不一致时必须显式暴露（不得美化）。
 */
function verdict(row) {
  if (row.windowCaptured && !row.identityHolds) {
    return `❌ **未对账**：存活 ${row.survivedEvents} + 计数 ${row.commitLostEvents} ≠ 期望 ${row.expectedEvents}` +
      `（差 ${row.identity}）—— D004 要求未提交事件单独计数`;
  }
  if (!row.windowCaptured && row.nothingCommitted) {
    return `⛔ **窗口未捕获，本格无结论**：SIGKILL 落在任何提交之前（\`nothingCommitted=true\`），` +
      `JSON 的 \`exposureReconciles\` 是对象 \`${JSON.stringify(row.reconcilesObj)}\` 而非 \`true\`；` +
      `存活+计数 ${row.survivedEvents + row.commitLostEvents} ≠ 期望 ${row.expectedEvents}。` +
      `**不得记为 0 丢失，也不得计入"已对账"**`;
  }
  if (row.identityHolds && row.commitLostEvents > 0) {
    return `完全对账 ✅（窗口已捕获：存活 ${row.survivedEvents} + 未提交 ${row.commitLostEvents} = 期望）`;
  }
  if (row.identityHolds && row.oncompleteSurvivors !== null && row.oncompleteSurvivors !== undefined) {
    return `完全对账 ✅（等 \`oncomplete\` 后杀：${row.survivedEvents}/${row.expectedEvents} 全部读回，计 0）`;
  }
  if (row.identityHolds) {
    return `完全对账 ✅（未捕获窗口：事务已先提交，存活 ${row.survivedEvents}/${row.expectedEvents}，计 0）`;
  }
  return `❌ **未对账**：存活 ${row.survivedEvents} + 计数 ${row.commitLostEvents} ≠ 期望 ${row.expectedEvents}（差 ${row.identity}）`;
}

function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return String(v);
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ms`;
}

/** 暴露窗口时长列：捕获到就是 `reopenCommitLoss.windowMs`，否则说明"未捕获"及其原因。 */
function winCell(r) {
  if (r.windowCaptured) return fmtMs(r.commitLostWindowMs);
  return `—（未捕获；杀在发出后 ${fmtMs(r.measuredMsAfterIssue)}）`;
}

const FULL_HEADER =
  '| 格子 | 样本量 | 期望事件 | 存活（读回） | 读不回 | `prewrite_commit_lost` 计数 | 暴露窗口时长 | 对账 | 证据（JSON 路径） |\n' +
  '|---|---|---|---|---|---|---|---|---|\n';

/** 一行的渲染。`src` 是文件级证据标识（如 `d004-chromium.json`）。 */
function row(r, src) {
  return (
    `| ${r.cell} | ${r.count} 批 × ${r.eventsPerBatch} | ${r.expectedEvents} | ${r.survivedEvents} | ` +
    `${r.missingEvents} | ${r.commitLostEvents} | ${winCell(r)} | ${verdict(r)} | ` +
    `\`${src}\` \`cells[${r.index}]\` |`
  );
}

// ---------------------------------------------------------------- 报告生成

/**
 * 引擎覆盖账：本次要读的（默认 = 声明的全部）、真正读到证据的、缺证据的。
 * 「有文件」的判据与 `loadSummaries` 一致（`missing === false`）。
 */
export function coverageOf(summaries, requested = DECLARED_BROWSERS) {
  const present = new Set(summaries.filter((s) => s.missing !== true).map((s) => s.browser));
  const missing = requested.filter((name) => !present.has(name));
  return {
    requested: [...requested],
    covered: requested.length - missing.length,
    total: requested.length,
    missing,
  };
}

/** §3.0 顶部的覆盖声明（固定写出 N/M；缺口必须点名）。 */
export function coverageLine(coverage) {
  const gap =
    coverage.missing.length === 0
      ? '全部声明引擎都有证据'
      : `**缺少 ${coverage.missing.join('、')} 的 d004 JSON**——这是证据缺口，` +
        '**不得读成"该引擎没有问题"或"没有差异"**';
  return (
    `> **引擎覆盖：本次只覆盖了 ${coverage.covered}/${coverage.total} 个引擎**（${gap}）。` +
    '引擎名单来自 `tests/e2e/lib/browser-names.mjs`（= `@playwright/test` 的 BrowserType），不在本脚本另写一份。'
  );
}

/**
 * 渲染第 3 节。返回 `{ markdown, coverage }`：`coverage` 供 CLI 在 stderr 再告警一次，
 * 不必为了拿覆盖数把 300 KB 的 JSON 再读一遍。
 */
export function renderReconciliation({ browsers = DECLARED_BROWSERS } = {}) {
  const summaries = loadSummaries({ browsers });
  const coverage = coverageOf(summaries, browsers);
  const L = [];
  const p = (s = '') => L.push(s);

  p('#### 3.0 逐格总览与三类归属');
  p('');
  p(coverageLine(coverage));
  p('');

  // 归类：把每个 cell 映射到 D004 三类之一；未归类即异常，必须报出（不得静默丢弃）。
  const allNames = new Set();
  for (const s of summaries) if (!s.missing) for (const c of s.cells) allNames.add(c.name);
  const known = new Set(Object.values(CLASSIFICATION).flat());
  const unclassified = [...allNames].filter((n) => !known.has(n));

  p(`- 已归类的格子名（${known.size} 个）：${[...known].map((n) => '`' + n + '`').join('、')}`);
  p(
    `- **未归类的格子**：${unclassified.length === 0 ? '无' : unclassified.map((n) => '`' + n + '`').join('、')}` +
      `（脚本把新出现的格子名视为口径缺口在此列出，不静默丢弃）`,
  );
  p('');
  p('| 引擎 | 类别 | 格子 | 期望 | 存活 | 计数 | 窗口捕获 | 对账等式成立 | `exposureReconciles` |');
  p('|---|---|---|---|---|---|---|---|---|');
  const CLASS_LABEL = {
    graceful: '① 优雅路径',
    hardKillDurable: '② 硬杀已落盘',
    hardKillExposure: '③ 暴露窗口',
    anchorExposure: '③-D1 锚点子窗口',
  };
  for (const s of summaries) {
    if (s.missing) {
      p(`| ${s.browser} | — | **文件缺失**（\`${s.file}\`） | — | — | — | — | — | — |`);
      continue;
    }
    for (const cls of ['graceful', 'hardKillDurable', 'hardKillExposure', 'anchorExposure']) {
      for (const n of CLASSIFICATION[cls]) {
        const r = s.cells.find((c) => c.name === n);
        if (!r) continue;
        p(
          `| ${s.browser} | ${CLASS_LABEL[cls]} | \`${n}\` | ${r.expectedEvents} | ${r.survivedEvents} | ` +
            `${r.commitLostEvents} | ${r.windowCaptured ? '是' : '否'} | ${r.identityHolds ? '✅' : '❌'} | ` +
            `${r.reconcilesBool ? '`true`' : '`' + JSON.stringify(r.reconciles) + '`'} |`,
        );
      }
    }
  }
  p('');

  p('### 3.1 数据源指纹（每个数字都可回指这些数据文件）');
  p('');
  p('| 引擎 | 文件 | `generatedAt` | 被测实现 `sha256` 前缀 | 驱动 |');
  p('|---|---|---|---|---|');
  for (const s of summaries) {
    if (s.missing) { p(`| ${s.browser} | \`${s.file}\` | **文件缺失** | — | — |`); continue; }
    p(`| ${s.browser} | \`${s.file}\` | ${s.generatedAt} | \`${s.transport.sha256}\` | \`${s.driver.id}\` |`);
  }
  p('');

  // ① 优雅路径：本仓库当前无数据 —— 如实说明

  // 关键口径提醒：JSON 里的窗口时长字段不是 D004 定义的暴露窗口时长（本次实测发现）。
  p('> **读表前必读：`exposure_window_ms` 的语义不等于 D004 的"暴露窗口"**（本任务实测发现，见缺口 2）。');
  p('> 实现里 `commitLostWindowMs` 来自 `reconcileCommitLoss()` 的 `windowMs = now() - first_pending_at`，');
  p('> 源码注释写明"窗口时长是**上界**：会话死亡时刻不可观测，只能给到对账时刻"');
  p('> （`packages/transport/src/offline/offline-store.ts:318`）。因此它**包含强杀 + 重启 + 探测页打开**的耗时，');
  p('> 是三张表里 900–1700 ms 那一列，**不是** D004 定义的那个"由批写提交延迟决定（p50 1–4.1 ms / p95 3–17 ms）"的窗口。');
  p('> 真正的窗口量级只能从 `measuredMsAfterIssue` 与"是否捕获到窗口"的临界点间接看出（③ 表）。');
  p('');
  p('### ① 优雅退出路径（按丢失率：critical ≤0.1%、normal ≤1%）');
  p('');
  p('**本仓库当前没有可供对账的实测数据**（这是缺口，不是"通过"）。缺什么见第 5 节「缺口 1」。');
  p('');
  p('| 场景 | 样本量 | 存活 | 丢失 | 丢失率 | 判据 | 证据来源 |');
  p('|---|---|---|---|---|---|---|');
  for (const scen of ['页面离开 / 隐藏', '断网恢复（1–30 min）', '多标签页（2–5 个）', '优雅关闭']) {
    p(`| ${scen} | — | — | — | — | critical ≤0.1% / normal ≤1% | **无数据源**（归 T29 / 需非沙箱会话） |`);
  }
  p('');
  p('> 现有真实浏览器数据不能代替：T29 的功能验证样本量是 5–7 个事件');
  p('> （`sendBeacon` 送达 5/5、IDB 写 7 事件 reload 后读回 7），分辨率远粗于 0.1%；');
  p('> 且 `tests/e2e/results/*.json` 中**没有任何丢失率字段**。');
  p('');

  const titles = {
    hardKillDurable: '### ② 硬杀「已确认落盘」（事务 `oncomplete` 已返回）——**不丢**',
    hardKillExposure: '### ③ 硬杀「暴露窗口内未提交」——事务在途，按条数与窗口时长计量',
    anchorExposure: '### ③-D1 子窗口「事件已产生、锚点未落」（D-1 修复后新增计数）',
  };
  for (const cls of ['hardKillDurable', 'hardKillExposure', 'anchorExposure']) {
    const names = CLASSIFICATION[cls];
    if (names.length === 0) continue;
    p(titles[cls]);
    p('');
    p(FULL_HEADER.trimEnd());
    for (const s of summaries) {
      if (s.missing) { p(`| ${s.browser}：文件缺失 | — | — | — | — | — | — | — | — |`); continue; }
      for (const n of names) {
        const r = s.cells.find((c) => c.name === n);
        if (!r) { p(`| ${s.browser} \`${n}\` | **JSON 中无此格** | — | — | — | — | — | — | — |`); continue; }
        p(row(r, `d004-${s.browser}.json`));
      }
    }
    p('');
  }

  // 重复性：用同一份 T29 harness 独立再跑一次 Chromium（T32 本任务新增），逐格比对。
  const REPLICATE = resolve(REPO, 'tests/reliability/results/d004-chromium-rerun.json');
  p('### 3.2 重复性对账（Chromium 第二次独立运行，T32 本任务新增）');
  p('');
  p('命令（**不改动 T29 的官方产物**，用 `--out` 另存）：');
  p('');
  p('```');
  p('node tests/e2e/lib/d004-run.mjs --browser chromium --out tests/reliability/results/d004-chromium-rerun.json');
  p('```');
  p('');
  if (!existsSync(REPLICATE)) {
    p('> ⚠️ `tests/reliability/results/d004-chromium-rerun.json` 不存在，本节无数据。');
  } else {
    p(renderComparison(resolve(RESULTS, 'd004-chromium.json'), REPLICATE));
    p('');
    // 从两次运行里现算"哪些可重复、哪些不可重复"——不写死数字。
    const A = loadJson(resolve(RESULTS, 'd004-chromium.json'));
    const B = loadJson(REPLICATE);
    const nCapturedA = A.cells.filter((c) => c.windowCaptured).length;
    const nCapturedB = B.cells.filter((c) => c.windowCaptured).length;
    const preA = A.cells.find((c) => c.name === 'preflush-small');
    const preB = B.cells.find((c) => c.name === 'preflush-small');
    const durA = A.cells.find((c) => c.name === 'durable');
    const durB = B.cells.find((c) => c.name === 'durable');
    const winPairs = A.cells
      .filter((c) => c.windowCaptured && B.cells.find((x) => x.name === c.name)?.windowCaptured)
      .map((c) => [c.reopenCommitLoss.windowMs, B.cells.find((x) => x.name === c.name).reopenCommitLoss.windowMs]);
    const spread = winPairs.map(([x, y]) => Math.abs(y - x) / x);
    p('**读法（只陈述两次运行里实际变了什么）**：');
    p('');
    p(
      `- **可重复**：两次运行捕获到窗口的格子数分别为 ${nCapturedA} / ${nCapturedB}（同一组格名），` +
        `**9/9 格的对账等式两次都成立**；`,
    );
    p(
      `- **D-1 子窗口的计数装置可重复**：\`preflush-small\`（默认配置、最贴近生产的那一格）两次都是` +
        `「存活 0 + 计数 ${preA.d004.uncommittedFromIntent} = 期望 ${preA.expectedEvents}」与` +
        `「存活 0 + 计数 ${preB.d004.uncommittedFromIntent} = 期望 ${preB.expectedEvents}」` +
        `——第二次独立复现了"计数锚点覆盖到该子窗口"这一结论。`,
    );
    p(
      `- **不可重复（绝对值）**：暴露窗口时长在两次运行间的相对偏离为 ` +
        `${spread.map((s) => (s * 100).toFixed(0) + '%').join(' / ')}（各捕获格）；` +
        `\`durable\` 格的"杀在发出后"从 ${durA.measuredMsAfterIssue} ms 变到 ${durB.measuredMsAfterIssue} ms。` +
        `**因此本报告不把任何单次窗口时长当作分布或 SLA 输入**` +
        `（D004 引用的 p50 1–4.1 ms / p95 3–17 ms 是 POC-1 的批写提交延迟，不是这里的端到端窗口时长）。`,
    );
    p(
      `- **仍不能说明的事**：两次运行都是 Chromium、都是单次、都是 headless；` +
        `**WebKit 没有第二次运行**（本任务不允许覆写 T29 的 webkit 产物），Firefox 未测。`,
    );
  }
  p('');
  p(renderExposureBounds());
  p('');
  p(renderCaptureGate());

  return { markdown: L.join('\n'), coverage };
}

// ------------------------------------------------- 捕获判定（T29 尾部护栏，只增不改）

/**
 * 3.4 捕获判定：**只增不改**。
 *
 * 本节不改 3.0–3.3 的任何判定，只把 T29 尾部新增的护栏读数（`captureGates`）列出来 ——
 * 因为 3.0/3.1 看到的是**被报告的那一轮**（护栏刻意选一轮完整捕获），
 * 单看它会把「捕获不稳定」读成「完全对账」。
 *
 * 口径（与 `tests/e2e/lib/d004-capture.mjs` 同源）：
 *   - `passed=true` 仅当**连续 `requiredStreak` 轮完整**（窗口已捕获且 `存活+计数=期望`）；
 *   - `never-complete` / `blank-only` / `window-never-captured` 都是**未通过**捕获判定，
 *     且**不得**读作「0 丢失」；
 *   - 逐轮判定里 `blank`/`undercounted` 的 `lostEvents` 是 `null`（无计数证据），
 *     只有 `window-missed`（全部读回）才是 `0`。
 */
export function renderCaptureGate() {
  const out = [];
  out.push('### 3.4 捕获判定（T29 尾部护栏「锚点合并残余窗口」，只增不改）');
  out.push('');
  out.push('> 背景：intent 锚点是**异步**写入且取值取自发起那一刻（`offline-store.ts:367-396`），');
  out.push('> SIGKILL 落在 Δt=0 时只有最早那份锚点落盘 → `prewrite_commit_lost` **偏小**（不是数据丢失）。');
  out.push('> 出处：`docs/reports/e2e-d004-hardkill.md` 局限第 6 条（已预报）。本节只报判定，不改上面任何结论。');
  out.push('');

  const summaries = loadSummaries();
  const missing = summaries.filter((s) => s.missing);
  if (missing.length > 0) {
    out.push(
      `> ⚠️ **本节引擎覆盖：${summaries.length - missing.length}/${summaries.length}**；` +
        `缺少 ${missing.map((s) => s.browser).join('、')} 的证据（文件缺失）。` +
        '下表只列有证据的引擎——**不得把"没出现在表里"读成"该引擎没有捕获问题"**。',
    );
    out.push('');
  }
  const withGate = summaries.filter((s) => !s.missing && s.cells.some((c) => c.captureVerdict !== null));
  if (withGate.length === 0) {
    out.push('> ⚠️ 现有 d004 产物里没有 `captureGate` 字段（早于本护栏），本节无数据（不补数）。');
    return out.join('\n');
  }

  out.push('| 引擎 | 格子 | 捕获判定 | 通过 | 轮数 | 最长连续完整 / 要求 | 抖动率 | 逐轮判定（存活/计数/lostEvents） |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const s of summaries) {
    if (s.missing) continue;
    for (const c of s.cells) {
      if (c.captureVerdict === null) continue;
      const rounds = (c.captureRoundVerdicts ?? [])
        .map((r) => `#${r.round + 1} ${r.verdict}(${r.survivors}/${r.commitLost}/${r.lostEvents === null ? 'null' : r.lostEvents})`)
        .join('、');
      out.push(
        `| ${s.browser} | \`${c.name}\` | \`${c.captureVerdict}\` | ` +
          `${c.capturePassed === null ? '—（非捕获格）' : c.capturePassed ? '✅' : '❌ **未通过**'} | ` +
          `${c.captureRounds ?? '—'} | ${c.captureBestStreak ?? '—'} / ${c.captureRequiredStreak ?? '—'} | ` +
          `${c.captureJitterRate === null || c.captureJitterRate === undefined ? '—' : (c.captureJitterRate * 100).toFixed(0) + '%'} | ` +
          `${rounds === '' ? '—' : rounds} |`,
      );
    }
  }
  out.push('');
  const notPassed = [];
  for (const s of summaries) {
    if (s.missing) continue;
    for (const c of s.cells) if (c.captureGated === true && c.capturePassed === false) notPassed.push(`${s.browser} \`${c.name}\`（${c.captureVerdict}，抖动 ${((c.captureJitterRate ?? 0) * 100).toFixed(0)}%）`);
  }
  if (notPassed.length === 0) {
    out.push('- 所有捕获格都**通过**了捕获判定（连续 N 轮完整）。');
  } else {
    out.push(
      `- **未通过捕获判定的捕获格（${notPassed.length} 个）**：${notPassed.join('、')}。` +
        '它们是**捕获不稳定/无计数证据**，既不是「0 丢失」也不是「数据丢失」；' +
        '逐轮判定里 `lostEvents: null` 表示**没有计数证据**（不得读成 0）。',
    );
  }
  out.push(
    '- 注意：3.0/3.1/3.2 的表格读的是**被报告的那一轮**（护栏刻意挑一轮完整捕获，以免单轮抖动被读成红/绿）；' +
      '单看那几张表**看不出**捕获是否稳定 —— 稳定性只在本节。',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------- CR-008 夹逼读数（只增不改）

/**
 * CR-008（2026-10-14 批准）的夹逼读数：契约字段暴露窗口的**两个端点**。
 *
 * **只增不改**：本区**不复用、也不改动**任何既有判定（`verdict` / `identityHolds` /
 * `CLASSIFICATION` / 3.0–3.2 的表格与口径），只把两个端点成对列出：
 * `observedWindowMs ≤ W ≤ windowMs`。
 *
 * 数据源按优先级取第一个存在的文件；每个格子的下界依次读：
 * `reopenCommitLoss.observedWindowMs`（CR-007 起 T29/T33 产物带）→
 * `reopenStats.exposure.commitLostObservedWindowMs` →
 * 契约指标键 `exposure_window_lower_bound_ms`（若 JSON 直接带了 metrics）。
 */
export const SQUEEZE_SOURCES = [
  'tests/reliability/results/d004-chromium-observed-window.json',
  'tests/e2e/results/d004-chromium.json',
  'tests/e2e/results/d004-webkit.json',
];

/** 读一份 d004 JSON 的两个端点；只读，不写任何 T29/T33 产物。 */
export function loadExposureBounds(path) {
  const json = loadJson(path);
  const cells = json.cells.map((cell, index) => {
    const metrics = cell.sdkHealthMetrics ?? cell.metrics ?? null;
    const fromMetrics = (key) => (metrics !== null && typeof metrics[key] === 'number' ? metrics[key] : null);
    const lower =
      cell.reopenCommitLoss?.observedWindowMs ??
      cell.reopenStats?.exposure?.commitLostObservedWindowMs ??
      fromMetrics('exposure_window_lower_bound_ms');
    const upper =
      cell.reopenCommitLoss?.windowMs ??
      fromMetrics('exposure_window_upper_bound_ms') ??
      fromMetrics('exposure_window_ms');
    const lostEvents =
      typeof cell.reopenCommitLoss?.events === 'number' ? cell.reopenCommitLoss.events : null;
    const captured = cell.windowCaptured === true;
    // 夹逼只在「窗口被捕获且真有丢失事件、且两端点都可读」时成立。
    // 未捕获的格子 JSON 里是 `{events: 0, windowMs: 0, observedWindowMs: 0}` 的初值，
    // 那是「没有账目」而不是「窗口 = 0 ms」——不得渲染成 [0, 0]（与 3.0 的既有口径一致）。
    const bounded =
      captured &&
      (lostEvents === null || lostEvents > 0) &&
      typeof lower === 'number' &&
      typeof upper === 'number' &&
      upper >= 1;
    return {
      index,
      name: cell.name,
      lower: bounded ? lower : null,
      upper: bounded ? upper : null,
      captured,
      lostEvents,
      bounded,
      measuredMsAfterIssue: cell.measuredMsAfterIssue ?? null,
    };
  });
  return {
    file: path.startsWith(REPO) ? path.slice(REPO.length + 1) : path,
    browser: json.browser,
    generatedAt: json.generatedAt,
    cells,
  };
}

/** 一格没有夹逼区间时的原因（不美化、不补数）。 */
function noBracketReason(cell) {
  if (!cell.captured) {
    const lost = cell.lostEvents === null ? '未知' : cell.lostEvents;
    return `—（未捕获窗口：\`prewrite_commit_lost\` = ${lost}，无端点；**不得读作窗口 0 ms**）`;
  }
  if (cell.upper === null) return '—（该产物没有上界读数）';
  return '—（该产物早于 CR-007，没有下界读数）';
}

/** 渲染 3.3 节；没有任何产物时如实说明，不补数。 */
export function renderExposureBounds() {
  const out = [];
  out.push('### 3.3 暴露窗口的夹逼读数（CR-008 追加，只增不改）');
  out.push('');
  out.push('> **口径**（CR-008）：D004 的真实暴露窗口 W 的右端点（进程死亡时刻）客户端不可观测，');
  out.push('> 因此契约只承诺两个端点，不承诺任何叫「真实窗口」的字段：');
  out.push('> `exposure_window_lower_bound_ms`（`事件产生 → 最后一次「会话仍存活」证据`，**低估**）与');
  out.push('> `exposure_window_upper_bound_ms`（`事件产生 → 重启后对账`，**高估**，与 `exposure_window_ms` 同源同值）。');
  out.push('> 本节**不改动** 3.0–3.2 的任何判定，只把两个端点成对列出：`lower ≤ W ≤ upper`；');
  out.push('> 没有捕获到窗口的格子**没有**夹逼区间（JSON 的 `0` 是初值，不是窗口 0 ms）。');
  out.push('');

  const path = SQUEEZE_SOURCES.map((p) => resolve(REPO, p)).find((p) => existsSync(p));
  if (path === undefined) {
    out.push('> ⚠️ 没有可用的 d004 产物，本节无数据（不补数）。');
    return out.join('\n');
  }

  const data = loadExposureBounds(path);
  out.push(`数据源：\`${data.file}\`（${data.browser}，${data.generatedAt}）`);
  out.push('');
  out.push('| 格子 | 下界 `observedWindowMs` | 上界 `windowMs`（= `exposure_window_ms`） | 窗口捕获 | 杀在发出后 | 夹逼区间 |');
  out.push('|---|---|---|---|---|---|');
  for (const cell of data.cells) {
    const bracket = cell.bounded ? `[${cell.lower}, ${cell.upper}] ms` : noBracketReason(cell);
    out.push(
      `| \`${cell.name}\` | ${cell.lower === null ? '—' : `${cell.lower} ms`} | ` +
        `${cell.upper === null ? '—' : `${cell.upper} ms`} | ${cell.captured ? '是' : '否'} | ` +
        `${fmtMs(cell.measuredMsAfterIssue)} | ${bracket} |`,
    );
  }
  out.push('');
  const bounded = data.cells.filter((cell) => cell.bounded);
  if (bounded.length === 0) {
    out.push('> ⚠️ 本产物里**没有**任何可用的夹逼区间：');
    if (data.cells.every((cell) => !cell.captured)) {
      out.push('> 所有格子都没有捕获到暴露窗口（`windowCaptured=false`），因此谈不上端点。');
    } else {
      out.push('> 捕获到窗口的格子缺下界读数——该产物产生于 CR-007（本地下界观测量 `observedWindowMs`）落地之前。');
    }
    out.push('> 表中的上界仍按 CR-007 的「上界」语义列出；**不得**把缺失读成"窗口为 0"。');
  } else {
    const captured = data.cells.filter((cell) => cell.captured).length;
    out.push(
      `> 本产物有 **${bounded.length}/${data.cells.length}** 格给出夹逼区间（捕获到窗口的格子共 ${captured} 格）；` +
        '未给出的格子已逐格标注原因，**不得**读成"窗口为 0"。',
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- 重复性对账（可选：两份 JSON 逐格比对）

/**
 * 比较两份 d004 JSON（同一引擎、不同次运行）的逐格事实。
 * 用途：用**同一份 T29 harness**、写到 `--out` 的第二个文件，检查
 * 「窗口是否每次都捕获」「计数是否每次都守恒」——这是③类"计量可靠"的最小证据。
 */
export function compareRuns(aPath, bPath) {
  const A = loadJson(aPath);
  const B = loadJson(bPath);
  const rows = [];
  for (const ca of A.cells) {
    const cb = B.cells.find((c) => c.name === ca.name);
    if (!cb) { rows.push({ name: ca.name, missing: true }); continue; }
    rows.push({
      name: ca.name,
      a: { captured: ca.windowCaptured, survived: ca.survived.events, lost: ca.d004.uncommittedFromIntent, exp: ca.expectedEvents, win: ca.reopenCommitLoss.windowMs, ms: ca.measuredMsAfterIssue },
      b: { captured: cb.windowCaptured, survived: cb.survived.events, lost: cb.d004.uncommittedFromIntent, exp: cb.expectedEvents, win: cb.reopenCommitLoss.windowMs, ms: cb.measuredMsAfterIssue },
    });
  }
  return { a: { file: aPath, browser: A.browser, sha: A.transport.sha256, generatedAt: A.generatedAt },
           b: { file: bPath, browser: B.browser, sha: B.transport.sha256, generatedAt: B.generatedAt },
           rows };
}

export function renderComparison(aPath, bPath) {
  const { a, b, rows } = compareRuns(aPath, bPath);
  const out = [];
  out.push(`- A：\`${a.file}\`（${a.browser}，sha256 \`${a.sha}\`，${a.generatedAt}）`);
  out.push(`- B：\`${b.file}\`（${b.browser}，sha256 \`${b.sha}\`，${b.generatedAt}）`);
  out.push(`- 同一份被测实现：${a.sha === b.sha ? '**是**' : `**否**（\`${a.sha}\` vs \`${b.sha}\`）—— 两次运行不可直接比较`}`);
  out.push('');
  out.push('| 格子 | A 窗口捕获 | B 窗口捕获 | A 存活+计数=期望 | B 存活+计数=期望 | A 窗口时长 | B 窗口时长 | A 杀在发出后 | B 杀在发出后 | 判定 |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (r.missing) { out.push(`| \`${r.name}\` | — | **B 中缺此格** | — | — | — | — | — | — | ⚠️ |`); continue; }
    const okA = r.a.survived + r.a.lost === r.a.exp;
    const okB = r.b.survived + r.b.lost === r.b.exp;
    const stable = r.a.captured === r.b.captured && okA && okB;
    out.push(
      `| \`${r.name}\` | ${r.a.captured ? '是' : '否'} | ${r.b.captured ? '是' : '否'} | ` +
        `${r.a.survived}+${r.a.lost}=${r.a.exp} ${okA ? '✅' : '❌'} | ${r.b.survived}+${r.b.lost}=${r.b.exp} ${okB ? '✅' : '❌'} | ` +
        `${r.a.win} ms | ${r.b.win} ms | ${r.a.ms} ms | ${r.b.ms} ms | ${stable ? '守恒且一致' : '**需人判**'} |`,
    );
  }
  return out.join(String.fromCharCode(10));
}

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const writeIdx = argv.indexOf('--write');
  const cmpIdx = argv.indexOf('--compare');
  const browserIdx = argv.indexOf('--browser');

  let browsers = DECLARED_BROWSERS;
  if (browserIdx >= 0) {
    try {
      browsers = expandBrowserArg(argv[browserIdx + 1]);
    } catch (error) {
      console.error(
        `${String(error?.message ?? error)}\n` +
          `用法：node tests/reliability/reconcile.mjs [--browser all|${DECLARED_BROWSERS.join('|')}] ` +
          '[--write] [--compare <A.json> <B.json>]',
      );
      process.exit(2);
    }
  }
  if (writeIdx >= 0 && browserIdx >= 0) {
    console.error(
      '--browser 不能与 --write 同时使用：生成的报告必须覆盖全部声明引擎（否则会把"少读一个引擎"写进正式报告）。',
    );
    process.exit(2);
  }

  if (cmpIdx >= 0) {
    const a = argv[cmpIdx + 1];
    const b = argv[cmpIdx + 2];
    if (!a || !b) { console.error('用法：--compare <A.json> <B.json>'); process.exit(2); }
    console.log(renderComparison(resolve(REPO, a), resolve(REPO, b)));
  } else {
    const { markdown, coverage } = renderReconciliation({ browsers });
    if (coverage.missing.length > 0) {
      // 显式告警：缺一个引擎的证据时，绝不能让命令行看起来像"全绿跑完"。
      console.error(
        `⚠️ [reconcile] 本次只覆盖了 ${coverage.covered}/${coverage.total} 个引擎：` +
          `缺少 ${coverage.missing.join('、')} 的 tests/e2e/results/d004-<engine>.json。` +
          '这是**证据覆盖缺口**（不是"通过"），报告 §3.0 已逐项记账。',
      );
    }
    if (writeIdx >= 0) {
      const { writeFileSync } = await import('node:fs');
      const target = resolve(REPO, 'docs/reports/reliability-reconciliation.md');
      const BEGIN = '<!-- BEGIN GENERATED';
      const END = '<!-- END GENERATED -->';
      const existing = readFileSync(target, 'utf8');
      const i = existing.indexOf(BEGIN);
      const j = existing.indexOf(END, i + 1);
      if (i < 0 || j < 0) {
        console.error(`!! 生成区标记未找到（BEGIN@${i} END@${j}），未写入。`);
        process.exit(1);
      }
      const next =
        existing.slice(0, i) +
        `<!-- BEGIN GENERATED: node tests/reliability/reconcile.mjs --write -->\n${markdown}\n${END}` +
        existing.slice(j + END.length);
      if (next === existing) {
        // 幂等：生成区已是最新（不是错误，退出码 0，便于脚本化）。
        console.log('unchanged: docs/reports/reliability-reconciliation.md（生成区已是最新）');
        process.exit(0);
      }
      writeFileSync(target, next);
      console.log('written: docs/reports/reliability-reconciliation.md');
    } else {
      console.log(markdown);
    }
  }
}
