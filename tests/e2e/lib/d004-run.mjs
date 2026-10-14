/**
 * T29 / D004 核心承诺复测：**硬杀下 IndexedDB `oncomplete` 是唯一落盘点**。
 *
 * 做法（每个格子）：
 *   1. 全新 profile 启动 → 打开**真实实现**（`packages/transport/dist` 的 `createOfflineStore`）；
 *   2. 同步预写 N=100 批 × 10 事件 = 1000 事件（`prewrite` 返回即「事件已产生」）；
 *   3a. 「已 oncomplete」组：等所有 `settled` 解析（只有在事务 `oncomplete` 后才解析）→ 真 SIGKILL；
 *   3b. 「未 oncomplete」组（对照组）：不等 `settled`，延迟 Δt 后真 SIGKILL；
 *   4. 同一 profile 重启（新 sessionId + `deadSessionMs: 0` 强制对账）→ `list()`/`read()` 读回，
 *      统计存活批次/事件，并读 `commitLoss()` 拿到「已发起预写但未提交」的事件数。
 *
 * 两组**分开报**：D004 说的是「已 oncomplete 的不丢；窗口内未提交的单独计量」。
 * 任何与 D004 不符的结果如实写进 JSON，不修实现。
 *
 * 用法：node tests/e2e/lib/d004-run.mjs --browser chromium [--out <file>] [--cells durable,0,5]
 */
import fs from 'node:fs';
import nodeCrypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser } from './browsers.mjs';
import { startStaticServer } from './static-server.mjs';
import {
  browserPids,
  closeQuietly,
  freshProfile,
  hardKill,
  killMatching,
  launchPersistent,
  makeRunDir,
  openProbe,
  profilePids,
  sleep,
  writeJson,
} from './harness.mjs';

/** 只清理本 profile 的残留进程（并行 worker 安全）。 */
function cleanProfile(profileDir, log) {
  return killMatching(profilePids(profileDir), log);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const DEFAULT_CELLS = [
  { name: 'durable', group: 'oncomplete', delayMs: null, awaitSettled: true },
  { name: 'pending-d0', group: 'unsettled', delayMs: 0, awaitSettled: false },
  { name: 'pending-d5', group: 'unsettled', delayMs: 5, awaitSettled: false },
  { name: 'pending-d20', group: 'unsettled', delayMs: 20, awaitSettled: false },
  { name: 'pending-d60', group: 'unsettled', delayMs: 60, awaitSettled: false },
  { name: 'pending-d200', group: 'unsettled', delayMs: 200, awaitSettled: false },
  // 大 payload（每事件 ~16 KB、500 批 × 10 事件 ≈ 82 MB，并放宽淘汰上限避免被 enforceLimits 驱逐）
  // → 提交无法在 kill 往返内完成，用来在三个引擎上都**可靠地**构造出
  // 「事务在途、oncomplete 未返回」的硬杀（本会话实测过 4 KB/21 MB 在 WebKit 上不够稳）。
  {
    name: 'bulk-d0',
    group: 'unsettled',
    delayMs: 10,
    awaitSettled: false,
    count: 500,
    padBytes: 16384,
    limits: { maxEvents: 50_000, maxBatches: 50_000, maxBytes: 500 * 1024 * 1024, commitBatchSize: 10 },
  },
  // flush 生效前硬杀：提交节流窗口被人为放大到 1000 s，事务根本没发起（intent 也没落）。
  // 用来验证「暴露窗口内的事件必须单独计数并上报」这一条在实现里成立与否。
  {
    name: 'preflush-d0',
    group: 'preflush',
    delayMs: 0,
    awaitSettled: false,
    limits: { commitBatchSize: 1_000_000_000, commitIntervalMs: 1_000_000_000 },
  },
  // 同一现象在**默认配置**下的最小复现：10 批 < commitBatchSize(100)，
  // 所以 flush 要等 200 ms 定时器；在此之前硬杀 → 事务从未发起。
  { name: 'preflush-small', group: 'preflush', delayMs: 0, awaitSettled: false, count: 10 },
];

function buildInfo() {
  const file = path.join(REPO_ROOT, 'packages/transport/dist/index.js');
  const buf = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return {
    path: path.relative(REPO_ROOT, file),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    sha256: nodeCrypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    note: '被复测的真实实现（单包 build 产物，源码 packages/transport/src/offline/**）',
  };
}

function parseArgs(argv) {
  const args = { browser: 'chromium', out: null, cells: null, count: 100, eventsPerBatch: 10, bulkPad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--browser') args.browser = value;
    else if (key === '--out') args.out = value;
    else if (key === '--cells') args.cells = value.split(',');
    else if (key === '--count') args.count = Number(value);
    else if (key === '--events-per-batch') args.eventsPerBatch = Number(value);
    else if (key === '--bulk-pad') args.bulkPad = Number(value);
  }
  return args;
}

function expectedIds(prefix, count, eventsPerBatch) {
  const ids = new Set();
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < eventsPerBatch; j += 1) ids.add(`${prefix}-${i}-${j}`);
  }
  return ids;
}

