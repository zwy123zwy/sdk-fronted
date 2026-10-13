/**
 * C07 离线存储的调度与账目：批量提交（100 条 / 200 ms 取先到者）、溢出转离线
 * （C06 的 `OfflineSpillPort`）、补发记账（`markAttempt`）、列表排序与统计。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, createRecordingBackend, makeBatch, makeEvent, TEST_HEADER } from './fixtures';
import { createOfflineStore } from './offline-store';

describe('C07 离线存储调度与账目', () => {
  test('批量提交：达到 commitBatchSize 立即提交（取先到者）', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      header: { header: () => TEST_HEADER },
      backend: recorder.backend,
      limits: { commitBatchSize: 2, commitIntervalMs: 10_000 },
    });
    try {
      await store.ready();
      const first = store.prewrite(makeBatch());
      const second = store.prewrite(makeBatch());
      await Promise.all([first.settled, second.settled]);
      // 两条一起提交（一次事务），不必等 10 秒的间隔
      expect(recorder.writes).toHaveLength(1);
      expect(recorder.writes[0]).toHaveLength(2);
      expect(store.stats().storedBatches).toBe(2);
    } finally {
      store.dispose();
    }
  });

  test('批量提交：未达条数时由间隔定时器提交', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 100, commitIntervalMs: 20 },
    });
    try {
      await store.ready();
      const handle = store.prewrite(makeBatch());
      // 间隔到期之前不提交
      expect(recorder.writes).toHaveLength(0);
      const outcome = await handle.settled;
      expect(outcome).toEqual({ status: 'durable' });
      expect(recorder.writes).toHaveLength(1);
    } finally {
      store.dispose();
    }
  });

  test('溢出转离线（C06 OfflineSpillPort）：受理并落盘为单事件批次', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      header: { header: () => TEST_HEADER },
      backend: recorder.backend,
      limits: { commitBatchSize: 1 },
    });
    try {
      await store.ready();
      const event = makeEvent({ priority: 'critical' });
      const accepted = store.spill(event, 'queue_overflow');
      expect(accepted).toBe(true);
      await store.drain();
      const records = await store.list(10);
      expect(records).toHaveLength(1);
      expect(records[0]?.event_count).toBe(1);
      expect(records[0]?.critical_count).toBe(1);
      const batch = records[0] === undefined ? null : await store.read(records[0].batch_id);
      expect(batch?.events[0]?.event_id).toBe(event.event_id);
    } finally {
      store.dispose();
    }
  });

  test('溢出转离线：没有批次头时拒绝受理（返回 false，不抛错）', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
    });
    try {
      await store.ready();
      expect(store.spill(makeEvent(), 'queue_overflow')).toBe(false);
    } finally {
      store.dispose();
    }
  });

  test('list 按 enqueued_at 升序（FIFO，供淘汰与补发使用）', async () => {
    const recorder = createRecordingBackend();
    let now = 1_000;
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      now: () => now,
      limits: { commitBatchSize: 1 },
    });
    try {
      await store.ready();
      const a = makeBatch();
      const b = makeBatch();
      const c = makeBatch();
      now = 2_000;
      await store.prewrite(b).settled;
      now = 1_500;
      await store.prewrite(a).settled;
      now = 3_000;
      await store.prewrite(c).settled;
      const listed = await store.list(10);
      expect(listed.map((item) => item.batch_id)).toEqual([a.batch_id, b.batch_id, c.batch_id]);
    } finally {
      store.dispose();
    }
  });

  test('markAttempt 记录补发尝试次数与时间（失败退避用）', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      now: () => 5_000,
    });
    try {
      await store.ready();
      const batch = makeBatch();
      await store.prewrite(batch).settled;
      await store.markAttempt(batch.batch_id);
      await store.markAttempt(batch.batch_id);
      const listed = await store.list(10);
      expect(listed[0]?.attempt_count).toBe(2);
    } finally {
      store.dispose();
    }
  });

  test('writeFailures 记入 stats（不抛错、不影响后续写入）', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
    });
    try {
      await store.ready();
      recorder.failNextCommit(new Error('boom'));
      const failed = await store.prewrite(makeBatch()).settled;
      expect(failed.status).toBe('rejected');
      // 后续写入仍然可用
      const ok = await store.prewrite(makeBatch()).settled;
      expect(ok).toEqual({ status: 'durable' });
      expect(store.stats().writeFailures).toBe(1);
    } finally {
      store.dispose();
    }
  });
});
