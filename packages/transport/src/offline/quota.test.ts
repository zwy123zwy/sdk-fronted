/**
 * C07-AC-23（存储侧）配额与不可用：**写入被拒时计数且不向业务抛错**。
 *
 * D004 强制：离线副本只用 IndexedDB，**完全不用 localStorage**；因此
 * 「IndexedDB 不可用」即计 `storage_unavailable`（AC-23 的"两者都不可用"是其真子集）。
 *
 * 真实 `QuotaExceededError` 在本环境构造不出来（POC-1-storage 局限第 4 条），
 * 这里用**合成的 `QuotaExceededError`** 验证检测与降级路径；真实配额耗尽归 T29。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, createRecordingBackend, makeBatch, makeEvent, TEST_HEADER } from './fixtures';
import { createOfflineStore } from './offline-store';

function quotaError(): Error {
  return new DOMException('quota exceeded', 'QuotaExceededError');
}

describe('C07-AC-23 离线存储不可用与配额', () => {
  test('AC-23 无 indexedDB：预写降级为 rejected(unavailable)，计 storage_unavailable，不抛错', async () => {
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      idbFactory: null,
      counters: counters.port,
    });
    try {
      await store.ready();
      const outcome = await store.prewrite(makeBatch()).settled;
      expect(outcome).toEqual({ status: 'rejected', reason: 'unavailable' });
      expect(counters.get('storage_unavailable')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('AC-23 不传 idbFactory 时以 globalThis.indexedDB 为准（本环境无 IDB）', async () => {
    // 前置断言：本文件不加载 fake-indexeddb，happy-dom 没有 indexedDB。
    expect(typeof indexedDB).toBe('undefined');
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      counters: counters.port,
    });
    try {
      await store.ready();
      const outcome = await store.prewrite(makeBatch()).settled;
      expect(outcome.status).toBe('rejected');
      expect(counters.get('storage_unavailable')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('D004 离线模块不写 localStorage（运行时对照；源级扫描归 T31/T29 的 tests 范围）', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      idbFactory: null,
    });
    try {
      await store.ready();
      await store.prewrite(makeBatch()).settled;
      await store.list(10);
      await store.clear();
      // D004：离线副本只用 IndexedDB；整条失败路径不留下任何 localStorage 键。
      expect(localStorage.length).toBe(0);
    } finally {
      store.dispose();
    }
  });

  test('配额失败：先淘汰再重试一次，成功则不降级计数', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      limits: { maxBatches: 100, maxEvents: 1_000, maxBytes: 10_000_000, commitBatchSize: 1 },
    });
    try {
      await store.ready();
      const stored = makeBatch();
      await store.prewrite(stored).settled;
      recorder.failNextCommit(quotaError());
      const outcome = await store.prewrite(makeBatch()).settled;
      expect(outcome).toEqual({ status: 'durable' });
      // 触发过一次淘汰（把已存量降到更低水位）
      expect(recorder.deletes.length).toBeGreaterThanOrEqual(1);
      expect(counters.get('storage_unavailable')).toBe(0);
    } finally {
      store.dispose();
    }
  });

  test('配额持续失败：降级为 rejected(quota) 并计 storage_unavailable，不抛错', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      limits: { commitBatchSize: 1 },
    });
    try {
      await store.ready();
      const failing = {
        ...recorder.backend,
        commit: (): Promise<void> => Promise.reject(quotaError()),
      };
      const failingStore = createOfflineStore({
        appId: 'demo-app',
        sessionId: 'session-a',
        backend: failing,
        counters: counters.port,
        limits: { commitBatchSize: 1 },
      });
      try {
        await failingStore.ready();
        const outcome = await failingStore.prewrite(makeBatch()).settled;
        expect(outcome).toEqual({ status: 'rejected', reason: 'quota' });
        expect(counters.get('storage_unavailable')).toBeGreaterThanOrEqual(1);
      } finally {
        failingStore.dispose();
      }
    } finally {
      store.dispose();
    }
  });

  test('非配额错误：降级为 rejected(unavailable)，不抛错', async () => {
    const recorder = createRecordingBackend();
    const counters = createCountersSpy();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      counters: counters.port,
      limits: { commitBatchSize: 1 },
    });
    try {
      await store.ready();
      recorder.failNextCommit(new Error('disk on fire'));
      const outcome = await store.prewrite(makeBatch()).settled;
      expect(outcome).toEqual({ status: 'rejected', reason: 'unavailable' });
      expect(counters.get('storage_unavailable')).toBeGreaterThanOrEqual(1);
    } finally {
      store.dispose();
    }
  });

  test('spill 在存储不可用时返回 false（C06 会据此计 storage_unavailable）', async () => {
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      idbFactory: null,
      header: { header: () => TEST_HEADER },
    });
    try {
      await store.ready();
      expect(store.spill(makeEvent(), 'queue_overflow')).toBe(false);
    } finally {
      store.dispose();
    }
  });
});
