/**
 * C06 队列与调度的注入接口。
 *
 * C06 不负责发送：批次交给注入的 `BatchSubmitPort`（T16 实现）；
 * 离线存储、生效配置、网络信息、页面离开信号同样通过注入接口获取，
 * 因此本包不依赖 C03/C07 的实现进度，也不依赖任何运行时库。
 */
import type { BatchEnvelope, BatchHeaderSource, QueueEvent } from '../batch/types';

/** 计数器接口（C08 读取并聚合为 `sdk_health`）；与 `packages/core` 的 Counters 结构兼容。 */
export interface CountersPort {
  /** 累加一个原因码。 */
  count(reason: string, delta?: number): void;
}

/**
 * 溢出转离线接口（T16 实现）。
 * 内存队列在「无 normal 事件可淘汰、且新到事件为 critical」时调用它。
 * 返回 false 或抛错都表示离线存储不可用，此时 critical 事件降级丢弃并计数 `storage_unavailable`。
 */
export interface OfflineSpillPort {
  spill(event: QueueEvent, reason: 'queue_overflow'): boolean;
}

/** 生效配置的 `transport` 组（见 remote-config.schema.json；由 C03 提供）。 */
export interface TransportSettings {
  readonly max_batch_events?: number | undefined;
  readonly max_batch_bytes?: number | undefined;
  readonly idle_flush_ms?: number | undefined;
  readonly max_wait_ms?: number | undefined;
  readonly replay_batches_per_second?: number | undefined;
}

/** 生效配置读取接口；每次冲刷重新读取，支持运行期配置变更。 */
export interface TransportConfigPort {
  transport(): TransportSettings;
}

/** 网络信息快照（来自 `navigator.connection`）。 */
export interface NetworkSnapshot {
  readonly effectiveType?: string | undefined;
  readonly saveData?: boolean | undefined;
}

/** 网络信息读取接口；未注入时视为非弱网。 */
export interface NetworkInfoPort {
  snapshot(): NetworkSnapshot;
}

/** 弱网自适应策略（C06-F5）。 */
export interface WeakNetworkPolicy {
  /** 视为弱网的 `effectiveType` 取值；缺省 `['slow-2g', '2g']`。 */
  readonly slowEffectiveTypes?: readonly string[] | undefined;
  /** `max_batch_events` 放大倍率；缺省 2，非法值按 1 处理。 */
  readonly batchEventsMultiplier?: number | undefined;
  /** `idle_flush_ms` 放大倍率；缺省 2，非法值按 1 处理。 */
  readonly idleFlushMsMultiplier?: number | undefined;
}

/** 冲刷后生效的上限。 */
export interface EffectiveLimits {
  readonly maxBatchEvents: number;
  readonly maxBatchBytes: number;
  readonly idleFlushMs: number;
  readonly maxWaitMs: number;
  readonly replayBatchesPerSecond: number;
  /** 是否命中弱网自适应。 */
  readonly weakNetwork: boolean;
}

/** 提交通道：常规 HTTP 或页面离开通道（信标 / 同步发送）。 */
export type SubmitChannel = 'default' | 'page_leave';

/** 批次结果信号，由 C07 判定；`circuit_open` 会让 C06 暂停常规冲刷。 */
export type SubmitOutcome = 'sent' | 'failed' | 'circuit_open';

/** 提交上下文；`complete` 必须在批次处理结束后调用（可同步调用）。 */
export interface SubmitContext {
  readonly channel: SubmitChannel;
  readonly complete: (outcome: SubmitOutcome) => void;
}

/**
 * 提交批次接口（T16 实现）。
 * 约定：不向 C06 抛错；失败通过 `context.complete('failed')` 上报。
 */
export interface BatchSubmitPort {
  submit(batch: BatchEnvelope, context: SubmitContext): void;
}

/** 冲刷原因。 */
export type FlushReason = 'events' | 'bytes' | 'idle' | 'max_wait' | 'manual' | 'page_leave' | 'resume';

/** 冲刷结果状态。 */
export type FlushStatus = 'submitted' | 'empty' | 'in_flight' | 'circuit_open';

/** 冲刷结果。 */
export interface FlushResult {
  readonly status: FlushStatus;
  readonly reason: FlushReason;
  /** status 为 submitted 时给出本次提交的第一个批次。 */
  readonly batch?: BatchEnvelope | undefined;
}

/** 入队结果状态。 */
export type QueuePushStatus = 'queued' | 'evicted' | 'rejected' | 'spilled' | 'spill_failed';

/** 入队结果。 */
export interface QueuePushResult {
  readonly status: QueuePushStatus;
  /** 本次入队的事件。 */
  readonly event: QueueEvent;
  /** status 为 evicted/rejected 时为被淘汰（或丢弃）的事件。 */
  readonly evicted?: readonly QueueEvent[] | undefined;
}

