/**
 * 暴露窗口（D004）与 CR-001 计数。
 *
 * D004 的口径：「已落盘不丢 + 未提交部分按暴露窗口计量并单独计数」。
 * 本文件提供**正向/负向对照**，证明测量不是空转：
 *
 * | 对照 | 期望 |
 * |---|---|
 * | 正常提交 | `settled === durable`；`list()` 可见；暴露窗口归零；重启后对账 0 |
 * | 事务推迟（永不提交） | `settled` 不解析；`list()` 看不到；暴露窗口 > 0；重启后对账出 `prewrite_commit_lost` |
 *
 * 「事件已产生但事务未提交」的**真实浏览器**版本（延迟提交 + SIGKILL + 重启读回）归 T29；
 * 这里用真实 IndexedDB 事务语义 + 受控的"会话死亡"时间线来测同一段逻辑。
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import {
  METRIC_EXPOSURE_WINDOW_EVENTS,
  METRIC_EXPOSURE_WINDOW_MS,
  REASON_PREWRITE_COMMIT_LOST,
} from './constants';
import { createCountersSpy, createRecordingBackend, makeBatch } from './fixtures';
import { createIdbBackend } from './idb-backend';
import { createOfflineStore } from './offline-store';
import type { OfflineBackend } from './types';

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `wr-test-exposure-${String(dbCounter)}`;
}

const T0 = 1_700_000_000_000;
const DEAD_SESSION_MS = 90_000;

function neverCommitting(inner: OfflineBackend): OfflineBackend {
  return { ...inner, commit: (): Promise<void> => new Promise<void>(() => undefined) };
}

describe('暴露窗口与 CR-001 计数', () => {
  test('正向：提交期间窗口 > 0，提交完成后归零', async () => {
    const recorder = createRecordingBackend();
    const release: { current: (() => void) | null } = { current: null };
    const gate = new Promise<void>((resolve) => {
      release.current = resolve;
    });
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: {
        ...recorder.backend,
        commit: async (records, metas) => {
          await gate;
          await recorder.backend.commit(records, metas);
        },
      },
      now: () => T0,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      const handle = store.prewrite(makeBatch());
      // 让 flush 进入提交中状态
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      const during = store.stats().exposure;
      expect(during.pendingEvents).toBe(1);
      expect(during.pendingBatches).toBe(1);

      expect(release.current).not.toBeNull();
      release.current?.();
      expect(await handle.settled).toEqual({ status: 'durable' });

      const after = store.stats().exposure;
      expect(after.pendingEvents).toBe(0);
      expect(after.pendingBatches).toBe(0);
      expect(after.commitLatencyP50Ms).not.toBeNull();
    } finally {
      store.dispose();
    }
  });

  test('负向对照：永不提交时窗口保持 > 0，且不当作已落盘', async () => {
    const recorder = createRecordingBackend();
    let current = T0;
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: neverCommitting(recorder.backend),
      now: () => current,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await store.ready();
      store.prewrite(makeBatch());
      current = T0 + 1_000;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      const exposure = store.stats().exposure;
      expect(exposure.pendingEvents).toBe(1);
      expect(exposure.oldestPendingMs).toBe(1_000);
      expect(await store.list(10)).toEqual([]);
    } finally {
      store.dispose();
    }
  });

  test('CR-001 负向对照：死亡会话的未提交事件在重启后计为 prewrite_commit_lost', async () => {
    const dbName = freshDbName();
    const counters = createCountersSpy();
    // 会话 A：写了 intent，但数据事务永不提交（模拟硬杀在提交前发生）
    const storeA = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: neverCommitting(createIdbBackend({ dbName })),
      now: () => T0,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await storeA.ready();
      storeA.prewrite(makeBatch());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
    } finally {
      storeA.dispose();
    }

    // 会话 B：晚于 deadSessionMs 之后启动，对上一次会话对账
    const storeB = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-b',
      dbName,
      now: () => T0 + 10 * DEAD_SESSION_MS,
      counters: counters.port,
    });
    try {
      await storeB.ready();
      const report = storeB.commitLoss();
      expect(report.events).toBe(1);
      expect(report.sessionIds).toEqual(['session-a']);
      expect(report.windowMs).toBeGreaterThan(0);
      expect(counters.get(REASON_PREWRITE_COMMIT_LOST)).toBe(1);
      const exposure = storeB.stats().exposure;
      expect(exposure.commitLostEvents).toBe(1);
      expect(exposure.commitLostWindowMs).toBeGreaterThan(0);
    } finally {
      storeB.dispose();
    }
  });

  test('CR-001 正向对照：正常提交的会话不产生假的 commit_lost（测量非空转）', async () => {
    const dbName = freshDbName();
    const counters = createCountersSpy();
    const storeA = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      dbName,
      now: () => T0,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await storeA.ready();
      await storeA.prewrite(makeBatch()).settled;
    } finally {
      storeA.dispose();
    }

    const storeB = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-b',
      dbName,
      now: () => T0 + 10 * DEAD_SESSION_MS,
      counters: counters.port,
    });
    try {
      await storeB.ready();
      expect(storeB.commitLoss().events).toBe(0);
      expect(counters.get(REASON_PREWRITE_COMMIT_LOST)).toBe(0);
      // 对照组同时证明"已落盘不丢"：A 的批次在 B 里读得到
      expect(await storeB.list(10)).toHaveLength(1);
      const exposure = storeB.stats().exposure;
      expect(exposure.commitLostEvents).toBe(0);
      // CR-001 的约束：事件数为 0 时不上报窗口时长
      expect(exposure.commitLostWindowMs).toBeNull();
    } finally {
      storeB.dispose();
    }
  });

  test('CR-001 存活会话不被误判：另一个标签页仍在窗口内则不回收', async () => {
    const dbName = freshDbName();
    const counters = createCountersSpy();
    const storeA = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: neverCommitting(createIdbBackend({ dbName })),
      now: () => T0,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    try {
      await storeA.ready();
      storeA.prewrite(makeBatch());
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
    } finally {
      storeA.dispose();
    }

    // B 只比 A 晚 1 秒启动：A 可能仍存活，不得对账、不得回收
    const storeB = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-b',
      dbName,
      now: () => T0 + 1_000,
      counters: counters.port,
    });
    try {
      await storeB.ready();
      expect(storeB.commitLoss().events).toBe(0);
      expect(counters.get(REASON_PREWRITE_COMMIT_LOST)).toBe(0);
    } finally {
      storeB.dispose();
    }
  });

  test('CR-001 指标名与常量已按契约值导出', () => {
    expect(REASON_PREWRITE_COMMIT_LOST).toBe('prewrite_commit_lost');
    expect(METRIC_EXPOSURE_WINDOW_EVENTS).toBe('exposure_window_events');
    expect(METRIC_EXPOSURE_WINDOW_MS).toBe('exposure_window_ms');
  });
});
