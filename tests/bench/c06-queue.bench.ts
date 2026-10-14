/**
 * C06 队列与批次组装基准（T20 是契约目标值的权威验证方；单元护栏见
 * `packages/transport/src/queue/perf.test.ts`）。
 *
 * 契约目标值（T15 任务卡）：
 * - 入队 **P99 ≤ 0.01 ms**；
 * - 单批组装与序列化 **≤ 2 ms**；
 * - 常驻内存 **≤ 1 MB**。
 *
 * 口径：
 * - 入队用「手动提交」的队列（首个批次进入在途后不再冲刷），测的是入队自身成本；
 * - 组装与序列化分开报：`assemble()`（提升公共字段 + 组包）与 `assemble + JSON.stringify`
 *   （契约说的是「组装与序列化」，因此以后者判定）；
 * - 常驻内存：满载队列事件的确定性结构字节（下界）+ 堆增量上界（未强制 GC）。
 */
import { afterAll, describe, expect, test } from 'vitest';

import { loadTransportEntry } from './lib/entries';
import { makeQueueEvent, TEST_START, testHeader, testUuid } from './lib/fixtures';
import { formatKb, heapDeltaBytes, totalJsonUnits, totalStructuralBytes } from './lib/memory';
import { createBenchReport } from './lib/report';
import { summarize, timedIterations, warmup } from './lib/stats';

const report = createBenchReport('c06-queue');

const ENQUEUE_P99_TARGET_MS = 0.01;
const ASSEMBLE_TARGET_MS = 2;
/** 常驻内存预算：1 MB。 */
const RESIDENT_BUDGET_BYTES = 1024 * 1024;

const BATCH_ID = 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e';
const ENQUEUE_WARMUP = 1_000;
const ENQUEUE_ITERATIONS = 5_000;

afterAll(() => {
  report.finish();
});

