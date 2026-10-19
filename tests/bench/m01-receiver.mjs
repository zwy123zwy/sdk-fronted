#!/usr/bin/env node
/**
 * M01 两条契约规格线的**受控基准**（此前没有家）。
 *
 * 规格线原文（`tests/acceptance/M01.md`，逐字）：
 * - 第 19 行（M01-AC-13）：`在 Vitest 中以编程方式启动、发请求、停止，重复 3 次`
 *   → `每次启动不超过 2 秒；停止后端口释放；未指定端口时自动分配空闲端口`；
 * - 第 20 行（M01-AC-14）：`本地压测 30 秒，每批 15 条事件`
 *   → `每秒处理不少于 500 个批次，无错误响应`。
 *
 * ## 口径（与原文一致，不换成更松的口径）
 *
 * 1. **启动**：原文限定「以编程方式启动」，因此口径是 **`startReceiver()` 调用 → 返回
 *    （server 已监听、可接受请求）**，**不是** `node dist/cli.js` 的进程冷启动。
 *    主判据取 3 次中的 **max**（原文是「每次启动不超过 2 秒」，不是中位数）；
 *    另记「启动后第一个批次拿到 202」的墙钟（含一次 HTTP 往返，更严，仅作证据）。
 * 2. **吞吐**：**30 秒窗口**、**每批 15 条唯一事件**（原文的批定义），
 *    4 条 keep-alive 连接（仓库既有 M01-AC-14 压测的并发，见
 *    `tools/mock-receiver/src/hosting.acceptance.test.ts`；本文件用同一个 `loadTest`）。
 *    判定量 = **成功（202）批次数 / 实际耗时**（实际耗时含窗口末尾的排空，是保守值）。
 *    同时记录非 202 与网络错误数；原文要求「无错误响应」。
 * 3. **这不是门禁**：`tests/bench/**` 不在 `pnpm gates` / `.github/workflows/ci.yml` 里
 *    （见 `tests/bench/README.md` §1）。规格线不达标**不会**让这个脚本以非零码退出
 *    （退出码只表示「测错了」：入口缺失、统计不完整、入库数对不上等）。
 *
 * ## 为什么直接加载 `src/*.ts`
 *
 * 被测对象是**当前源码**。`tools/mock-receiver/dist/` 被 `.gitignore` 忽略，本机实测比
 * `src/**` 旧；用 dist 会量到历史代码。Node 24 自带类型擦除，但不会把源码里的 `./x.js`
 * 改写成 `./x.ts`，所以这里注册一个只做这件事的小 loader（`lib/m01-source-loader.mjs`）。
 *
 * ## 运行
 *
 * ```bash
 * node tests/bench/m01-receiver.mjs                       # 30 秒窗口 + 3 次启动
 * M01_BENCH_DURATION_MS=3000 node tests/bench/m01-receiver.mjs   # 冒烟：窗口 <30 s，只记录不判规格线
 * M01_BENCH_CONNECTIONS=4 node tests/bench/m01-receiver.mjs
 * ```
 *
 * 结果写到 `tests/bench/results/m01-receiver.json`（并追加 `history.jsonl`），
 * 含机器信息、实测前后的 `loadavg`、原始样本、实测值与规格线的比值（余量）。
 */
import { register } from 'node:module';
import { cpus, loadavg, totalmem, version as osVersion } from 'node:os';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

// 必须在 import 被测源码**之前**注册：把 `./x.js` 解析到同目录的 `x.ts`。
register('./lib/m01-source-loader.mjs', import.meta.url);

const { startReceiver } = await import('../../tools/mock-receiver/src/index.ts');
const { httpRequestTo, idOf, loadTest, PLACEHOLDER_WRITE_TOKEN } = await import(
  '../../tools/mock-receiver/src/test-support.ts'
);
const { createBenchReport } = await import('./lib/report.ts');
const { summarize } = await import('./lib/stats.ts');

