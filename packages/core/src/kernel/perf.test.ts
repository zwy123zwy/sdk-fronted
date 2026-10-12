/**
 * C02 内核非功能目标（任务卡 T11）实测 —— **回归护栏，不是规格线**。
 *
 * 契约目标值（T11 任务卡）：初始化 ≤ 5 ms；六段管线处理单条事件 P99 ≤ 0.05 ms；
 * 预启动队列内存 ≤ 256 KB（队列上限 500 条）。这些绝对值的权威验证归 T20 的
 * `tests/bench/` 受控基准；本文件只保留**带文档余量的回归护栏**：
 * - 初始化：50 次 `createKernel + init + start` 采样的**中位数（P50）**，护栏 0.1 ms；
 * - 管线：5,000 次迭代的**中位数（P50）**，护栏 0.02 ms；
 * - 预启动队列上限 500 与溢出计数是确定性行为，仍是正式门禁（不是 timing）。
 *
 * 为什么护栏锚定中位数而不是 P99 / 单次采样：本机（10 核，其他 lane 并发，load average 5–18）
 * 反复实测——初始化单次采样 1.2 µs–38 µs（个别被抢占的采样是典型值的 20 倍以上），而
 * 50 次采样的中位数稳定在 2.0–5.5 µs；管线 P50 稳定在 0.29–1.29 µs，而单次迭代最大
 * 0.031–0.238 ms（抢占放大 100 倍以上），单轮 P99 在 1.5–4.2 µs 之间抖动。P99 与单次采样
 * 由进程抢占主导：用契约目标值（0.05 ms / 5 ms）当门禁会误报，用「有负载 P99 × 10」当门禁
 * 又会大到失去意义。中位数反映真实单位成本、对抢占不敏感，因此护栏取中位数的 ≥10 倍余量：
 * - 初始化 P50 < 0.1 ms：≥18 倍于有负载实测最大值 5.5 µs，≈50 倍于典型值 2.0 µs；
 * - 管线 P50 < 0.02 ms：≈15 倍于有负载实测最大值 1.29 µs，≈69 倍于典型值 0.29 µs。
 * 两个护栏都拦得住 10 倍量级的病态回归，且远低于契约目标值（分别是 5 ms 的 1/50、0.05 ms 的 40%）。
 */
import { describe, expect, it } from 'vitest';

import { PIPELINE_STAGES, PRESTART_QUEUE_CAPACITY, createKernel } from '../index';
import type { KernelEvent } from '../index';

/** 初始化中位数护栏（回归护栏，非契约目标值 5 ms）。 */
const INIT_P50_GUARD_MS = 0.1;

/** 六段管线单条事件处理中位数护栏（回归护栏，非契约目标值 P99 ≤ 0.05 ms）。 */
const PIPELINE_P50_GUARD_MS = 0.02;

/** 初始化采样次数（每次采样含 createKernel + init + start + destroy）。 */
const INIT_SAMPLES = 50;

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'perf_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

/** 中位数（回归护栏用的稳健统计量；对个别被进程抢占的采样不敏感）。 */
function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('C02 非功能目标（回归护栏）', () => {
  it('初始化与启动的中位数不高于回归护栏（契约目标 ≤ 5 ms 由 T20 基准验证）', () => {
    for (let index = 0; index < 20; index += 1) {
      const warmup = createKernel({ target: null });
      warmup.init();
      warmup.start();
      warmup.destroy();
    }

    const samples: number[] = [];
    for (let index = 0; index < INIT_SAMPLES; index += 1) {
      const startedAt = performance.now();
      const kernel = createKernel({ target: null });
      kernel.init();
      kernel.start();
      samples.push(performance.now() - startedAt);
      kernel.destroy();
    }

    const p50 = median(samples);
    expect(
      p50,
      `初始化 P50 实测 ${p50.toFixed(5)} ms（回归护栏 ${String(INIT_P50_GUARD_MS)} ms）`,
    ).toBeLessThan(INIT_P50_GUARD_MS);
  });

  it('六段管线处理单条事件的中位数不高于回归护栏（契约目标 P99 ≤ 0.05 ms 由 T20 基准验证）', () => {
    const kernel = createKernel({ target: null });
    kernel.init();
    kernel.start();
    kernel.markConfigReady();
    for (const stage of PIPELINE_STAGES) {
      kernel.registerProcessor(stage, (event) => {
        event['touched'] = stage;
        return event;
      });
    }

    const event = makeEvent();
    for (let index = 0; index < 2_000; index += 1) {
      kernel.pipeline.process(event);
    }

    const samples: number[] = [];
    const iterations = 5_000;
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      kernel.pipeline.process(event);
      samples.push(performance.now() - startedAt);
    }

    const p50 = median(samples);
    expect(
      p50,
      `管线处理 P50 实测 ${p50.toFixed(5)} ms（回归护栏 ${String(PIPELINE_P50_GUARD_MS)} ms）`,
    ).toBeLessThan(PIPELINE_P50_GUARD_MS);
  });

  it('预启动队列上限为 500 条且溢出淘汰最早的 normal 事件', () => {
    const kernel = createKernel({ target: null });
    kernel.init();

    for (let index = 0; index < PRESTART_QUEUE_CAPACITY + 1; index += 1) {
      kernel.report(makeEvent({ index }));
    }

    expect(kernel.prestartQueue.size()).toBe(PRESTART_QUEUE_CAPACITY);
    expect(kernel.counters.get('prestart_queue_overflow')).toBe(1);
  });
});
