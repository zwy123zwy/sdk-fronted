/**
 * C07 离线存储（C07-F5 预写 / C07-F6 补发 的存储层）。
 *
 * 设计要点：
 * - **唯一落盘点是事务 `oncomplete`**（D004）；`PrewriteHandle.settled` 在此之前保持 pending；
 * - 批量提交：`commitBatchSize`（100 条）或 `commitIntervalMs`（200 ms）**取先到者**；
 * - 多上限同时生效、最严者先触发，溢出**先淘汰 normal**；每淘汰一条计 `offline_evicted`；
 * - 配额/不可用一律降级为 `rejected` 计数，**绝不向业务抛错**；
 * - 暴露窗口（「已产生但事务未提交」）单独计量：pending 观测量 + intent 对账
 *   （CR-001 的 `prewrite_commit_lost`）；intent 锚点在 `prewrite()` 的**同一同步回合**
 *   落痕（D-1 修复），使该窗口一产生就有痕迹；**锚点只为计数，`oncomplete` 仍是唯一
 *   durability 点**（锚点只写 `meta`，未提交的 `records` / `summaries` 不可读回）；
 * - **完全不用 `localStorage`**（D004）。
 */
import { createBatchAssembler } from '../batch/assembler';
import type { BatchEnvelope, QueueEvent } from '../batch/types';
import type { CountersPort } from '../queue/types';
import {
  DEFAULT_DEAD_SESSION_MS,
  DEFAULT_OFFLINE_LIMITS,
  META_FORMAT_KEY,
  META_INTENT_PREFIX,
  OFFLINE_FORMAT_VERSION,
  REASON_OFFLINE_EVICTED,
  REASON_OFFLINE_INCOMPATIBLE,
  REASON_PREWRITE_COMMIT_LOST,
  REASON_STORAGE_UNAVAILABLE,
} from './constants';
import { createOfflineRecord, isRecordCompatible, toSummary } from './format';
import { createIdbBackend } from './idb-backend';
import type {
  CommitLossReport,
  MetaEntry,
  OfflineBackend,
  OfflineLimits,
  OfflineRecord,
  OfflineRecordSummary,
  OfflineStats,
  OfflineStore,
  OfflineStoreOptions,
  PrewriteHandle,
  PrewriteOutcome,
  PrewriteRejection,
} from './types';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const noopCounters: CountersPort = { count: (): void => undefined };

interface PendingEntry {
  readonly record: OfflineRecord;
  readonly resolve: (outcome: PrewriteOutcome) => void;
  settled: boolean;
}

interface IntentState {
  readonly session_id: string;
  readonly total_enqueued: number;
  readonly total_committed: number;
  readonly first_pending_at: number;
  readonly updated_at: number;
}

const LATENCY_SAMPLE_CAP = 200;

function hasIndexedDb(explicit: IDBFactory | null | undefined): boolean {
  if (explicit === null) return false;
  if (explicit !== undefined) return true;
  return (globalThis as { indexedDB?: IDBFactory | undefined }).indexedDB !== undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'QuotaExceededError';
  }
  return error instanceof Error && error.name === 'QuotaExceededError';
}

function percentile(samples: readonly number[], ratio: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index] ?? null;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseIntent(value: string): IntentState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isObjectLike(parsed)) return null;
  const session = parsed['session_id'];
  const enqueued = parsed['total_enqueued'];
  const committed = parsed['total_committed'];
  const firstPending = parsed['first_pending_at'];
  const updatedAt = parsed['updated_at'];
  if (
    typeof session !== 'string' ||
    typeof enqueued !== 'number' ||
    typeof committed !== 'number' ||
    typeof firstPending !== 'number' ||
    typeof updatedAt !== 'number'
  ) {
    return null;
  }
  return {
    session_id: session,
    total_enqueued: enqueued,
    total_committed: committed,
    first_pending_at: firstPending,
    updated_at: updatedAt,
  };
}

