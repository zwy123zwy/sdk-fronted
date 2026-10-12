/**
 * 队列与调度器（C06-F1 至 C06-F5）。
 *
 * 冲刷触发：
 * - 入队条数达到 `max_batch_events`（20）或体积达到 `max_batch_bytes`（32 KB）立即冲刷；
 * - 静默 `idle_flush_ms`（1 秒）后冲刷；
 * - 距首条事件 `max_wait_ms`（5 秒）因最长等待冲刷；
 * - `visibilitychange`（hidden）与 `pagehide` 同步冲刷，并使用页面离开通道；
 * - 业务调用 `flush()` 立即冲刷。
 *
 * 在途控制（C06-F4）：常规批次同一时刻只允许一个在途；在途期间新事件继续入队，
 * 批次完成（`complete` 回调）后立即继续冲刷。页面离开属于同步通道，不受在途限制。
 *
 * C06 不负责发送：批次通过注入的 `BatchSubmitPort` 交给 T16。
 */
import { createBatchAssembler } from '../batch/assembler';
import type { BatchAssembler, BatchEnvelope, QueueEvent } from '../batch/types';
import {
  DEFAULT_WEAK_NETWORK_POLICY,
  REASON_CIRCUIT_OPEN,
  REASON_PROCESSOR_ERROR,
} from './constants';
import { createMemoryQueue } from './memory-queue';
import { resolveLimits } from './settings';
import type {
  CountersPort,
  EffectiveLimits,
  FlushReason,
  FlushResult,
  MemoryQueue,
  QueuePushResult,
  SubmitChannel,
  SubmitContext,
  SubmitOutcome,
  TransportQueue,
  TransportQueueOptions,
} from './types';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const noopCounters: CountersPort = {
  count: (): void => undefined,
};

