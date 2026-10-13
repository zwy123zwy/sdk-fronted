/**
 * C07 离线存储的常量与默认值。
 *
 * 原因码一律取自 `docs/contracts/reason-codes.md`；`prewrite_commit_lost` 与
 * `exposure_window_events` / `exposure_window_ms` 依据 **CR-001（2026-10-13 批准）**
 * 加入契约（兼容追加）。
 */
import type { OfflineLimits } from './types';

/** 记录格式版本（AC-22 的兼容依据）。 */
export const OFFLINE_FORMAT_VERSION = 1;

/** 默认数据库名。 */
export const OFFLINE_DB_NAME = 'web-report-sdk-offline';

/** object store 名。 */
export const OFFLINE_RECORD_STORE = 'records';
export const OFFLINE_SUMMARY_STORE = 'summaries';
export const OFFLINE_META_STORE = 'meta';

/** 数据库结构版本（与记录格式版本无关）。 */
export const OFFLINE_DB_VERSION = 1;

/** 默认上限：多上限同时生效、最严者先触发（已裁定口径）。 */
export const DEFAULT_OFFLINE_LIMITS: OfflineLimits = {
  maxEvents: 5_000,
  maxBatches: 2_000,
  maxBytes: 5 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  commitBatchSize: 100,
  commitIntervalMs: 200,
};

/** 会话死亡判定阈值：intent 超过该时长未更新才允许回收对账。 */
export const DEFAULT_DEAD_SESSION_MS = 90_000;

/** intent 元数据的 key 前缀。 */
export const META_INTENT_PREFIX = 'intent:';
/** 记录格式版本的元数据 key。 */
export const META_FORMAT_KEY = 'format';

/** 原因码：离线淘汰 / 过期（reason-codes.md 第 1 节）。 */
export const REASON_OFFLINE_EVICTED = 'offline_evicted';
/** 原因码：离线数据格式不兼容被清理。 */
export const REASON_OFFLINE_INCOMPATIBLE = 'offline_incompatible';
/** 原因码：离线存储不可用（只计数）。 */
export const REASON_STORAGE_UNAVAILABLE = 'storage_unavailable';
/** 原因码：已发起预写但事务未提交（CR-001 新增，第 1 节）。 */
export const REASON_PREWRITE_COMMIT_LOST = 'prewrite_commit_lost';

/** 指标名：暴露窗口内的事件数（CR-001 新增，仅 ≥1 时上报）。 */
export const METRIC_EXPOSURE_WINDOW_EVENTS = 'exposure_window_events';
/** 指标名：暴露窗口时长（CR-001 新增，仅在事件数 ≥1 时上报）。 */
export const METRIC_EXPOSURE_WINDOW_MS = 'exposure_window_ms';
