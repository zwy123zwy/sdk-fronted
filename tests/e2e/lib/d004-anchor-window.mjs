#!/usr/bin/env node
/**
 * D004 捕获护栏的**非浏览器**判别性验证 —— 「锚点合并残余窗口」的确定性复现。
 *
 * ## 为什么必须有一个非浏览器的复现
 *
 * 单元层用的是 `fake-indexeddb`（**同步**），结构上做不出「锚点已在途、事件已产生、进程被杀」这个
 * 异步窗口；而真实浏览器复跑是**碰运气**（WebKit 5 次独立单格复跑里 `pending-d0` 有 1 次计数 10、
 * `preflush-d0` 有 1 次空白）。护栏如果只能靠真实浏览器碰运气来验证，就没有解决「一会儿红一会儿绿」。
 *
 * 本脚本用**注入式异步延迟**把这个窗口搬到 Node 里，确定性复现，判据不依赖任何浏览器：
 *
 *   - **被测实现是真的**：`packages/transport/dist/index.js`（`createOfflineStore`），不是替身；
 *   - **唯一注入的是存储后端的时序**：`OfflineStoreOptions.backend` 是公开注入点
 *     （`packages/transport/src/offline/types.ts:192`），这里用一个共享内存后端的包装：
 *     第一份 intent 锚点正常落盘，**后续锚点与数据事务一律「在途、永不落盘」**——
 *     这正是 `offline-store.ts:367-396` 的 `requestAnchor()`（异步 putMeta + `anchorQueued` 合并）
 *     遇到 SIGKILL 时的磁盘状态：落盘的只有最早那份 `total_enqueued`（= 1 批 = 10 个事件）。
 *
 * ## 用法 / 变异
 *
 *   node tests/e2e/lib/d004-anchor-window.mjs                                  # 护栏生效 → 全绿
 *   D004_CAPTURE_GUARD=off node tests/e2e/lib/d004-anchor-window.mjs           # 关掉护栏 → 必须红
 *   node tests/e2e/lib/d004-anchor-window.mjs --dump                           # 附：对真实 d004 JSON 逐格分类
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../../../packages/transport/dist/index.js';
import {
  ROUND_VERDICT,
  GATE_VERDICT,
  assertNoBlankAsZeroLoss,
  classifyRound,
  deriveGateVerdict,
  guardEnabled,
  judgeCaptureRounds,
  renderRounds,
} from './d004-capture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

// ---------------------------------------------------------------- 极简测试运行器

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error: error instanceof Error ? error.message : String(error) });
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error: error instanceof Error ? error.message : String(error) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertEq(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}：期望 ${String(expected)}，实际 ${String(actual)}`);
  }
}

// ---------------------------------------------------------------- 注入式后端（在途锚点）

function createDisk() {
  return { meta: new Map(), records: new Map(), summaries: new Map() };
}

function summaryOf(record) {
  return {
    batch_id: record.batch_id,
    format_version: record.format_version,
    enqueued_at: record.enqueued_at,
    has_critical: record.has_critical,
    event_count: record.event_count,
    critical_count: record.critical_count,
    bytes: record.bytes,
    attempt_count: record.attempt_count,
    last_attempt_at: record.last_attempt_at,
  };
}

/**
 * 共享同一份「磁盘」的后端。时序开关：
 *   - `deferFirstAnchor`：连第一份 **intent 锚点**也不落盘（→ 完全空白）；
 *   - `deferLaterAnchors`：后续 intent 锚点**永久在途**（模拟锚点事务未 oncomplete 就被 SIGKILL）;
 *   - `deferCommit`：数据事务永久在途（`oncomplete` 未返回）。
 *
 * 注意：**只延迟 `intent:` 前缀的 meta**。`loadState()` 会先写格式 meta
 * （`offline-store.ts:545`），把它一起延迟会让 `ready()` 挂死 —— 那测的就不是锚点窗口了。
 */
