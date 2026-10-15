/**
 * 计数来源装饰器与端口适配器用例（C08-F1）：
 * - `createQueueMetricsSource`：包装 C06 公开的 `enqueue()` + `queueLength()`，
 *   得到窗口内的 `events_enqueued` 与精确的 `queue_length_max` 峰值，
 *   并按 `event_name === 'sdk_health'` 排除自监控事件（AC-05）；
 * - `createSubmitMetricsSource`：包装 C07 公开的 `BatchSubmitPort`，
 *   按提交结果得到 `events_sent` / `batches_sent` / `batches_failed`，同样排除自监控批次；
 * - `createDeliveryMetricsSource`：把 T16 `DeliveryMetrics` 的 `offlineWritten` /
 *   `offlineReplayed`（**批次数**、累计值）做窗口差分；`offlineEvicted` 与原因码
 *   `offline_evicted` 同源，只取原因码一处以避免双计；
 * - 其余端口（暴露窗口、定时器、生命周期维度、固定计数累加器）。
 */
import { describe, expect, test } from 'vitest';
import type { QueueEvent } from '../batch/types';
import {
  combineFixedMetrics,
  createDeliveryMetricsSource,
  createFixedMetricsAccumulator,
  createHealthDimensionsReader,
  createOfflineExposureSource,
  createQueueMetricsSource,
  createRegistryTimer,
  createSubmitMetricsSource,
} from './adapters';
import {
  constantFixedMetrics,
  createFakeQueue,
  createSubmitRecorder,
  makeBatch,
  makeEvent,
} from './fixtures';
import { createHealthReporter } from './reporter';

const SELF_EVENT: QueueEvent = makeEvent({ event_name: 'sdk_health', event_type: 'sdk_internal' });

describe('createQueueMetricsSource', () => {
  test('events_enqueued 按入队状态计数（rejected 不计）', () => {
    const accepted = createQueueMetricsSource({ queue: createFakeQueue({ status: 'queued' }) });
    accepted.queue.enqueue(makeEvent());
    accepted.queue.enqueue(makeEvent());
    expect(accepted.take()).toEqual({ events_enqueued: 2, queue_length_max: 2 });

    const spilled = createQueueMetricsSource({ queue: createFakeQueue({ status: 'spilled' }) });
    spilled.queue.enqueue(makeEvent());
    expect(spilled.take()).toEqual({ events_enqueued: 1, queue_length_max: 1 });

    const evicted = createQueueMetricsSource({ queue: createFakeQueue({ status: 'evicted' }) });
    evicted.queue.enqueue(makeEvent());
    expect(evicted.take()).toEqual({ events_enqueued: 1, queue_length_max: 1 });

    const rejected = createQueueMetricsSource({ queue: createFakeQueue({ status: 'rejected' }) });
    rejected.queue.enqueue(makeEvent());
    expect(rejected.take()).toEqual({});
  });

  test('queue_length_max 取窗口内峰值，且 take 后清零', () => {
    const source = createQueueMetricsSource({ queue: createFakeQueue({ length: 3 }) });
    source.take();
    source.queue.enqueue(makeEvent());
    source.queue.enqueue(makeEvent());
    expect(source.take()).toEqual({ events_enqueued: 2, queue_length_max: 5 });
    expect(source.take()).toEqual({});
  });

  test('自监控事件不计入 events_enqueued（AC-05）', () => {
    const source = createQueueMetricsSource({ queue: createFakeQueue() });
    source.queue.enqueue(SELF_EVENT);
    expect(source.take()).toEqual({});
    source.queue.enqueue(makeEvent());
    // queue_length_max 是「非自监控入队时刻」的队列占用量观测量：此时自监控事件
    // 仍在队列里（占 1），因此观测到 2；它不把 sdk_health 计成业务事件。
    expect(source.take()).toEqual({ events_enqueued: 1, queue_length_max: 2 });
  });

  test('包装后的队列仍代理 C06 的其它公开方法', () => {
    const fake = createFakeQueue({ length: 2 });
    const source = createQueueMetricsSource({ queue: fake });
    expect(source.queue.queueLength()).toBe(2);
    expect(source.queue.flush('manual')).toEqual({ status: 'empty', reason: 'manual' });
    expect(source.queue.inFlight()).toBe(false);
    expect(source.queue.isCircuitOpen()).toBe(false);
    expect(source.queue.limits().maxBatchEvents).toBe(20);
    expect(source.queue.queueBytes()).toBe(200);
    source.queue.setCircuitOpen(true);
    source.queue.dispose();
  });
});

