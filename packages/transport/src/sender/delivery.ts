/**
 * C07 装配层：把离线存储、发送器、页面离开通道、补发与选主接到 C06 的注入接口上。
 *
 * 依赖方向：本模块**消费** T15 已冻结的 `BatchSubmitPort` / `TransportQueue`，
 * 不修改队列代码；C06 只通过 `submit(batch, context)` 与本模块交互。
 */
import type { BatchEnvelope, BatchHeaderSource, QueueEvent } from '../batch/types';
import { createOfflineStore } from '../offline/offline-store';
import { METRIC_EXPOSURE_WINDOW_EVENTS, METRIC_EXPOSURE_WINDOW_MS } from '../offline/constants';
import { countCriticalEvents } from '../offline/format';
import type { ExposureStats, OfflineStore, OfflineStoreOptions, PrewriteHandle } from '../offline/types';
import type {
  BatchSubmitPort,
  CountersPort,
  FlushReason,
  SubmitContext,
} from '../queue/types';
import { createLeaderElection } from '../leader/leader';
import type { BroadcastPort, LeaderMode, LocksPort } from '../leader/leader';
import { createReplayController } from '../leader/replay';
import type { ReplayRoundResult } from '../leader/replay';
import { createLeaveSender } from './page-leave';
import type { LeaveBudget, LeaveStats } from './page-leave';
import { createBatchSender } from './sender';
import type {
  BatchSender,
  CredentialsPort,
  NativeHttpRefs,
  SenderStats,
  TransportPort,
} from './types';

/** C06 队列中供 C07 使用的控制面（`TransportQueue` 结构上满足它）。 */
export interface QueueControlPort {
  setCircuitOpen(open: boolean): void;
  isCircuitOpen(): boolean;
  inFlight(): boolean;
  limits(): { readonly replayBatchesPerSecond: number };
}

/** 关键事件立即冲刷所需的最小队列能力（`wireEnqueue` 用）。 */
export interface CriticalFlushQueue {
  enqueue(event: QueueEvent): unknown;
  flush(reason?: FlushReason): unknown;
}

export type PageResumeReason = 'online' | 'visible' | 'pageshow';

export interface PageEventsPort {
  subscribe(handler: (reason: PageResumeReason) => void): () => void;
}

