/**
 * C02 内核基准（T20 是契约目标值的权威验证方；单元护栏见
 * `packages/core/src/kernel/perf.test.ts`）。
 *
 * 契约目标值（T11 任务卡）：
 * - 初始化 **≤ 5 ms**；
 * - 六段管线处理单条事件 **P99 ≤ 0.05 ms**；
 * - 预启动队列内存 **≤ 256 KB**（队列上限 500 条）。
 *
 * 内存口径（两种，都不含引擎对象头，且分开报）：
 * - **确定性结构字节**（`structuralBytes`，可复现、无 GC 噪声）：500 条事件的有效载荷字节，
 *   是「≤ 256 KB」的**下界**；
 * - **进程堆增量上界**（未强制 GC）：100 个内核各带一个满载预启动队列的 `heapUsed` 增量摊薄，
 *   是**上界**。两者都远低于 256 KB 时结论才稳。
 */
import { afterAll, describe, expect, test } from 'vitest';

import { loadCoreEntry } from './lib/entries';
import { makeKernelEvent, makeTypicalKernelEvent } from './lib/fixtures';
import { formatKb, heapDeltaBytes, totalJsonUnits, totalStructuralBytes } from './lib/memory';
import { createBenchReport } from './lib/report';
import { summarize, timedIterations, timedRounds, warmup } from './lib/stats';

const report = createBenchReport('c02-kernel');

const INIT_TARGET_MS = 5;
const PIPELINE_P99_TARGET_MS = 0.05;
/** 预启动队列内存预算：256 KB。 */
const PRESTART_BUDGET_BYTES = 256 * 1024;

const INIT_SAMPLES = 300;
const PIPELINE_ITERATIONS = 20_000;
const PIPELINE_WARMUP = 2_000;

afterAll(() => {
  report.finish();
});