function createTimedBackend(disk, options = {}) {
  const deferFirstAnchor = options.deferFirstAnchor ?? false;
  const deferLaterAnchors = options.deferLaterAnchors ?? true;
  const deferCommit = options.deferCommit ?? false;
  let putMetaCalls = 0;
  const inFlight = [];
  return {
    open: async () => 'ok',
    reset: async () => {
      disk.meta.clear();
      disk.records.clear();
      disk.summaries.clear();
    },
    commit: async (records, metas) => {
      if (deferCommit) return await new Promise(() => {}); // 在途：oncomplete 永不返回
      for (const record of records) {
        disk.records.set(record.batch_id, record);
        disk.summaries.set(record.batch_id, summaryOf(record));
      }
      for (const meta of metas ?? []) disk.meta.set(meta.key, meta);
    },
    putSummaries: async (list) => {
      for (const summary of list) disk.summaries.set(summary.batch_id, summary);
    },
    readSummaries: async (limit) => [...disk.summaries.values()].slice(0, limit),
    read: async (batchId) => disk.records.get(batchId) ?? null,
    remove: async (batchIds) => {
      for (const batchId of batchIds) {
        disk.records.delete(batchId);
        disk.summaries.delete(batchId);
      }
    },
    clear: async () => {
      disk.records.clear();
      disk.summaries.clear();
      disk.meta.clear();
    },
    putMeta: (entry) => {
      const isIntent = entry.key.startsWith('intent:');
      if (isIntent) putMetaCalls += 1;
      const defer = isIntent && (putMetaCalls === 1 ? deferFirstAnchor : deferLaterAnchors);
      if (defer) {
        inFlight.push(JSON.parse(entry.value)); // 在途：SIGKILL 时没落盘
        return new Promise(() => {});
      }
      disk.meta.set(entry.key, entry);
      return Promise.resolve();
    },
    readMeta: async (key) => disk.meta.get(key) ?? null,
    listMeta: async (prefix) => [...disk.meta.values()].filter((entry) => entry.key.startsWith(prefix)),
    deleteMeta: async (keys) => {
      for (const key of keys) disk.meta.delete(key);
    },
    close: () => {},
    intentAnchors: () => putMetaCalls,
    inFlight: () => inFlight.map((value) => ({ ...value })),
  };
}

const LIMITS = Object.freeze({
  maxEvents: 50_000,
  maxBatches: 50_000,
  maxBytes: 500 * 1024 * 1024,
  commitBatchSize: 100,
  commitIntervalMs: 1_000_000_000,
});

function makeBatch(sessionId, index, eventsPerBatch = 10) {
  const events = [];
  for (let j = 0; j < eventsPerBatch; j += 1) {
    events.push({
      event_id: `anchor-${index}-${j}`,
      event_name: 'e2e_d004_probe',
      event_type: 'performance',
      schema_version: 1,
      occurred_at: 1_700_000_000_000 + index,
      priority: 'critical',
    });
  }
  return {
    protocol_version: 1,
    app_id: 'e2e-anchor',
    env: 'e2e',
    release: 'e2e',
    sdk_name: '@web-report-sdk/browser',
    sdk_version: '0.0.0',
    device_id: 'e2e-device',
    session_id: sessionId,
    clock_offset: 0,
    consent: 'granted',
    batch_id: `anchor-batch-${index}`,
    sent_at: 1_700_000_000_000 + index,
    common: { url: 'http://127.0.0.1/probes/durability.html' },
    events,
  };
}

function runnerShapedCell({ name, group = 'unsettled', expectedEvents, survivors, commitLost, partiallyReadable = 0, unexpectedEvents = 0 }) {
  return {
    name,
    group,
    expectedEvents,
    survived: {
      events: survivors,
      missingEvents: expectedEvents - survivors,
      partiallyReadable,
      unexpectedEvents,
    },
    d004: { uncommittedFromIntent: commitLost },
  };
}

async function countReadable(store) {
  const list = await store.list(100_000);
  const batchIds = new Set();
  let events = 0;
  for (const summary of list) {
    const batch = await store.read(summary.batch_id);
    if (batch === null) continue;
    batchIds.add(summary.batch_id);
    events += batch.events.length;
  }
  return { batches: batchIds.size, events };
}

/**
 * 一次「硬杀 + 同盘重启」：确定性复现残余窗口。
 * @returns {{disk: object, persisted: object[], inFlight: object[], survivors: number, commitLoss: object, cell: object}}
 */
