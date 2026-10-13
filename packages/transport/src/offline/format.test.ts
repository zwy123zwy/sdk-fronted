/**
 * C07-AC-22 离线数据格式不兼容：**静默清理，不抛错**，计 `offline_incompatible`。
 *
 * 三条路径都要覆盖：
 * 1. 记录格式版本（`meta/format`）与当前 SDK 不一致 → 整库清空；
 * 2. 数据库结构版本回退（另一个更高版本的 SDK 建过库）→ `VersionError` → 删除重建；
 * 3. 个别记录被外部写坏（`format_version` 不符）→ 只删该条。
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { createCountersSpy, createRecordingBackend, makeBatch, testUuid } from './fixtures';
import { toSummary } from './format';
import { createIdbBackend } from './idb-backend';
import { createOfflineStore } from './offline-store';
import type { OfflineRecord } from './types';

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `wr-test-format-${String(dbCounter)}`;
}

describe('C07-AC-22 格式不兼容清理', () => {
  test('AC-22 记录格式版本变化：下次打开整库清空并计 offline_incompatible', async () => {
    const dbName = freshDbName();
    const first = createOfflineStore({ appId: 'demo-app', sessionId: 'session-a', dbName });
    await first.ready();
    await first.prewrite(makeBatch()).settled;
    expect(await first.list(10)).toHaveLength(1);
    first.dispose();

    const counters = createCountersSpy();
    const second = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      dbName,
      formatVersion: 2,
      counters: counters.port,
    });
    try {
      await second.ready();
      expect(await second.list(10)).toEqual([]);
      expect(second.stats().storedBatches).toBe(0);
      expect(counters.get('offline_incompatible')).toBeGreaterThanOrEqual(1);
    } finally {
      second.dispose();
    }
  });

  test('AC-22 数据库结构版本回退：VersionError → 删除重建，不抛错', async () => {
    const dbName = freshDbName();
    // 先用更高结构版本建库（模拟另一个更新版本的 SDK 写过的数据）
    const newer = createIdbBackend({ dbName, dbVersion: 2 });
    const result = await newer.open();
    expect(result).toBe('ok');
    newer.close();

    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      dbName,
      dbVersion: 1,
      counters: counters.port,
    });
    try {
      await store.ready();
      expect(store.stats().available).toBe(true);
      expect(await store.list(10)).toEqual([]);
      expect(counters.get('offline_incompatible')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('AC-22 个别记录被写坏：只删该条，保留其余', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      limits: { commitBatchSize: 100, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      const good = makeBatch();
      await store.prewrite(good).settled;
      const corruptedId = testUuid(999999);
      const corrupted: OfflineRecord = {
        batch_id: corruptedId,
        format_version: 99,
        app_id: 'demo-app',
        session_id: 'session-a',
        enqueued_at: 1,
        committed_at: 1,
        has_critical: true,
        event_count: 1,
        critical_count: 1,
        bytes: 10,
        attempt_count: 0,
        last_attempt_at: null,
        batch: makeBatch({ batchId: corruptedId }),
      };
      recorder.records.set(corruptedId, corrupted);
      recorder.summaries.set(corruptedId, toSummary(corrupted));

      // 重新打开一次以走启动清理路径
      const reopened = createOfflineStore({
        appId: 'demo-app',
        sessionId: 'session-a',
        backend: recorder.backend,
        counters: counters.port,
      });
      try {
        await reopened.ready();
        const listed = await reopened.list(10);
        expect(listed.map((item) => item.batch_id)).toEqual([good.batch_id]);
        expect(counters.get('offline_incompatible')).toBeGreaterThanOrEqual(1);
      } finally {
        reopened.dispose();
      }
    } finally {
      store.dispose();
    }
  });

  test('AC-22 读到时才发现不兼容：删除该条并返回 null', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      limits: { commitBatchSize: 100, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      const batch = makeBatch();
      await store.prewrite(batch).settled;
      const stored = recorder.records.get(batch.batch_id);
      expect(stored).toBeDefined();
      if (stored !== undefined) recorder.records.set(batch.batch_id, { ...stored, format_version: 42 });
      expect(await store.read(batch.batch_id)).toBeNull();
      expect(counters.get('offline_incompatible')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });
});