/** 创建队列与调度器。 */
export function createTransportQueue(options: TransportQueueOptions): TransportQueue {
  const counters = options.counters ?? noopCounters;
  const policy = options.weakNetwork ?? DEFAULT_WEAK_NETWORK_POLICY;
  const assembler: BatchAssembler = createBatchAssembler({
    header: options.header,
    now: options.now,
    createId: options.createId,
  });
  const queue: MemoryQueue = createMemoryQueue({
    maxEvents: options.maxQueueEvents,
    maxBytes: options.maxQueueBytes,
    measure: options.measure,
    counters,
    offline: options.offline,
  });

  let idleTimer: TimerHandle | null = null;
  let maxWaitTimer: TimerHandle | null = null;
  let inFlightCount = 0;
  let circuitOpen = false;
  let disposed = false;
  let pumping = false;

  function limits(): EffectiveLimits {
    const snapshot = options.network === undefined ? {} : options.network.snapshot();
    return resolveLimits(options.config.transport(), snapshot, policy);
  }

  // 通过访问器读取在闭包中改写的状态，避免类型收窄把它当作常量（也便于 T16 观测）。
  function isDisposed(): boolean {
    return disposed;
  }

  function isCircuitOpen(): boolean {
    return circuitOpen;
  }

  function clearTimers(): void {
    if (idleTimer !== null) {
      globalThis.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (maxWaitTimer !== null) {
      globalThis.clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  /** 武装空闲与最长等待计时器；空闲计时器每次入队重置，最长等待计时器只在队列由空转非空时武装。 */
  function armTimers(): void {
    if (disposed || circuitOpen || queue.size() === 0) {
      clearTimers();
      return;
    }
    const current = limits();
    if (maxWaitTimer === null) {
      maxWaitTimer = globalThis.setTimeout(() => {
        maxWaitTimer = null;
        attemptFlush('max_wait');
      }, current.maxWaitMs);
    }
    if (idleTimer !== null) globalThis.clearTimeout(idleTimer);
    idleTimer = globalThis.setTimeout(() => {
      idleTimer = null;
      attemptFlush('idle');
    }, current.idleFlushMs);
  }

  /** 批次完成：熔断信号生效、重新武装计时器并继续冲刷积压事件。 */
  function handleComplete(outcome: SubmitOutcome): void {
    if (outcome === 'circuit_open') {
      circuitOpen = true;
      counters.count(REASON_CIRCUIT_OPEN);
    }
    if (disposed) return;
    if (queue.size() > 0) {
      armTimers();
      if (!circuitOpen && inFlightCount === 0) pump('resume');
      return;
    }
    clearTimers();
  }

  /** 组装并提交一段事件；返回组装出的批次，失败时返回 null。 */
  function submitSlice(events: readonly QueueEvent[], channel: SubmitChannel): BatchEnvelope | null {
    let batch: BatchEnvelope;
    try {
      batch = assembler.assemble(events);
    } catch {
      counters.count(REASON_PROCESSOR_ERROR);
      return null;
    }
    inFlightCount += 1;
    const inFlightBefore = inFlightCount;
    let settled = false;
    const complete = (outcome: SubmitOutcome): void => {
      if (settled) return;
      settled = true;
      inFlightCount -= 1;
      handleComplete(outcome);
    };
    const context: SubmitContext = { channel, complete };
    try {
      options.submit.submit(batch, context);
    } catch {
      // 提交端口抛错：它若已同步上报过结果（inFlightCount 已扣减），这里不再重复扣减
      if (inFlightCount === inFlightBefore) inFlightCount -= 1;
      counters.count(REASON_PROCESSOR_ERROR);
      return null;
    }
    return batch;
  }

  /** 常规冲刷循环：提交端口同步完成时可以连续排出多个批次；异步时只发一个。 */
  function pump(reason: FlushReason): FlushResult {
    if (disposed) return { status: 'empty', reason };
    if (circuitOpen) return { status: 'circuit_open', reason };
    if (queue.size() === 0) return { status: 'empty', reason };
    if (inFlightCount > 0 || pumping) return { status: 'in_flight', reason };

    pumping = true;
    let firstBatch: BatchEnvelope | null = null;
    try {
      while (!isDisposed() && !isCircuitOpen() && inFlightCount === 0 && queue.size() > 0) {
        const current = limits();
        const slice = queue.drainUpTo(current.maxBatchEvents, current.maxBatchBytes);
        if (slice.events.length === 0) break;
        clearTimers();
        const batch = submitSlice(slice.events, 'default');
        if (batch === null) continue;
        if (firstBatch === null) firstBatch = batch;
        // 提交端口同步调用 complete 时 inFlightCount 已归零，循环继续排空队列
      }
    } finally {
      pumping = false;
    }

    if (firstBatch === null) return { status: 'empty', reason };
    return { status: 'submitted', reason, batch: firstBatch };
  }

  /** 计时器与内部触发的冲刷：不重复计数熔断。 */
  function attemptFlush(reason: FlushReason): FlushResult {
    if (disposed) return { status: 'empty', reason };
    if (queue.size() === 0) return { status: 'empty', reason };
    if (circuitOpen) return { status: 'circuit_open', reason };
    if (inFlightCount > 0) return { status: 'in_flight', reason };
    return pump(reason);
  }

  /** 页面离开：同步冲刷，使用页面离开通道，必要时分多个批次。 */
  function flushPageLeave(): void {
    if (disposed) return;
    while (!isDisposed() && queue.size() > 0) {
      const current = limits();
      const slice = queue.drainUpTo(current.maxBatchEvents, current.maxBatchBytes);
      if (slice.events.length === 0) break;
      submitSlice(slice.events, 'page_leave');
    }
    clearTimers();
  }

  const disposePageLeave: (() => void) | null =
    options.pageLeave === undefined
      ? null
      : options.pageLeave.subscribe((): void => {
          flushPageLeave();
        });

  function setCircuitOpen(open: boolean): void {
    circuitOpen = open;
    if (open) {
      clearTimers();
      return;
    }
    if (disposed) return;
    if (queue.size() > 0) {
      armTimers();
      if (inFlightCount === 0) pump('resume');
    }
  }

  return {
    enqueue(event: QueueEvent): QueuePushResult {
      if (disposed) return { status: 'rejected', event };
      const result = queue.push(event);
      if (queue.size() === 0) return result;

      const current = limits();
      const reachedEvents = queue.size() >= current.maxBatchEvents;
      if (reachedEvents || queue.bytes() >= current.maxBatchBytes) {
        pump(reachedEvents ? 'events' : 'bytes');
      }
      if (queue.size() > 0) armTimers();
      return result;
    },

    flush(reason: FlushReason = 'manual'): FlushResult {
      if (disposed) return { status: 'empty', reason };
      if (queue.size() === 0) return { status: 'empty', reason };
      if (circuitOpen) {
        counters.count(REASON_CIRCUIT_OPEN);
        return { status: 'circuit_open', reason };
      }
      if (inFlightCount > 0) return { status: 'in_flight', reason };
      return pump(reason);
    },

    inFlight(): boolean {
      return inFlightCount > 0;
    },

    isCircuitOpen(): boolean {
      return circuitOpen;
    },

    setCircuitOpen,

    queueLength(): number {
      return queue.size();
    },

    queueBytes(): number {
      return queue.bytes();
    },

    limits,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      if (disposePageLeave !== null) disposePageLeave();
    },
  };
}