async function hardKillAndReopen({ label, batches = 100, eventsPerBatch = 10, ...backendOptions }) {
  const disk = createDisk();
  const backendA = createTimedBackend(disk, backendOptions);
  let clockA = 1_000_000;
  const storeA = T.createOfflineStore({
    appId: 'e2e-anchor',
    sessionId: `${label}-first`,
    backend: backendA,
    now: () => clockA,
    limits: LIMITS,
  });
  await storeA.ready();
  let issued = 0;
  for (let i = 0; i < batches; i += 1) {
    storeA.prewrite(makeBatch(`${label}-first`, i, eventsPerBatch));
    issued += eventsPerBatch;
  }
  // 让「第一份锚点落盘」「flush 发起（其锚点/提交在途）」这段异步时序真的走一步，
  // 但**不** release 任何在途写入 —— 这就是 SIGKILL 落点。
  await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
  if (backendOptions.awaitDrain === true) {
    // 唯一需要真正落盘的对照（0 丢失）：等在途提交全部有结论。
    await storeA.drain();
  }
  clockA += 100;
  const persisted = [...disk.meta.values()]
    .filter((entry) => entry.key.startsWith('intent:'))
    .map((entry) => JSON.parse(entry.value));
  const inFlight = backendA.inFlight();
  // 不 dispose（那会触发优雅路径）；直接丢弃 storeA —— 在途 promise 随之永不落盘。
  const backendB = createTimedBackend(disk, { deferFirstAnchor: false, deferLaterAnchors: false, deferCommit: false });
  const clockB = clockA + 5_000;
  const storeB = T.createOfflineStore({
    appId: 'e2e-anchor',
    sessionId: `${label}-second`,
    backend: backendB,
    now: () => clockB,
    deadSessionMs: 0, // 强制把上一个会话判死并对账
    limits: LIMITS,
  });
  await storeB.ready();
  const readable = await countReadable(storeB);
  const commitLoss = storeB.commitLoss();
  const expectedEvents = batches * eventsPerBatch;
  const cell = runnerShapedCell({
    name: label,
    expectedEvents,
    survivors: readable.events,
    commitLost: commitLoss.events,
  });
  return { disk, persisted, inFlight, issued, survivors: readable.events, commitLoss, cell, expectedEvents };
}

// ---------------------------------------------------------------- 1. 残余窗口的确定性复现

const residual = await hardKillAndReopen({ label: 'residual', deferFirstAnchor: false, deferLaterAnchors: true, deferCommit: true });
const blank = await hardKillAndReopen({ label: 'blank', deferFirstAnchor: true, deferLaterAnchors: true, deferCommit: true });
const zeroLoss = await hardKillAndReopen({ label: 'zero-loss', deferFirstAnchor: false, deferLaterAnchors: false, deferCommit: false, awaitDrain: true });

await testAsync('复现①：锚点在途时，落盘的只有最早那份计数（10，而事件已产生 1000）', async () => {
  assertEq(residual.issued, 1000, 'prewrite 受理的事件数');
  assertEq(residual.persisted.length, 1, '落盘的 intent 条数');
  assertEq(residual.persisted[0].total_enqueued, 10, '落盘的 total_enqueued（= 第 1 批 × 10 事件）');
  assertEq(residual.persisted[0].total_committed, 0, '落盘的 total_committed');
  assert(residual.inFlight.length >= 1, `应有在途（未落盘）锚点，实际 ${residual.inFlight.length}`);
  assert(
    residual.inFlight.some((state) => state.total_enqueued === 1000),
    `在途锚点里应能看到 1000 的账目，实际 ${JSON.stringify(residual.inFlight)}`,
  );
});

await testAsync('复现②：重启对账读到的是偏小的计数（10），且没有数据丢失（存活 0、无半落盘）', async () => {
  assertEq(residual.commitLoss.events, 10, '重启后 prewrite_commit_lost 计数');
  assertEq(residual.survivors, 0, '读回的事件数');
  assertEq(residual.disk.records.size, 0, '磁盘上的记录数（数据事务在途、未落盘）');
});

