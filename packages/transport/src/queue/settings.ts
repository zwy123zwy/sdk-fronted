/**
 * 生效上限解析（C06-F2 的 transport 组、C06-F5 的弱网自适应）。
 *
 * 取值来自注入的配置读取接口；缺省值与超区间值一律回退到契约区间内的默认值，
 * 放大结果再钳制回契约上限（`max_batch_events` ≤ 100、`idle_flush_ms` ≤ 10000）。
 */
import {
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
  REPLAY_BATCHES_PER_SECOND_MAX,
} from './constants';
import type {
  EffectiveLimits,
  NetworkSnapshot,
  TransportSettings,
  WeakNetworkPolicy,
} from './types';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 取区间内的整数；非整数或超区间时回退默认值。 */
function rangedInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

/** 取区间内的有限数；超区间时回退默认值。 */
function rangedNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value <= min || value > max) return fallback;
  return value;
}

/** 放大倍率；非正数或非有限值按 1（不放大）处理。 */
function multiplier(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

/** 解析当前生效上限（含弱网自适应）。 */
export function resolveLimits(
  settings: TransportSettings,
  network: NetworkSnapshot,
  policy: WeakNetworkPolicy = DEFAULT_WEAK_NETWORK_POLICY,
): EffectiveLimits {
  const maxBatchEvents = rangedInteger(
    settings.max_batch_events,
    LIMIT_RANGES.maxBatchEvents.min,
    LIMIT_RANGES.maxBatchEvents.max,
    DEFAULT_MAX_BATCH_EVENTS,
  );
  const maxBatchBytes = rangedInteger(
    settings.max_batch_bytes,
    LIMIT_RANGES.maxBatchBytes.min,
    LIMIT_RANGES.maxBatchBytes.max,
    DEFAULT_MAX_BATCH_BYTES,
  );
  const idleFlushMs = rangedInteger(
    settings.idle_flush_ms,
    LIMIT_RANGES.idleFlushMs.min,
    LIMIT_RANGES.idleFlushMs.max,
    DEFAULT_IDLE_FLUSH_MS,
  );
  const maxWaitMs = rangedInteger(
    settings.max_wait_ms,
    LIMIT_RANGES.maxWaitMs.min,
    LIMIT_RANGES.maxWaitMs.max,
    DEFAULT_MAX_WAIT_MS,
  );
  const replayBatchesPerSecond = rangedNumber(
    settings.replay_batches_per_second,
    0,
    REPLAY_BATCHES_PER_SECOND_MAX,
    DEFAULT_REPLAY_BATCHES_PER_SECOND,
  );

  const slowTypes = policy.slowEffectiveTypes ?? DEFAULT_SLOW_EFFECTIVE_TYPES;
  const effectiveType = network.effectiveType;
  const weakNetwork =
    (effectiveType !== undefined && slowTypes.includes(effectiveType)) || network.saveData === true;

  if (!weakNetwork) {
    return {
      maxBatchEvents,
      maxBatchBytes,
      idleFlushMs,
      maxWaitMs,
      replayBatchesPerSecond,
      weakNetwork: false,
    };
  }

  return {
    maxBatchEvents: clamp(
      Math.round(
        maxBatchEvents *
          multiplier(policy.batchEventsMultiplier ?? DEFAULT_WEAK_BATCH_EVENTS_MULTIPLIER),
      ),
      LIMIT_RANGES.maxBatchEvents.min,
      LIMIT_RANGES.maxBatchEvents.max,
    ),
    maxBatchBytes,
    idleFlushMs: clamp(
      Math.round(
        idleFlushMs *
          multiplier(policy.idleFlushMsMultiplier ?? DEFAULT_WEAK_IDLE_FLUSH_MS_MULTIPLIER),
      ),
      LIMIT_RANGES.idleFlushMs.min,
      LIMIT_RANGES.idleFlushMs.max,
    ),
    maxWaitMs,
    replayBatchesPerSecond,
    weakNetwork: true,
  };
}