/** 跑一个格子（含一次硬杀 + 一次重启读回）。 */
async function runCell({ info, server, runDir, cell, appId, count, eventsPerBatch, log }) {
  const cellCount = cell.count ?? count;
  const dbName = `e2e-d004-${cell.name}`;
  const prefix = `${cell.name}`;
  const expected = expectedIds(prefix, cellCount, eventsPerBatch);
  const profileDir = freshProfile(runDir, `profile-${cell.name}`);
  const result = {
    name: cell.name,
    group: cell.group,
    scheduledDelayMs: cell.delayMs,
    awaitSettled: cell.awaitSettled,
    count: cellCount,
    eventsPerBatch,
    padBytes: cell.padBytes ?? 0,
    limits: cell.limits ?? null,
    expectedEvents: expected.size,
    dbName,
    profile: path.relative(runDir, profileDir) || profileDir,
  };

  // --- 第一次启动：预写 ---
  const pidsBefore = browserPids(info.executablePath);
  let context = await launchPersistent(info, profileDir);
  // 启动后立刻记下本 profile 的 PID：强杀时不走 pgrep，延迟最低（并行负载下必需）。
  const launchPids = profilePids(profileDir);
  let page = await openProbe(context, `${server.url}/probes/durability.html`);
  result.open = await page.evaluate((cfg) => globalThis.window.__d004.open(cfg), {
    appId,
    sessionId: `${cell.name}-first`,
    dbName,
    ...(cell.limits === undefined ? {} : { limits: cell.limits }),
  });
  result.issue = await page.evaluate((cfg) => globalThis.window.__d004.issue(cfg), {
    appId,
    count: cellCount,
    eventsPerBatch,
    prefix,
    sessionId: `${cell.name}-first`,
    priority: 'critical',
    ...(cell.padBytes === undefined ? {} : { padBytes: cell.padBytes }),
  });
  if (result.issue.issued !== cellCount) {
    throw new Error(`${cell.name}: prewrite 受理数 ${result.issue.issued} ≠ ${cellCount}`);
  }
  const afterIssueAt = Date.now();

  if (cell.awaitSettled) {
    result.settle = await page.evaluate((ms) => globalThis.window.__d004.awaitSettled(ms), 30_000);
    if (result.settle.total !== cellCount) {
      throw new Error(`${cell.name}: settled 数 ${result.settle.total} ≠ ${cellCount}`);
    }
  } else if (cell.delayMs > 0) {
    await sleep(cell.delayMs);
  }

  // --- 真杀 ---
  result.kill = await hardKill(context, info, { pidsBefore, userDataDir: profileDir, targetPids: launchPids });
  result.measuredMsAfterIssue = result.kill.killAt - afterIssueAt;
  result.processExited = profilePids(profileDir).length === 0;
  cleanProfile(profileDir, log);
  await closeQuietly(context);

  // --- 同一 profile 重启：读回 ---
  const pidsBefore2 = browserPids(info.executablePath);
  context = await launchPersistent(info, profileDir);
  page = await openProbe(context, `${server.url}/probes/durability.html`);
  // 先不经过 SDK 数一遍磁盘上的现场（判定半落盘是存储层还是 SDK 索引/淘汰造成的）
  result.rawDumpBeforeOpen = await page.evaluate((name) => globalThis.window.__d004.rawDump(name), dbName);
  result.reopen = await page.evaluate((cfg) => globalThis.window.__d004.open(cfg), {
    appId,
    sessionId: `${cell.name}-second`,
    dbName,
    deadSessionMs: 0, // 强制把上一个会话判死并对账，暴露窗口才可观测
    // **必须与第一次打开用同一组上限**：否则重启会用默认 maxBytes=5 MB 去淘汰大 load 的记录，
    // 把「被 SDK 主动淘汰」误判成「硬杀丢了」（本会话踩过一次，靠 rawDump 才定位）。
    ...(cell.limits === undefined ? {} : { limits: cell.limits }),
  });
  const inventory = await page.evaluate((limit) => globalThis.window.__d004.inventory(limit), 100_000);
  result.inventoryCounts = { indexed: inventory.count };
  result.reopenStats = inventory.stats;
  result.reopenCommitLoss = inventory.commitLoss;
  /** 测量有效性：重启时若 SDK 主动淘汰过记录，存活数就不能用来判断硬杀落盘。 */
  result.evictedOnReopen = (inventory.stats.evictedBatches ?? 0) > 0;

  const survivedIds = new Set();
  const readableBatchIds = new Set();
  let partiallyReadable = 0;
  for (const record of inventory.records) {
    if (!record.readable) continue;
    readableBatchIds.add(record.batchId);
    for (const id of record.eventIds ?? []) survivedIds.add(id);
    if ((record.eventIds ?? []).length !== record.eventCount) partiallyReadable += 1;
  }
  const missing = [...expected].filter((id) => !survivedIds.has(id));
  const duplicated = survivedIds.size - [...survivedIds].filter((id) => expected.has(id)).length;
  result.expectedBatchIds = cellCount;
  result.survived = {
    batches: readableBatchIds.size,
    events: survivedIds.size,
    missingEvents: missing.length,
    missingIdsSample: missing.slice(0, 5),
    unexpectedEvents: duplicated,
    partiallyReadable,
    rate: expected.size === 0 ? null : survivedIds.size / expected.size,
  };
  result.d004 = {
    oncompleteSurvivors: cell.group === 'oncomplete' ? readableBatchIds.size : null,
    uncommittedFromIntent: inventory.commitLoss.events,
    commitLostWindowMs: inventory.commitLoss.windowMs,
  };
  result.exposureReconciles =
    survivedIds.size + inventory.commitLoss.events === expected.size
      ? true
      : { survivors: survivedIds.size, commitLost: inventory.commitLoss.events, expected: expected.size };
  /**
   * 「窗口是否真的被捕获」的判据：硬杀时刻事务**尚未全部提交**。
   * 只有 commitLost > 0（intent 显示有已发起未提交的事件）才证明 kill 落在暴露窗口内；
   * 存活 < 期望但 commitLost = 0 说明是 flush 从未发起（连 intent 都没落），另算一类。
   */
  result.windowCaptured = inventory.commitLoss.events > 0;
  result.nothingCommitted = survivedIds.size === 0 && inventory.commitLoss.events === 0;
  if (result.evictedOnReopen) {
    throw new Error(
      `${cell.name}: 重启打开时 SDK 淘汰了 ${inventory.stats.evictedBatches} 个批次（reopen 上限与首次打开不一致）——` +
        '本次落盘测量无效，必须先对齐 limits 再跑。',
    );
  }

  cleanProfile(profileDir, log);
  await closeQuietly(context);
  void pidsBefore2;
  log(
    `  格 ${cell.name}: 存活事件 ${survivedIds.size}/${expected.size}，` +
      `intent 未提交 ${inventory.commitLoss.events}（窗口捕获=${result.windowCaptured}），kill=${result.kill.mode}`,
  );
  return result;
}

