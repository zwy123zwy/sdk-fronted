/**
 * monitor 测试用的最小结构替身与构造器（**不参与公共导出**）。
 *
 * 只镜像 `packages/core` 与 `packages/transport` 的公开结构，不跨包 import：
 * transport 包声明零依赖，`packages/transport/package.json` 不含 `@web-report-sdk/core`，
 * 因此单测也只能用结构替身（与 T15 的 `CountersPort` 做法一致）。
 */
import type { BatchEnvelope, QueueEvent } from '../batch/types';
import type {
  BatchSubmitPort,
  FlushReason,
  FlushResult,
  QueuePushResult,
  QueuePushStatus,
  SubmitContext,
  TransportQueue,
} from '../queue/types';
import type { FixedMetricDeltas, FixedMetricsPort, HealthCountersPort } from './types';

/** 结构上兼容 `packages/core` 的 `Counters`（含 snapshot/reset）。 */
export type TestCounters = HealthCountersPort & {
  count(reason: string, delta?: number): void;
};

export function createTestCounters(): TestCounters {
  const values = new Map<string, number>();
  return {
    count(reason: string, delta = 1): void {
      if (!Number.isFinite(delta) || delta <= 0) return;
      values.set(reason, (values.get(reason) ?? 0) + delta);
    },
    snapshot(): Readonly<Record<string, number>> {
      return Object.fromEntries(values);
    },
    reset(): void {
      values.clear();
    },
  };
}

/** 每次 take 都返回同一组值的端口（测试里表示“窗口内固定这么多”）。 */
export function constantFixedMetrics(values: FixedMetricDeltas): FixedMetricsPort {
  return { take: (): FixedMetricDeltas => ({ ...values }) };
}

export function makeEvent(overrides: Readonly<Record<string, unknown>> = {}): QueueEvent {
  return {
    event_id: 'e0000000-0000-4000-8000-000000000001',
    event_name: 'demo_event',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: 1_793_000_000_000,
    priority: 'normal',
    ...overrides,
  };
}

export function makeBatch(events: readonly QueueEvent[]): BatchEnvelope {
  return {
    protocol_version: 1,
    app_id: 'demo-app',
    env: 'test',
    release: '1.0.0',
    sdk_name: '@web-report-sdk/transport',
    sdk_version: '1.0.0',
    device_id: 'd0000000-0000-4000-8000-000000000001',
    session_id: '50000000-0000-4000-8000-000000000001',
    clock_offset: 0,
    batch_id: 'b0000000-0000-4000-8000-000000000001',
    sent_at: 1_793_000_000_000,
    events,
  };
}

/** 只记录 enqueue 的最小队列替身；返回结构上完整的 `TransportQueue`。 */
export interface FakeQueue extends TransportQueue {
  readonly pushed: readonly QueueEvent[];
  grow(amount: number): void;
}

export function createFakeQueue(
  options: { readonly status?: QueuePushStatus; readonly length?: number } = {},
): FakeQueue {
  const pushed: QueueEvent[] = [];
  const status: QueuePushStatus = options.status ?? 'queued';
  let length = options.length ?? 0;
  let circuitOpen = false;
  return {
    pushed,
    grow(amount: number): void {
      length += amount;
    },
    enqueue(event: QueueEvent): QueuePushResult {
      pushed.push(event);
      if (status === 'queued' || status === 'evicted' || status === 'spilled') length += 1;
      return { status, event };
    },
    flush(reason?: FlushReason): FlushResult {
      return { status: 'empty', reason: reason ?? 'manual' };
    },
    inFlight: (): boolean => false,
    isCircuitOpen: (): boolean => circuitOpen,
    setCircuitOpen(open: boolean): void {
      circuitOpen = open;
    },
    queueLength: (): number => length,
    queueBytes: (): number => length * 100,
    limits: () => ({
      maxBatchEvents: 20,
      maxBatchBytes: 32_768,
      idleFlushMs: 1_000,
      maxWaitMs: 5_000,
      replayBatchesPerSecond: 1,
      weakNetwork: false,
    }),
    dispose: (): void => undefined,
  };
}

/** 记录提交上下文的假 `BatchSubmitPort`，由测试自行 `complete`。 */
export interface SubmitRecorder {
  readonly submit: BatchSubmitPort;
  readonly contexts: readonly SubmitContext[];
  readonly batches: readonly BatchEnvelope[];
}

export function createSubmitRecorder(): SubmitRecorder {
  const contexts: SubmitContext[] = [];
  const batches: BatchEnvelope[] = [];
  return {
    contexts,
    batches,
    submit: {
      submit(batch: BatchEnvelope, context: SubmitContext): void {
        contexts.push(context);
        batches.push(batch);
      },
    },
  };
}
