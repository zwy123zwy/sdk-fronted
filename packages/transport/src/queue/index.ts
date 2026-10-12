/**
 * C06 队列与调度（C06-F1 至 C06-F5）的公开导出。
 * 公共类型只从 `packages/transport/src/index.ts` 暴露（指南第 11 节）。
 */
export { createDomPageLeaveSource } from './page-lifecycle';
export { createMemoryQueue } from './memory-queue';
export { createTransportQueue } from './transport-queue';
export { resolveLimits } from './settings';
export { estimateEventBytes } from './size';
export {
  DEFAULT_IDLE_FLUSH_MS,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_BATCH_EVENTS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_REPLAY_BATCHES_PER_SECOND,
  DEFAULT_SLOW_EFFECTIVE_TYPES,
  DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER,
  DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER,
  DEFAULT_WEAK_NETWORK_POLICY,
  LIMIT_RANGES,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_EVENTS,
  REASON_CIRCUIT_OPEN,
  REASON_PROCESSOR_ERROR,
  REASON_QUEUE_EVICTED,
  REASON_STORAGE_UNAVAILABLE,
  REPLAY_BATCHES_PER_SECOND_MAX,
} from './constants';
export type {
  BatchSubmitPort,
  CountersPort,
  EffectiveLimits,
  FlushReason,
  FlushResult,
  FlushStatus,
  MemoryQueue,
  MemoryQueueOptions,
  NetworkInfoPort,
  NetworkSnapshot,
  OfflineSpillPort,
  PageLeaveSignal,
  PageLeaveSource,
  PageLifecycleDocument,
  QueuePushResult,
  QueuePushStatus,
  QueueSlice,
  SubmitChannel,
  SubmitContext,
  SubmitOutcome,
  TransportConfigPort,
  TransportQueue,
  TransportQueueOptions,
  TransportSettings,
  WeakNetworkPolicy,
} from './types';
