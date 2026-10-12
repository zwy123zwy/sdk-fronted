/**
 * C01 非功能目标实测（任务卡 T12）：
 * - 单次 `track` 同步耗时 P99 不超过 0.1 ms；
 * - 命令队列上限 200 条（功能用例已覆盖，这里只做一次批量 push 的耗时参考）。
 *
 * 说明：这里的断言用于拦截病态回归；正式基准由 T20 负责（`tests/bench/`）。
 */
import { describe, expect, it } from 'vitest';

import { createCommandQueue } from './command-queue';
import { createClient } from './client';
import type { KernelEvent } from '../kernel';

function percentile(samples: readonly number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? 0;
}

describe('C01 非功能目标', () => {
  it('单次 track 同步耗时 P99 不高于 0.1 ms', () => {
    const events: KernelEvent[] = [];
    const client = createClient({ appId: 'app-perf', debug: false, onEvent: (event) => events.push(event) });
    client.init({ appId: 'app-perf' });

    const track = (index: number): void => {
      client.track('task_complete', {
        dimensions: { task_id: `t-${String(index)}`, tenant: 'acme' },
        metrics: { duration_ms: index, retry_count: 0 },
      });
    };

    for (let index = 0; index < 2_000; index += 1) track(index);

    const samples: number[] = [];
    const iterations = 5_000;
    for (let index = 0; index < iterations; index += 1) {
      const start = performance.now();
      track(index);
      samples.push(performance.now() - start);
    }

    expect(events.length).toBeGreaterThanOrEqual(iterations);
    expect(percentile(samples, 0.99)).toBeLessThanOrEqual(0.1);
    expect(percentile(samples, 0.5)).toBeLessThanOrEqual(0.1);
    client.destroy();
  });

  it('命令队列 push 200 条的同步耗时不高于 1 ms', () => {
    const queue = createCommandQueue();
    const start = performance.now();
    for (let index = 0; index < 200; index += 1) {
      queue.push({
        kind: 'track',
        name: `queue_event_${String(index)}`,
        eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        occurredAt: index,
      });
    }
    const elapsed = performance.now() - start;

    expect(queue.size()).toBe(200);
    expect(elapsed).toBeLessThanOrEqual(1);
  });
});
