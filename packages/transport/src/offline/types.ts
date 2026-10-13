/**
 * C07 离线存储的类型与端口。
 *
 * 落盘语义（D004 强制）：**`IDBTransaction.oncomplete` 是唯一落盘点**；
 * `PrewriteHandle.settled` 在此之前一律保持 pending，调用方不得把它当已落盘。
 *
 * 零运行时依赖：所有外部能力（IndexedDB 工厂、计时、计数器、批次头）都是注入端口。
 */
import type { BatchEnvelope, BatchHeaderSource, QueueEvent } from '../batch/types';
import type { CountersPort } from '../queue/types';

/** 逐条离线记录（`records` object store，keyPath `batch_id`）。 */
export interface OfflineRecord {
  readonly batch_id: string;
  /** 记录格式版本；读到不等于当前版本即按 AC-22 清理。 */
  readonly format_version: number;
  readonly app_id: string;
  readonly session_id: string;
  /** 事件进入交付层的时刻 = 暴露窗口起点。 */
  readonly enqueued_at: number;
  readonly committed_at: number;
  readonly has_critical: boolean;
  readonly event_count: number;
  readonly critical_count: number;
  readonly bytes: number;
  readonly attempt_count: number;
  readonly last_attempt_at: number | null;
  /** 原样批次：`batch_id` 与每个 `event_id` 保持不变（契约 §4）。 */
  readonly batch: BatchEnvelope;
}

/** 摘要（`summaries` object store）：小记录，用于在内存里维护索引与淘汰顺序。 */
export interface OfflineRecordSummary {
  readonly batch_id: string;
  /** 记录格式版本；启动时可据此清理被写坏的个别记录（AC-22）。 */
  readonly format_version: number;
  readonly enqueued_at: number;
  readonly has_critical: boolean;
  readonly event_count: number;
  readonly critical_count: number;
  readonly bytes: number;
  readonly attempt_count: number;
  readonly last_attempt_at: number | null;
}

/** 元数据小记录（`meta` object store，keyPath `key`）。值一律是 JSON 字符串。 */
export interface MetaEntry {
  readonly key: string;
  readonly value: string;
}

export type OfflineOpenResult = 'ok' | 'incompatible' | 'unavailable';

/**
 * 低层离线后端端口（AC-20 的存储适配器注入点）。
 *
 * `commit` 必须在事务 `oncomplete` 之后才 resolve；任何提前 resolve 的实现都会
 * 破坏 D004 的落盘承诺，因此后端必须自证（测试里有正向与负向对照）。
 */