describe('T20 基准：C02 内核', () => {
  test('初始化与启动（契约 ≤ 5 ms）', async () => {
    const core = await loadCoreEntry();

    warmup(20, () => {
      const kernel = core.createKernel({ target: null });
      kernel.init();
      kernel.start();
      kernel.destroy();
    });

    const samples: number[] = [];
    for (let index = 0; index < INIT_SAMPLES; index += 1) {
      const startedAt = performance.now();
      const kernel = core.createKernel({ target: null });
      kernel.init();
      kernel.start();
      samples.push(performance.now() - startedAt);
      kernel.destroy();
    }
    const stats = summarize(samples);

    // 测量完整性：采样数与最小值必须是有限正数
    expect(stats.samples).toBe(INIT_SAMPLES);
    expect(stats.min).toBeGreaterThan(0);

    report.record({
      metric: 'C02 初始化 + 启动（createKernel+init+start）',
      stat: 'p99',
      value: stats.p99,
      unit: 'ms',
      samples: stats.samples,
      target: INIT_TARGET_MS,
      targetText: '≤ 5 ms',
      source: 'docs/tasks/T11.md 非功能目标',
      extra: { p50: stats.p50, min: stats.min, max: stats.max },
    });
  });

  test('六段管线处理单条事件（契约 P99 ≤ 0.05 ms）', async () => {
    const core = await loadCoreEntry();
    const kernel = core.createKernel({ target: null });
    kernel.init();
    kernel.start();
    kernel.markConfigReady();
    for (const stage of core.PIPELINE_STAGES) {
      kernel.registerProcessor(stage, (event) => {
        event['touched'] = stage;
        return event;
      });
    }

    // 测量完整性：六段都注册了处理器
    for (const stage of core.PIPELINE_STAGES) {
      expect(kernel.pipeline.size(stage)).toBeGreaterThanOrEqual(1);
    }

    const event = makeKernelEvent();
    try {
      warmup(PIPELINE_WARMUP, () => {
        kernel.pipeline.process(event);
      });
      const samples = timedIterations(PIPELINE_ITERATIONS, () => {
        kernel.pipeline.process(event);
      });
      const stats = summarize(samples);
      report.record({
        metric: 'C02 六段管线处理单条事件',
        stat: 'p99',
        value: stats.p99,
        unit: 'ms',
        samples: stats.samples,
        target: PIPELINE_P99_TARGET_MS,
        targetText: 'P99 ≤ 0.05 ms',
        source: 'docs/tasks/T11.md 非功能目标',
        extra: { p50: stats.p50, min: stats.min, max: stats.max },
      });
    } finally {
      kernel.destroy();
    }
  });

  test('预启动队列内存（契约 ≤ 256 KB / 500 条）', async () => {
    const core = await loadCoreEntry();
    const capacity = core.PRESTART_QUEUE_CAPACITY;

    /** 把内核的预启动队列填满并取回事件。 */
    const fillAndDrain = (make: (index: number) => Record<string, unknown>): readonly Record<string, unknown>[] => {
      const kernel = core.createKernel({ target: null });
      kernel.init();
      for (let index = 0; index < capacity; index += 1) kernel.report(make(index));
      const size = kernel.prestartQueue.size();
      const drained = kernel.prestartQueue.drain();
      kernel.destroy();
      // 测量完整性：队列确实被填满
      expect(size).toBe(capacity);
      return drained;
    };

    // ① 典型形态（3 个短维度、无长值）
    const typical = fillAndDrain((index) => makeTypicalKernelEvent(index));
    const typicalUnits = totalJsonUnits(typical);
    const typicalBytes = totalStructuralBytes(typical);
    // ② 生产上界形态（含 200 字符长值 + 一处伪造 PII）
    const worst = fillAndDrain(() => makeKernelEvent());
    const worstUnits = totalJsonUnits(worst);
    const worstBytes = totalStructuralBytes(worst);

    // 堆增量上界：100 个内核各带一个满载预启动队列（生产上界形态）
    const KERNELS = 100;
    const heap = heapDeltaBytes(KERNELS, () => {
      const perKernel = core.createKernel({ target: null });
      perKernel.init();
      for (let index = 0; index < capacity; index += 1) perKernel.report(makeKernelEvent());
      return perKernel;
    });

    report.record({
      metric: 'C02 预启动队列内存（典型形态 3 个短维度，仓库体积口径）',
      stat: 'p50',
      value: typicalUnits,
      unit: 'B',
      samples: typical.length,
      target: PRESTART_BUDGET_BYTES,
      targetText: '≤ 256 KB',
      source: 'docs/tasks/T11.md 非功能目标',
      note: `JSON 码元数；每条约 ${(typicalUnits / typical.length).toFixed(0)} B`,
      extra: { kb: typicalUnits / 1024, memory_upper_bytes: typicalBytes },
    });
    report.record({
      metric: 'C02 预启动队列内存（生产上界形态，仓库体积口径）',
      stat: 'p50',
      value: worstUnits,
      unit: 'B',
      samples: worst.length,
      target: PRESTART_BUDGET_BYTES,
      targetText: '≤ 256 KB',
      source: 'docs/tasks/T11.md 非功能目标',
      note: `JSON 码元数；含 200 字符长值与伪造 PII，每条约 ${(worstUnits / worst.length).toFixed(0)} B；256 KB / 500 条隐含平均 ≤ ${(PRESTART_BUDGET_BYTES / capacity).toFixed(0)} B/条`,
      extra: { kb: worstUnits / 1024, memory_upper_bytes: worstBytes },
    });
    report.record({
      metric: 'C02 预启动队列内存（生产上界形态，内存保守上界 UTF-16×2）',
      stat: 'p50',
      value: worstBytes,
      unit: 'B',
      samples: worst.length,
      note: `每条约 ${(worstBytes / worst.length).toFixed(0)} B；真实 V8 对 Latin-1 字符串按 1 B/码元，故这是上界`,
      extra: { kb: worstBytes / 1024 },
    });
    report.record({
      metric: 'C02 预启动队列堆增量摊薄（生产上界形态，含未回收临时对象）',
      stat: 'p50',
      value: heap.bytes / heap.perItem,
      unit: 'B',
      samples: KERNELS,
      note: `上界，未强制 GC（gcForced=${String(heap.gcForced)}）；每内核 ${formatKb(heap.bytes / heap.perItem)} KB`,
    });
  });

  test('分轮中位数（对照：抑制跨轮漂移）', async () => {
    const core = await loadCoreEntry();
    const kernel = core.createKernel({ target: null });
    kernel.init();
    kernel.start();
    kernel.markConfigReady();
    for (const stage of core.PIPELINE_STAGES) {
      kernel.registerProcessor(stage, (event) => event);
    }
    const event = makeKernelEvent();
    try {
      const rounds = timedRounds(5, 4_000, () => {
        kernel.pipeline.process(event);
      });
      report.record({
        metric: 'C02 管线（5 轮 × 4000 次的轮中位数）',
        stat: 'p50',
        value: rounds.summary.p50,
        unit: 'ms',
        samples: rounds.roundMedians.length,
        note: `轮中位数 ${rounds.roundMedians.map((value) => value.toFixed(6)).join(' / ')}`,
      });
    } finally {
      kernel.destroy();
    }
  });
});
