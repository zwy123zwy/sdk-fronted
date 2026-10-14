/**
 * C08 自监控基准（T20 是契约目标值的权威验证方；单元护栏见
 * `packages/transport/src/monitor/perf.test.ts`）。
 *
 * 契约目标值（T17 任务卡）：
 * - **计数操作 ≤ 0.001 ms**；
 * - **自监控流量占业务流量 ≤ 1%**（T17 用确定性计数测得计数比 0.100% / 体积比 0.1028%；
 *   基准侧补**真实序列化流量**）。
 *
 * 口径：
 * - 「计数操作」= 真实计数器的一次 `count(reason)`（`createCounters`），
 *   **不是**整窗映射；整窗映射（全部固定计数 + 全部原因码 + 暴露窗口 + 三个 p99）另行记录，
 *   并说明单元护栏的 0.06 ms 是整窗的回归护栏；
 * - 流量占比用**真实产出**：真实批次组装器产出的业务事件 JSON 字节 vs
 *   `buildHealthMetrics` + `buildHealthEvents` 产出的 `sdk_health` JSON 字节。
 */
import { afterAll, describe, expect, test } from 'vitest';

import { loadCoreEntry, loadTransportEntry } from './lib/entries';
import { makeQueueEvent, TEST_START, testHeader, testUuid } from './lib/fixtures';
import { createBenchReport } from './lib/report';
import { summarize, timedIterations, warmup } from './lib/stats';

const report = createBenchReport('c08-monitor');

/** 契约目标：单次计数操作。 */
const COUNT_OP_TARGET_MS = 0.001;
/** 契约目标：自监控流量占比（计数比与体积比都要 ≤ 1%）。 */
const TRAFFIC_SHARE_TARGET = 0.01;

const COUNT_ITERATIONS = 50_000;

afterAll(() => {
  report.finish();
});

