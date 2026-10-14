/**
 * D-1 回归：**intent 锚点必须在 `prewrite()` 的同一同步回合落痕**。
 *
 * 缺陷（T29 真实浏览器实测，见 `docs/reports/e2e-d004-hardkill.md` 的 D-1）：
 * intent 只在 `flush()` 里写，而 `prewrite()` 同步只入内存；于是「事件已产生、
 * 锚点未落」这段窗口里的硬杀会让事件**既丢失又不计数**（`prewrite_commit_lost = 0`），
 * 违反 D004 结论第 1 条。
 *
 * 本文件钉住三件事：
 * 1. **落痕时机（不依赖 `fake-indexeddb` 的语义断言）**：`prewrite()` 返回时，
 *    锚点已由后端同步受理；且它**只写 `meta`**，未提交的数据不得被当成已持久化读回。
 * 2. **窗口可对账**：锚点落盘、数据事务从未 `oncomplete` 时硬杀 →
 *    未提交事件必须计入 `prewrite_commit_lost`（不是静默消失），且**只计一次**。
 * 3. **正常路径不多计**：等到 `oncomplete` 之后再硬杀 → 不得把已落盘的计成 lost。
 *
 * 边界（本次改动最容易搞错的地方）：锚点落痕**只为计数**；`oncomplete` 仍是唯一
 * durability 点，`list()` / `read()` 在读锚点时一律看不到未提交的数据。
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import { META_INTENT_PREFIX, REASON_PREWRITE_COMMIT_LOST } from './constants';
import { createCountersSpy, createRecordingBackend, makeBatch, makeEvent } from './fixtures';
import { createIdbBackend } from './idb-backend';
import { createOfflineStore } from './offline-store';
import type { OfflineBackend } from './types';

let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `wr-test-intent-anchor-${String(dbCounter)}`;
}

const T0 = 1_700_000_000_000;
const DEAD_SESSION_MS = 90_000;

/** 极限节流：commit 阈值与定时器都远大于样本量，flush 在测试内不会发起。 */
const NO_FLUSH = { commitBatchSize: 1_000_000, commitIntervalMs: 1_000_000 } as const;

interface IntentState {
  readonly total_enqueued: number;
  readonly total_committed: number;
}

/** 从内存后端读回 intent 锚点（只用合法 JSON 的伪造数据）。 */
function readAnchor(metas: ReadonlyMap<string, { readonly value: string }>, sessionId: string): IntentState | null {
  const entry = metas.get(`${META_INTENT_PREFIX}${sessionId}`);
  if (entry === undefined) return null;
  const parsed: unknown = JSON.parse(entry.value);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const enqueued = record['total_enqueued'];
  const committed = record['total_committed'];
  if (typeof enqueued !== 'number' || typeof committed !== 'number') return null;
  return { total_enqueued: enqueued, total_committed: committed };
}