/** 页面恢复事件的 DOM 适配（`window` 上同时监听三个事件）。 */
export interface DomPageEventsTarget {
  readonly visibilityState?: string | undefined;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export function createDomPageEventsSource(target: DomPageEventsTarget): PageEventsPort {
  return {
    subscribe(handler: (reason: PageResumeReason) => void): () => void {
      const onOnline = (): void => {
        handler('online');
      };
      const onVisible = (): void => {
        if (target.visibilityState === 'visible') handler('visible');
      };
      const onPageShow = (): void => {
        handler('pageshow');
      };
      target.addEventListener('online', onOnline);
      target.addEventListener('visibilitychange', onVisible);
      target.addEventListener('pageshow', onPageShow);
      return (): void => {
        target.removeEventListener('online', onOnline);
        target.removeEventListener('visibilitychange', onVisible);
        target.removeEventListener('pageshow', onPageShow);
      };
    },
  };
}

export type ReplayReason = 'startup' | 'online' | 'visible' | 'pageshow' | 'manual';

/**
 * 交付层的计数快照。
 *
 * **单位口径（逐字段与 `reason-codes.md` 第 4 节 / `sdk_health.schema.json` 对齐）**：
 * - 名字与契约指标同名的字段（`eventsSent` / `batchesSent` / `batchesFailed` /
 *   `offlineWritten` / `offlineReplayed`），单位与契约描述**逐字一致**；
 * - `offlineWritten` / `offlineReplayed` 是**批次数**（契约明确写「批次数」）；
 *   事件数放在名字里显式带 `Events` 的字段，避免同一个名字有两种含义；
 * - 所有计数都是**自本交付层创建以来的累计值**，契约要求的是「窗口内」增量——
 *   **窗口差分由 C08（T17）负责**；
 * - 不带契约同名的字段是**内部观测量**，不得直接当作 `sdk_health` 指标上报。
 */
export interface DeliveryMetrics {
  /** 契约 `events_sent`：发送成功的事件数（累计）。 */
  readonly eventsSent: number;
  /** 契约 `batches_sent`：发送成功的**批次数**（累计）。413 拆分出的子批次不重复计入。 */
  readonly batchesSent: number;
  /** 契约 `batches_failed`：未成功送达的**批次数**（累计，含重试用尽、终态拒绝与熔断期间未发送的批次）。 */
  readonly batchesFailed: number;
  /** 契约 `offline_written`：写入离线存储的**批次数**（每个事务落盘成功 +1）。 */
  readonly offlineWritten: number;
  /** 非契约指标：写入离线存储的**事件数**（供 T17/T32 参考，不得当作 `offline_written` 上报）。 */
  readonly offlineWrittenEvents: number;
  /** 契约 `offline_replayed`：离线补发的**批次数**（累计）。 */
  readonly offlineReplayed: number;
  /** 非契约指标：离线补发的**事件数**（供 T17/T32 参考，不得当作 `offline_replayed` 上报）。 */
  readonly offlineReplayedEvents: number;
  /** 非契约指标：淘汰的**批次数**；与原因码 `offline_evicted`（`drop_offline_evicted`）同源，勿重复计。 */
  readonly offlineEvicted: number;
  /** 暴露窗口观测量（CR-001 的两个契约指标见 `exposureMetrics()`）。 */
  readonly exposure: ExposureStats;
  /** 离开通道的观测量（**单位是事件数**，见 `LeaveStats`）；无对应契约指标。 */
  readonly leave: LeaveStats;
  /** 重试观测量：`attempts` 是**发送尝试次数**（含重试），`ratio = 重试次数 / 尝试次数`。无对应契约指标。 */
  readonly retry: { readonly attempts: number; readonly ratio: number };
  /** 选主观测量（模式与是否当选）。CR-008：`leaderLost` 是**累计**的"从 leader 变为非 leader"次数（首轮未当选不计）。 */
  readonly leader: { readonly mode: LeaderMode; readonly leader: boolean; readonly leaderLost: number };
  /** 熔断器当前状态；契约里的 `state` 维度是**生命周期状态**，与它无关。 */
  readonly circuitOpen: boolean;
  /** 是否因 401/403 暂停。 */
  readonly paused: boolean;
  /** 最近一次补发的触发来源（诊断用）。 */
  readonly lastReplayReason: ReplayReason;
}

export interface DeliveryOptions {
  readonly appId: string;
  readonly sessionId: string;
  readonly credentials: CredentialsPort;
  readonly offline?: OfflineStore | Omit<OfflineStoreOptions, 'appId' | 'sessionId'> | undefined;
  readonly header?: BatchHeaderSource | undefined;
  readonly http?: NativeHttpRefs | undefined;
  readonly transport?: TransportPort | undefined;
  readonly counters?: CountersPort | undefined;
  readonly pageEvents?: PageEventsPort | undefined;
  readonly locks?: LocksPort | null | undefined;
  readonly broadcast?: BroadcastPort | null | undefined;
  readonly settleMs?: number | undefined;
  readonly queue?: (() => QueueControlPort | null) | undefined;
  readonly now?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly keepaliveSupported?: (() => boolean) | undefined;
  readonly onServerTime?: ((serverTimeMs: number) => void) | undefined;
  readonly leaveBudget?: Partial<LeaveBudget> | undefined;
}

export interface Delivery {
  readonly submit: BatchSubmitPort;
  readonly offline: OfflineStore;
  readonly sender: BatchSender;
  attachQueue(queue: QueueControlPort): void;
  /** 给 C01 的 `EventSink`：critical 事件立即冲刷（POC 的「事件产生即发送」）。 */
  wireEnqueue(queue: CriticalFlushQueue): (event: { readonly priority?: string | undefined }) => void;
  replay(reason?: ReplayReason): Promise<ReplayRoundResult>;
  clearOffline(): Promise<void>;
  metrics(): DeliveryMetrics;
  /** CR-001 的暴露窗口指标（仅事件数 ≥1 时上报，且值 ≥1）。 */
  exposureMetrics(): readonly { readonly name: string; readonly value: number }[];
  start(): () => void;
  dispose(): void;
}

const noopCounters: CountersPort = { count: (): void => undefined };
const LEAVE_BURST_GAP_MS = 100;

/** 创建装配后的 C07 交付层。 */
export function createDelivery(options: DeliveryOptions): Delivery {
  const counters = options.counters ?? noopCounters;
  const now = options.now ?? ((): number => Date.now());
  const offline: OfflineStore =
    options.offline !== undefined && 'prewrite' in options.offline
      ? options.offline
      : createOfflineStore({
          appId: options.appId,
          sessionId: options.sessionId,
          ...(options.offline === undefined ? {} : options.offline),
          ...(options.header === undefined ? {} : { header: options.header }),
          ...(options.counters === undefined ? {} : { counters: options.counters }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });

  const sender = createBatchSender({
    credentials: options.credentials,
    ...(options.http === undefined ? {} : { http: options.http }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.counters === undefined ? {} : { counters: options.counters }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.keepaliveSupported === undefined
      ? {}
      : { keepaliveSupported: options.keepaliveSupported }),
    ...(options.onServerTime === undefined ? {} : { onServerTime: options.onServerTime }),
  });

  const leave = createLeaveSender({
    credentials: options.credentials,
    ...(options.http === undefined ? {} : { http: options.http }),
    transport: sender.transport,
    ...(options.counters === undefined ? {} : { counters: options.counters }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.leaveBudget === undefined ? {} : { budget: options.leaveBudget }),
  });

  const leader = createLeaderElection({
    ...(options.locks === undefined ? {} : { locks: options.locks }),
    ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.counters === undefined ? {} : { counters: options.counters }),
  });

  const replayController = createReplayController({
    offline,
    sender,
    leader,
    counters,
    rate: (): number => queueControl?.limits().replayBatchesPerSecond ?? 1,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });

  let queueControl: QueueControlPort | null = null;
  let disposed = false;
  let replaying = false;
  let lastLeaveAt = 0;
  let eventsSent = 0;
  let batchesSent = 0;
  let batchesFailed = 0;
  // 契约口径：offline_written / offline_replayed 都是**批次数**；
  // 事件数另用显式字段保存（避免同名两义）。
  let offlineWrittenBatches = 0;
  let offlineWrittenEvents = 0;
  let offlineReplayedBatches = 0;
  let offlineReplayedEvents = 0;
  let lastReplayReason: ReplayReason = 'manual';

  function trackHandle(handle: PrewriteHandle): void {
    void handle.settled.then((outcome) => {
      if (outcome.status !== 'durable') return;
      offlineWrittenBatches += 1;
      offlineWrittenEvents += handle.eventCount;
    });
  }

  function deleteWhenDurable(handle: PrewriteHandle): void {
    void handle.settled.then((outcome) => {
      if (outcome.status === 'durable') void offline.remove([handle.batchId]);
    });
  }

  function submit(batch: BatchEnvelope, context: SubmitContext): void {
    if (disposed) {
      context.complete('failed');
      return;
    }
    let handle: PrewriteHandle | null = null;
    try {
      if (countCriticalEvents(batch) > 0) {
        handle = offline.prewrite(batch);
        trackHandle(handle);
      }
    } catch {
      // 存储层自己会计 storage_unavailable；这里只保证不向业务抛错。
      handle = null;
    }

    if (context.channel === 'page_leave') {
      try {
        const startedAt = now();
        if (startedAt - lastLeaveAt > LEAVE_BURST_GAP_MS) leave.resetBudget();
        lastLeaveAt = startedAt;
        leave.send(batch);
      } catch {
        // 离开路径绝不抛错。
      }
      // 信标通道拿不到 202：报 failed，**不删离线副本**（AC-13）。
      context.complete('failed');
      return;
    }

    void sender.send(batch).then(
      (result) => {
        if (result.status === 'sent') {
          eventsSent += batch.events.length;
          batchesSent += 1;
          if (handle !== null) deleteWhenDurable(handle);
        } else if (result.status === 'circuit_open') {
          batchesFailed += 1;
          const control = queueControl;
          if (control !== null) control.setCircuitOpen(true);
        } else {
          batchesFailed += 1;
          // 终态丢弃（4xx / 单条超限）：删除副本，避免补发里无限重试。
          if (result.terminal && handle !== null) deleteWhenDurable(handle);
        }
        context.complete(result.status);
      },
      () => {
        batchesFailed += 1;
        context.complete('failed');
      },
    );
  }

  async function replay(reason: ReplayReason = 'manual'): Promise<ReplayRoundResult> {
    if (disposed || replaying) {
      return { leader: false, mode: 'none', batches: 0, events: 0, skipped: 0 };
    }
    replaying = true;
    lastReplayReason = reason;
    try {
      const result = await replayController.run();
      offlineReplayedBatches += result.batches;
      offlineReplayedEvents += result.events;
      return result;
    } catch {
      return { leader: false, mode: leader.mode(), batches: 0, events: 0, skipped: 0 };
    } finally {
      replaying = false;
    }
  }

  return {
    submit: { submit },

    offline,
    sender,

    attachQueue(queue: QueueControlPort): void {
      queueControl = queue;
    },

    wireEnqueue(queue: CriticalFlushQueue) {
      return (event: { readonly priority?: string | undefined }): void => {
        queue.enqueue(event as unknown as QueueEvent);
        // 「事件产生即发送 critical」：不等 C06 的静默窗口，立即冲刷（POC-1 建议第 1 条）。
        if (event.priority === 'critical') queue.flush('events');
      };
    },

    replay,

    async clearOffline(): Promise<void> {
      await offline.clear();
      offlineWrittenBatches = 0;
      offlineWrittenEvents = 0;
    },

    metrics(): DeliveryMetrics {
      const offlineStats = offline.stats();
      const senderStats: SenderStats = sender.stats();
      return {
        eventsSent,
        batchesSent,
        batchesFailed,
        offlineWritten: offlineWrittenBatches,
        offlineWrittenEvents,
        offlineReplayed: offlineReplayedBatches,
        offlineReplayedEvents,
        offlineEvicted: offlineStats.evictedBatches,
        exposure: offlineStats.exposure,
        leave: leave.stats(),
        retry: { attempts: senderStats.attempts, ratio: senderStats.retryRatio },
        leader: { mode: leader.mode(), leader: leader.lastLeader(), leaderLost: leader.leaderLost() },
        circuitOpen: senderStats.circuitOpen,
        paused: senderStats.paused,
        lastReplayReason,
      };
    },

    exposureMetrics(): readonly { readonly name: string; readonly value: number }[] {
      const exposure = offline.stats().exposure;
      if (exposure.commitLostEvents < 1) return [];
      const metrics: { readonly name: string; readonly value: number }[] = [
        { name: METRIC_EXPOSURE_WINDOW_EVENTS, value: exposure.commitLostEvents },
      ];
      if (exposure.commitLostWindowMs !== null) {
        // CR-001 的 Schema 约束：两个指标都是 `integer, minimum: 1`。
        metrics.push({
          name: METRIC_EXPOSURE_WINDOW_MS,
          value: Math.max(1, Math.round(exposure.commitLostWindowMs)),
        });
      }
      return metrics;
    },

    start(): () => void {
      const pageEvents = options.pageEvents;
      if (pageEvents === undefined) return () => undefined;
      const unsubscribe = pageEvents.subscribe((reason) => {
        void replay(reason);
      });
      void replay('startup');
      return (): void => {
        unsubscribe();
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      queueControl = null;
      offline.dispose();
    },
  };
}