/** `M01.md:19`：每次启动 ≤ 2 秒。 */
const STARTUP_LIMIT_MS = 2_000;
/** `M01.md:20`：每秒 ≥ 500 个批次。 */
const THROUGHPUT_MIN_BATCHES_PER_SECOND = 500;
/** `M01.md:20`：压测窗口 30 秒。 */
const SPEC_WINDOW_MS = 30_000;
/** `M01.md:20`：每批 15 条事件。 */
const EVENTS_PER_BATCH = 15;
/** `M01-AC-13`：重复 3 次。 */
const STARTUP_ROUNDS = 3;
/** 与仓库既有 M01-AC-14 压测同口径（`hosting.acceptance.test.ts` 用并发 4）。 */
const DEFAULT_CONNECTIONS = 4;

/** 读正整数环境变量；非法值直接报错，不静默回退（否则口径会被悄悄换掉）。 */
function readPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

const WINDOW_MS = readPositiveInt('M01_BENCH_DURATION_MS', SPEC_WINDOW_MS);
const CONNECTIONS = readPositiveInt('M01_BENCH_CONNECTIONS', DEFAULT_CONNECTIONS);
const WINDOW_IS_SPEC = WINDOW_MS >= SPEC_WINDOW_MS;

/** `loadavg` 快照（两位小数）。 */
function loadavgSnapshot() {
  const [one, five, fifteen] = loadavg();
  return {
    one_minute: Number(one.toFixed(2)),
    five_minutes: Number(five.toFixed(2)),
    fifteen_minutes: Number(fifteen.toFixed(2)),
  };
}

/** 机器信息（结果 JSON 必须能回答「这台机器当时是什么状态」）。 */
function machineInfo() {
  const list = cpus();
  const first = list[0];
  return {
    cpu: (process.env['BENCH_CPU'] ?? '').trim() || first?.model || 'unknown',
    cpus: list.length,
    memory_gb: Number((totalmem() / 1024 ** 3).toFixed(1)),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    os: osVersion(),
  };
}

/** 启动用的最小合法批次（1 条事件即可证明「可接受请求」；批定义 15 条只用于吞吐）。 */
function startupBatch(appId, round) {
  return {
    protocol_version: 1,
    app_id: appId,
    env: 'staging',
    release: '1.4.0',
    sdk_name: 'web-report-sdk',
    sdk_version: '0.1.0',
    device_id: idOf(9_000 + round, 0, 0),
    session_id: idOf(9_100 + round, 0, 0),
    batch_id: idOf(9_200 + round, 0, 0),
    sent_at: 1793000000500,
    clock_offset: 0,
    events: [
      {
        event_id: idOf(9_300 + round, 0, 0),
        event_name: 'task_submit_complete',
        event_type: 'custom',
        schema_version: 2,
        occurred_at: 1793000000000,
        priority: 'normal',
        sample_rate: 1,
        dimensions: { result: 'pass' },
        metrics: { duration_ms: 12 },
      },
    ],
  };
}

/**
 * 一次启动测量：`startReceiver()` 调用 → 返回（server 就绪）→ 首个批次 202。
 * 返回值为毫秒；`readyMs` 是主判据，`firstAcceptedMs` 是「可接受请求」的实证。
 */
async function measureStartup(round) {
  const appId = `demo-app-m01-startup-${String(round + 1)}`;
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-write-token': PLACEHOLDER_WRITE_TOKEN,
  };
  const startedAt = performance.now();
  const receiver = await startReceiver({ port: 0 });
  const readyMs = performance.now() - startedAt;
  try {
    if (!receiver.listening) throw new Error(`第 ${String(round + 1)} 次启动后 listening=false`);
    if (receiver.port <= 0) throw new Error(`第 ${String(round + 1)} 次启动未分配端口（port=${String(receiver.port)}）`);
    const body = JSON.stringify(startupBatch(appId, round));
    const result = await httpRequestTo(receiver.port, '/v1/batch', {
      method: 'POST',
      headers,
      body,
      timeoutMs: 5_000,
    });
    const firstAcceptedMs = performance.now() - startedAt;
    if (result.status !== 202) {
      throw new Error(
        `第 ${String(round + 1)} 次启动后的首个批次返回 ${String(result.status)}（期望 202）：` +
          result.body.slice(0, 200),
      );
    }
    return { readyMs, firstAcceptedMs, port: receiver.port };
  } finally {
    await receiver.stop();
  }
}

