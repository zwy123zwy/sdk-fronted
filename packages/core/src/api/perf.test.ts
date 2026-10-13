/**
 * C01 非功能目标实测（任务卡 T12）：
 * - 单次 `track` 同步耗时 P99 不超过 0.1 ms；
 * - 命令队列上限 200 条（功能用例已覆盖，这里只做一次批量 push 的耗时参考）。
 *
 * **口径（2026-10-13 修正，按本仓库既定政策）**：本仓库规定**单元门禁不得断言微秒/毫秒级
 * 绝对墙钟目标**——负载尖峰会让这类断言随机变红（本文件原先把阈值直接取成契约目标值
 * 0.1 ms，实测中位数仅 0.00087 ms、契约目标有 26 倍余量，却在一次负载尖峰下以 0.104 ms 变红）。
 * 因此这里只保留**有文档化余量的中位数回归护栏**（拦截病态回归），
 * **契约目标值（P99 ≤ 0.1 ms、200 条 push ≤ 1 ms）的权威验证归 T20 的 `tests/bench/`**；
 * 实测值随断言消息输出，便于观察趋势。
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
  it('单次 track 同步耗时（中位数回归护栏；契约 P99 目标由 T20 验证）', () => {
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
    const median = percentile(samples, 0.5);
    const p99 = percentile(samples, 0.99);
    // 护栏值 0.02 ms：相对实测中位数（0.00087 ms）有 ≈23 倍余量，且远低于契约目标 0.1 ms。
    // 仅用于拦截病态回归，**不是契约目标值**。
    expect(
      median,
      `实测中位数 ${median.toFixed(5)} ms（护栏 0.02 ms；同轮 P99 观测 ${p99.toFixed(5)} ms）`,
    ).toBeLessThanOrEqual(0.02);
    client.destroy();
  });

  it('命令队列 push 200 条（回归护栏；契约目标由 T20 验证）', () => {
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
    // 护栏值 0.6 ms：相对实测值（200 条共 0.0556 ms）有 ≈11 倍余量，且远低于契约目标 1 ms。
    // 仅用于拦截病态回归，**不是契约目标值**。
    expect(elapsed, `实测 200 条 push 共 ${elapsed.toFixed(5)} ms（护栏 0.6 ms）`).toBeLessThanOrEqual(0.6);
  });
});