describe('createSubmitMetricsSource', () => {
  test('sent 累计成功事件数与批次数', () => {
    const recorder = createSubmitRecorder();
    const source = createSubmitMetricsSource({ submit: recorder.submit });
    const outcomes: string[] = [];
    source.submit.submit(makeBatch([makeEvent(), makeEvent()]), {
      channel: 'default',
      complete: (outcome) => outcomes.push(outcome),
    });
    recorder.contexts[0]?.complete('sent');
    expect(outcomes).toEqual(['sent']);
    expect(source.take()).toEqual({ events_sent: 2, batches_sent: 1 });
    expect(source.take()).toEqual({});
  });

  test('failed 与 circuit_open 计入 batches_failed', () => {
    const recorder = createSubmitRecorder();
    const source = createSubmitMetricsSource({ submit: recorder.submit });
    source.submit.submit(makeBatch([makeEvent()]), { channel: 'default', complete: () => undefined });
    recorder.contexts[0]?.complete('failed');
    source.submit.submit(makeBatch([makeEvent()]), { channel: 'default', complete: () => undefined });
    recorder.contexts[1]?.complete('circuit_open');
    expect(source.take()).toEqual({ batches_failed: 2 });
  });

  test('自监控批次被排除（AC-05）', () => {
    const recorder = createSubmitRecorder();
    const source = createSubmitMetricsSource({ submit: recorder.submit });
    source.submit.submit(makeBatch([SELF_EVENT]), { channel: 'default', complete: () => undefined });
    recorder.contexts[0]?.complete('sent');
    expect(source.take()).toEqual({});
  });

  test('混合批次：只计业务事件数，批次数不计（避免把自监控算进去）', () => {
    const recorder = createSubmitRecorder();
    const source = createSubmitMetricsSource({ submit: recorder.submit });
    source.submit.submit(makeBatch([makeEvent(), makeEvent(), SELF_EVENT]), {
      channel: 'default',
      complete: () => undefined,
    });
    recorder.contexts[0]?.complete('sent');
    expect(source.take()).toEqual({ events_sent: 2 });
  });
});

describe('固定计数端口', () => {
  test('累加器：add 求和、observePeak 取最大、take 后清零', () => {
    const accumulator = createFixedMetricsAccumulator();
    accumulator.add('calls_total', 5);
    accumulator.add('calls_total', 2);
    accumulator.add('events_sent');
    accumulator.add('events_sent', -1);
    accumulator.add('calls_total', Number.NaN);
    accumulator.observePeak('queue_length_max', 3);
    accumulator.observePeak('queue_length_max', 1);
    expect(accumulator.take()).toEqual({
      calls_total: 7,
      events_sent: 1,
      queue_length_max: 3,
    });
    expect(accumulator.take()).toEqual({});
  });

  test('combineFixedMetrics：计数求和，queue_length_max 取最大', () => {
    const combined = combineFixedMetrics(
      constantFixedMetrics({ calls_total: 1, queue_length_max: 5 }),
      constantFixedMetrics({ calls_total: 2, events_sent: 4, queue_length_max: 9 }),
    );
    expect(combined.take()).toEqual({ calls_total: 3, events_sent: 4, queue_length_max: 9 });
  });
});

describe('createDeliveryMetricsSource（T16 批次计数 → 窗口差分）', () => {
  interface FakeDelivery {
    metrics(): { readonly offlineWritten: number; readonly offlineReplayed: number };
    advance(written: number, replayed: number): void;
    reset(): void;
  }

  function createFakeDelivery(): FakeDelivery {
    let offlineWritten = 0;
    let offlineReplayed = 0;
    return {
      metrics: () => ({ offlineWritten, offlineReplayed }),
      advance: (written, replayed) => {
        offlineWritten += written;
        offlineReplayed += replayed;
      },
      reset: () => {
        offlineWritten = 0;
        offlineReplayed = 0;
      },
    };
  }

  test('返回窗口增量，take 后清零', () => {
    const delivery = createFakeDelivery();
    const source = createDeliveryMetricsSource(delivery);
    expect(source.take()).toEqual({});
    delivery.advance(2, 1);
    expect(source.take()).toEqual({ offline_written: 2, offline_replayed: 1 });
    expect(source.take()).toEqual({});
  });

  test('适配器创建时的累计值作为基线，不计入第一个窗口', () => {
    const delivery = createFakeDelivery();
    delivery.advance(5, 3);
    const source = createDeliveryMetricsSource(delivery);
    expect(source.take()).toEqual({});
    delivery.advance(1, 0);
    expect(source.take()).toEqual({ offline_written: 1 });
  });

  test('计数回退（清空离线存储）时不产生负值', () => {
    const delivery = createFakeDelivery();
    const source = createDeliveryMetricsSource(delivery);
    delivery.advance(4, 2);
    expect(source.take()).toEqual({ offline_written: 4, offline_replayed: 2 });
    delivery.reset();
    expect(source.take()).toEqual({});
    delivery.advance(1, 1);
    expect(source.take()).toEqual({ offline_written: 1, offline_replayed: 1 });
  });
});

