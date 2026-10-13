/**
 * C07-AC-16 离线存储上限与淘汰：**多上限同时生效、最严者先触发**，溢出先淘汰 normal。
 *
 * 上限口径（已裁定）：5,000 条事件 + 2,000 批 + 5 MB + 7 天，四者同时生效；
 * 每次淘汰都计 `offline_evicted`（reason-codes.md 第 1 节）。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, createRecordingBackend, makeBatch, makeEvent } from './fixtures';
import { createOfflineStore } from './offline-store';

describe('C07-AC-16 离线上限与淘汰', () => {
  test('事件条数上限：超出时淘汰最早的批次并计 offline_evicted', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    let now = 1_000;
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      now: () => now,
      limits: {
        maxEvents: 4,
        maxBatches: 100,
        maxBytes: 10_000_000,
        commitBatchSize: 100,
        commitIntervalMs: 5,
      },
    });
    try {
      await store.ready();
      const pair = (): ReturnType<typeof makeBatch> =>
        makeBatch({ events: [makeEvent(), makeEvent()] });
      const first = pair();
      now = 2_000;
      await store.prewrite(first).settled;
      now = 3_000;
      await store.prewrite(pair()).settled;
      now = 4_000;
      await store.prewrite(pair()).settled;

      const listed = await store.list(10);
      expect(listed.length).toBeLessThan(3);
      expect(listed.some((item) => item.batch_id === first.batch_id)).toBe(false);
      expect(counters.get('offline_evicted')).toBeGreaterThanOrEqual(1);
      expect(store.stats().storedEvents).toBeLessThanOrEqual(4);
      expect(store.stats().evictedBatches).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('批次数上限：超出时淘汰最早的批次', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    let now = 1_000;
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      now: () => now,
      limits: { maxEvents: 1_000, maxBatches: 2, maxBytes: 10_000_000, commitBatchSize: 100 },
    });
    try {
      await store.ready();
      for (let index = 0; index < 3; index += 1) {
        now = 2_000 + index;
        await store.prewrite(makeBatch()).settled;
      }
      const listed = await store.list(10);
      expect(listed).toHaveLength(2);
      expect(counters.get('offline_evicted')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('体积上限：超出时淘汰最早的批次', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    let now = 1_000;
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      now: () => now,
      limits: {
        maxEvents: 1_000,
        maxBatches: 100,
        maxBytes: 900,
        commitBatchSize: 100,
      },
    });
    try {
      await store.ready();
      for (let index = 0; index < 4; index += 1) {
        now = 2_000 + index;
        await store.prewrite(makeBatch({ events: [makeEvent({ bytes: 400 })] })).settled;
      }
      expect(store.stats().storedBytes).toBeLessThanOrEqual(900);
      expect(counters.get('offline_evicted')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('淘汰顺序：先淘汰 normal 批次，再淘汰 critical 批次', async () => {
    const recorder = createRecordingBackend();
    let now = 1_000;
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      now: () => now,
      limits: { maxEvents: 1_000, maxBatches: 2, maxBytes: 10_000_000, commitBatchSize: 100 },
    });
    try {
      await store.ready();
      const normal = makeBatch({ events: [makeEvent({ priority: 'normal' })] });
      now = 1_100;
      await store.prewrite(normal).settled;
      const critical = makeBatch({ events: [makeEvent({ priority: 'critical' })] });
      now = 1_200;
      await store.prewrite(critical).settled;
      const newest = makeBatch({ events: [makeEvent({ priority: 'critical' })] });
      now = 1_300;
      await store.prewrite(newest).settled;

      const listed = await store.list(10);
      // normal 最先被淘汰，即使它比某些 critical 更晚写入
      expect(listed.some((item) => item.batch_id === normal.batch_id)).toBe(false);
      expect(listed.some((item) => item.batch_id === critical.batch_id)).toBe(true);
      expect(listed.some((item) => item.batch_id === newest.batch_id)).toBe(true);
    } finally {
      store.dispose();
    }
  });

  test('7 天保留期：过期记录在 list 时清理并计 offline_evicted', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    let now = 1_000;
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      now: () => now,
      limits: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, commitBatchSize: 100 },
    });
    try {
      await store.ready();
      await store.prewrite(makeBatch()).settled;
      expect(await store.list(10)).toHaveLength(1);
      now += 8 * 24 * 60 * 60 * 1000;
      expect(await store.list(10)).toEqual([]);
      expect(counters.get('offline_evicted')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('淘汰不抛错：淘汰后仍可继续写入', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { maxBatches: 1, maxEvents: 1_000, maxBytes: 10_000_000, commitBatchSize: 100 },
    });
    try {
      await store.ready();
      await store.prewrite(makeBatch()).settled;
      await store.prewrite(makeBatch()).settled;
      const outcome = await store.prewrite(makeBatch()).settled;
      expect(outcome).toEqual({ status: 'durable' });
      expect(store.stats().storedBatches).toBe(1);
    } finally {
      store.dispose();
    }
  });
});