describe('D-1 intent 锚点在 prewrite 同步落痕', () => {
  test('语义断言（不用 fake-indexeddb）：prewrite 返回时锚点已被同步受理，且未提交数据不可读回', async () => {
    const recorder = createRecordingBackend();
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      now: () => T0,
      limits: { commitBatchSize: NO_FLUSH.commitBatchSize, commitIntervalMs: NO_FLUSH.commitIntervalMs },
    });
    try {
      await store.ready();
      const handle = store.prewrite(makeBatch());

      // 落痕时机：`prewrite` 返回后**同一个同步回合**里，锚点已经写入后端 meta。
      // （不是等 `commitIntervalMs` 定时器、也不是等 `commitBatchSize` 阈值。）
      const anchor = readAnchor(recorder.metas, 'session-a');
      expect(anchor).toEqual({ total_enqueued: 1, total_committed: 0 });

      // 边界：锚点只为计数，不是 durability 点 —— 未提交的记录/摘要一个都没有，
      // 因此 `list()` / `read()` 看不到这批数据。
      expect(recorder.records.size).toBe(0);
      expect(recorder.summaries.size).toBe(0);
      expect(await store.list(10)).toEqual([]);
      expect(await store.read(handle.batchId)).toBeNull();
    } finally {
      store.dispose();
    }
  });

  test('锚点落盘后硬杀（数据事务从未 oncomplete）：计入 prewrite_commit_lost，且只计一次', async () => {
    const dbName = freshDbName();
    const counters = createCountersSpy();
    const inner = createIdbBackend({ dbName });
    const intentWrites: Promise<void>[] = [];
    const backend: OfflineBackend = {
      ...inner,
      // 数据事务永不 oncomplete：模拟「锚点已落、数据未落」的硬杀现场。
      commit: (): Promise<void> => new Promise<void>(() => undefined),
      putMeta: (entry) => {
        const pending = inner.putMeta(entry);
        if (entry.key.startsWith(META_INTENT_PREFIX)) intentWrites.push(pending);
        return pending;
      },
    };
    const storeA = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend,
      now: () => T0,
      limits: { commitBatchSize: NO_FLUSH.commitBatchSize, commitIntervalMs: NO_FLUSH.commitIntervalMs },
    });
    try {
      await storeA.ready();
      storeA.prewrite(
        makeBatch({ events: [makeEvent(), makeEvent(), makeEvent()] }),
      );
      // 锚点是同步发起的（这条断言本身就是 D-1 的核心：不能再等 flush）。
      expect(intentWrites.length).toBeGreaterThan(0);
      // 等锚点事务 oncomplete —— 此后就是「事件已产生、锚点已落、数据未落」的窗口。
      await Promise.all(intentWrites);
    } finally {
      // 硬杀：数据事务从未提交，store 的 dispose 不会也不能「补落」数据。
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
      expect(storeB.commitLoss().events).toBe(3);
      expect(storeB.commitLoss().sessionIds).toEqual(['session-a']);
      // 只计一次：3 条事件 → 计数恰好 3（不得在 prewrite 与 flush 各计一遍）。
      expect(counters.get(REASON_PREWRITE_COMMIT_LOST)).toBe(3);
      // 边界：锚点没有把未提交的数据变成"已持久化"。
      expect(await storeB.list(10)).toEqual([]);
      expect(storeB.stats().storedBatches).toBe(0);
    } finally {
      storeB.dispose();
    }
  });

  test('锚点写入同步抛错时 prewrite 仍不向业务抛错（versionchange 关连接的真实场景）', async () => {
    // 真机复测抓到过：`versionchange` 让后端连接关闭后，`putMeta` 会**同步**抛
    // `offline database is not open`；锚点是新增的同步调用，必须自己吞掉。
    const inner = createIdbBackend({ dbName: freshDbName() });
    const store = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: {
        ...inner,
        putMeta: (entry: { readonly key: string; readonly value: string }): Promise<void> => {
          // 只让锚点写入同步抛错；格式版本元数据写入仍走真实后端，保证 open 成功。
          if (entry.key.startsWith(META_INTENT_PREFIX)) {
            throw new Error('offline database is not open');
          }
          return inner.putMeta(entry);
        },
      },
      now: () => T0,
      limits: { commitBatchSize: NO_FLUSH.commitBatchSize, commitIntervalMs: NO_FLUSH.commitIntervalMs },
    });
    try {
      await store.ready();
      expect(() => store.prewrite(makeBatch())).not.toThrow();
      // 锚点失败不影响内存账目：事件仍按暴露窗口计量。
      expect(store.stats().exposure.pendingEvents).toBe(1);
    } finally {
      store.dispose();
    }
  });

  test('正常路径（等到 oncomplete）：已落盘的事件不得多计成 lost', async () => {
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
      // 已落盘的不丢，也不被锚点打扰。
      expect(await storeB.list(10)).toHaveLength(1);
    } finally {
      storeB.dispose();
    }
  });
});
