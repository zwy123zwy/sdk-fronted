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
  DEFAULT_MAX_ROUNDS,
  DEFAULT_REQUIRED_STREAK,
  GATED_CELLS,
  assertNoBlankAsZeroLoss,
  classifyRound,
  guardEnabled,
  judgeCaptureRounds,
} from './d004-capture.mjs';
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
  // Δt=0 的暴露窗口格：T29 尾部在这类格上实测到「锚点合并残余窗口」（计数 10，而期望 1000），
  // 因此它们参加「连续 N 轮完整」的捕获判定（`captureRequired`）。判定逻辑见 `d004-capture.mjs`。
  { name: 'pending-d0', group: 'unsettled', delayMs: 0, awaitSettled: false, captureRequired: true },
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
    captureRequired: true,
    limits: { commitBatchSize: 1_000_000_000, commitIntervalMs: 1_000_000_000 },
  },
  // 同一现象在**默认配置**下的最小复现：10 批 < commitBatchSize(100)，
  // 所以 flush 要等 200 ms 定时器；在此之前硬杀 → 事务从未发起。
  { name: 'preflush-small', group: 'preflush', delayMs: 0, awaitSettled: false, count: 10, captureRequired: true },
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
  const args = {
    browser: 'chromium',
    out: null,
    cells: null,
    count: 100,
    eventsPerBatch: 10,
    bulkPad: null,
    streak: null,
    maxRounds: null,
    gate: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--browser') args.browser = value;
    else if (key === '--out') args.out = value;
    else if (key === '--cells') args.cells = value.split(',');
    else if (key === '--count') args.count = Number(value);
    else if (key === '--events-per-batch') args.eventsPerBatch = Number(value);
    else if (key === '--bulk-pad') args.bulkPad = Number(value);
    else if (key === '--streak') args.streak = Number(value);
    else if (key === '--max-rounds') args.maxRounds = Number(value);
    else if (key === '--no-gate') args.gate = false;
  }
  return args;
}

/**
 * 捕获判定策略：`--streak` / `--max-rounds`（或同名环境变量）覆盖；
 * `--no-gate` 等价于 `--streak 1 --max-rounds 1`（只跑单轮，用于观察原始抖动）。
 */
function capturePolicy(args) {
  const env = globalThis.process?.env ?? {};
  const requiredStreak = args.streak ?? Number(env['D004_CAPTURE_STREAK'] ?? DEFAULT_REQUIRED_STREAK);
  const maxRounds = args.maxRounds ?? Number(env['D004_CAPTURE_MAX_ROUNDS'] ?? DEFAULT_MAX_ROUNDS);
  return {
    requiredStreak: Number.isFinite(requiredStreak) && requiredStreak > 0 ? requiredStreak : DEFAULT_REQUIRED_STREAK,
    maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : DEFAULT_MAX_ROUNDS,
    enabled: args.gate !== false && guardEnabled(),
    gateNames: GATED_CELLS,
  };
}

function expectedIds(prefix, count, eventsPerBatch) {
  const ids = new Set();
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < eventsPerBatch; j += 1) ids.add(`${prefix}-${i}-${j}`);
  }
  return ids;
}

/** 跑一个格子（含一次硬杀 + 一次重启读回）。`round` 用于同一格的多轮捕获判定（每轮全新 profile / 库）。 */
async function runCell({ info, server, runDir, cell, appId, count, eventsPerBatch, log, round = 0 }) {
  const cellCount = cell.count ?? count;
  const suffix = round === 0 ? '' : `-r${round}`;
  const dbName = `e2e-d004-${cell.name}${suffix}`;
  const prefix = `${cell.name}`;
  const expected = expectedIds(prefix, cellCount, eventsPerBatch);
  const profileDir = freshProfile(runDir, `profile-${cell.name}${suffix}`);
  const result = {
    name: cell.name,
    group: cell.group,
    round,
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
    `  格 ${cell.name}${suffix}: 存活事件 ${survivedIds.size}/${expected.size}，` +
      `intent 未提交 ${inventory.commitLoss.events}（窗口捕获=${result.windowCaptured}），kill=${result.kill.mode}`,
  );
  return result;
}

/**
 * 捕获格：重复 N 轮，要求**连续 `requiredStreak` 轮完整**才算捕获成立。
 *
 * - 不完整的轮**不判失败**，记为「抖动/未捕获」（`blank` / `undercounted` / `window-missed`），
 *   继续跑下一轮，最多 `maxRounds` 轮；
 * - 最终判定由 N 轮结果给出（`judgeCaptureRounds`）：`stable-complete` / `complete-with-jitter` /
 *   `never-complete` / `blank-only` / `window-never-captured`；
 * - 交给既有 D004-A/B/C 断言的是 `gate.selectedRoundIndex` 那一轮 —— **既有通过标准一个字都没动**：
 *   若本格一次完整轮都没有，交给既有断言的仍是未对账的那一轮。
 */
