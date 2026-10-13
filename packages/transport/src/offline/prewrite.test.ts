/**
 * C07-F5 预写：**唯一落盘点是事务 `oncomplete`**（D004 强制要求）。
 *
 * 证据要点（对应派工第 8 点「如何在测试里真实地制造并观测这个窗口」）：
 * - 正向：`settled` 只在 `oncomplete` 之后解析为 `durable`，此前 `list()` 看不到该批次；
 * - 负向对照：把一个**永不提交**的事务交给 store（用装饰过的真实后端制造），
 *   `settled` 永远不解析、`list()` 看不到 —— 证明代码确实在等 `oncomplete`，
 *   而不是把 `put()` 被调用当成已落盘（R1，最严重的数据丢失路径）。
 *
 * 真实浏览器上的落盘持久性（SIGKILL 后读回）归 T29，本文件不冒充该证据。
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import type { BatchEnvelope } from '../batch/types';
import { createCountersSpy, createRecordingBackend, makeBatch, makeEvent } from './fixtures';
import { createIdbBackend } from './idb-backend';
import { createOfflineStore } from './offline-store';
import type { OfflineBackend, PrewriteOutcome } from './types';

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `wr-test-prewrite-${String(dbCounter)}`;
}

/** 装饰后端：`commit` 永不解析（模拟「事件已产生但事务未提交」）。 */
function neverCommitting(inner: OfflineBackend): OfflineBackend {
  return {
    ...inner,
    commit: (): Promise<void> => new Promise<void>(() => undefined),
  };
}

/** 装饰后端：`commit` 以中止错误拒绝（模拟事务被页面销毁打断）。 */
function aborting(inner: OfflineBackend): OfflineBackend {
  return {
    ...inner,
    commit: (): Promise<void> =>
      Promise.reject(new DOMException('transaction aborted', 'AbortError')),
  };
}

describe('C07-F5 预写（AC-12 / AC-13）', () => {
  test('AC-12 预写：settled 只在事务 oncomplete 后解析为 durable，此前不可见', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      limits: { commitIntervalMs: 5 },
      dbName: freshDbName(),
    });
    try {
      await store.ready();
      const batch = makeBatch();
      const handle = store.prewrite(batch);

      // 句柄同步可得（调用方不等 I/O）
      expect(handle.batchId).toBe(batch.batch_id);
      expect(handle.eventCount).toBe(1);
      expect(handle.criticalCount).toBe(1);
      expect(handle.bytes).toBeGreaterThan(0);

      const outcome = await handle.settled;
      expect(outcome).toEqual({ status: 'durable' });

      const listed = await store.list(10);
      expect(listed.map((item) => item.batch_id)).toEqual([batch.batch_id]);

      const readBack = await store.read(batch.batch_id);
      expect(readBack?.batch_id).toBe(batch.batch_id);
      expect(readBack?.events.map((event) => event.event_id)).toEqual(
        batch.events.map((event) => event.event_id),
      );
    } finally {
      store.dispose();
    }
  });

  test('AC-13 负向对照：永不提交的事务不得被视为已落盘', async () => {
    const inner = createIdbBackend({ dbName: freshDbName() });
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      limits: { commitIntervalMs: 5 },
      backend: neverCommitting(inner),
    });
    try {
      await store.ready();
      const batch = makeBatch();
      const handle = store.prewrite(batch);
      const seen: PrewriteOutcome[] = [];
      void handle.settled.then((value) => {
        seen.push(value);
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(seen).toEqual([]);
      expect(await store.list(10)).toEqual([]);
      // 未提交的事件按暴露窗口计量，而不是当作已落盘
      expect(store.stats().exposure.pendingEvents).toBe(1);
    } finally {
      store.dispose();
    }
  });

  test('AC-12 删除副本幂等：remove 不存在的 batch_id 不抛错', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      limits: { commitIntervalMs: 5 },
      dbName: freshDbName(),
    });
    try {
      await store.ready();
      const batch = makeBatch();
      await store.prewrite(batch).settled;
      await store.remove([batch.batch_id]);
      await store.remove([batch.batch_id]);
      expect(await store.list(10)).toEqual([]);
    } finally {
      store.dispose();
    }
  });

  test('AC-12 重复预写同一 batch_id 幂等（重试复用同一批次）', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      limits: { commitIntervalMs: 5 },
      dbName: freshDbName(),
    });
    try {
      await store.ready();
      const batch = makeBatch();
      await store.prewrite(batch).settled;
      await store.prewrite(batch).settled;
      const listed = await store.list(10);
      expect(listed).toHaveLength(1);
      expect(store.stats().storedBatches).toBe(1);
    } finally {
      store.dispose();
    }
  });

  test('AC-12 混合批次：含 critical 即整批预写，normal 事件随批保存', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      limits: { commitIntervalMs: 5 },
      dbName: freshDbName(),
    });
    try {
      await store.ready();
      const batch = makeBatch({
        events: [makeEvent({ priority: 'critical' }), makeEvent({ priority: 'normal' })],
      });
      const handle = store.prewrite(batch);
      expect(handle.criticalCount).toBe(1);
      expect(handle.eventCount).toBe(2);
      await handle.settled;
      const readBack: BatchEnvelope | null = await store.read(batch.batch_id);
      expect(readBack?.events).toHaveLength(2);
    } finally {
      store.dispose();
    }
  });

  test('预写不向业务抛错：事务被中止时解析为 aborted 并计数，不 reject', async () => {
    const counters = createCountersSpy();
    const inner = createIdbBackend({ dbName: freshDbName() });
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      limits: { commitIntervalMs: 5 },
      backend: aborting(inner),
      counters: counters.port,
    });
    try {
      await store.ready();
      const outcome = await store.prewrite(makeBatch()).settled;
      expect(outcome.status).toBe('aborted');
      expect(await store.list(10)).toEqual([]);
      // 中止是明确的失败路径：计 storage_unavailable（只计数，不向业务抛错）
      expect(counters.get('storage_unavailable')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('预写句柄在 store 未 ready 时也可同步返回（首帧不阻塞）', () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      limits: { commitIntervalMs: 5 },
      backend: recorder.backend,
    });
    try {
      const handle = store.prewrite(makeBatch());
      expect(handle.batchId).toBeTruthy();
      expect(store.stats().exposure.pendingEvents).toBe(1);
    } finally {
      store.dispose();
    }
  });
});
