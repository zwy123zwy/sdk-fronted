/**
 * C08-F1 的计数来源适配器与装饰器：只消费其它模块的**公开接口**，不改动它们。
 *
 * 各指标来源（逐条说明为什么这样选，避免双计）：
 * - `events_enqueued` / `queue_length_max`：包装 C06 公开的 `enqueue()` + `queueLength()`
 *   （队列只在入队时增长，因此入队后采样即为窗口峰值）；
 * - `events_sent` / `batches_sent` / `batches_failed`：包装 C07 公开的 `BatchSubmitPort`。
 *   选它不是选 `DeliveryMetrics`，因为它**窗口原生**且能按 `event_name === 'sdk_health'`
 *   排除自监控批次（T16 的累计计数做不到，AC-05）；离开通道拿不到送达信号，不计入；
 * - `offline_written` / `offline_replayed`：取 T16 `DeliveryMetrics` 的**批次计数**
 *   （契约明确是「批次数」）并做窗口差分（T16 的计数是自交付层创建以来的累计值）；
 * - `calls_total`：包装客户端公共方法（装配根接线归 T18）；
 * - `offline_evicted` **不走这里**：它既是原因码（`drop_offline_evicted`，由计数器给出）
 *   又是 T16 的 `DeliveryMetrics.offlineEvicted` 观测量，**同源**；只取原因码一处，避免双计。
 */
import type { BatchEnvelope, QueueEvent } from '../batch/types';
import type {
  BatchSubmitPort,
  QueuePushResult,
  SubmitContext,
  SubmitOutcome,
  TransportQueue,
} from '../queue/types';
import { FIXED_METRIC_NAMES } from './types';
import type {
  ExposureWindowInput,
  ExposureWindowPort,
  FixedMetricDeltas,
  FixedMetricName,
  FixedMetricsPort,
  HealthDimensionsInput,
  HealthState,
  HealthTimerPort,
  ObservableMetricsInput,
  ObservableMetricsPort,
} from './types';

const isAcceptedPush = (status: QueuePushResult['status']): boolean =>
  status === 'queued' || status === 'evicted' || status === 'spilled';

const DEFAULT_IS_SELF = (event: QueueEvent): boolean => event.event_name === 'sdk_health';

/** 求和/取峰值的固定计数累加器（`queue_length_max` 用 `observePeak`）。 */
export interface FixedMetricsAccumulator extends FixedMetricsPort {
  /** 累加一个计数；非有限值或非正数忽略。 */
  add(name: FixedMetricName, delta?: number): void;
  /** 观察一个峰值型指标（取最大）。 */
  observePeak(name: FixedMetricName, value: number): void;
}

export function createFixedMetricsAccumulator(): FixedMetricsAccumulator {
  const sums = new Map<FixedMetricName, number>();
  const peaks = new Map<FixedMetricName, number>();
  return {
    add(name: FixedMetricName, delta = 1): void {
      if (!Number.isFinite(delta) || delta <= 0) return;
      sums.set(name, (sums.get(name) ?? 0) + delta);
    },
    observePeak(name: FixedMetricName, value: number): void {
      if (!Number.isFinite(value) || value < 0) return;
      peaks.set(name, Math.max(peaks.get(name) ?? 0, value));
    },
    take(): FixedMetricDeltas {
      const deltas: FixedMetricDeltas = {};
      for (const [name, value] of sums) {
        if (value >= 1) deltas[name] = value;
      }
      for (const [name, value] of peaks) {
        if (value >= 1) deltas[name] = Math.max(deltas[name] ?? 0, value);
      }
      sums.clear();
      peaks.clear();
      return deltas;
    },
  };
}

/** 组合多个固定计数来源：计数求和，`queue_length_max` 取最大值。 */
export function combineFixedMetrics(...sources: readonly FixedMetricsPort[]): FixedMetricsPort {
  return {
    take(): FixedMetricDeltas {
      const merged: FixedMetricDeltas = {};
      for (const source of sources) {
        const deltas = source.take();
        for (const name of FIXED_METRIC_NAMES) {
          const value = deltas[name];
          if (value === undefined || !Number.isFinite(value)) continue;
          const current = merged[name];
          merged[name] =
            name === 'queue_length_max'
              ? current === undefined
                ? value
                : Math.max(current, value)
              : (current ?? 0) + value;
        }
      }
      return merged;
    },
  };
}

export interface QueueMetricsSourceOptions {
  readonly queue: TransportQueue;
  /** 判定自监控事件；缺省 `event_name === 'sdk_health'`。 */
  readonly isSelf?: ((event: QueueEvent) => boolean) | undefined;
}

export interface QueueMetricsSource {
  /** 必须把这个句柄（而不是原始队列）交给 C01/C07 使用。 */
  readonly queue: TransportQueue;
  take(): FixedMetricDeltas;
}

/**
 * 包装 C06 队列得到 `events_enqueued` 与 `queue_length_max`。
 * 自监控事件不计入 `events_enqueued`、也不触发峰值采样（AC-05）。
 */
