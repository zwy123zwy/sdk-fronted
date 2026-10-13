/**
 * 离线存储的非功能回归护栏。
 *
 * **契约口径**：任务卡要求「单次写入阻塞主线程不超过 1 ms」。
 * 本仓库已确立政策（`docs/reports/wave1-lanes.md`、看板）：**单元门禁不得断言
 * 微秒/毫秒级的绝对墙钟目标值**，P99/吞吐/内存等绝对值归 T20 的受控基准；
 * 单元门禁只保留**带文档余量的中位数回归护栏**。
 *
 * 因此这里：
 * - 只测**同步 API 调用**的耗时（`prewrite` 的 `performance.now()` 差值）——
 *   IndexedDB 事务提交耗时是**异步**的，不属于"阻塞主线程"，只作为数据记录在
 *   `stats().exposure.commitLatencyP50Ms/P95Ms`，**不做断言**（权威验证归 T20）；
 * - 护栏锚定**中位数 P50 < 0.5 ms**（≥10 倍余量，且 < 1 ms），只在注释与断言消息里
 *   写明实测值；测试名标注「回归护栏，非契约目标值」。
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { createRecordingBackend, makeBatch, makeEvent } from './fixtures';
import { createOfflineStore } from './offline-store';

/** 同步写入中位数护栏（回归护栏，非契约目标值）。 */
const PREWRITE_P50_GUARD_MS = 0.5;

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `wr-test-perf-${String(dbCounter)}`;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5));
  return sorted[index] ?? 0;
}

describe('C07 离线存储非功能回归护栏', () => {
  test('prewrite 同步调用中位数不高于回归护栏（契约目标 1 ms 由 T20 基准验证）', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 10_000, commitIntervalMs: 10_000 },
    });
    try {
      await store.ready();
      const batch = makeBatch();
      const samples: number[] = [];
      for (let index = 0; index < 2_000; index += 1) {
        const startedAt = performance.now();
        store.prewrite(batch);
        samples.push(performance.now() - startedAt);
      }
      const p50 = median(samples);
      expect(
        p50,
        `prewrite 同步调用 P50 实测 ${p50.toFixed(5)} ms（回归护栏 ${String(PREWRITE_P50_GUARD_MS)} ms）`,
      ).toBeLessThan(PREWRITE_P50_GUARD_MS);
    } finally {
      store.dispose();
    }
  });

  test('大批次（100 事件）prewrite 仍不高于护栏：同步路径不做整批 JSON 序列化', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 10_000, commitIntervalMs: 10_000 },
    });
    try {
      await store.ready();
      const events = Array.from({ length: 100 }, () => makeEvent({ bytes: 200 }));
      const batch = makeBatch({ events });
      const samples: number[] = [];
      for (let index = 0; index < 300; index += 1) {
        const startedAt = performance.now();
        store.prewrite(batch);
        samples.push(performance.now() - startedAt);
      }
      const p50 = median(samples);
      expect(
        p50,
        `100 事件批次 prewrite P50 实测 ${p50.toFixed(5)} ms（回归护栏 ${String(PREWRITE_P50_GUARD_MS)} ms）`,
      ).toBeLessThan(PREWRITE_P50_GUARD_MS);
    } finally {
      store.dispose();
    }
  });

  test('真实 IndexedDB 下的异步提交耗时只记录、不断言（权威验证归 T20）', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      dbName: freshDbName(),
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      for (let index = 0; index < 20; index += 1) {
        await store.prewrite(makeBatch()).settled;
      }
      const exposure = store.stats().exposure;
      // 记录数据（供 T20/T32 取用），不做绝对墙钟断言。
      expect(exposure.commitLatencyP50Ms).not.toBeNull();
      expect(exposure.commitLostEvents).toBe(0);
    } finally {
      store.dispose();
    }
  });
});