/** 创建离线存储。 */
export function createOfflineStore(options: OfflineStoreOptions): OfflineStore {
  const appId = options.appId;
  const sessionId = options.sessionId;
  const formatVersion = options.formatVersion ?? OFFLINE_FORMAT_VERSION;
  const now = options.now ?? ((): number => Date.now());
  const counters = options.counters ?? noopCounters;
  const deadSessionMs = options.deadSessionMs ?? DEFAULT_DEAD_SESSION_MS;
  const limits: OfflineLimits = { ...DEFAULT_OFFLINE_LIMITS, ...options.limits };
  const summaryScanLimit = Math.max(limits.maxBatches + 1, 5_000);
  const intentKey = `${META_INTENT_PREFIX}${sessionId}`;
  const assembler =
    options.header === undefined ? null : createBatchAssembler({ header: options.header });

  const backend: OfflineBackend =
    options.backend ??
    createIdbBackend({
      dbName: options.dbName,
      dbVersion: options.dbVersion,
      idbFactory: options.idbFactory,
    });
  /** 同步可知的不可用（没有 IndexedDB、也没注入后端）。 */
  const knownUnavailable = options.backend === undefined && !hasIndexedDb(options.idbFactory);

  const index = new Map<string, OfflineRecordSummary>();
  const pending: PendingEntry[] = [];
  const latencySamples: number[] = [];

  let available: boolean | null = null;
  let openPromise: Promise<void> | null = null;
  let timer: TimerHandle | null = null;
  let committing = false;
  let disposed = false;
  let totalEnqueued = 0;
  let totalCommitted = 0;
  let firstPendingAt: number | null = null;
  /** 正在提交中的记录（已离开 `pending`，但事务尚未完成）——暴露窗口的一部分。 */
  let inFlight: readonly PendingEntry[] = [];
  /**
   * intent 锚点（**只为计数**，不是 durability 点）。
   *
   * D-1 修复：锚点在 `prewrite()` 的**同一同步回合**发起，使「事件已产生但事务未提交」
   * 这段窗口在库里立即有痕迹；`oncomplete` 仍是唯一 durability 点 —— 锚点只写 `meta`，
   * 未提交的 `records` / `summaries` 不会因此被读回。
   */
  let anchorsEnabled = false;
  let anchorsPaused = false;
  let anchorBusy = false;
  let anchorQueued = false;
  let anchorTail: Promise<void> = Promise.resolve();
  let resolveAnchorTail: (() => void) | null = null;
  let evictedBatches = 0;
  let evictedEvents = 0;
  let writeFailures = 0;
  let lossReport: CommitLossReport = { events: 0, windowMs: 0, sessionIds: [] };

  function settle(entry: PendingEntry, outcome: PrewriteOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.resolve(outcome);
  }

  function failPending(reason: PrewriteRejection, countStorageUnavailable: boolean): void {
    const entries = pending.splice(0, pending.length);
    if (entries.length === 0) return;
    let events = 0;
    for (const entry of entries) {
      events += entry.record.event_count;
      settle(entry, { status: 'rejected', reason });
    }
    totalEnqueued -= events;
    if (totalEnqueued < totalCommitted) totalEnqueued = totalCommitted;
    firstPendingAt = null;
    if (countStorageUnavailable) counters.count(REASON_STORAGE_UNAVAILABLE);
  }

  function markUnavailable(): void {
    if (available === false) return;
    available = false;
    anchorsEnabled = false;
    counters.count(REASON_STORAGE_UNAVAILABLE);
    failPending('unavailable', false);
  }

  async function evict(batchIds: readonly string[]): Promise<void> {
    const victims: string[] = [];
    for (const batchId of batchIds) {
      const summary = index.get(batchId);
      if (summary === undefined) continue;
      victims.push(batchId);
      evictedBatches += 1;
      evictedEvents += summary.event_count;
      index.delete(batchId);
    }
    if (victims.length === 0) return;
    counters.count(REASON_OFFLINE_EVICTED, victims.length);
    try {
      await backend.remove(victims);
    } catch {
      // 淘汰失败不影响后续写入；下次打开时会重新对账。
    }
  }

  async function pruneExpired(): Promise<void> {
    if (available !== true) return;
    const cutoff = now() - limits.maxAgeMs;
    const expired: string[] = [];
    for (const summary of index.values()) {
      if (summary.enqueued_at < cutoff) expired.push(summary.batch_id);
    }
    if (expired.length > 0) await evict(expired);
  }

  /**
   * 容量淘汰：多上限同时生效、最严者先触发；**先淘汰 normal，再淘汰最早的 critical**。
   * 返回需要丢弃的**新记录** id（已存量的受害者在函数内直接删除）。
   */
  async function enforceLimits(newSummaries: readonly OfflineRecordSummary[]): Promise<readonly string[]> {
    const candidates: OfflineRecordSummary[] = [...index.values(), ...newSummaries];
    let events = 0;
    let bytes = 0;
    for (const summary of candidates) {
      events += summary.event_count;
      bytes += summary.bytes;
    }
    let batches = candidates.length;
    const withinLimits = (): boolean =>
      events <= limits.maxEvents && bytes <= limits.maxBytes && batches <= limits.maxBatches;
    if (withinLimits()) return [];

    const ordered = [...candidates].sort((left, right) => {
      const rankLeft = left.has_critical ? 1 : 0;
      const rankRight = right.has_critical ? 1 : 0;
      if (rankLeft !== rankRight) return rankLeft - rankRight;
      return left.enqueued_at - right.enqueued_at;
    });
    const newIds = new Set(newSummaries.map((summary) => summary.batch_id));
    const storedVictims: string[] = [];
    const droppedNew: string[] = [];
    for (const candidate of ordered) {
      if (withinLimits()) break;
      if (newIds.has(candidate.batch_id)) {
        droppedNew.push(candidate.batch_id);
      } else {
        storedVictims.push(candidate.batch_id);
        index.delete(candidate.batch_id);
      }
      events -= candidate.event_count;
      bytes -= candidate.bytes;
      batches -= 1;
    }
    for (const batchId of storedVictims) {
      const summary = index.get(batchId);
      evictedBatches += 1;
      evictedEvents += summary === undefined ? 0 : summary.event_count;
    }
    if (storedVictims.length > 0) {
      counters.count(REASON_OFFLINE_EVICTED, storedVictims.length);
      try {
        await backend.remove(storedVictims);
      } catch {
        // 同上：不阻塞写入。
      }
    }
    if (droppedNew.length > 0) counters.count(REASON_OFFLINE_EVICTED, droppedNew.length);
    return droppedNew;
  }

  /** 配额失败后的激进淘汰：丢掉最早的一半已存量，为新数据腾空间。 */
  async function aggressiveEvict(): Promise<void> {
    const ordered = [...index.values()].sort((left, right) => left.enqueued_at - right.enqueued_at);
    const target = Math.max(1, Math.floor(ordered.length / 2));
    await evict(ordered.slice(0, target).map((summary) => summary.batch_id));
  }

  async function reconcileCommitLoss(): Promise<CommitLossReport> {
    const entries = await backend.listMeta(META_INTENT_PREFIX);
    const reap: string[] = [];
    let events = 0;
    let windowMs = 0;
    const sessionIds: string[] = [];
    for (const entry of entries) {
      const state = parseIntent(entry.value);
      if (state === null || state.session_id === sessionId) {
        reap.push(entry.key);
        continue;
      }
      if (now() - state.updated_at <= deadSessionMs) continue; // 可能仍存活，不动
      const lost = Math.max(0, state.total_enqueued - state.total_committed);
      reap.push(entry.key);
      if (lost > 0) {
        events += lost;
        sessionIds.push(state.session_id);
        // 窗口时长是**上界**：会话死亡时刻不可观测，只能给到对账时刻。
        windowMs = Math.max(windowMs, Math.max(0, now() - state.first_pending_at));
      }
    }
    if (reap.length > 0) {
      try {
        await backend.deleteMeta(reap);
      } catch {
        // 回收失败不影响本次对账结果。
      }
    }
    if (events > 0) counters.count(REASON_PREWRITE_COMMIT_LOST, events);
    return { events, windowMs, sessionIds };
  }

  /** 当前账目的 intent 值（锚点与提交后的对账锚点共用同一形状）。 */
  function intentValue(): string {
    const intent: IntentState = {
      session_id: sessionId,
      total_enqueued: totalEnqueued,
      total_committed: totalCommitted,
      first_pending_at: firstPendingAt ?? now(),
      updated_at: now(),
    };
    return JSON.stringify(intent);
  }

  /**
   * 同步发起一次 intent 锚点写入（D-1 修复）。
   *
   * - **只为计数**：只写 `meta`，绝不写 `records` / `summaries`，因此未提交的数据
   *   不会因为锚点而被 `list()` / `read()` 读回；`oncomplete` 仍是唯一 durability 点。
   * - **同步发起**：`backend.putMeta` 内联创建 IndexedDB 事务，窗口从 `commitIntervalMs`
   *   （默认 200 ms）缩到一次 meta 事务往返，使「事件已产生但事务未提交」有痕迹可对账。
   * - **在途合并**：写入值在真正写时按当前 `totalEnqueued` / `totalCommitted` 计算，
   *   突发 prewrite 合并成「最新一次」，不让热路径退化成逐条事务。
   * - **提交前置**：`flush()` 用 `pauseAnchors()` 等在途锚点结束，保证锚点事务排在数据
   *   事务之前，已提交的 `settledIntent` 不会被旧锚点覆盖（否则正常路径会被多计成 lost）。
   */
  function requestAnchor(): void {
    if (disposed) return;
    if (!anchorsEnabled || anchorsPaused || anchorBusy) {
      anchorQueued = true;
      return;
    }
    anchorBusy = true;
    anchorQueued = false;
    anchorTail = new Promise<void>((resolve) => {
      resolveAnchorTail = resolve;
    });
    const value = intentValue();
    // `putMeta` 可能**同步**抛错（例如 versionchange 已把连接关掉）：锚点失败只能吞掉，
    // `prewrite` 绝不向业务抛错，也不能因此改变 durability 语义。
    let write: Promise<void>;
    try {
      write = backend.putMeta({ key: intentKey, value });
    } catch {
      write = Promise.resolve();
    }
    void write
      .catch(() => undefined)
      .then(() => {
        anchorBusy = false;
        const resolve = resolveAnchorTail;
        resolveAnchorTail = null;
        if (resolve !== null) resolve();
        if (anchorQueued && !anchorsPaused && !disposed) requestAnchor();
      });
  }

  /** 提交事务创建前调用：暂停新锚点并等在途锚点写入结束（保证事务先后顺序）。 */
  async function pauseAnchors(): Promise<void> {
    anchorsPaused = true;
    await anchorTail;
  }

  /** 提交事务结束后调用：放行锚点；期间累积的合并请求在此刻以最新账目写出。 */
  function resumeAnchors(): void {
    anchorsPaused = false;
    if (disposed) return;
    if (anchorQueued) requestAnchor();
  }

  function scheduleFlush(delayMs: number): void {
    if (disposed || available === false) return;
    if (timer !== null) {
      if (delayMs > 0) return;
      globalThis.clearTimeout(timer);
      timer = null;
    }
    if (available === null) return; // 未就绪：open 完成后统一冲刷
    timer = globalThis.setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  type CommitAttempt =
    | { readonly ok: true }
    | { readonly ok: false; readonly outcome: PrewriteOutcome };

  function failureOutcome(error: unknown): PrewriteOutcome {
    if (isAbortError(error)) return { status: 'aborted' };
    return { status: 'rejected', reason: isQuotaError(error) ? 'quota' : 'unavailable' };
  }

  async function commitWithRetry(
    records: readonly OfflineRecord[],
    intent: MetaEntry,
  ): Promise<CommitAttempt> {
    try {
      await backend.commit(records, [intent]);
      return { ok: true };
    } catch (error) {
      if (!isQuotaError(error)) return { ok: false, outcome: failureOutcome(error) };
      try {
        await aggressiveEvict();
        await backend.commit(records, [intent]);
        return { ok: true };
      } catch (retryError) {
        return { ok: false, outcome: failureOutcome(retryError) };
      }
    }
  }

  async function flush(): Promise<void> {
    if (committing) return;
    if (pending.length === 0) return;
    if (available !== true) {
      failPending('unavailable', false);
      return;
    }
    committing = true;
    const entries = pending.splice(0, pending.length);
    inFlight = entries;
    const records = entries.map((entry) => entry.record);
    const startedAt = now();
    try {
      const droppedNew = await enforceLimits(records.map(toSummary));
      const droppedSet = new Set(droppedNew);
      for (const entry of entries) {
        if (!droppedSet.has(entry.record.batch_id)) continue;
        settle(entry, { status: 'rejected', reason: 'overflow' });
        evictedEvents += entry.record.event_count;
        totalEnqueued -= entry.record.event_count;
      }
      const writable = records.filter((record) => !droppedSet.has(record.batch_id));
      if (writable.length === 0) return;

      // 锚点已在 `prewrite()` 里同步落痕（D-1）；这里再做一次**整批**写入：
      // `pauseAnchors()` 会把合并中的后续锚点暂停掉，而本批的 `total_enqueued` 必须
      // 一次性落定，否则突发批次只会留下第一条锚点的计数（D-1 复测就抓到过这一点）。
      // 因为它创建在提交事务之前（且锚点已暂停），本事务内的 `settledIntent`
      // 一定是「最新且已提交」的那一份。
      await pauseAnchors();
      try {
        await backend.putMeta({ key: intentKey, value: intentValue() });
      } catch {
        // intent 写失败只是少一次对账锚点，不能阻塞数据落盘。
      }
      const settledIntent: MetaEntry = {
        key: intentKey,
        value: JSON.stringify({
          session_id: sessionId,
          total_enqueued: totalEnqueued,
          total_committed: totalEnqueued,
          first_pending_at: firstPendingAt ?? startedAt,
          updated_at: now(),
        } satisfies IntentState),
      };
      const attempt = await commitWithRetry(writable, settledIntent);
      if (attempt.ok) {
        totalCommitted = totalEnqueued;
        for (const record of writable) index.set(record.batch_id, toSummary(record));
        for (const entry of entries) {
          if (!droppedSet.has(entry.record.batch_id)) settle(entry, { status: 'durable' });
        }
        latencySamples.push(Math.max(0, now() - startedAt));
        if (latencySamples.length > LATENCY_SAMPLE_CAP) latencySamples.shift();
        if (pending.length === 0) firstPendingAt = null;
        return;
      }
      // 彻底失败：降级为仅内存，计数但**不抛错**。
      writeFailures += 1;
      counters.count(REASON_STORAGE_UNAVAILABLE);
      for (const record of writable) {
        const entry = entries.find((item) => item.record.batch_id === record.batch_id);
        if (entry !== undefined) settle(entry, attempt.outcome);
      }
      totalEnqueued = totalCommitted;
      if (pending.length === 0) firstPendingAt = null;
      try {
        // 修正为「没有未提交事件」：锚点仍只为计数，不改变 durability 语义。
        await backend.putMeta({ key: intentKey, value: intentValue() });
      } catch {
        // 修正失败只会让暴露窗口偏保守（多报未提交），可接受。
      }
    } catch {
      writeFailures += 1;
      failPending('unavailable', false);
      counters.count(REASON_STORAGE_UNAVAILABLE);
    } finally {
      resumeAnchors();
      inFlight = [];
      committing = false;
      if (!disposed && pending.length > 0) scheduleFlush(0);
    }
  }

  async function loadState(): Promise<void> {
    const stored = await backend.readMeta(META_FORMAT_KEY);
    if (stored !== null && stored.value !== String(formatVersion)) {
      // 整库格式不兼容：静默清理（AC-22），不报错。
      counters.count(REASON_OFFLINE_INCOMPATIBLE);
      await backend.clear();
      await backend.putMeta({ key: META_FORMAT_KEY, value: String(formatVersion) });
    } else if (stored === null) {
      await backend.putMeta({ key: META_FORMAT_KEY, value: String(formatVersion) });
    }

    const summaries = await backend.readSummaries(summaryScanLimit);
    const incompatible: string[] = [];
    for (const summary of summaries) {
      if (summary.format_version !== formatVersion) {
        incompatible.push(summary.batch_id);
        continue;
      }
      index.set(summary.batch_id, summary);
    }
    if (incompatible.length > 0) {
      counters.count(REASON_OFFLINE_INCOMPATIBLE, incompatible.length);
      try {
        await backend.remove(incompatible);
      } catch {
        // 清理失败不影响后续流程。
      }
    }

    await pruneExpired();
    await enforceLimits([]);
    lossReport = await reconcileCommitLoss();

    if (pending.length > 0) scheduleFlush(0);
  }

  function openInternal(): Promise<void> {
    if (openPromise !== null) return openPromise;
    openPromise = (async (): Promise<void> => {
      try {
        if (knownUnavailable) {
          markUnavailable();
          return;
        }
        const result = await backend.open();
        if (result === 'unavailable') {
          markUnavailable();
          return;
        }
        if (result === 'incompatible') {
          counters.count(REASON_OFFLINE_INCOMPATIBLE);
          await backend.reset();
          const retryResult = await backend.open();
          if (retryResult !== 'ok') {
            markUnavailable();
            return;
          }
        }
        available = true;
        await loadState();
        // 锚点能力在 `loadState()`（含 intent 对账回收）之后才开启：
        // 否则本会话刚写的锚点可能被自己的启动对账当成"上次会话"回收掉。
        anchorsEnabled = true;
        if (anchorQueued) requestAnchor();
      } catch {
        markUnavailable();
      }
    })();
    return openPromise;
  }

  function prewrite(batch: BatchEnvelope): PrewriteHandle {
    const enqueuedAt = now();
    const record = createOfflineRecord({
      batch,
      formatVersion,
      sessionId,
      appId,
      enqueuedAt,
      committedAt: enqueuedAt,
    });
    let resolveOutcome: (outcome: PrewriteOutcome) => void = (): void => undefined;
    const settled = new Promise<PrewriteOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const handle: PrewriteHandle = {
      batchId: record.batch_id,
      eventCount: record.event_count,
      criticalCount: record.critical_count,
      bytes: record.bytes,
      settled,
    };
    if (disposed || available === false) {
      // 已确定不可用：立即降级（storage_unavailable 已在 markUnavailable 计过一次）。
      resolveOutcome({ status: 'rejected', reason: 'unavailable' });
      return handle;
    }
    pending.push({ record, resolve: resolveOutcome, settled: false });
    totalEnqueued += record.event_count;
    if (firstPendingAt === null) firstPendingAt = enqueuedAt;
    void openInternal();
    // D-1：在**同一同步回合**落下 intent 锚点（只为计数），
    // 这样「事件已产生但事务未提交」的窗口一产生就有痕迹可对账。
    requestAnchor();
    if (pending.length >= limits.commitBatchSize) scheduleFlush(0);
    else scheduleFlush(limits.commitIntervalMs);
    return handle;
  }

  return {
    prewrite,

    // 实现只用到 event；`reason` 由接口（C06 的 OfflineSpillPort）声明。
    spill(event: QueueEvent): boolean {
      if (disposed || knownUnavailable || available === false) return false;
      if (assembler === null) return false;
      let batch: BatchEnvelope;
      try {
        batch = assembler.assemble([event]);
      } catch {
        return false;
      }
      prewrite(batch);
      return true;
    },

    async list(limit: number): Promise<readonly OfflineRecordSummary[]> {
      await openInternal();
      if (available !== true) return [];
      await pruneExpired();
      return [...index.values()]
        .sort((left, right) => left.enqueued_at - right.enqueued_at)
        .slice(0, limit);
    },

    async read(batchId: string): Promise<BatchEnvelope | null> {
      await openInternal();
      if (available !== true) return null;
      const record = await backend.read(batchId);
      if (record === null) return null;
      if (!isRecordCompatible(record, formatVersion)) {
        counters.count(REASON_OFFLINE_INCOMPATIBLE);
        index.delete(batchId);
        try {
          await backend.remove([batchId]);
        } catch {
          // 清理失败：下次读到时再试。
        }
        return null;
      }
      return record.batch;
    },

    async markAttempt(batchId: string): Promise<void> {
      await openInternal();
      if (available !== true) return;
      const summary = index.get(batchId);
      if (summary === undefined) return;
      const updated: OfflineRecordSummary = {
        ...summary,
        attempt_count: summary.attempt_count + 1,
        last_attempt_at: now(),
      };
      index.set(batchId, updated);
      try {
        await backend.putSummaries([updated]);
      } catch {
        // 记账失败不影响补发本身。
      }
    },

    async remove(batchIds: readonly string[]): Promise<void> {
      for (const batchId of batchIds) index.delete(batchId);
      await openInternal();
      if (available !== true || batchIds.length === 0) return;
      await backend.remove(batchIds);
    },

    async clear(): Promise<void> {
      failPending('unavailable', false);
      index.clear();
      await openInternal();
      if (available === true) await backend.clear();
    },

    stats(): OfflineStats {
      let storedEvents = 0;
      let storedBytes = 0;
      for (const summary of index.values()) {
        storedEvents += summary.event_count;
        storedBytes += summary.bytes;
      }
      // 暴露窗口 = 已受理但事务尚未提交的事件（排队中 + 提交中）。
      // 用 totalEnqueued - totalCommitted 计算，避免遗漏已离开 pending 的在途记录。
      const pendingEvents = Math.max(0, totalEnqueued - totalCommitted);
      return {
        storedBatches: index.size,
        storedEvents,
        storedBytes,
        evictedBatches,
        evictedEvents,
        writeFailures,
        ready: available !== null,
        available: available === true,
        exposure: {
          pendingBatches: pending.length + inFlight.length,
          pendingEvents,
          oldestPendingMs: firstPendingAt === null ? null : Math.max(0, now() - firstPendingAt),
          commitLatencyP50Ms: percentile(latencySamples, 0.5),
          commitLatencyP95Ms: percentile(latencySamples, 0.95),
          commitLostEvents: lossReport.events,
          commitLostWindowMs: lossReport.events === 0 ? null : lossReport.windowMs,
        },
      };
    },

    quota(): Promise<{ readonly usage: number; readonly quota: number } | null> {
      const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } } })
        .navigator?.storage;
      if (storage?.estimate === undefined) return Promise.resolve(null);
      return storage
        .estimate()
        .then((value) => ({ usage: value.usage ?? 0, quota: value.quota ?? 0 }))
        .catch(() => null);
    },

    commitLoss(): CommitLossReport {
      return lossReport;
    },

    ready(): Promise<void> {
      return openInternal();
    },

    async drain(): Promise<void> {
      await openInternal();
      for (let guard = 0; guard < 200; guard += 1) {
        if (pending.length === 0 && !committing) return;
        await flush();
        if (pending.length === 0 && !committing) return;
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 0);
        });
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
        timer = null;
      }
      failPending('unavailable', false);
      try {
        backend.close();
      } catch {
        // 关闭失败无需处理。
      }
    },
  };
}