await testAsync('复现③：护栏把这一轮判为「窗口已捕获但计数偏小」，而不是「空白」也不是「0 丢失」', async () => {
  const round = classifyRound(residual.cell, { round: 0 });
  assertEq(round.verdict, ROUND_VERDICT.UNDERCOUNTED, '轮次判定');
  assertEq(round.windowCaptured, true, 'windowCaptured');
  assertEq(round.reconciles, false, 'reconciles');
  assertEq(round.complete, false, 'complete');
  assertEq(round.unaccountedEvents, 990, '未被单独计数的事件数');
  assertEq(round.zeroLoss, false, 'zeroLoss');
  assertEq(round.lostEvents, null, 'lostEvents（计数不可信 → null）');
  assertEq(round.lostEventsLowerBound, 1000, '至少未读回的事件数');
  assertEq(round.blank, false, 'blank');
});

await testAsync('复现④：连第一份锚点都没落 → 「窗口未捕获（空白）」，≠0 丢失', async () => {
  assertEq(blank.persisted.length, 0, '落盘的 intent 条数');
  assertEq(blank.commitLoss.events, 0, '重启后 prewrite_commit_lost 计数');
  assertEq(blank.survivors, 0, '读回的事件数');
  const round = classifyRound(blank.cell, { round: 0 });
  assertEq(round.verdict, ROUND_VERDICT.BLANK, '轮次判定');
  assertEq(round.blank, true, 'blank');
  assertEq(round.zeroLoss, false, 'zeroLoss（空白不是 0 丢失）');
  assertEq(round.lostEvents, null, 'lostEvents（无计数证据 → null，不是 0）');
  assertEq(round.lostEventsLowerBound, 1000, '至少未读回的事件数');
  assertEq(round.blankIsNotZeroLoss, true, 'blankIsNotZeroLoss');
});

await testAsync('复现⑤：唯一算「0 丢失」的是「杀在提交之后、全部读回」', async () => {
  assertEq(zeroLoss.survivors, 1000, '读回的事件数');
  assertEq(zeroLoss.commitLoss.events, 0, 'prewrite_commit_lost 计数');
  const round = classifyRound(zeroLoss.cell, { round: 0 });
  assertEq(round.verdict, ROUND_VERDICT.WINDOW_MISSED, '轮次判定');
  assertEq(round.zeroLoss, true, 'zeroLoss');
  assertEq(round.lostEvents, 0, 'lostEvents');
  assertEq(round.lostEventsLowerBound, 0, '未读回的事件数');
});

await testAsync('复现⑥：「空白」与「0 丢失」在输出里结构上不可混淆（null vs 0，且 zeroLoss 相反）', async () => {
  const blankRound = classifyRound(blank.cell, { round: 0 });
  const zeroRound = classifyRound(zeroLoss.cell, { round: 0 });
  assert(blankRound.lostEvents === null && zeroRound.lostEvents === 0, 'lostEvents 必须是 null vs 0');
  assertEq(blankRound.zeroLoss, false, '空白格 zeroLoss');
  assertEq(zeroRound.zeroLoss, true, '零丢失格 zeroLoss');
  assert(blankRound.lostEventsLowerBound > 0, '空白格的「至少未读回」必须 > 0');
  assert(
    renderRounds([blankRound]).includes('≠0 丢失'),
    `空白格的渲染必须显式写出「≠0 丢失」，实际：${renderRounds([blankRound])}`,
  );
  assert(
    !renderRounds([zeroRound]).includes('≠0 丢失'),
    `零丢失格的渲染不应出现「≠0 丢失」，实际：${renderRounds([zeroRound])}`,
  );
});

// ---------------------------------------------------------------- 2. T29 尾部实测向量的分类（判据对齐真实数据）

/** 出处：`docs/reports/e2e-real-browser.md` 追加节（T29 尾部）§1 的 D004 逐格表。 */
const T29_WEBKIT_VECTORS = Object.freeze([
  { name: 'durable', group: 'oncomplete', expectedEvents: 1000, survivors: 1000, commitLost: 0, expect: ROUND_VERDICT.WINDOW_MISSED },
  { name: 'pending-d0', group: 'unsettled', expectedEvents: 1000, survivors: 0, commitLost: 10, expect: ROUND_VERDICT.UNDERCOUNTED },
  { name: 'pending-d5', group: 'unsettled', expectedEvents: 1000, survivors: 0, commitLost: 1000, expect: ROUND_VERDICT.COMPLETE },
  { name: 'bulk-d0', group: 'unsettled', expectedEvents: 5000, survivors: 0, commitLost: 5000, expect: ROUND_VERDICT.COMPLETE },
  { name: 'preflush-d0', group: 'preflush', expectedEvents: 1000, survivors: 0, commitLost: 1000, expect: ROUND_VERDICT.COMPLETE },
  { name: 'preflush-small', group: 'preflush', expectedEvents: 100, survivors: 0, commitLost: 0, expect: ROUND_VERDICT.BLANK },
]);