export async function runD004({ browser = 'chromium', cells = null, count = 100, eventsPerBatch = 10, bulkPad = null, out = null, log = console.log } = {}) {
  const info = await resolveBrowser(browser);
  const transport = buildInfo();
  const runDir = makeRunDir(`d004-${browser}`);
  const server = await startStaticServer({
    repoRoot: REPO_ROOT,
    mounts: [
      ['/transport', 'packages/transport/dist'],
      ['/probes', 'tests/e2e/probes'],
    ],
  });
  log(`D004 复测：browser=${browser} driver=${info.driverId} exe=${info.executablePath}`);
  log(`  被测实现 ${transport.path} sha256=${transport.sha256} mtime=${transport.mtime}`);
  log(`  静态页 ${server.url}`);

  const selected = DEFAULT_CELLS.filter((cell) => cells === null || cells.includes(cell.name)).map((cell) =>
    bulkPad !== null && cell.name === 'bulk-d0' ? { ...cell, padBytes: bulkPad } : cell,
  );
  const appId = 'e2e-d004';
  const results = [];
  try {
    for (const cell of selected) {
      let outcome = await runCell({ info, server, runDir, cell, appId, count, eventsPerBatch, log });
      // 并行负载下 pgrep/往返延迟可能让事务先提交完，窗口没被捕获 → 加大负载重试（确定性优先）。
      if (cell.name === 'bulk-d0' && !outcome.windowCaptured) {
        for (let attempt = 2; attempt <= 3 && !outcome.windowCaptured; attempt += 1) {
          const bigger = { ...cell, padBytes: (cell.padBytes ?? 16384) * attempt, delayMs: 0 };
          log(`  格 bulk-d0 未捕获窗口，第 ${attempt} 次以 padBytes=${bigger.padBytes} 重试`);
          const retried = await runCell({ info, server, runDir, cell: bigger, appId, count, eventsPerBatch, log });
          retried.retryAttempt = attempt;
          outcome = retried;
        }
        outcome.attempts = outcome.retryAttempt ?? 1;
      }
      results.push(outcome);
    }
  } finally {
    await server.close();
  }

  const oncomplete = results.filter((cell) => cell.group === 'oncomplete');
  const unsettled = results.filter((cell) => cell.group === 'unsettled');
  const preflush = results.filter((cell) => cell.group === 'preflush');
  const brief = (cell) => ({
    name: cell.name,
    scheduledDelayMs: cell.scheduledDelayMs,
    measuredMsAfterIssue: cell.measuredMsAfterIssue,
    survivedEvents: cell.survived.events,
    expectedEvents: cell.expectedEvents,
    rate: cell.survived.rate,
    commitLostEvents: cell.d004.uncommittedFromIntent,
    commitLostWindowMs: cell.d004.commitLostWindowMs,
    windowCaptured: cell.windowCaptured,
    reconciles: cell.exposureReconciles,
  });
  const summary = {
    task: 'T29 / D004 硬杀落盘复测',
    generatedAt: new Date().toISOString(),
    browser,
    driver: { id: info.driverId, executablePath: info.executablePath, exactPairing: info.exactPairing },
    transport,
    serverUrl: server.url,
    profileRoot: runDir,
    cells: results,
    grouped: {
      oncomplete: oncomplete.map(brief),
      unsettled: unsettled.map(brief),
      preflush: preflush.map(brief),
    },
  };
  const target = out ?? path.join(REPO_ROOT, 'tests/e2e/results', `d004-${browser}.json`);
  writeJson(target, summary);
  log(`结果写入 ${path.relative(REPO_ROOT, target)}`);
  return summary;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runD004({ ...args });
  console.log(JSON.stringify(summary.grouped, null, 2));
}