const loadavgStart = loadavgSnapshot();
const machine = machineInfo();
const details = {
  startup_samples_ms: [],
  throughput: null,
};

const report = createBenchReport('m01-receiver', {
  meta: () => ({
    /** 让读结果的人不必翻 README 就知道这是受控口径、不是门禁。 */
    controlled: {
      is_gate: false,
      statement: '受控口径，不是门禁：tests/bench/** 不在 pnpm gates / CI 中；规格线不达标不会让本脚本非零退出。',
    },
    machine: machine,
    loadavg: { at_start: loadavgStart, at_end: loadavgSnapshot() },
    spec: {
      source: 'tests/acceptance/M01.md:19-20',
      startup_max_ms: STARTUP_LIMIT_MS,
      throughput_min_batches_per_second: THROUGHPUT_MIN_BATCHES_PER_SECOND,
      window_ms: SPEC_WINDOW_MS,
      events_per_batch: EVENTS_PER_BATCH,
      startup_caliber: 'startReceiver() 返回（server 就绪），不是进程冷启动',
    },
    measurement: {
      window_requested_ms: WINDOW_MS,
      window_is_spec: WINDOW_IS_SPEC,
      connections: CONNECTIONS,
      events_per_batch: EVENTS_PER_BATCH,
      startup_rounds: STARTUP_ROUNDS,
      load_generator: 'tools/mock-receiver/src/test-support.ts loadTest（与门禁内 6 秒压测同一实现）',
    },
    details: details,
  }),
});

console.log('='.repeat(100));
console.log('M01 受控基准（不是门禁）：启动 ≤ 2 s / 30 s ≥ 500 批/秒（每批 15 条）');
console.log(
  `机器：${machine.cpu} × ${String(machine.cpus)}，${String(machine.memory_gb)} GB，` +
    `${machine.platform}/${machine.arch}，node ${machine.node}`,
);
console.log(
  `负载（start）：1m=${String(loadavgStart.one_minute)} 5m=${String(loadavgStart.five_minutes)} ` +
    `15m=${String(loadavgStart.fifteen_minutes)}；窗口=${String(WINDOW_MS)} ms，连接=${String(CONNECTIONS)}`,
);
console.log('='.repeat(100));
if (!WINDOW_IS_SPEC) {
  console.warn(
    `!! 本次窗口 ${String(WINDOW_MS)} ms < 规格的 ${String(SPEC_WINDOW_MS)} ms：` +
      '吞吐行只记录、**不判定**规格线（避免用更短的窗口冒充 30 秒口径）。',
  );
}

/* ---------------------------------------------------------------- ① 启动（M01-AC-13） */

for (let round = 0; round < STARTUP_ROUNDS; round += 1) {
  const sample = await measureStartup(round);
  details.startup_samples_ms.push({
    round: round + 1,
    ready_ms: Number(sample.readyMs.toFixed(6)),
    first_accepted_ms: Number(sample.firstAcceptedMs.toFixed(6)),
    port: sample.port,
  });
}

const readyStats = summarize(details.startup_samples_ms.map((sample) => sample.ready_ms));
const firstAcceptedStats = summarize(details.startup_samples_ms.map((sample) => sample.first_accepted_ms));

report.record({
  metric: 'M01 编程式启动（startReceiver 返回 = server 就绪）',
  stat: 'max',
  value: readyStats.max,
  unit: 'ms',
  samples: readyStats.samples,
  target: STARTUP_LIMIT_MS,
  targetText: '每次启动 ≤ 2000 ms（M01-AC-13）',
  source: 'tests/acceptance/M01.md:19',
  note: `口径=server 就绪，不是进程冷启动；${String(STARTUP_ROUNDS)} 次全部 ≤ 2 s 才达标（取 max）`,
  extra: {
    p50: readyStats.p50,
    min: readyStats.min,
    margin: STARTUP_LIMIT_MS / readyStats.max,
  },
});