test('T29 向量：逐格分类与 T29 尾部报告里的人工读法一致（含 3 个「空白」格）', () => {
  for (const vector of T29_WEBKIT_VECTORS) {
    const cell = runnerShapedCell(vector);
    const round = classifyRound(cell, { round: 0 });
    assertEq(round.verdict, vector.expect, `格 ${vector.name} 的判定`);
  }
});

test('T29 向量：T32 点名的 3 格，空白/欠计数一律不得读成 0 丢失', () => {
  const rounds = T29_WEBKIT_VECTORS.filter((v) => ['pending-d0', 'preflush-d0', 'preflush-small'].includes(v.name)).map(
    (v) => classifyRound(runnerShapedCell(v), { round: 0 }),
  );
  assertNoBlankAsZeroLoss(rounds);
  const pending = rounds.find((r) => r.name === 'pending-d0');
  assertEq(pending.lostEvents, null, 'pending-d0（计数 10）的 lostEvents');
  const small = rounds.find((r) => r.name === 'preflush-small');
  assertEq(small.zeroLoss, false, 'preflush-small（空白）的 zeroLoss');
});

// ---------------------------------------------------------------- 3. 「连续 N 轮完整」的判定

function rounds(...kinds) {
  return kinds.map((kind, index) => {
    const base = { name: 'pending-d0', group: 'unsettled', expectedEvents: 1000 };
    if (kind === 'complete') return classifyRound(runnerShapedCell({ ...base, survivors: 0, commitLost: 1000 }), { round: index });
    if (kind === 'undercounted') return classifyRound(runnerShapedCell({ ...base, survivors: 0, commitLost: 10 }), { round: index });
    if (kind === 'blank') return classifyRound(runnerShapedCell({ ...base, survivors: 0, commitLost: 0 }), { round: index });
    if (kind === 'missed') return classifyRound(runnerShapedCell({ ...base, survivors: 1000, commitLost: 0 }), { round: index });
    if (kind === 'torn') return classifyRound(runnerShapedCell({ ...base, survivors: 1000, commitLost: 0, partiallyReadable: 1 }), { round: index });
    throw new Error(`未知轮次类型 ${kind}`);
  });
}

test('N 轮：连续 3 轮完整 → stable-complete', () => {
  const gate = judgeCaptureRounds('pending-d0', rounds('complete', 'complete', 'complete'));
  assertEq(gate.verdict, GATE_VERDICT.STABLE, '最终判定');
  assertEq(gate.bestStreak, 3, '最长连续完整轮数');
  assertEq(gate.discardedRounds, 0, '被丢弃的轮数');
  assertEq(gate.guard, 'on', '护栏状态');
});

test('N 轮：单轮不完整不判失败（抖动轮记在案，后接 3 连续完整 → complete-with-jitter）', () => {
  const gate = judgeCaptureRounds('pending-d0', rounds('complete', 'blank', 'complete', 'complete', 'complete'));
  assertEq(gate.verdict, GATE_VERDICT.JITTER, '最终判定');
  assertEq(gate.bestStreak, 3, '最长连续完整轮数');
  assertEq(gate.discardedRounds, 1, '被丢弃的轮数');
  assertEq(gate.classes[ROUND_VERDICT.BLANK], 1, '空白轮数');
  assert(Math.abs(gate.jitterRate - 0.2) < 1e-9, `抖动率应为 0.2，实际 ${gate.jitterRate}`);
  // ★ 交给既有 D004-A/B/C 的必须是**完整**那一轮，不能是空白轮
  assertEq(gate.rounds[gate.selectedRoundIndex].verdict, ROUND_VERDICT.COMPLETE, '选定轮的判定');
});

test('N 轮：M 轮内始终凑不出连续 3 轮完整 → never-complete（不是抖动，是系统性）', () => {
  const gate = judgeCaptureRounds('pending-d0', rounds('complete', 'complete', 'blank', 'blank', 'blank', 'blank'));
  assertEq(gate.verdict, GATE_VERDICT.NEVER_COMPLETE, '最终判定');
  assertEq(gate.bestStreak, 2, '最长连续完整轮数');
});