describe('T20 基准：C06 入队与批次组装', () => {
  test('入队 P99（契约 P99 ≤ 0.01 ms）', async () => {
    const transport = await loadTransportEntry();
    const queue = transport.createTransportQueue({
      config: { transport: () => ({}) },
      // 手动完成：首个批次进入在途后不再冲刷，测量入队本身的成本
      submit: { submit: () => undefined },
      header: { header: () => testHeader() },
      now: () => TEST_START,
      createId: () => BATCH_ID,
    });
    try {
      warmup(ENQUEUE_WARMUP, () => {
        queue.enqueue(makeQueueEvent());
      });
      const samples = timedIterations(ENQUEUE_ITERATIONS, () => {
        queue.enqueue(makeQueueEvent());
      });
      const stats = summarize(samples);
      // 测量完整性
      expect(stats.samples).toBe(ENQUEUE_ITERATIONS);
      expect(stats.min).toBeGreaterThanOrEqual(0);

      report.record({
        metric: 'C06 入队单条耗时',
        stat: 'p99',
        value: stats.p99,
        unit: 'ms',
        samples: stats.samples,
        target: ENQUEUE_P99_TARGET_MS,
        targetText: 'P99 ≤ 0.01 ms',
        source: 'docs/tasks/T15.md 非功能目标',
        extra: { p50: stats.p50, min: stats.min, max: stats.max },
      });
    } finally {
      queue.dispose();
    }
  });

  test('单批组装与序列化（契约 ≤ 2 ms）', async () => {
    const transport = await loadTransportEntry();
    const assembler = transport.createBatchAssembler({
      header: { header: () => testHeader() },
      now: () => TEST_START,
      createId: () => BATCH_ID,
    });
    const events = Array.from({ length: 20 }, () => makeQueueEvent());

    // 正断言 + 样本量：序列化确实产出了字节
    const batchBytes = JSON.stringify(assembler.assemble(events)).length;
    expect(batchBytes).toBeGreaterThan(0);

    const ASSEMBLE_ITERATIONS = 500;
    warmup(50, () => {
      assembler.assemble(events);
    });
    const assembleSamples = timedIterations(ASSEMBLE_ITERATIONS, () => {
      assembler.assemble(events);
    });
    const serializeSamples = timedIterations(ASSEMBLE_ITERATIONS, () => {
      JSON.stringify(assembler.assemble(events));
    });

    const assembleStats = summarize(assembleSamples);
    const serializeStats = summarize(serializeSamples);

    report.record({
      metric: 'C06 单批组装（20 条事件）',
      stat: 'p50',
      value: assembleStats.p50,
      unit: 'ms',
      samples: assembleStats.samples,
      note: '对照行（不含序列化）',
      extra: { p99: assembleStats.p99, min: assembleStats.min },
    });
    report.record({
      metric: 'C06 单批组装 + JSON 序列化（20 条事件）',
      stat: 'p50',
      value: serializeStats.p50,
      unit: 'ms',
      samples: serializeStats.samples,
      target: ASSEMBLE_TARGET_MS,
      targetText: '≤ 2 ms',
      source: 'docs/tasks/T15.md 非功能目标',
      extra: { p99: serializeStats.p99, min: serializeStats.min, batch_json_bytes: batchBytes },
    });
  });

  test('常驻内存（契约 ≤ 1 MB；队列自身默认上限 500 条 / 512 KB）', async () => {
    const transport = await loadTransportEntry();
    const queue = transport.createTransportQueue({
      config: { transport: () => ({}) },
      submit: { submit: () => undefined },
      header: { header: () => testHeader() },
      now: () => TEST_START,
      createId: () => testUuid(1),
    });

    // 用实现自身的默认上限填充队列（`submit` 不冲刷，因此事件留在内存里）
    const retained: Record<string, unknown>[] = [];
    for (let index = 0; index < transport.QUEUE_MAX_EVENTS + 100; index += 1) {
      const event = makeQueueEvent();
      retained.push(event);
      queue.enqueue(event);
    }
    const queueLength = queue.queueLength();
    /** 实现自身的体积估算（`size.ts` 的口径，偏保守）。 */
    const queueBytes = queue.queueBytes();
    const payloadUnits = totalJsonUnits(retained.slice(0, queueLength));
    const payloadBytes = totalStructuralBytes(retained.slice(0, queueLength));
    queue.dispose();

    // 测量完整性：队列被填到上限，且实现报告了非零体积
    expect(queueLength).toBe(transport.QUEUE_MAX_EVENTS);
    expect(queueBytes).toBeGreaterThan(0);

    // 堆增量上界：单独保留相同条数的事件对象
    const heap = heapDeltaBytes(1, () => retained.slice(0, queueLength).map((event) => ({ ...event })));

    report.record({
      metric: 'C06 满载队列（默认上限 500 条）的常驻内存：实现自估体积',
      stat: 'p50',
      value: queueBytes,
      unit: 'B',
      samples: queueLength,
      target: RESIDENT_BUDGET_BYTES,
      targetText: '≤ 1 MB',
      source: 'docs/tasks/T15.md 非功能目标',
      note: `队列自身默认上限 ${formatKb(transport.QUEUE_MAX_BYTES)} KB；每条约 ${(queueBytes / queueLength).toFixed(0)} B`,
      extra: { kb: queueBytes / 1024, queue_max_kb: transport.QUEUE_MAX_BYTES / 1024 },
    });
    report.record({
      metric: 'C06 满载队列（默认上限 500 条）事件体积（仓库口径 JSON 码元数）',
      stat: 'p50',
      value: payloadUnits,
      unit: 'B',
      samples: queueLength,
      note: `每条约 ${(payloadUnits / queueLength).toFixed(0)} B；实现自估 ${(queueBytes / queueLength).toFixed(0)} B/条（更保守）`,
      extra: { kb: payloadUnits / 1024 },
    });
    report.record({
      metric: 'C06 满载队列（默认上限 500 条）事件内存保守上界（UTF-16×2）',
      stat: 'p50',
      value: payloadBytes,
      unit: 'B',
      samples: queueLength,
      note: '确定性结构字节上界，不含引擎对象头',
      extra: { kb: payloadBytes / 1024 },
    });
    report.record({
      metric: 'C06 满载队列保留事件对象的堆增量（含引擎开销）',
      stat: 'p50',
      value: heap.bytes,
      unit: 'B',
      samples: queueLength,
      note: `上界，未强制 GC（gcForced=${String(heap.gcForced)}）；合计 ${formatKb(heap.bytes)} KB`,
    });
  });
});
