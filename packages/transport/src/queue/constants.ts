/**
 * C06 队列与调度的常量与默认值。
 * 所有默认值都落在契约区间内（`docs/contracts/schemas/remote-config.schema.json` 的 `transport` 组）。
 */
import type { WeakNetworkPolicy } from './types';

/** 内存队列条数上限（C06-F1，契约值）。 */
export const QUEUE_MAX_EVENTS = 500;

/** 内存队列体积上限（C06-F1），512 KB。 */
export const QUEUE_MAX_BYTES = 512 * 1024;

/** `max_batch_events` 默认值：连续入队 20 条立即冲刷（C06-AC-04）。 */
export const DEFAULT_MAX_BATCH_EVENTS = 20;

/** `max_batch_bytes` 默认值：入队体积达到 32 KB 立即冲刷（C06-AC-05）。 */
export const DEFAULT_MAX_BATCH_BYTES = 32 * 1024;

/** `idle_flush_ms` 默认值：静默 1 秒冲刷（C06-AC-06）。 */
export const DEFAULT_IDLE_FLUSH_MS = 1000;

/** `max_wait_ms` 默认值：最长等待 5 秒冲刷（C06-AC-06）。 */
export const DEFAULT_MAX_WAIT_MS = 5000;

/** `replay_batches_per_second` 默认值（C07 补发限速）。 */
export const DEFAULT_REPLAY_BATCHES_PER_SECOND = 1;

/** 契约区间；超出的值视为无效，回退到默认值。 */
export const LIMIT_RANGES = {
  maxBatchEvents: { min: 1, max: 100 },
  maxBatchBytes: { min: 1024, max: 61440 },
  idleFlushMs: { min: 200, max: 10000 },
  maxWaitMs: { min: 1000, max: 60000 },
} as const;

/** `replay_batches_per_second` 的区间：(0, 2]。 */
export const REPLAY_BATCHES_PER_SECOND_MAX = 2;

/** 视为弱网的 `effectiveType` 取值。 */
export const DEFAULT_SLOW_EFFECTIVE_TYPES: readonly string[] = ['slow-2g', '2g'];

/** 弱网下 `max_batch_events` 的默认放大倍率。 */
export const DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER = 2;

/** 弱网下 `idle_flush_ms` 的默认放大倍率。 */
export const DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER = 2;

/** 弱网自适应默认策略：条数上限与静默时间各放大 2 倍（C06-F5）。 */
export const DEFAULT_WEAK_NETWORK_POLICY: WeakNetworkPolicy = {
  slowEffectiveTypes: DEFAULT_SLOW_EFFECTIVE_TYPES,
  batchEventsMultiplier: DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER,
  idleFlushMsMultiplier: DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER,
};

/** 内存队列淘汰最早 normal 事件的原因码（reason-codes.md 第 1 节）。 */
export const REASON_QUEUE_EVICTED = 'queue_evicted';

/** critical 事件无法转入离线存储时的降级原因码（reason-codes.md 第 2 节）。 */
export const REASON_STORAGE_UNAVAILABLE = 'storage_unavailable';

/** 熔断期间暂停发送的原因码（reason-codes.md 第 2 节）。 */
export const REASON_CIRCUIT_OPEN = 'circuit_open';

/** 内部处理异常（组装或提交端口抛错）的原因码（reason-codes.md 第 2 节）。 */
export const REASON_PROCESSOR_ERROR = 'processor_error';
