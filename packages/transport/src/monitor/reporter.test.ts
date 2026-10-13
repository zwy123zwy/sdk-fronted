/**
 * C08-AC-01 至 AC-07 在 reporter 层的可执行用例（时间全部用注入的假定时器，无墙钟断言）。
 *
 * | 用例 | 覆盖点 |
 * |---|---|
 * | AC-01 | 第 1 节每个丢弃原因码都被计数并映射 |
 * | AC-02 | `calls_total` / `events_enqueued` / `events_sent` 与实际一致（经装饰器装饰） |
 * | AC-03 | 1% 会话命中带三个 p99，未命中不带 |
 * | AC-04 | 60 秒上报一条，`window_ms` 为 60000，值为 0 的计数不出现 |
 * | AC-05 | `sdk_health` 本身发送/重试不计入下一个窗口 |
 * | AC-06 | 非零指标超过 50 拆成多条 |
 * | AC-07 | 自监控流量占比（确定性计数 + 体积口径） |
 */
import { describe, expect, test, vi } from 'vitest';
import type { QueueEvent } from '../batch/types';
import {
  combineFixedMetrics,
  createFixedMetricsAccumulator,
  createQueueMetricsSource,
  createSubmitMetricsSource,
} from './adapters';
import { createFakeQueue, createSubmitRecorder, createTestCounters, makeBatch, makeEvent } from './fixtures';
import { createLatencyWindow, createSessionSampler } from './latency';
import { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';
import { createHealthReporter } from './reporter';
import type { HealthState, SdkHealthEvent } from './types';
import { measureTrafficShare } from './traffic';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface ManualTimer {
  readonly timer: { schedule(handler: () => void, intervalMs: number): () => void };
  readonly tick: () => void;
  readonly scheduled: () => boolean;
  readonly cancels: () => number;
  readonly interval: () => number;
}

function createManualTimer(): ManualTimer {
  let handler: (() => void) | null = null;
  let cancels = 0;
  let interval = 0;
  return {
    timer: {
      schedule(callback: () => void, intervalMs: number): () => void {
        handler = callback;
        interval = intervalMs;
        return () => {
          handler = null;
          cancels += 1;
        };
      },
    },
    tick: (): void => {
      const current = handler;
      if (current !== null) current();
    },
    scheduled: (): boolean => handler !== null,
    cancels: (): number => cancels,
    interval: (): number => interval,
  };
}

function createClock(start: number): { readonly now: () => number; readonly advance: (ms: number) => void } {
  let value = start;
  return {
    now: (): number => value,
    advance: (ms: number): void => {
      value += ms;
    },
  };
}

let idSequence = 0;
function createId(): string {
  idSequence += 1;
  return `00000000-0000-4000-8000-${String(idSequence).padStart(12, '0')}`;
}

function mergeMetrics(events: readonly SdkHealthEvent[]): Readonly<Record<string, number>> {
  const merged: Record<string, number> = {};
  for (const event of events) Object.assign(merged, event.metrics);
  return merged;
}

function makeBusinessEvent(index: number): Record<string, unknown> {
  return {
    event_id: `e0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    event_name: 'web_http',
    event_type: 'http',
    schema_version: 1,
    occurred_at: 1_793_000_000_000 + index,
    priority: 'normal',
    sample_rate: 1,
    page_id: '/orders/:id',
    view_id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    url: 'https://app.example.com/orders/12345',
    dimensions: {
      method: 'GET',
      url_template: '/api/orders/:id',
      status_class: '2xx',
    },
    metrics: { status: 200, duration_ms: 120.5, request_bytes: 512, response_bytes: 2048 },
  };
}

describe('createHealthReporter（C08-F3）', () => {
  test('AC-04：60 秒定时上报一条，window_ms=60000，值为 0 的计数不出现', () => {
    const clock = createClock(1_000);
    const manualTimer = createManualTimer();
    const emitted: SdkHealthEvent[] = [];
    const reporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: (event) => emitted.push(event),
      timer: manualTimer.timer,
      now: clock.now,
      createId,
    });
    reporter.start();
    expect(manualTimer.scheduled()).toBe(true);
    expect(manualTimer.interval()).toBe(60_000);
    clock.advance(60_000);
    manualTimer.tick();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.metrics.window_ms).toBe(60_000);
    expect(Object.keys(emitted[0]?.metrics ?? {})).toEqual(['window_ms']);
    clock.advance(60_000);
    manualTimer.tick();
    expect(emitted).toHaveLength(2);
    reporter.dispose();
    expect(manualTimer.cancels()).toBe(1);
    reporter.dispose();
    expect(manualTimer.cancels()).toBe(1);
  });

  test('AC-01：第 1/2 节每个原因码都被计数并映射', () => {
    const counters = createTestCounters();
    for (const code of DROP_REASON_CODES) counters.count(code, 2);
    for (const code of COUNT_REASON_CODES) counters.count(code, 3);
    const reporter = createHealthReporter({
      counters,
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      now: () => 1_000,
      createId,
    });
    const metrics = mergeMetrics(reporter.flush());
    for (const code of DROP_REASON_CODES) {
      expect(metrics[`drop_${code}`], code).toBe(2);
    }
    for (const code of COUNT_REASON_CODES) {
      expect(metrics[`count_${code}`], code).toBe(3);
    }
  });

  test('AC-02：calls_total / events_enqueued / events_sent 与实际一致', () => {
    const clock = createClock(1_000);
    const queueSource = createQueueMetricsSource({ queue: createFakeQueue() });
    const recorder = createSubmitRecorder();
    const submitSource = createSubmitMetricsSource({ submit: recorder.submit });
    const calls = createFixedMetricsAccumulator();
    // 100 条业务事件入队；按 C06 默认 20 条一批，分 5 批全部发送成功。
    for (let index = 0; index < 100; index += 1) queueSource.queue.enqueue(makeEvent());
    for (let batchIndex = 0; batchIndex < 5; batchIndex += 1) {
      submitSource.submit.submit(
        makeBatch(Array.from({ length: 20 }, () => makeEvent())),
        { channel: 'default', complete: () => undefined },
      );
    }
    for (const context of recorder.contexts) context.complete('sent');
    calls.add('calls_total', 100);

    const emitted: SdkHealthEvent[] = [];
    const reporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: (event) => emitted.push(event),
      metrics: combineFixedMetrics(queueSource, submitSource, calls),
      now: clock.now,
      createId,
    });
    const metrics = mergeMetrics(reporter.flush());
    expect(metrics.calls_total).toBe(100);
    expect(metrics.events_enqueued).toBe(100);
    expect(metrics.events_sent).toBe(100);
    expect(metrics.batches_sent).toBe(5);
  });

  test('AC-03：1% 会话命中时带三个 p99，未命中时不带', () => {
    const clock = createClock(1_000);
    const hit = createSessionSampler({ random: () => 0.005, rate: 0.01 });
    const hitWindow = createLatencyWindow({ sampled: hit.sampled() });
    for (let index = 1; index <= 100; index += 1) {
      hitWindow.record('track', index);
      hitWindow.record('pipeline', index * 2);
      hitWindow.record('serialize', index * 3);
    }
    const hitReporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      latency: hitWindow,
      now: clock.now,
      createId,
    });
    const hitMetrics = mergeMetrics(hitReporter.flush());
    expect(hitMetrics.track_p99_ms).toBe(99);
    expect(hitMetrics.pipeline_p99_ms).toBe(198);
    expect(hitMetrics.serialize_p99_ms).toBe(297);

    const miss = createSessionSampler({ random: () => 0.5, rate: 0.01 });
    const missWindow = createLatencyWindow({ sampled: miss.sampled() });
    missWindow.record('track', 5);
    const missReporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      latency: missWindow,
      now: clock.now,
      createId,
    });
    const missMetrics = mergeMetrics(missReporter.flush());
    expect('track_p99_ms' in missMetrics).toBe(false);
    expect('pipeline_p99_ms' in missMetrics).toBe(false);
    expect('serialize_p99_ms' in missMetrics).toBe(false);
  });

  test('AC-05：sdk_health 自身的发送/重试不计入下一个窗口', () => {
    const clock = createClock(1_000);
    const counters = createTestCounters();
    const queueSource = createQueueMetricsSource({ queue: createFakeQueue() });
    const reporter = createHealthReporter({
      counters,
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: (event) => {
        // 模拟“上报动作自身”造成的同步副作用：入队 + 一次丢弃计数。
        queueSource.queue.enqueue(event as unknown as QueueEvent);
        counters.count('queue_evicted');
      },
      metrics: queueSource,
      now: clock.now,
      createId,
    });
    const first = reporter.flush();
    expect(first).toHaveLength(1);
    clock.advance(60_000);
    const second = reporter.flush();
    expect(second).toHaveLength(1);
    expect(second[0]?.metrics).toEqual({ window_ms: 60_000 });
  });

  test('AC-06：一个窗口内非零指标超过 50 时拆成多条', () => {
    const counters = createTestCounters();
    for (const code of DROP_REASON_CODES) counters.count(code);
    for (const code of COUNT_REASON_CODES) counters.count(code);
    // 只使用有真实来源的固定计数（offline_written/offline_replayed 等 T16 修复前不上报）。
    const fixed = createFixedMetricsAccumulator();
    for (const name of [
      'calls_total',
      'events_enqueued',
      'events_sent',
      'batches_sent',
      'batches_failed',
      'queue_length_max',
    ] as const) {
      fixed.add(name);
    }
    const reporter = createHealthReporter({
      counters,
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      metrics: fixed,
      now: () => 1_000,
      createId,
    });
    const events = reporter.flush();
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(Object.keys(event.metrics).length).toBeLessThanOrEqual(50);
      expect(event.metrics.window_ms).toBe(1);
      expect(event.dimensions).toEqual({ sdk_version: '1.2.3', state: 'running' });
    }
    const merged = mergeMetrics(events);
    expect(Object.keys(merged).length).toBe(1 + 6 + DROP_REASON_CODES.length + COUNT_REASON_CODES.length);
  });

  test('AC-07：1000 条业务事件时自监控流量占比不超过 1%（计数与体积口径）', () => {
    const counters = createTestCounters();
    for (const code of ['invalid_args', 'sampled_out_session', 'queue_evicted'] as const) {
      counters.count(code, 2);
    }
    for (const code of ['processor_error', 'retry_5xx', 'replayed'] as const) {
      counters.count(code, 1);
    }
    const fixed = createFixedMetricsAccumulator();
    fixed.add('calls_total', 1_000);
    fixed.add('events_enqueued', 1_000);
    fixed.add('events_sent', 980);
    fixed.add('batches_sent', 49);
    fixed.add('batches_failed', 1);
    const reporter = createHealthReporter({
      counters,
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      metrics: fixed,
      now: () => 1_000,
      createId,
    });
    const health = reporter.flush();
    const business = Array.from({ length: 1_000 }, (_item, index) => makeBusinessEvent(index));
    const share = measureTrafficShare(health, business);
    expect(share.businessEvents).toBe(1_000);
    expect(share.countRatio).toBeLessThanOrEqual(0.01);
    expect(
      share.byteRatio,
      `自监控 ${String(share.healthBytes)} B / 业务 ${String(share.businessBytes)} B`,
    ).toBeLessThanOrEqual(0.01);
  });

  test('生命周期状态不可上报（未初始化）时不产生事件，计数留到下一个窗口', () => {
    const counters = createTestCounters();
    counters.count('invalid_args');
    let state: HealthState | null = null;
    const reporter = createHealthReporter({
      counters,
      dimensions: () => ({ sdk_version: '1.2.3', state }),
      emit: () => undefined,
      now: () => 1_000,
      createId,
    });
    expect(reporter.flush()).toEqual([]);
    state = 'running';
    const events = reporter.flush();
    expect(events[0]?.metrics.drop_invalid_args).toBe(1);
  });

  test('dispose 后 flush 不再产出事件', () => {
    const reporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      now: () => 1_000,
      createId,
    });
    reporter.dispose();
    expect(reporter.flush()).toEqual([]);
  });

  test('config_version 以十进制字符串进入 dimensions，无生效配置时省略', () => {
    let version: number | null = 7;
    const reporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running', config_version: version }),
      emit: () => undefined,
      now: () => 1_000,
      createId,
    });
    expect(reporter.flush()[0]?.dimensions).toEqual({
      sdk_version: '1.2.3',
      state: 'running',
      config_version: '7',
    });
    version = null;
    expect(reporter.flush()[0]?.dimensions).toEqual({ sdk_version: '1.2.3', state: 'running' });
    version = 7.6;
    expect(reporter.flush()[0]?.dimensions.config_version).toBe('8');
    version = 0;
    expect('config_version' in (reporter.flush()[0]?.dimensions ?? {})).toBe(false);
    version = Number.NaN;
    expect('config_version' in (reporter.flush()[0]?.dimensions ?? {})).toBe(false);
  });

  test('缺省 event_id 生成器产出合法 UUID v4', () => {
    const reporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      now: () => 1_000,
    });
    const eventId = reporter.flush()[0]?.event_id ?? '';
    expect(eventId).toMatch(UUID_V4_PATTERN);
  });

  test('crypto.randomUUID 不可用时回退到 UUID v4', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      const reporter = createHealthReporter({
        counters: createTestCounters(),
        dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
        emit: () => undefined,
        now: () => 1_000,
      });
      expect(reporter.flush()[0]?.event_id).toMatch(UUID_V4_PATTERN);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('自定义窗口长度与非法窗口长度', () => {
    const custom = createManualTimer();
    const reporter = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      timer: custom.timer,
      windowMs: 1_000,
    });
    reporter.start();
    expect(custom.interval()).toBe(1_000);

    const fallback = createManualTimer();
    const defaulted = createHealthReporter({
      counters: createTestCounters(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: () => undefined,
      timer: fallback.timer,
      windowMs: Number.NaN,
    });
    defaulted.start();
    expect(fallback.interval()).toBe(60_000);
  });
});