describe('T20 基准：C08 计数与自监控流量', () => {
  test('单次计数操作（契约 ≤ 0.001 ms）', async () => {
    const core = await loadCoreEntry();
    const counters = core.createCounters();
    const reasons = ['queue_overflow', 'sample_dropped', 'consent_denied', 'transport_failed'];

    // 正断言：计数确实累加
    counters.count('t20-bench', 2);
    expect(counters.get('t20-bench')).toBe(2);

    warmup(5_000, () => {
      counters.count('t20-bench');
    });
    const stats = summarize(
      timedIterations(COUNT_ITERATIONS, (index) => {
        counters.count(reasons[index % reasons.length] ?? 't20-bench');
      }),
    );
    report.record({
      metric: 'C08 单次计数操作 counters.count(reason)',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      target: COUNT_OP_TARGET_MS,
      targetText: '≤ 0.001 ms',
      source: 'docs/tasks/T17.md 非功能目标',
      note: `计数器当前键数=${String(Object.keys(counters.snapshot()).length)}`,
      extra: { p50: stats.p50, min: stats.min, max: stats.max },
    });
  });

  test('整窗映射 buildHealthMetrics（回归护栏 0.06 ms，非契约目标）', async () => {
    const transport = await loadTransportEntry();
    const counters: Record<string, number> = {};
    for (const code of transport.DROP_REASON_CODES) counters[code] = 7;
    for (const code of transport.COUNT_REASON_CODES) counters[code] = 3;
    const input = {
      counters,
      windowMs: 60_000,
      fixed: {
        calls_total: 1_000,
        events_enqueued: 900,
        events_sent: 880,
        batches_sent: 44,
        batches_failed: 2,
        queue_length_max: 120,
      },
      latency: { track: 1.5, pipeline: 2.5, serialize: 0.5 },
      exposure: { events: 2, windowMs: 30 },
    };

    const probe = transport.buildHealthMetrics(input);
    expect(Object.keys(probe).length).toBeGreaterThan(10);

    warmup(500, () => {
      transport.buildHealthMetrics(input);
    });
    const stats = summarize(
      timedIterations(5_000, () => {
        transport.buildHealthMetrics(input);
      }),
    );
    report.record({
      metric: `C08 整窗映射（${String(Object.keys(probe).length)} 个指标）`,
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      note: '比「单次计数操作」保守得多，T17 的单元回归护栏是 0.06 ms',
      extra: { p50: stats.p50, min: stats.min, max: stats.max },
    });
  });

  test('自监控流量占比（契约 ≤ 1%，真实序列化流量）', async () => {
    const transport = await loadTransportEntry();
    const assembler = transport.createBatchAssembler({
      header: { header: () => testHeader() },
      now: () => TEST_START,
      createId: () => testUuid(9_000_000),
    });

    // 真实业务流量：1,000 条业务事件（口径同契约 A.5「1000 条业务事件」），
    // 另用真实组装器把同样的事件组批，记录成批后的字节数作为参考。
    const BUSINESS_EVENTS = 1_000;
    const businessEvents: Record<string, unknown>[] = [];
    for (let index = 0; index < BUSINESS_EVENTS; index += 1) businessEvents.push(makeQueueEvent());
    const businessBatches: Record<string, unknown>[] = [];
    for (let index = 0; index < BUSINESS_EVENTS / 20; index += 1) {
      businessBatches.push(assembler.assemble(businessEvents.slice(index * 20, index * 20 + 20)));
    }
    const businessBytes = businessEvents.reduce((total, event) => total + transport.jsonSize(event), 0);
    const batchBytes = businessBatches.reduce((total, batch) => total + transport.jsonSize(batch), 0);

    // 真实自监控流量：一个 60 秒窗口的 sdk_health（12 个指标 = 契约 A.5 的形态）
    const counters: Record<string, number> = { drop_queue_overflow: 3, count_offline_replayed: 5 };
    const metrics = transport.buildHealthMetrics({
      counters,
      windowMs: 60_000,
      fixed: {
        calls_total: 1_000,
        events_enqueued: 1_000,
        events_sent: 980,
        batches_sent: 49,
        batches_failed: 1,
        queue_length_max: 40,
      },
      latency: { track: 1.5, pipeline: 2.5, serialize: 0.5 },
      exposure: { events: 1, windowMs: 60_000 },
    });
    const healthEvents = transport.buildHealthEvents({
      metrics,
      dimensions: { app_id: 'demo-app', env: 'staging', sdk_version: '0.1.0', session_id: testUuid(7_000_000) },
      occurredAt: TEST_START,
      createId: () => testUuid(8_000_000),
    });
    const healthBytes = healthEvents.reduce<number>((total, event) => total + transport.jsonSize(event), 0);

    // 真实产出：业务侧确实有 1,000 条事件、自监控侧确实有事件
    expect(businessEvents.length).toBe(BUSINESS_EVENTS);
    expect(businessBatches.length).toBe(BUSINESS_EVENTS / 20);
    expect(healthEvents.length).toBeGreaterThanOrEqual(1);

    const share = transport.measureTrafficShare(healthEvents, businessEvents);
    expect(healthBytes).toBeGreaterThan(0);

    report.record({
      metric: 'C08 自监控/业务 计数比（真实产出）',
      stat: 'p50',
      value: share.countRatio,
      unit: '比例',
      samples: BUSINESS_EVENTS,
      target: TRAFFIC_SHARE_TARGET,
      targetText: '≤ 1%',
      source: 'docs/tasks/T17.md 非功能目标',
      note: `${String(healthEvents.length)} 条 sdk_health / ${String(BUSINESS_EVENTS)} 条业务事件`,
      extra: { percent: share.countRatio * 100 },
    });
    report.record({
      metric: 'C08 自监控/业务 体积比（真实产出）',
      stat: 'p50',
      value: share.byteRatio,
      unit: '比例',
      samples: BUSINESS_EVENTS,
      target: TRAFFIC_SHARE_TARGET,
      targetText: '≤ 1%',
      source: 'docs/tasks/T17.md 非功能目标',
      note: `sdk_health ${String(healthBytes)} B；业务 ${String(businessBytes)} B（${(businessBytes / BUSINESS_EVENTS).toFixed(0)} B/条）；组批后 ${String(batchBytes)} B`,
      extra: { percent: share.byteRatio * 100 },
    });
  });
});