test('N 轮：全空白 → blank-only（不得读作 0 丢失）；从未捕获 → window-never-captured', () => {
  const onlyBlank = judgeCaptureRounds('preflush-small', rounds('blank', 'blank', 'blank'));
  assertEq(onlyBlank.verdict, GATE_VERDICT.BLANK_ONLY, '全空白判定');
  assertEq(onlyBlank.classes[ROUND_VERDICT.BLANK], 3, '空白轮数');
  const never = judgeCaptureRounds('pending-d0', rounds('missed', 'missed'));
  assertEq(never.verdict, GATE_VERDICT.NEVER_CAPTURED, '从未捕获判定');
});

test('N 轮：判定可由逐轮结果独立重算（spec 侧的自洽性检查用同一实现）', () => {
  const sequences = [
    ['complete', 'complete', 'complete'],
    ['complete', 'blank', 'complete', 'complete', 'complete'],
    ['complete', 'complete', 'blank', 'blank'],
    ['blank', 'blank'],
    ['missed', 'missed'],
    ['undercounted', 'undercounted', 'undercounted'],
  ];
  for (const kinds of sequences) {
    const list = rounds(...kinds);
    const gate = judgeCaptureRounds('pending-d0', list, { requiredStreak: 3 });
    assertEq(
      gate.verdict,
      deriveGateVerdict(list, { gated: true, requiredStreak: 3 }),
      `序列 [${kinds.join(',')}] 的重算判定`,
    );
  }
});

test('N 轮：非捕获格只报分类，不参与连续 N 轮判定', () => {
  const gate = judgeCaptureRounds('pending-d200', rounds('missed', 'missed'), { gated: false });
  assertEq(gate.verdict, GATE_VERDICT.NOT_GATED, '非捕获格判定');
});

test('不变量：把空白轮伪造成 0 丢失会被 assertNoBlankAsZeroLoss 抓住', () => {
  const blankRound = rounds('blank')[0];
  assertNoBlankAsZeroLoss([blankRound]); // 正常情况不抛
  const forged = { ...blankRound, zeroLoss: true, lostEvents: 0, blankIsNotZeroLoss: false };
  let threw = false;
  try {
    assertNoBlankAsZeroLoss([forged]);
  } catch {
    threw = true;
  }
  assert(threw, '伪造的「空白=0 丢失」必须抛错');
});

// ---------------------------------------------------------------- 4. 真实产物（只读、信息性）

function dumpRealArtifacts() {
  const out = [];
  for (const browser of ['chromium', 'webkit']) {
    const file = path.join(REPO, 'tests/e2e/results', `d004-${browser}.json`);
    if (!fs.existsSync(file)) {
      out.push(`${browser}: 无产物（${path.relative(REPO, file)}）`);
      continue;
    }
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    out.push(`${browser}: ${json.generatedAt} sha256=${json.transport.sha256}`);
    for (const cell of json.cells) {
      const round = classifyRound(cell, { round: 0 });
      out.push(
        `  ${cell.name.padEnd(14)} 存活 ${String(round.survivors).padStart(5)}/${round.expectedEvents} ` +
          `计数 ${String(round.commitLost).padStart(5)} → ${round.verdict}` +
          `${round.blank ? '（空白：≠0 丢失，至少未读回 ' + round.lostEventsLowerBound + '）' : ''}`,
      );
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- 汇总

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok) console.log(`ok   - ${r.name}`);
  else console.log(`FAIL - ${r.name}\n       ${r.error}`);
}
console.log(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'} ${results.length - failed.length}/${results.length}` +
    `（护栏 ${guardEnabled() ? '生效' : '已关闭（D004_CAPTURE_GUARD=off，变异体）'}）`,
);
if (process.argv.includes('--dump')) {
  console.log('\n--- 真实 d004 产物逐格分类（只读、不断言）---');
  console.log(dumpRealArtifacts());
}
console.log('\n被判定为空白/欠计数的轮（应为 0 个「可读成 0 丢失」）：');
console.log(renderRounds([classifyRound(blank.cell, { round: 0 }), classifyRound(residual.cell, { round: 0 })]));
process.exit(failed.length === 0 ? 0 : 1);
