/**
 * C08 计数映射的非功能回归护栏。
 *
 * **契约口径**：任务卡要求「计数操作不超过 0.001 ms」。
 * 本仓库已确立政策（`docs/reports/wave1-lanes.md`、看板）：**单元门禁不得断言
 * 微秒/毫秒级的绝对墙钟目标值**；P99/吞吐/内存等绝对值归 T20 的受控基准。
 * 因此这里只测**同步映射路径的中位数**，并留 ≥10 倍余量：
 * - 测试名与断言消息都写明「回归护栏，非契约目标值」；
 * - `0.001 ms` 的权威验证归 **T20** 的 `tests/bench/`；
 * - 本用例测的是**整窗映射（全部固定计数 + 全部原因码 + 暴露窗口 + 三个 p99）**的
 *   同步耗时，比任务卡说的「单次计数操作」更保守；因此它只能当回归护栏。
 */
import { describe, expect, test } from 'vitest';
import { buildHealthMetrics } from './metrics';
import { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';
import type { HealthMetricsInput } from './metrics';

/**
 * 回归护栏（**非契约目标值**）。
 *
 * 实测（2026-10-13，本工作树）：
 * - 空闲中位数 **0.00425 ms**；
 * - 4 个并发忙循环（模拟共享机器负载）下三轮中位数 **0.00496 / 0.00438 / 0.00500 ms**。
 *
 * 阈值取「有负载实测最大值 0.0050 ms」的 **12 倍**（0.06 ms），仍远小于 1 ms：
 * 既能拦住 10 倍量级的病态回归，也不会因共享机器的噪声误报。
 */
const BUILD_METRICS_P50_GUARD_MS = 0.06;

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5));
  return sorted[index] ?? 0;
}

function worstCaseInput(): HealthMetricsInput {
  const counters: Record<string, number> = {};
  for (const code of DROP_REASON_CODES) counters[code] = 7;
  for (const code of COUNT_REASON_CODES) counters[code] = 3;
  return {
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
}

describe('C08 计数映射的非功能回归护栏', () => {
  test('buildHealthMetrics 中位数不高于回归护栏（回归护栏，非契约目标值）', () => {
    const input = worstCaseInput();
    for (let index = 0; index < 500; index += 1) buildHealthMetrics(input);
    const samples: number[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      const startedAt = performance.now();
      buildHealthMetrics(input);
      samples.push(performance.now() - startedAt);
    }
    const p50 = median(samples);
    expect(
      p50,
      `buildHealthMetrics P50 实测 ${p50.toFixed(6)} ms（回归护栏 ${String(BUILD_METRICS_P50_GUARD_MS)} ms；契约 0.001 ms 由 T20 受控基准验证）`,
    ).toBeLessThan(BUILD_METRICS_P50_GUARD_MS);
  });
});
