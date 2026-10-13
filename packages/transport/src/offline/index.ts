/**
 * C07 离线存储（C07-F5 / C07-F6 的存储层）的公开导出。
 *
 * 公共类型只从 `packages/transport/src/index.ts` 暴露（指南第 11 节）；
 * 本文件只做目录内聚合。
 */
export { createOfflineStore } from './offline-store';
export { createIdbBackend } from './idb-backend';
export {
  DEFAULT_DEAD_SESSION_MS,
  DEFAULT_OFFLINE_LIMITS,
  METRIC_EXPOSURE_WINDOW_EVENTS,
  METRIC_EXPOSURE_WINDOW_MS,
  OFFLINE_DB_NAME,
  OFFLINE_FORMAT_VERSION,
  REASON_OFFLINE_EVICTED,
  REASON_OFFLINE_INCOMPATIBLE,
  REASON_PREWRITE_COMMIT_LOST,
} from './constants';
export type { IdbBackendOptions } from './idb-backend';
export type {
  CommitLossReport,
  CountersPort,
  ExposureStats,
  MetaEntry,
  OfflineBackend,
  OfflineLimits,
  OfflineOpenResult,
  OfflineRecord,
  OfflineRecordSummary,
  OfflineStats,
  OfflineStore,
  OfflineStoreOptions,
  PrewriteHandle,
  PrewriteOutcome,
  PrewriteRejection,
  QueueEvent,
} from './types';
