/**
 * C06-F2 冲刷触发（C06-AC-04 至 C06-AC-08）、C06-F4 在途控制（C06-AC-10）、
 * C06-F5 弱网自适应（C06-AC-11）的验收用例。
 * 全部时间相关断言使用假定时器。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BatchEnvelope, BatchHeader, QueueEvent } from '../batch/types';
import { DEFAULT_MAX_BATCH_BYTES, DEFAULT_MAX_BATCH_EVENTS } from './constants';
import { createDomPageLeaveSource } from './page-lifecycle';
import { resolveLimits } from './settings';
import { estimateEventBytes } from './size';
import { createTransportQueue } from './transport-queue';
import type {
  BatchSubmitPort,
  CountersPort,
  NetworkSnapshot,
  OfflineSpillPort,
  PageLeaveSignal,
  PageLeaveSource,
  SubmitChannel,
  SubmitContext,
  SubmitOutcome,
  TransportQueue,
  TransportQueueOptions,
  TransportSettings,
  WeakNetworkPolicy,
} from './types';

const START = 1793000000000;
const BATCH_ID = 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e';

const HEADER: BatchHeader = {
  protocol_version: 1,
  app_id: 'demo-app',
  env: 'staging',
  release: '1.4.0',
  sdk_name: 'web-report-sdk',
  sdk_version: '0.1.0',
  device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
  session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
  clock_offset: 0,
};

type TestCounters = CountersPort & { get(reason: string): number };

function makeCounters(): TestCounters {
  const values = new Map<string, number>();
  return {
    count(reason: string, delta = 1): void {
      values.set(reason, (values.get(reason) ?? 0) + delta);
    },
    get(reason: string): number {
      return values.get(reason) ?? 0;
    },
  };
}

let seq = 0;

interface EventOverrides {
  readonly priority?: 'normal' | 'critical' | undefined;
  readonly page_id?: string | undefined;
  readonly url?: string | undefined;
  readonly attachment?: string | undefined;
}

function makeEvent(overrides: EventOverrides = {}): QueueEvent {
  seq += 1;
  const event: QueueEvent = {
    event_id: `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    event_name: 'web_vitals',
    event_type: 'perf',
    schema_version: 1,
    occurred_at: START + seq,
    priority: overrides.priority ?? 'normal',
  };
  if (overrides.page_id !== undefined) event['page_id'] = overrides.page_id;
  if (overrides.url !== undefined) event['url'] = overrides.url;
  if (overrides.attachment !== undefined) event['attachment'] = overrides.attachment;
  return event;
}

function makeEventOfSize(target: number): QueueEvent {
  const base = makeEvent({ attachment: '' });
  const pad = target - estimateEventBytes(base);
  expect(pad).toBeGreaterThan(0);
  return makeEvent({ attachment: 'a'.repeat(pad) });
}

function enqueueMany(queue: TransportQueue, count: number): void {
  for (let i = 0; i < count; i += 1) queue.enqueue(makeEvent());
}

interface Submission {
  readonly batch: BatchEnvelope;
  readonly channel: SubmitChannel;
  readonly at: number;
  readonly complete: (outcome: SubmitOutcome) => void;
}

interface FakePageLeave extends PageLeaveSource {
  emit(signal: PageLeaveSignal): void;
  subscribers(): number;
}

function makePageLeave(): FakePageLeave {
  const handlers = new Set<(signal: PageLeaveSignal) => void>();
  return {
    subscribe(handler: (signal: PageLeaveSignal) => void): () => void {
      handlers.add(handler);
      return (): void => {
        handlers.delete(handler);
      };
    },
    emit(signal: PageLeaveSignal): void {
      for (const handler of [...handlers]) handler(signal);
    },
    subscribers(): number {
      return handlers.size;
    },
  };
}

interface HarnessOptions {
  readonly settings?: TransportSettings | undefined;
  readonly network?: NetworkSnapshot | undefined;
  readonly autoComplete?: SubmitOutcome | null | undefined;
  readonly pageLeave?: PageLeaveSource | undefined;
  readonly weakNetwork?: WeakNetworkPolicy | undefined;
  readonly offline?: OfflineSpillPort | undefined;
}

interface Harness {
  readonly queue: TransportQueue;
  readonly submissions: Submission[];
  readonly counters: TestCounters;
}

const created: TransportQueue[] = [];

function makeHarness(options: HarnessOptions = {}): Harness {
  const counters = makeCounters();
  const submissions: Submission[] = [];
  const auto = options.autoComplete === undefined ? 'sent' : options.autoComplete;
  const submit: BatchSubmitPort = {
    submit(batch: BatchEnvelope, context: SubmitContext): void {
      submissions.push({
        batch,
        channel: context.channel,
        at: Date.now(),
        complete: context.complete,
      });
      if (auto !== null) context.complete(auto);
    },
  };
  const queueOptions: TransportQueueOptions = {
    config: { transport: () => options.settings ?? {} },
    submit,
    header: { header: () => HEADER },
    counters,
    now: () => Date.now(),
    createId: () => BATCH_ID,
    network: options.network === undefined ? undefined : { snapshot: () => options.network ?? {} },
    pageLeave: options.pageLeave,
    weakNetwork: options.weakNetwork,
    offline: options.offline,
  };
  const queue = createTransportQueue(queueOptions);
  created.push(queue);
  return { queue, submissions, counters };
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('期望至少有一个元素');
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  for (const queue of created) queue.dispose();
  created.length = 0;
  vi.useRealTimers();
});

describe('C06-F2 冲刷触发', () => {
  test('C06-AC-04 连续入队 20 条时立即冲刷一个批次', () => {
    const harness = makeHarness();

    enqueueMany(harness.queue, 19);
    expect(harness.submissions).toHaveLength(0);
    expect(harness.queue.queueBytes()).toBeGreaterThan(0);
    enqueueMany(harness.queue, 1);

    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).batch.events).toHaveLength(DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.queue.queueLength()).toBe(0);
    expect(harness.queue.inFlight()).toBe(false);
  });

  test('C06-AC-05 入队体积达到 32 KB 时立即冲刷（不足 20 条）', () => {
    const harness = makeHarness();
    const perEvent = DEFAULT_MAX_BATCH_BYTES / 8;

    for (let i = 0; i < 7; i += 1) harness.queue.enqueue(makeEventOfSize(perEvent));
    expect(harness.submissions).toHaveLength(0);

    harness.queue.enqueue(makeEventOfSize(perEvent));

    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).batch.events).toHaveLength(8);
    expect(harness.queue.queueLength()).toBe(0);
  });

  test('C06-AC-06 入队 1 条后静默 1 秒冲刷', () => {
    const harness = makeHarness();

    harness.queue.enqueue(makeEvent());
    vi.advanceTimersByTime(999);
    expect(harness.submissions).toHaveLength(0);

    vi.advanceTimersByTime(1);

    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).batch.events).toHaveLength(1);
    expect(first(harness.submissions).at - START).toBe(1000);
  });

  test('C06-AC-06 每 500 ms 入队一条持续 6 秒时在第 5 秒因最长等待冲刷', () => {
    const harness = makeHarness();

    for (let i = 0; i < 11; i += 1) {
      harness.queue.enqueue(makeEvent());
      vi.advanceTimersByTime(500);
    }

    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).at - START).toBe(5000);
    expect(first(harness.submissions).batch.events).toHaveLength(10);
    expect(harness.queue.queueLength()).toBe(1);
  });

  test('C06-AC-07 visibilitychange 为 hidden 时同步冲刷并使用页面离开通道', () => {
    const pageLeave = makePageLeave();
    const harness = makeHarness({ pageLeave });
    harness.queue.enqueue(makeEvent({ page_id: '/list' }));
    harness.queue.enqueue(makeEvent({ page_id: '/list' }));

    pageLeave.emit('hidden');

    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).channel).toBe('page_leave');
    expect(first(harness.submissions).batch.events).toHaveLength(2);
    expect(harness.queue.queueLength()).toBe(0);
  });

  test('C06-AC-07 pagehide 时同步冲刷并使用页面离开通道', () => {
    const pageLeave = makePageLeave();
    const harness = makeHarness({ pageLeave });
    harness.queue.enqueue(makeEvent());

    pageLeave.emit('pagehide');

    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).channel).toBe('page_leave');
    expect(first(harness.submissions).batch.events).toHaveLength(1);
  });

  test('C06-AC-07 DOM 页面离开信号源只在 hidden 与 pagehide 时冲刷', () => {
    const pageLeave = createDomPageLeaveSource(document);
    const harness = makeHarness({ pageLeave });
    harness.queue.enqueue(makeEvent());

    document.dispatchEvent(new Event('visibilitychange'));
    expect(harness.submissions).toHaveLength(0);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).channel).toBe('page_leave');

    harness.queue.enqueue(makeEvent());
    document.dispatchEvent(new Event('pagehide'));
    expect(harness.submissions).toHaveLength(2);
    expect(harness.queue.queueLength()).toBe(0);
  });

  test('C06-AC-07 页面离开时队列超过单批上限也会同步分多次提交', () => {
    const pageLeave = makePageLeave();
    const harness = makeHarness({ pageLeave, autoComplete: null });
    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.submissions).toHaveLength(1);

    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS * 2);
    expect(harness.submissions).toHaveLength(1);
    expect(harness.queue.queueLength()).toBe(DEFAULT_MAX_BATCH_EVENTS * 2);

    pageLeave.emit('pagehide');

    expect(harness.submissions).toHaveLength(3);
    expect(first(harness.submissions.slice(1)).channel).toBe('page_leave');
    expect(first(harness.submissions.slice(1)).batch.events).toHaveLength(DEFAULT_MAX_BATCH_EVENTS);
    expect(first(harness.submissions.slice(2)).batch.events).toHaveLength(DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.queue.queueLength()).toBe(0);
  });

  test('C06-AC-08 业务调用 flush 立即冲刷', () => {
    const harness = makeHarness();
    enqueueMany(harness.queue, 3);

    const result = harness.queue.flush();

    expect(result.status).toBe('submitted');
    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).batch.events).toHaveLength(3);
    expect(harness.queue.queueLength()).toBe(0);
  });

  test('C06-AC-08 空队列调用 flush 不提交', () => {
    const harness = makeHarness();

    const result = harness.queue.flush('manual');

    expect(result.status).toBe('empty');
    expect(harness.submissions).toHaveLength(0);
  });
});

describe('C06-F4 在途控制', () => {
  test('C06-AC-10 在途批次未完成时不发第二个常规批次，完成后继续冲刷', () => {
    const harness = makeHarness({ autoComplete: null });

    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.submissions).toHaveLength(1);
    expect(harness.queue.inFlight()).toBe(true);

    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.submissions).toHaveLength(1);
    expect(harness.queue.queueLength()).toBe(DEFAULT_MAX_BATCH_EVENTS);

    const blocked = harness.queue.flush();
    expect(blocked.status).toBe('in_flight');
    expect(harness.submissions).toHaveLength(1);

    first(harness.submissions).complete('sent');

    expect(harness.submissions).toHaveLength(2);
    const sentIds = first(harness.submissions).batch.events.map((event) => event.event_id);
    const lateIds = first(harness.submissions.slice(1)).batch.events.map((event) => event.event_id);
    expect(lateIds).not.toEqual(sentIds);
    expect(first(harness.submissions.slice(1)).batch.events).toHaveLength(DEFAULT_MAX_BATCH_EVENTS);

    first(harness.submissions.slice(1)).complete('sent');

    expect(harness.queue.inFlight()).toBe(false);
    expect(harness.queue.queueLength()).toBe(0);
  });

  test('C06-F4 在途期间计时器触发不会提交第二个常规批次', () => {
    const harness = makeHarness({ autoComplete: null });
    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.submissions).toHaveLength(1);

    enqueueMany(harness.queue, 3);
    vi.advanceTimersByTime(60_000);

    expect(harness.submissions).toHaveLength(1);
    expect(harness.queue.queueLength()).toBe(3);
  });

  test('C06-F4 熔断期间暂停常规冲刷并计数 circuit_open，恢复后继续', () => {
    const harness = makeHarness();
    enqueueMany(harness.queue, 2);
    harness.queue.setCircuitOpen(true);

    const blocked = harness.queue.flush();
    expect(blocked.status).toBe('circuit_open');
    expect(harness.counters.get('circuit_open')).toBe(1);
    expect(harness.submissions).toHaveLength(0);

    harness.queue.setCircuitOpen(false);

    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).batch.events).toHaveLength(2);
  });

  test('C06-F4 提交返回 circuit_open 信号后进入熔断，后续入队只排队', () => {
    const harness = makeHarness({ autoComplete: 'circuit_open' });

    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);

    expect(harness.queue.isCircuitOpen()).toBe(true);
    expect(harness.counters.get('circuit_open')).toBe(1);

    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.submissions).toHaveLength(1);
    expect(harness.queue.queueLength()).toBe(DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.queue.inFlight()).toBe(false);
  });

  test('C06-F4 提交端口抛错时不向外抛，并释放在途状态', () => {
    const counters = makeCounters();
    let attempts = 0;
    const queue = createTransportQueue({
      config: { transport: () => ({}) },
      submit: {
        submit(): void {
          attempts += 1;
          throw new Error('发送端口未就绪');
        },
      },
      header: { header: () => HEADER },
      counters,
      now: () => Date.now(),
      createId: () => BATCH_ID,
    });
    created.push(queue);

    enqueueMany(queue, DEFAULT_MAX_BATCH_EVENTS);

    expect(attempts).toBe(1);
    expect(queue.inFlight()).toBe(false);
    expect(counters.get('processor_error')).toBe(1);
  });

  test('C06-F4 批次头来源抛错时只计数 processor_error，不向外抛', () => {
    const counters = makeCounters();
    const harness = {
      submissions: [] as Submission[],
    };
    const queue = createTransportQueue({
      config: { transport: () => ({}) },
      submit: {
        submit(batch: BatchEnvelope, context: SubmitContext): void {
          harness.submissions.push({
            batch,
            channel: context.channel,
            at: Date.now(),
            complete: context.complete,
          });
          context.complete('sent');
        },
      },
      header: {
        header: (): BatchHeader => {
          throw new Error('批次头未就绪');
        },
      },
      counters,
      now: () => Date.now(),
      createId: () => BATCH_ID,
    });
    created.push(queue);

    enqueueMany(queue, DEFAULT_MAX_BATCH_EVENTS);

    expect(harness.submissions).toHaveLength(0);
    expect(counters.get('processor_error')).toBe(1);
    expect(queue.queueLength()).toBe(0);
    expect(queue.inFlight()).toBe(false);
  });
});

describe('C06-F5 弱网自适应', () => {
  test('C06-AC-11 effectiveType 为 2g 时按配置放大批次条数上限', () => {
    const harness = makeHarness({ network: { effectiveType: '2g' } });

    expect(harness.queue.limits().weakNetwork).toBe(true);
    expect(harness.queue.limits().maxBatchEvents).toBe(DEFAULT_MAX_BATCH_EVENTS * 2);
    expect(harness.queue.limits().idleFlushMs).toBe(2000);

    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.submissions).toHaveLength(0);

    enqueueMany(harness.queue, DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.submissions).toHaveLength(1);
    expect(first(harness.submissions).batch.events).toHaveLength(DEFAULT_MAX_BATCH_EVENTS * 2);
  });

  test('C06-AC-11 saveData 为 true 时静默时间按配置放大', () => {
    const harness = makeHarness({ network: { saveData: true } });

    harness.queue.enqueue(makeEvent());
    vi.advanceTimersByTime(1999);
    expect(harness.submissions).toHaveLength(0);

    vi.advanceTimersByTime(1);

    expect(harness.submissions).toHaveLength(1);
    expect(harness.queue.limits().idleFlushMs).toBe(2000);
  });

  test('C06-AC-11 未命中弱网条件时使用默认上限', () => {
    const harness = makeHarness({ network: { effectiveType: '4g', saveData: false } });

    expect(harness.queue.limits().weakNetwork).toBe(false);
    expect(harness.queue.limits().maxBatchEvents).toBe(DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.queue.limits().idleFlushMs).toBe(1000);
  });

  test('C06-AC-11 放大倍率可配置，且不超过契约上限', () => {
    const policy: WeakNetworkPolicy = { batchEventsMultiplier: 3, idleFlushMsMultiplier: 5 };
    const harness = makeHarness({ network: { effectiveType: '2g' }, weakNetwork: policy });

    expect(harness.queue.limits().maxBatchEvents).toBe(60);
    expect(harness.queue.limits().idleFlushMs).toBe(5000);

    const capped = makeHarness({
      network: { effectiveType: '2g' },
      settings: { max_batch_events: 100, idle_flush_ms: 10000 },
    });
    expect(capped.queue.limits().maxBatchEvents).toBe(100);
    expect(capped.queue.limits().idleFlushMs).toBe(10000);
  });

  test('C06-AC-11 非法放大倍率按不放大处理', () => {
    const harness = makeHarness({
      network: { saveData: true },
      weakNetwork: { batchEventsMultiplier: 0, idleFlushMsMultiplier: Number.NaN },
    });

    expect(harness.queue.limits().weakNetwork).toBe(true);
    expect(harness.queue.limits().maxBatchEvents).toBe(DEFAULT_MAX_BATCH_EVENTS);
    expect(harness.queue.limits().idleFlushMs).toBe(1000);
  });
});

describe('C06-F2 生效配置（transport 组）', () => {
  test('读取注入的 transport 配置', () => {
    const harness = makeHarness({
      settings: {
        max_batch_events: 30,
        max_batch_bytes: 4096,
        idle_flush_ms: 500,
        max_wait_ms: 2000,
        replay_batches_per_second: 2,
      },
    });

    expect(harness.queue.limits()).toMatchObject({
      maxBatchEvents: 30,
      maxBatchBytes: 4096,
      idleFlushMs: 500,
      maxWaitMs: 2000,
      replayBatchesPerSecond: 2,
    });
  });

  test('超出契约区间的值回退默认值', () => {
    const limits = resolveLimits(
      {
        max_batch_events: 1000,
        max_batch_bytes: 10,
        idle_flush_ms: 0,
        max_wait_ms: 60_001,
        replay_batches_per_second: 3,
      },
      {},
      {},
    );

    expect(limits).toMatchObject({
      maxBatchEvents: DEFAULT_MAX_BATCH_EVENTS,
      maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
      idleFlushMs: 1000,
      maxWaitMs: 5000,
      replayBatchesPerSecond: 1,
    });
  });

  test('全部缺省时使用契约区间内的默认值', () => {
    const limits = resolveLimits({}, {}, {});

    expect(limits.maxBatchEvents).toBe(20);
    expect(limits.maxBatchBytes).toBe(32 * 1024);
    expect(limits.idleFlushMs).toBe(1000);
    expect(limits.maxWaitMs).toBe(5000);
    expect(limits.replayBatchesPerSecond).toBe(1);
    expect(limits.weakNetwork).toBe(false);
  });

  test('dispose 后释放定时器与页面离开订阅', () => {
    const pageLeave = makePageLeave();
    const harness = makeHarness({ pageLeave });
    harness.queue.enqueue(makeEvent());
    expect(pageLeave.subscribers()).toBe(1);

    harness.queue.dispose();
    vi.advanceTimersByTime(60_000);
    pageLeave.emit('pagehide');

    expect(harness.submissions).toHaveLength(0);
    expect(pageLeave.subscribers()).toBe(0);
  });
});