export function createQueueMetricsSource(options: QueueMetricsSourceOptions): QueueMetricsSource {
  const base = options.queue;
  const isSelf = options.isSelf ?? DEFAULT_IS_SELF;
  let enqueued = 0;
  let peak = 0;

  const wrapped: TransportQueue = {
    enqueue(event: QueueEvent): QueuePushResult {
      const result = base.enqueue(event);
      if (!isSelf(event)) {
        if (isAcceptedPush(result.status)) enqueued += 1;
        peak = Math.max(peak, base.queueLength());
      }
      return result;
    },
    flush: (reason) => base.flush(reason),
    inFlight: () => base.inFlight(),
    isCircuitOpen: () => base.isCircuitOpen(),
    setCircuitOpen: (open: boolean): void => {
      base.setCircuitOpen(open);
    },
    queueLength: () => base.queueLength(),
    queueBytes: () => base.queueBytes(),
    limits: () => base.limits(),
    dispose: (): void => {
      base.dispose();
    },
  };

  return {
    queue: wrapped,
    take(): FixedMetricDeltas {
      const deltas: FixedMetricDeltas = {};
      if (enqueued >= 1) deltas.events_enqueued = enqueued;
      if (peak >= 1) deltas.queue_length_max = peak;
      enqueued = 0;
      peak = 0;
      return deltas;
    },
  };
}

export interface SubmitMetricsSourceOptions {
  readonly submit: BatchSubmitPort;
  /** 判定自监控事件；缺省 `event_name === 'sdk_health'`。 */
  readonly isSelf?: ((event: QueueEvent) => boolean) | undefined;
}

export interface SubmitMetricsSource {
  /** 必须把这个端口（而不是原始端口）交给 C06 的 `TransportQueueOptions.submit`。 */
  readonly submit: BatchSubmitPort;
  take(): FixedMetricDeltas;
}

/**
 * 包装 C07 的 `BatchSubmitPort` 得到 `events_sent` / `batches_sent` / `batches_failed`。
 * - 与 T16 `DeliveryMetrics` 口径一致：离开通道（拿不到送达信号）不计入；
 * - 排除自监控批次：全是 `sdk_health` 的批次完全不计；混合批次只计业务事件数、不计批次数。
 */
export function createSubmitMetricsSource(options: SubmitMetricsSourceOptions): SubmitMetricsSource {
  const base = options.submit;
  const isSelf = options.isSelf ?? DEFAULT_IS_SELF;
  let eventsSent = 0;
  let batchesSent = 0;
  let batchesFailed = 0;

  const wrapped: BatchSubmitPort = {
    submit(batch: BatchEnvelope, context: SubmitContext): void {
      if (context.channel === 'page_leave') {
        base.submit(batch, context);
        return;
      }
      const selfCount = batch.events.filter((event) => isSelf(event)).length;
      const businessCount = batch.events.length - selfCount;
      base.submit(batch, {
        channel: context.channel,
        complete(outcome: SubmitOutcome): void {
          if (outcome === 'sent') {
            if (businessCount >= 1) eventsSent += businessCount;
            if (selfCount === 0) batchesSent += 1;
          } else if (selfCount === 0) {
            batchesFailed += 1;
          }
          context.complete(outcome);
        },
      });
    },
  };

  return {
    submit: wrapped,
    take(): FixedMetricDeltas {
      const deltas: FixedMetricDeltas = {};
      if (eventsSent >= 1) deltas.events_sent = eventsSent;
      if (batchesSent >= 1) deltas.batches_sent = batchesSent;
      if (batchesFailed >= 1) deltas.batches_failed = batchesFailed;
      eventsSent = 0;
      batchesSent = 0;
      batchesFailed = 0;
      return deltas;
    },
  };
}

/** T16 交付层计数快照的最小结构（累计值）。 */
export interface DeliveryMetricsLike {
  metrics(): {
    readonly offlineWritten: number;
    readonly offlineReplayed: number;
  };
}

/**
 * 把 T16 `DeliveryMetrics` 的**批次计数**转成窗口增量。
 * 只映射 `offline_written` / `offline_replayed`：
 * - `events_sent` / `batches_sent` / `batches_failed` 由 submit 装饰器负责（窗口原生且排除自监控）；
 * - `offlineWrittenEvents` / `offlineReplayedEvents` 没有契约指标名，不上报；
 * - `offlineEvicted` 与原因码 `offline_evicted` 同源，改用 `drop_offline_evicted`，避免双计。
 */
export function createDeliveryMetricsSource(delivery: DeliveryMetricsLike): FixedMetricsPort {
  const initial = delivery.metrics();
  let lastWritten = initial.offlineWritten;
  let lastReplayed = initial.offlineReplayed;
  return {
    take(): FixedMetricDeltas {
      const current = delivery.metrics();
      const written = current.offlineWritten - lastWritten;
      const replayed = current.offlineReplayed - lastReplayed;
      lastWritten = current.offlineWritten;
      lastReplayed = current.offlineReplayed;
      const deltas: FixedMetricDeltas = {};
      if (written >= 1) deltas.offline_written = written;
      if (replayed >= 1) deltas.offline_replayed = replayed;
      return deltas;
    },
  };
}

