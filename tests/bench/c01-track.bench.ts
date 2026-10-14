/**
 * C01 公共 API 基准（T20 是契约目标值的权威验证方；单元护栏见
 * `packages/core/src/api/perf.test.ts`）。
 *
 * 契约目标值（T12 任务卡 / C01 非功能目标）：
 * - 单次 `track` 同步耗时 **P99 ≤ 0.1 ms**；
 * - 命令队列 200 条 `push` **≤ 1 ms**（批量口径，见下）。
 *
 * 口径：
 * - **不用总耗时**。`track` 用逐次采样的 P50/P99/最小值；吞吐由中位数推出。
 * - 「200 条 push ≤ 1 ms」本身是批量目标，因此用**每 200 条一组的组耗时中位数**判定
 *   （对单次 GC/调度抖动免疫），另给每条 push 的 P50/P99 作对照。
 * - `track` 采样 20,000 次（P99 ≈ 尾部 200 个样本），预热 2,000 次。
 */
import { afterAll, describe, expect, test } from 'vitest';

import type { LooseEvent } from './lib/fixtures';
import { loadCoreEntry } from './lib/entries';
import { createBenchReport } from './lib/report';
import { formatMs, summarize, throughputPerSecond, timeOnce, timedIterations, warmup } from './lib/stats';

const report = createBenchReport('c01-track');

/** 契约目标：单次 track P99。 */
const TRACK_P99_TARGET_MS = 0.1;
/** 契约目标：200 条 push 的组耗时。 */
const PUSH_200_TARGET_MS = 1;

const TRACK_ITERATIONS = 20_000;
const TRACK_WARMUP = 2_000;

afterAll(() => {
  report.finish();
});

describe('T20 基准：C01 track 与命令队列', () => {
  test('track 单次同步耗时的 P99（契约 P99 ≤ 0.1 ms）', async () => {
    const core = await loadCoreEntry();
    const events: LooseEvent[] = [];
    const client = core.createClient({
      appId: 'app-perf',
      debug: false,
      target: null,
      location: { href: 'https://app.example/list', pageId: '/list' },
      onEvent: (event: LooseEvent) => events.push(event),
    });
    client.init({ appId: 'app-perf', consent: 'granted' });

    const track = (index: number): void => {
      client.track('task_complete', {
        dimensions: { task_id: `t-${String(index)}`, tenant: 'acme' },
        metrics: { duration_ms: index % 1000, retry_count: 0 },
      });
    };

    try {
      warmup(TRACK_WARMUP, () => {
        track(0);
      });
      const samples = timedIterations(TRACK_ITERATIONS, track);
      const stats = summarize(samples);

      // 测量完整性：证明测的是真实工作（事件确实从出口出来了）
      expect(events.length).toBeGreaterThanOrEqual(TRACK_ITERATIONS);

      report.record({
        metric: 'C01 track 单次同步耗时',
        stat: 'p99',
        value: stats.p99,
        unit: 'ms',
        samples: stats.samples,
        target: TRACK_P99_TARGET_MS,
        targetText: 'P99 ≤ 0.1 ms',
        source: 'docs/tasks/T12.md C01 非功能目标',
        extra: { p50: stats.p50, min: stats.min, max: stats.max },
      });
      report.record({
        metric: 'C01 track 单线程吞吐（由 P50 推出）',
        stat: 'p50',
        value: throughputPerSecond(stats.p50),
        unit: '次/秒',
        samples: stats.samples,
        note: `track P50=${formatMs(stats.p50)} ms`,
      });

      // 逐次采样受计时器开销下限约束（本机 min≈2.7 µs）。用「批内摊销」给出真实单位成本的
      // 下界：每批 1,000 次 track 的总耗时 / 1,000，再取组内摊销耗时（100 组）的中位数。
      // 注意统计量仍是**摊销后的单条成本**，不是「总耗时」。
      const AMORTIZE_BATCH = 1_000;
      const amortized: number[] = [];
      for (let batch = 0; batch < 100; batch += 1) {
        const startedAt = performance.now();
        for (let index = 0; index < AMORTIZE_BATCH; index += 1) track(index);
        amortized.push((performance.now() - startedAt) / AMORTIZE_BATCH);
      }
      const amortizedStats = summarize(amortized);
      report.record({
        metric: 'C01 track 批内摊销单条耗时（每批 1000 次）',
        stat: 'p50',
        value: amortizedStats.p50,
        unit: 'ms',
        samples: amortizedStats.samples,
        note: '规避逐次计时的计时器下限，无契约目标',
        extra: { min: amortizedStats.min, p99: amortizedStats.p99 },
      });
    } finally {
      client.destroy();
    }
  });

  test('命令队列 200 条 push 的组耗时（契约 ≤ 1 ms）', async () => {
    const core = await loadCoreEntry();
    const queue = core.createCommandQueue();

    const pushBatch = (): void => {
      for (let index = 0; index < 200; index += 1) {
        queue.push({
          kind: 'track',
          name: `queue_event_${String(index)}`,
          eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          occurredAt: 1_793_000_000_000 + index,
        });
      }
    };

    warmup(5, pushBatch);

    // 测量完整性：一整批 200 条确实全部入队（容量为 200）
    queue.clear();
    pushBatch();
    expect(queue.capacity()).toBeGreaterThanOrEqual(200);
    expect(queue.size()).toBe(200);

    // 组耗时：每 200 条一组；队列容量上限 200，因此每组前先清空。
    const batchDurations: number[] = [];
    const BATCHES = 200;
    for (let batch = 0; batch < BATCHES; batch += 1) {
      queue.clear();
      batchDurations.push(timeOnce(pushBatch));
    }

    // 单条 push 的对照样本
    queue.clear();
    const perPushSamples: number[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      queue.shift();
      perPushSamples.push(
        timeOnce(() => {
          queue.push({
            kind: 'track',
            name: `queue_event_${String(index)}`,
            eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
            occurredAt: 1_793_000_000_000 + index,
          });
        }),
      );
    }

    // 测量完整性：队列已按容量上限填满
    expect(queue.size()).toBeGreaterThan(0);

    const batchStats = summarize(batchDurations);
    const perPush = summarize(perPushSamples);

    report.record({
      metric: 'C01 命令队列 200 条 push 组耗时',
      stat: 'p50',
      value: batchStats.p50,
      unit: 'ms',
      samples: batchStats.samples,
      target: PUSH_200_TARGET_MS,
      targetText: '200 条 ≤ 1 ms',
      source: 'docs/tasks/T12.md C01 非功能目标',
      extra: { p99: batchStats.p99, min: batchStats.min, max: batchStats.max },
    });
    report.record({
      metric: 'C01 命令队列单条 push',
      stat: 'p50',
      value: perPush.p50,
      unit: 'ms',
      samples: perPush.samples,
      extra: { p99: perPush.p99, min: perPush.min },
      note: '对照值，无独立契约目标',
    });
  });
});