report.record({
  metric: 'M01 启动后首个批次拿到 202（含一次 HTTP 往返）',
  stat: 'max',
  value: firstAcceptedStats.max,
  unit: 'ms',
  samples: firstAcceptedStats.samples,
  source: 'tests/acceptance/M01.md:19',
  note: '仅作「可接受请求」的证据，比 M01-AC-13 的启动口径更严，不单独判定规格线',
  extra: {
    p50: firstAcceptedStats.p50,
    min: firstAcceptedStats.min,
  },
});

/* ---------------------------------------------------------------- ② 吞吐（M01-AC-14） */

const throughputReceiver = await startReceiver({ port: 0 });
let loadResult;
let counters;
let rssMb;
let cpuMsPerBatch;
try {
  const cpuStarted = process.cpuUsage();
  loadResult = await loadTest(throughputReceiver.port, {
    durationMs: WINDOW_MS,
    concurrency: CONNECTIONS,
    eventsPerBatch: EVENTS_PER_BATCH,
    // 每批 15 条唯一事件（loadTest 的 idOf 保证唯一）；去重键是 app_id + event_id。
    appId: 'demo-app-m01-bench',
  });
  const cpuDelta = process.cpuUsage(cpuStarted);
  counters = throughputReceiver.counters.snapshot();
  rssMb = process.memoryUsage().rss / 1024 ** 2;
  const accepted = loadResult.statuses.get(202) ?? 0;
  cpuMsPerBatch = accepted === 0 ? Number.NaN : (cpuDelta.user + cpuDelta.system) / 1000 / accepted;
} finally {
  await throughputReceiver.stop();
}

const accepted = loadResult.statuses.get(202) ?? 0;
const non202 = loadResult.batches - accepted;
const errorResponses = non202 + loadResult.errors;
const acceptedRate = accepted / loadResult.seconds;
const attemptedRate = loadResult.batches / loadResult.seconds;
const expectedStoredEvents = accepted * EVENTS_PER_BATCH;
const storedOk =
  counters.stored_events === expectedStoredEvents && counters.stored_batches === accepted;
const duplicatesOk = counters.duplicate_events === 0;

details.throughput = {
  window_requested_ms: WINDOW_MS,
  elapsed_ms: Number((loadResult.seconds * 1000).toFixed(3)),
  connections: CONNECTIONS,
  events_per_batch: EVENTS_PER_BATCH,
  attempted_batches: loadResult.batches,
  accepted_batches: accepted,
  accepted_batches_per_second: Number(acceptedRate.toFixed(3)),
  attempted_batches_per_second: Number(attemptedRate.toFixed(3)),
  statuses: Object.fromEntries(loadResult.statuses),
  network_errors: loadResult.errors,
  non_202_responses: non202,
  first_failure: loadResult.firstFailure,
  accepted_events: expectedStoredEvents,
  stored_events: counters.stored_events,
  stored_batches: counters.stored_batches,
  duplicate_events: counters.duplicate_events,
  rss_mb: Number(rssMb.toFixed(1)),
  heap_used_mb: Number((process.memoryUsage().heapUsed / 1024 ** 2).toFixed(1)),
  heap_limit_mb: Number((getHeapStatistics().heap_size_limit / 1024 ** 2).toFixed(1)),
  cpu_ms_per_batch: Number.isFinite(cpuMsPerBatch) ? Number(cpuMsPerBatch.toFixed(4)) : null,
};