export interface OfflineBackend {
  open(): Promise<OfflineOpenResult>;
  /** 删除整个数据库（仅用于结构级不兼容，如 `VersionError`）。 */
  reset(): Promise<void>;
  /** 一个事务内写入记录、摘要与元数据；`oncomplete` 后 resolve。 */
  commit(records: readonly OfflineRecord[], metas?: readonly MetaEntry[]): Promise<void>;
  /** 只更新摘要（补发尝试计数），不动批次正文。 */
  putSummaries(summaries: readonly OfflineRecordSummary[]): Promise<void>;
  readSummaries(limit: number): Promise<readonly OfflineRecordSummary[]>;
  read(batchId: string): Promise<OfflineRecord | null>;
  remove(batchIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  putMeta(entry: MetaEntry): Promise<void>;
  readMeta(key: string): Promise<MetaEntry | null>;
  listMeta(prefix: string): Promise<readonly MetaEntry[]>;
  deleteMeta(keys: readonly string[]): Promise<void>;
  close(): void;
}

export type PrewriteRejection = 'quota' | 'unavailable' | 'incompatible' | 'overflow';

export type PrewriteOutcome =
  | { readonly status: 'durable' }
  | { readonly status: 'rejected'; readonly reason: PrewriteRejection }
  | { readonly status: 'aborted' };

/** 预写句柄：`settled` 只在事务 `oncomplete`（或明确的失败/中止）之后解析。 */
export interface PrewriteHandle {
  readonly batchId: string;
  readonly eventCount: number;
  readonly criticalCount: number;
  readonly bytes: number;
  readonly settled: Promise<PrewriteOutcome>;
}

/** 暴露窗口观测量（D004：未提交部分单独计量，不得与优雅路径混算）。 */
export interface ExposureStats {
  readonly pendingBatches: number;
  readonly pendingEvents: number;
  readonly oldestPendingMs: number | null;
  readonly commitLatencyP50Ms: number | null;
  readonly commitLatencyP95Ms: number | null;
  /** 重启后对账出的「已发起预写但事务未提交」事件数（CR-001：`prewrite_commit_lost`）。 */
  readonly commitLostEvents: number;
  readonly commitLostWindowMs: number | null;
}

export interface OfflineStats {
  readonly storedBatches: number;
  readonly storedEvents: number;
  readonly storedBytes: number;
  readonly evictedBatches: number;
  readonly evictedEvents: number;
  readonly writeFailures: number;
  readonly ready: boolean;
  readonly available: boolean;
  readonly exposure: ExposureStats;
}

export interface OfflineLimits {
  readonly maxEvents: number;
  readonly maxBatches: number;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
  /** 达到该条数立即提交（取先到者之一）。 */
  readonly commitBatchSize: number;
  /** 提交间隔上限（取先到者之一）。 */
  readonly commitIntervalMs: number;
}

/** 暴露窗口对账报告（一次检测的结果）。 */
export interface CommitLossReport {
  readonly events: number;
  readonly windowMs: number;
  readonly sessionIds: readonly string[];
}

export interface OfflineStoreOptions {
  readonly appId: string;
  /** 本标签页的会话标识；用于 intent 对账，避免把别的存活标签页判成已丢。 */
  readonly sessionId: string;
  /** 批次头来源；仅 `spill`（C06 溢出转离线）需要。 */
  readonly header?: BatchHeaderSource | undefined;
  readonly backend?: OfflineBackend | undefined;
  /** 缺省取 `globalThis.indexedDB`；显式传 `null` 表示不可用。 */
  readonly idbFactory?: IDBFactory | null | undefined;
  readonly dbName?: string | undefined;
  /** 数据库结构版本（测试用；缺省 1）。 */
  readonly dbVersion?: number | undefined;
  readonly counters?: CountersPort | undefined;
  readonly now?: (() => number) | undefined;
  readonly formatVersion?: number | undefined;
  readonly limits?: Partial<OfflineLimits> | undefined;
  /** 超过该时长没有更新 intent 的会话视为已死亡，可回收并对账。 */
  readonly deadSessionMs?: number | undefined;
}

/** 离线存储（C07-F5 / C07-F6 的存储层，给 T14 的 `clear` 与 T17 的观测量）。 */
export interface OfflineStore {
  /** 预写一个批次；**同步返回**，`settled` 只在落盘后解析。 */
  prewrite(batch: BatchEnvelope): PrewriteHandle;
  /** C06 溢出转离线（`OfflineSpillPort`）：受理返回 true。 */
  spill(event: QueueEvent, reason: 'queue_overflow'): boolean;
  /** 待补发记录摘要，按 `enqueued_at` 升序；同时清理过期记录。 */
  list(limit: number): Promise<readonly OfflineRecordSummary[]>;
  read(batchId: string): Promise<BatchEnvelope | null>;
  /** 记一次补发尝试（失败退避用）。 */
  markAttempt(batchId: string): Promise<void>;
  /** 删除已确认（常规通道 202）的记录；幂等。 */
  remove(batchIds: readonly string[]): Promise<void>;
  /** 清空（撤回同意 / 注销 / 格式不兼容）。幂等。 */
  clear(): Promise<void>;
  stats(): OfflineStats;
  quota(): Promise<{ readonly usage: number; readonly quota: number } | null>;
  /** 本次打开时对上一次会话的暴露窗口对账结果。 */
  commitLoss(): CommitLossReport;
  /** 打开完成（测试与装配用）；未 ready 时 `prewrite` 仍可同步受理。 */
  ready(): Promise<void>;
  /** 等待当前待提交记录全部有结论（测试与装配用；有界循环，不会挂死）。 */
  drain(): Promise<void>;
  dispose(): void;
}

export type { CountersPort, QueueEvent };