describe('其余端口适配器', () => {
  test('createOfflineExposureSource 读取 T16 的暴露窗口观测量', () => {
    const source = createOfflineExposureSource({
      stats: () => ({ exposure: { commitLostEvents: 2, commitLostWindowMs: 40 } }),
    });
    // CR-008：没有下界读数时 `observedWindowMs` 为 null（夹逼不成立，映射层不上报端点）。
    expect(source.exposure()).toEqual({ events: 2, windowMs: 40, observedWindowMs: null });
  });

  test('createOfflineExposureSource 同时读取 CR-007 的下界读数（CR-008 的夹逼左端点）', () => {
    const source = createOfflineExposureSource({
      stats: () => ({
        exposure: {
          commitLostEvents: 2,
          commitLostWindowMs: 1247,
          commitLostObservedWindowMs: 7,
        },
      }),
    });
    expect(source.exposure()).toEqual({ events: 2, windowMs: 1247, observedWindowMs: 7 });
  });

  test('createRegistryTimer 委托给 C02 全局注册表的 scheduleRepeat', () => {
    let interval = 0;
    let cancelled = 0;
    const captured: { current: (() => void) | null } = { current: null };
    const timer = createRegistryTimer({
      scheduleRepeat: (callback, intervalMs) => {
        captured.current = callback;
        interval = intervalMs;
        return () => {
          cancelled += 1;
        };
      },
    });
    let fired = 0;
    const cancel = timer.schedule(() => {
      fired += 1;
    }, 60_000);
    expect(interval).toBe(60_000);
    captured.current?.();
    expect(fired).toBe(1);
    cancel();
    expect(cancelled).toBe(1);
  });

  test('createHealthDimensionsReader 映射 C02 生命周期状态，未初始化态不上报', () => {
    let state = 'initialized';
    const reader = createHealthDimensionsReader({
      sdkVersion: '1.2.3',
      lifecycle: { state: () => state },
      configVersion: () => 7,
    });
    expect(reader()).toEqual({ sdk_version: '1.2.3', state: 'initialized', config_version: 7 });
    for (const [from, to] of [
      ['running', 'running'],
      ['paused', 'paused'],
      ['destroyed', 'destroyed'],
    ] as const) {
      state = from;
      expect(reader().state).toBe(to);
    }
    state = 'uninitialized';
    expect(reader().state).toBeNull();
    state = 'not-a-state';
    expect(reader().state).toBeNull();
  });

  test('createHealthDimensionsReader：没有生效配置时 config_version 为 null', () => {
    const reader = createHealthDimensionsReader({
      sdkVersion: '1.2.3',
      lifecycle: { state: () => 'running' },
    });
    expect(reader()).toEqual({ sdk_version: '1.2.3', state: 'running', config_version: null });
  });
});

describe('装饰器接入 reporter（装配前的最小闭环）', () => {
  test('队列 + 提交流量经端口汇总进 sdk_health', () => {
    const queueSource = createQueueMetricsSource({ queue: createFakeQueue() });
    const recorder = createSubmitRecorder();
    const submitSource = createSubmitMetricsSource({ submit: recorder.submit });
    queueSource.queue.enqueue(makeEvent());
    queueSource.queue.enqueue(makeEvent());
    submitSource.submit.submit(makeBatch([makeEvent()]), {
      channel: 'default',
      complete: () => undefined,
    });
    recorder.contexts[0]?.complete('sent');

    const events = createHealthReporter({
      counters: { snapshot: () => ({}), reset: () => undefined },
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      metrics: combineFixedMetrics(queueSource, submitSource),
      now: () => 1_000,
      createId: () => '00000000-0000-4000-8000-000000000001',
    }).flush();
    expect(events[0]?.metrics).toMatchObject({
      window_ms: 1,
      events_enqueued: 2,
      queue_length_max: 2,
      events_sent: 1,
      batches_sent: 1,
    });
  });
});