report.record({
  metric: 'M01-AC-14 吞吐（30 s 窗口，每批 15 条）',
  stat: 'window',
  value: acceptedRate,
  unit: '批/秒',
  samples: accepted,
  target: WINDOW_IS_SPEC ? THROUGHPUT_MIN_BATCHES_PER_SECOND : undefined,
  targetText: WINDOW_IS_SPEC ? '≥ 500 批/秒（30 s 窗口）' : '窗口 < 30 s，不判规格线',
  // 吞吐是「越大越好」：不写这一项会被报告当成 at-most 误判成不达标（首次运行已实测到）。
  direction: 'at-least',
  source: 'tests/acceptance/M01.md:20',
  note:
    `判定量=成功（202）/ 实际耗时 ${loadResult.seconds.toFixed(3)} s（含排空，保守）；` +
    `连接=${String(CONNECTIONS)}；负载生成与门禁内 6 秒压测同一实现（前 3 s 请求体 gzip）`,
  extra: {
    attempted_batches: loadResult.batches,
    attempted_rate: attemptedRate,
    non_202: non202,
    network_errors: loadResult.errors,
    margin: WINDOW_IS_SPEC ? acceptedRate / THROUGHPUT_MIN_BATCHES_PER_SECOND : Number.NaN,
  },
});

report.record({
  metric: 'M01-AC-14 错误响应（非 202 + 网络错误）',
  stat: 'window',
  value: errorResponses,
  unit: '个',
  samples: loadResult.batches + loadResult.errors,
  target: 0,
  targetText: '0 个错误响应',
  source: 'tests/acceptance/M01.md:20',
  note: '原文要求「无错误响应」；这项与吞吐分开，避免用高吞吐掩盖错误',
  extra: {
    non_202: non202,
    network_errors: loadResult.errors,
    first_failure_status: loadResult.firstFailure?.status ?? -1,
  },
});

report.record({
  metric: 'M01-AC-14 每批 CPU 成本（负载无关，仅记录）',
  stat: 'window',
  value: cpuMsPerBatch,
  unit: 'ms/批',
  samples: accepted,
  source: 'docs/tasks/T09.md 非功能目标（诊断量，不是规格线）',
  note: '墙钟吞吐会被同机其它 lane 抢占；CPU/批用于判断实现单位成本是否稳定',
  extra: {
    cpu_ms_total: Number.isFinite(cpuMsPerBatch)
      ? Number((cpuMsPerBatch * accepted).toFixed(1))
      : Number.NaN,
  },
});

report.record({
  metric: 'M01-AC-14 入库数（测量完整性：stored_events == 202 批 × 15）',
  stat: 'window',
  value: counters.stored_events,
  unit: '条',
  samples: counters.stored_batches,
  source: 'M01-F2 / RR-05（去重后入库）',
  note: storedOk
    ? `对账成立：stored_batches=${String(counters.stored_batches)}，duplicate=${String(counters.duplicate_events)}，RSS=${rssMb.toFixed(1)} MB`
    : `!! 测量无效：期望 ${String(expectedStoredEvents)} 条 / ${String(accepted)} 批，` +
      `实际 ${String(counters.stored_events)} 条 / ${String(counters.stored_batches)} 批`,
  extra: {
    expected_events: expectedStoredEvents,
    duplicate_events: counters.duplicate_events,
    rss_mb: Number(rssMb.toFixed(1)),
  },
});

report.finish();

if (!storedOk || !duplicatesOk) {
  console.error(
    '!! 测量完整性失败（这不是规格线不达标，而是「测错了」）：' +
      `stored_ok=${String(storedOk)}，duplicates_ok=${String(duplicatesOk)}`,
  );
  process.exitCode = 1;
}

console.log(
  `完成：结果写入 tests/bench/results/m01-receiver.json；` +
    `启动 max=${readyStats.max.toFixed(3)} ms（余量 ${(STARTUP_LIMIT_MS / readyStats.max).toFixed(1)}×），` +
    `吞吐=${acceptedRate.toFixed(1)} 批/秒（规格线 500 的 ${(acceptedRate / THROUGHPUT_MIN_BATCHES_PER_SECOND).toFixed(2)}×），` +
    `错误响应=${String(errorResponses)}`,
);