/** T16 离线存储观测量（`OfflineStore.stats().exposure`）的最小结构。 */
export interface ExposureStatsLike {
  stats(): {
    readonly exposure: {
      readonly commitLostEvents: number;
      readonly commitLostWindowMs: number | null;
      /** CR-008：真实窗口的**下界**读数（CR-007 起由 T16 提供）；缺省表示没有该读数。 */
      readonly commitLostObservedWindowMs?: number | null | undefined;
    };
  };
}

/** CR-001 / CR-008 暴露窗口来源：读取 T16 的对账结果，规则由映射层执行。 */
export function createOfflineExposureSource(source: ExposureStatsLike): ExposureWindowPort {
  return {
    exposure(): ExposureWindowInput {
      const exposure = source.stats().exposure;
      return {
        events: exposure.commitLostEvents,
        windowMs: exposure.commitLostWindowMs,
        observedWindowMs: exposure.commitLostObservedWindowMs ?? null,
      };
    },
  };
}

/** CR-008：离开通道观测量（`sender/page-leave.ts` 的 `LeaveStats`）的最小结构。 */
export interface LeaveObservablesLike {
  stats(): { readonly budgetStops: number };
}

/** CR-008：选主观测量（`leader/leader.ts` 的 `LeaderElection`）的最小结构。 */
export interface LeaderObservablesLike {
  leaderLost(): number;
}

export interface ObservableMetricsSourceOptions {
  readonly leave?: LeaveObservablesLike | undefined;
  readonly leader?: LeaderObservablesLike | undefined;
}

/**
 * CR-008 的两个**观测量**来源：把 `page-leave` / `leader` 的**累计**观测量差分成本窗口增量
 * （与 `createDeliveryMetricsSource` 同口径），值为 0 时不上报（映射层再兜一层）。
 *
 * 这两个量**不是原因码**（CR-001 §5.2 第 3 条裁定），因此不经过 `HealthCountersPort`。
 */
export function createObservableMetricsSource(
  options: ObservableMetricsSourceOptions = {},
): ObservableMetricsPort {
  const leave = options.leave;
  const leader = options.leader;
  let lastBudgetStops = leave === undefined ? 0 : leave.stats().budgetStops;
  let lastLeaderLost = leader === undefined ? 0 : leader.leaderLost();
  return {
    take(): ObservableMetricsInput {
      const deltas: {
        flushSkippedDueToBudget?: number;
        leaderLost?: number;
      } = {};
      if (leave !== undefined) {
        const current = leave.stats().budgetStops;
        const delta = current - lastBudgetStops;
        lastBudgetStops = current;
        if (Number.isFinite(delta) && delta >= 1) deltas.flushSkippedDueToBudget = delta;
      }
      if (leader !== undefined) {
        const current = leader.leaderLost();
        const delta = current - lastLeaderLost;
        lastLeaderLost = current;
        if (Number.isFinite(delta) && delta >= 1) deltas.leaderLost = delta;
      }
      return deltas;
    },
  };
}

/** C02 全局注册表的 `scheduleRepeat` 最小结构。 */
export interface RepeatSchedulerLike {
  scheduleRepeat(handler: () => void, intervalMs: number): () => void;
}

/** 用 C02 全局注册表实现周期定时器（销毁时由注册表统一回收）。 */
export function createRegistryTimer(registry: RepeatSchedulerLike): HealthTimerPort {
  return {
    schedule: (handler: () => void, intervalMs: number): (() => void) =>
      registry.scheduleRepeat(handler, intervalMs),
  };
}

/** C02 生命周期的最小结构。 */
export interface LifecycleStateSource {
  state(): string;
}

export interface HealthDimensionsReaderOptions {
  /** SDK 版本（semver）。 */
  readonly sdkVersion: string;
  readonly lifecycle: LifecycleStateSource;
  /** 生效的远程配置版本；返回 `null` 表示没有生效配置。 */
  readonly configVersion?: (() => number | null) | undefined;
}

const HEALTH_STATES: Readonly<Record<string, HealthState>> = {
  initialized: 'initialized',
  running: 'running',
  paused: 'paused',
  destroyed: 'destroyed',
};

/**
 * 把 C02 生命周期状态映射为 `sdk_health.dimensions.state`。
 * `uninitialized`（以及任何契约外取值）映射为 `null`，由 reporter 跳过该窗口——
 * Schema 的 `state` 是封闭 enum，不允许 `uninitialized`。
 */
export function createHealthDimensionsReader(
  options: HealthDimensionsReaderOptions,
): () => HealthDimensionsInput {
  return (): HealthDimensionsInput => {
    const state = HEALTH_STATES[options.lifecycle.state()] ?? null;
    const configVersion = options.configVersion === undefined ? null : options.configVersion();
    return { sdk_version: options.sdkVersion, state, config_version: configVersion };
  };
}