/** 从队列头部取出的一段事件及其估算体积。 */
export interface QueueSlice {
  readonly events: readonly QueueEvent[];
  readonly bytes: number;
}

/** 双上限内存队列（C06-F1）。 */
export interface MemoryQueue {
  /**
   * 入队；溢出时淘汰最早的 normal 事件并计数 `queue_evicted`。
   * critical 事件不被淘汰：全是 critical 时把新到事件转离线存储（无存储可用时计数 `storage_unavailable`）。
   */
  push(event: QueueEvent): QueuePushResult;
  /**
   * 从队头取出一段事件：条数不超过 `limitEvents`，体积不超过 `limitBytes`；
   * 总是至少取一条（单条事件超过体积上限时单独成批），避免调用方死循环。
   */
  drainUpTo(limitEvents: number, limitBytes: number): QueueSlice;
  size(): number;
  bytes(): number;
  clear(): void;
}

/** 内存队列选项。 */
export interface MemoryQueueOptions {
  /** 条数上限；缺省 500（契约值）。 */
  readonly maxEvents?: number | undefined;
  /** 体积上限（估算码元数）；缺省 512 KB（契约值）。 */
  readonly maxBytes?: number | undefined;
  /** 计数器；缺省不计数。 */
  readonly counters?: CountersPort | undefined;
  /** 溢出转离线接口；缺省时 critical 溢出按 `storage_unavailable` 降级。 */
  readonly offline?: OfflineSpillPort | undefined;
  /** 自定义事件体积测量；缺省 `estimateEventBytes`。 */
  readonly measure?: ((event: QueueEvent) => number) | undefined;
}

/** 页面离开信号。 */
export type PageLeaveSignal = 'hidden' | 'pagehide';

/**
 * 页面离开信号源。
 * `packages/core` 的全局注册表（C02-F6）可用它统一管理监听与回收；
 * `createDomPageLeaveSource` 提供基于 DOM 的实现。
 */
export interface PageLeaveSource {
  /** 订阅页面离开信号；返回注销函数。 */
  subscribe(handler: (signal: PageLeaveSignal) => void): () => void;
}

/** `createDomPageLeaveSource` 需要的最小 DOM 能力（便于测试注入假 document）。 */
export interface PageLifecycleDocument {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** 队列与调度器选项。 */
export interface TransportQueueOptions {
  /** 生效配置读取接口（`transport` 组）。 */
  readonly config: TransportConfigPort;
  /** 提交批次接口（T16）。 */
  readonly submit: BatchSubmitPort;
  /** 批次头来源（C04/C07）。 */
  readonly header: BatchHeaderSource;
  /** 计数器（C08）；缺省不计数。 */
  readonly counters?: CountersPort | undefined;
  /** 溢出转离线接口（T16）；缺省时 critical 溢出降级计数。 */
  readonly offline?: OfflineSpillPort | undefined;
  /** 网络信息（C06-F5）；缺省视为非弱网。 */
  readonly network?: NetworkInfoPort | undefined;
  /** 页面离开信号源；缺省不订阅（模块顶层不访问 window）。 */
  readonly pageLeave?: PageLeaveSource | undefined;
  /** 弱网自适应策略；缺省 `DEFAULT_WEAK_NETWORK_POLICY`。 */
  readonly weakNetwork?: WeakNetworkPolicy | undefined;
  /** 当前时间；透传给批次组装器生成 `sent_at`。 */
  readonly now?: (() => number) | undefined;
  /** `batch_id` 生成器；透传给批次组装器。 */
  readonly createId?: (() => string) | undefined;
  /** 内存队列条数上限；缺省 500。 */
  readonly maxQueueEvents?: number | undefined;
  /** 内存队列体积上限；缺省 512 KB。 */
  readonly maxQueueBytes?: number | undefined;
  /** 自定义事件体积测量；缺省 `estimateEventBytes`。 */
  readonly measure?: ((event: QueueEvent) => number) | undefined;
}

/** 队列与调度器（C06-F1 至 C06-F5）。 */
export interface TransportQueue {
  /** 入队；按需触发冲刷。 */
  enqueue(event: QueueEvent): QueuePushResult;
  /** 业务主动冲刷（C06-AC-08）；缺省原因为 manual。 */
  flush(reason?: FlushReason): FlushResult;
  /** 是否有常规批次在途（C06-F4）。 */
  inFlight(): boolean;
  /** 是否处于熔断状态。 */
  isCircuitOpen(): boolean;
  /** 由 C07 设置熔断状态；关闭时立即尝试冲刷积压事件。 */
  setCircuitOpen(open: boolean): void;
  queueLength(): number;
  queueBytes(): number;
  /** 当前生效上限（含弱网自适应结果）。 */
  limits(): EffectiveLimits;
  /** 释放定时器与页面离开订阅。 */
  dispose(): void;
}
