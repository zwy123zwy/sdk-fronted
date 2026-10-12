/**
 * C02 内核非功能目标实测（任务卡 T11）：
 * 初始化 ≤ 5 ms；六段管线处理单条事件 P99 ≤ 0.05 ms；预启动队列上限 500 条。
 * 这里的断言保留 10 倍以上余量，用于拦截病态回归；正式基准由 T20 负责。
 */
import { describe, expect, it } from 'vitest';

import { PIPELINE_STAGES, PRESTART_QUEUE_CAPACITY, createKernel } from '../index';
import type { KernelEvent } from '../index';

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'perf_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? 0;
}

describe('C02 非功能目标', () => {
  it('初始化与启动耗时不高于 5 ms', () => {
    for (let index = 0; index < 20; index += 1) {
      const warmup = createKernel({ target: null });
      warmup.init();
      warmup.start();
      warmup.destroy();
    }

    const start = performance.now();
    const kernel = createKernel({ target: null });
    kernel.init();
    kernel.start();
    const elapsed = performance.now() - start;
    kernel.destroy();

    expect(elapsed).toBeLessThanOrEqual(5);
  });

  it('六段管线处理单条事件的 P99 不高于 0.05 ms', () => {
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
      const start = performance.now();
      kernel.pipeline.process(event);
      samples.push(performance.now() - start);
    }

    expect(percentile(samples, 0.99)).toBeLessThanOrEqual(0.05);
    expect(percentile(samples, 0.5)).toBeLessThanOrEqual(0.05);
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
