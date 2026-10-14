/**
 * C07 离线存储基准（T20 是契约目标值的权威验证方；单元护栏见
 * `packages/transport/src/offline/perf.test.ts`）。
 *
 * 契约目标值（T16 任务卡）：**单次写入阻塞主线程 ≤ 1 ms**。
 *
 * 口径：
 * - 「阻塞主线程」= **同步 API 调用**的耗时：`store.prewrite(batch)` 的墙钟差。
 *   IndexedDB 事务提交是异步的，不属于阻塞主线程，只作为数据记录；
 * - 同步路径用 `fake-indexeddb` + 内存后端（`createRecordingBackend`，与单元护栏同一套夹具），
 *   分别测「单条事件批次」与「100 条事件的中等批次」；
 * - 异步落盘耗时从 `store.stats().exposure.commitLatencyP50Ms/P95Ms` 读取（真实 IndexedDB =
 *   `fake-indexeddb`），**不做达标判定**（T16 没有给异步提交定目标值），供 T32 对账取用。
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'vitest';

import { loadOfflineFixtures, loadTransportEntry } from './lib/entries';
import { makeBatch, makeQueueEvent, TEST_APP_ID, TEST_START } from './lib/fixtures';
import { createBenchReport } from './lib/report';
import { summarize, timedIterations, warmup } from './lib/stats';

const report = createBenchReport('c07-offline');

/** 契约目标：prewrite 同步调用。 */
const PREWRITE_TARGET_MS = 1;

const PREWRITE_ITERATIONS = 2_000;
const PREWRITE_WARMUP = 200;

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `t20-bench-${String(dbCounter)}`;
}

afterAll(() => {
  report.finish();
});

describe('T20 基准：C07 离线预写', () => {
  test('prewrite 同步调用：单条事件批次（契约 ≤ 1 ms）', async () => {
    const transport = await loadTransportEntry();
    const fixtures = await loadOfflineFixtures();
    const recorder = fixtures.createRecordingBackend();
    const store = transport.createOfflineStore({
      appId: TEST_APP_ID,
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 10_000, commitIntervalMs: 10_000 },
    });
    try {
      await store.ready();
      // 正断言：prewrite 确实返回了可落盘的句柄
      const probe = store.prewrite(makeBatch());
      expect(typeof probe.settled.then).toBe('function');

      warmup(PREWRITE_WARMUP, () => {
        store.prewrite(makeBatch());
      });
      const stats = summarize(
        timedIterations(PREWRITE_ITERATIONS, () => {
          store.prewrite(makeBatch());
        }),
      );
      report.record({
        metric: 'C07 prewrite 同步调用（单条事件批次）',
        stat: 'p99',
        value: stats.p99,
        unit: 'ms',
        samples: stats.samples,
        target: PREWRITE_TARGET_MS,
        targetText: '≤ 1 ms',
        source: 'docs/tasks/T16.md 非功能目标',
        extra: { p50: stats.p50, min: stats.min, max: stats.max },
      });
    } finally {
      store.dispose();
    }
  });

  test('prewrite 同步调用：100 条事件批次（契约 ≤ 1 ms）', async () => {
    const transport = await loadTransportEntry();
    const fixtures = await loadOfflineFixtures();
    const recorder = fixtures.createRecordingBackend();
    const store = transport.createOfflineStore({
      appId: TEST_APP_ID,
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 10_000, commitIntervalMs: 10_000 },
    });
    try {
      await store.ready();
      const events = Array.from({ length: 100 }, () => makeQueueEvent(200));
      const batch = makeBatch(100, 200);
      // 正断言：批次真的有 100 条
      expect((batch['events'] as readonly unknown[]).length).toBe(100);
      expect(events.length).toBe(100);

      warmup(20, () => {
        store.prewrite(batch);
      });
      const stats = summarize(
        timedIterations(300, () => {
          store.prewrite(batch);
        }),
      );
      report.record({
        metric: 'C07 prewrite 同步调用（100 条事件 / 每条约 200 B 附件）',
        stat: 'p99',
        value: stats.p99,
        unit: 'ms',
        samples: stats.samples,
        target: PREWRITE_TARGET_MS,
        targetText: '≤ 1 ms',
        source: 'docs/tasks/T16.md 非功能目标',
        note: '同步路径不做整批 JSON 序列化',
        extra: { p50: stats.p50, min: stats.min, max: stats.max },
      });
    } finally {
      store.dispose();
    }
  });

  test('异步落盘耗时（只记录，供 T32 对账；无契约目标）', async () => {
    const transport = await loadTransportEntry();
    const store = transport.createOfflineStore({
      appId: TEST_APP_ID,
      sessionId: 'session-a',
      dbName: freshDbName(),
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      for (let index = 0; index < 50; index += 1) {
        await store.prewrite(makeBatch()).settled;
      }
      const exposure = store.stats().exposure;
      // 测量完整性：真实 IndexedDB（fake-indexeddb）确实提交并记录了耗时
      expect(exposure.commitLatencyP50Ms).not.toBeNull();
      expect(exposure.commitLostEvents).toBe(0);

      report.record({
        metric: 'C07 异步落盘提交耗时 P50',
        stat: 'p50',
        value: exposure.commitLatencyP50Ms ?? Number.NaN,
        unit: 'ms',
        samples: 50,
        note: `真实 IDB（fake-indexeddb），提交 ${String(50)} 次；commitLostEvents=${String(exposure.commitLostEvents)}`,
      });
      report.record({
        metric: 'C07 异步落盘提交耗时 P95',
        stat: 'p95',
        value: exposure.commitLatencyP95Ms ?? Number.NaN,
        unit: 'ms',
        samples: 50,
        note: '不阻塞主线程，因此不计入 T16 的 1 ms 口径',
      });
      report.record({
        metric: 'C07 提交丢失事件数',
        stat: 'p50',
        value: exposure.commitLostEvents,
        unit: '条',
        samples: 50,
        note: `基准起点时间戳 ${String(TEST_START)}`,
      });
    } finally {
      store.dispose();
    }
  });
});