async function runCaptureGatedCell({ info, server, runDir, cell, appId, count, eventsPerBatch, log, policy }) {
  const cells = [];
  const rounds = [];
  let streak = 0;
  let index = 0;
  for (; index < policy.maxRounds && streak < policy.requiredStreak; index += 1) {
    const result = await runCell({ info, server, runDir, cell, appId, count, eventsPerBatch, log, round: index });
    const round = classifyRound(result, { round: index });
    // 护栏不变量：任何一轮都不得把「空白/欠计数」读成「0 丢失」。
    assertNoBlankAsZeroLoss([round]);
    cells.push(result);
    rounds.push(round);
    streak = round.complete ? streak + 1 : 0;
    if (!round.complete) {
      log(
        `  格 ${cell.name} 第 ${index + 1} 轮**不完整**（${round.verdict}）—— 记为抖动/未捕获，` +
          `连续完整 ${streak}/${policy.requiredStreak}，继续；${round.windowCaptured ? `已捕获窗口但计数 ${round.commitLost} ≠ 期望 ${round.expectedEvents}` : ''}`,
      );
    }
  }
  const gate = judgeCaptureRounds(cell.name, rounds, {
    requiredStreak: policy.requiredStreak,
    maxRounds: policy.maxRounds,
    gated: true,
  });
  const selected = cells[gate.selectedRoundIndex] ?? cells[cells.length - 1];
  selected.captureGate = gate;
  selected.captureRounds = cells.length;
  selected.captureSelectedRound = gate.selectedRoundIndex;
  log(
    `  格 ${cell.name} 捕获判定：${gate.verdict}（${gate.passed ? '通过' : '**未通过**'}；${gate.roundCount} 轮，最长连续完整 ${gate.bestStreak}/` +
      `${policy.requiredStreak}，抖动率 ${(gate.jitterRate * 100).toFixed(0)}%）；报告第 ${gate.selectedRoundIndex + 1} 轮`,
  );
  return selected;
}

export async function runD004({
  browser = 'chromium',
  cells = null,
  count = 100,
  eventsPerBatch = 10,
  bulkPad = null,
  out = null,
  log = console.log,
  streak = null,
  maxRounds = null,
  gate = null,
} = {}) {
  const info = await resolveBrowser(browser);
  const transport = buildInfo();
  const runDir = makeRunDir(`d004-${browser}`);
  const policy = capturePolicy({ streak, maxRounds, gate });
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
  log(
    `  捕获判定：${policy.enabled ? `连续 ${policy.requiredStreak} 轮完整才算捕获（最多 ${policy.maxRounds} 轮/格）` : '关闭（单轮）'}` +
      `，捕获格 ${policy.gateNames.join('/')}`,
  );

  const selected = DEFAULT_CELLS.filter((cell) => cells === null || cells.includes(cell.name)).map((cell) =>
    bulkPad !== null && cell.name === 'bulk-d0' ? { ...cell, padBytes: bulkPad } : cell,
  );
  const appId = 'e2e-d004';
  const results = [];
  const captureGates = {};
  try {
    for (const cell of selected) {
      const gated = policy.enabled && cell.captureRequired === true;
      let outcome;
      if (gated) {
        outcome = await runCaptureGatedCell({ info, server, runDir, cell, appId, count, eventsPerBatch, log, policy });
        captureGates[cell.name] = outcome.captureGate;
      } else {
        outcome = await runCell({ info, server, runDir, cell, appId, count, eventsPerBatch, log });
      }
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
      if (!gated) {
        // 非捕获格也逐格分类（用于「空白 ≠ 0 丢失」的显式上报），但不参与连续 N 轮判定。
        const round = classifyRound(outcome, { round: 0 });
        // 护栏不变量只在护栏生效时施加：`D004_CAPTURE_GUARD=off` 是**变异体**，
        // 它必须能跑完测量、让 spec 的断言变红，而不是让 runner 自己抛错（那就不叫「护栏前」了）。
        if (policy.enabled) assertNoBlankAsZeroLoss([round]);
        captureGates[cell.name] = judgeCaptureRounds(cell.name, [round], {
          requiredStreak: policy.requiredStreak,
          maxRounds: 1,
          gated: false,
        });
        outcome.captureGate = captureGates[cell.name];
        outcome.captureRounds = 1;
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
    // 捕获判定（T29 尾部的残余窗口护栏）：单轮不完整不判失败，最终判定由 N 轮结果给出。
    captureVerdict: cell.captureGate?.verdict ?? null,
    captureRounds: cell.captureRounds ?? 1,
  });
  const summary = {
    task: 'T29 / D004 硬杀落盘复测',
    generatedAt: new Date().toISOString(),
    browser,
    driver: { id: info.driverId, executablePath: info.executablePath, exactPairing: info.exactPairing },
    transport,
    serverUrl: server.url,
    profileRoot: runDir,
    capturePolicy: {
      guard: policy.enabled ? 'on' : 'off',
      requiredStreak: policy.requiredStreak,
      maxRounds: policy.maxRounds,
      gatedCells: policy.gateNames,
      note:
        '捕获格必须**连续 requiredStreak 轮完整**（windowCaptured && reconciles）才算捕获成立；' +
        '不完整的轮记为抖动/未捕获（不判失败）并继续，最多 maxRounds 轮；' +
        '空白（无计数证据）与 0 丢失在每轮判定里用 lostEvents: null vs 0 显式区分。',
    },
    captureGates,
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
  log(
    '捕获判定逐格：' +
      results.map((cell) => `${cell.name}=${cell.captureGate?.verdict ?? '—'}(${cell.captureRounds ?? 1}轮)`).join('，'),
  );
  return summary;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runD004({ ...args });
  console.log(JSON.stringify(summary.grouped, null, 2));
}
