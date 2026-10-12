/**
 * C06-F1 双上限内存队列的验收用例（C06-AC-01、C06-AC-02、C06-AC-03）。
 * 时间无关，全部同步断言。
 */
import { describe, expect, test } from 'vitest';
import type { QueueEvent } from '../batch/types';
import { QUEUE_MAX_BYTES, QUEUE_MAX_EVENTS } from './constants';
import { createMemoryQueue } from './memory-queue';
import { estimateEventBytes } from './size';
import type { CountersPort } from './types';

const START = 1793000000000;
let seq = 0;

interface EventOverrides {
  readonly priority?: 'normal' | 'critical' | undefined;
  readonly page_id?: string | undefined;
  readonly url?: string | undefined;
  readonly attachment?: string | undefined;
  readonly sample_rate?: number | undefined;
  readonly context?: Record<string, string> | undefined;
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
  if (overrides.sample_rate !== undefined) event['sample_rate'] = overrides.sample_rate;
  if (overrides.context !== undefined) event['context'] = overrides.context;
  return event;
}

/** 构造可被 estimateEventBytes 精确测量为 target 码元的事件（体积与 attachment 长度线性）。 */
function makeEventOfSize(target: number): QueueEvent {
  const base = makeEvent({ attachment: '' });
  const pad = target - estimateEventBytes(base);
  expect(pad).toBeGreaterThan(0);
  return makeEvent({ attachment: 'a'.repeat(pad) });
}

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

function ids(events: readonly QueueEvent[]): readonly unknown[] {
  return events.map((event) => event.event_id);
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('期望至少有一个元素');
  return value;
}

describe('C06-F1 双上限内存队列', () => {
  test('C06-AC-01 队列保留最新 500 条并计数 queue_evicted', () => {
    const counters = makeCounters();
    const queue = createMemoryQueue({ counters });
    const events = Array.from({ length: 600 }, () => makeEvent());

    for (const event of events) queue.push(event);

    expect(queue.size()).toBe(QUEUE_MAX_EVENTS);
    expect(queue.bytes()).toBeLessThanOrEqual(QUEUE_MAX_BYTES);
    expect(counters.get('queue_evicted')).toBe(100);
    expect(ids(queue.drainUpTo(QUEUE_MAX_EVENTS, QUEUE_MAX_BYTES).events)).toEqual(
      ids(events.slice(100)),
    );
  });

  test('C06-AC-02 入队总体积超过 512 KB 时按体积上限淘汰最早的 normal 事件', () => {
    const counters = makeCounters();
    const queue = createMemoryQueue({ counters });
    const events = Array.from({ length: 200 }, () => makeEventOfSize(4096));
    const first = events[0];
    if (first === undefined) throw new Error('用例需要事件');
    expect(estimateEventBytes(first)).toBe(4096);

    for (const event of events) queue.push(event);

    const capacity = Math.floor(QUEUE_MAX_BYTES / 4096);
    expect(queue.size()).toBe(capacity);
    expect(queue.bytes()).toBe(capacity * 4096);
    expect(counters.get('queue_evicted')).toBe(200 - capacity);
    expect(ids(queue.drainUpTo(capacity, QUEUE_MAX_BYTES).events)).toEqual(
      ids(events.slice(200 - capacity)),
    );
  });

  test('C06-AC-03 队列已满时入队 critical：淘汰的是最早的 normal 事件，critical 保留', () => {
    const counters = makeCounters();
    const queue = createMemoryQueue({ counters });
    const normals = Array.from({ length: QUEUE_MAX_EVENTS }, () => makeEvent());
    for (const event of normals) queue.push(event);

    const critical = makeEvent({ priority: 'critical' });
    const result = queue.push(critical);

    expect(result.status).toBe('evicted');
    expect(ids(result.evicted ?? [])).toEqual(ids([first(normals)]));
    expect(queue.size()).toBe(QUEUE_MAX_EVENTS);
    expect(counters.get('queue_evicted')).toBe(1);
    const drained = queue.drainUpTo(QUEUE_MAX_EVENTS, QUEUE_MAX_BYTES).events;
    expect(drained[drained.length - 1]?.event_id).toBe(critical.event_id);
    expect(ids(drained)).not.toContain(normals[0]?.event_id);
  });

  test('C06-AC-03 全是 critical 时转入离线存储，不淘汰也不计数 queue_evicted', () => {
    const counters = makeCounters();
    const spilled: QueueEvent[] = [];
    const queue = createMemoryQueue({
      counters,
      offline: {
        spill(event): boolean {
          spilled.push(event);
          return true;
        },
      },
    });
    for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) queue.push(makeEvent({ priority: 'critical' }));

    const extra = makeEvent({ priority: 'critical' });
    const result = queue.push(extra);

    expect(result.status).toBe('spilled');
    expect(ids(spilled)).toEqual(ids([extra]));
    expect(queue.size()).toBe(QUEUE_MAX_EVENTS);
    expect(counters.get('queue_evicted')).toBe(0);
    const drained = queue.drainUpTo(QUEUE_MAX_EVENTS, QUEUE_MAX_BYTES).events;
    expect(ids(drained)).not.toContain(extra.event_id);
  });

  test('C06-AC-03 没有离线存储时按 storage_unavailable 降级计数', () => {
    const counters = makeCounters();
    const queue = createMemoryQueue({ counters });
    for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) queue.push(makeEvent({ priority: 'critical' }));

    const extra = makeEvent({ priority: 'critical' });
    const result = queue.push(extra);

    expect(result.status).toBe('spill_failed');
    expect(queue.size()).toBe(QUEUE_MAX_EVENTS);
    expect(counters.get('storage_unavailable')).toBe(1);
    expect(counters.get('queue_evicted')).toBe(0);
  });

  test('C06-AC-03 离线存储返回 false 或抛错时按 storage_unavailable 降级计数', () => {
    const rejecting = makeCounters();
    const rejectingQueue = createMemoryQueue({
      counters: rejecting,
      offline: {
        spill(): boolean {
          return false;
        },
      },
    });
    for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) {
      rejectingQueue.push(makeEvent({ priority: 'critical' }));
    }

    const rejected = rejectingQueue.push(makeEvent({ priority: 'critical' }));

    expect(rejected.status).toBe('spill_failed');
    expect(rejecting.get('storage_unavailable')).toBe(1);

    const counters = makeCounters();
    const queue = createMemoryQueue({
      counters,
      offline: {
        spill(): boolean {
          throw new Error('存储不可用');
        },
      },
    });
    for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) queue.push(makeEvent({ priority: 'critical' }));

    const result = queue.push(makeEvent({ priority: 'critical' }));

    expect(result.status).toBe('spill_failed');
    expect(counters.get('storage_unavailable')).toBe(1);
  });

  test('C06-AC-03 全 critical 队列中新到的 normal 事件被丢弃并计数 queue_evicted', () => {
    const counters = makeCounters();
    const queue = createMemoryQueue({ counters });
    for (let i = 0; i < QUEUE_MAX_EVENTS; i += 1) queue.push(makeEvent({ priority: 'critical' }));

    const result = queue.push(makeEvent());

    expect(result.status).toBe('rejected');
    expect(queue.size()).toBe(QUEUE_MAX_EVENTS);
    expect(counters.get('queue_evicted')).toBe(1);
  });
});

describe('C06-F1 内存队列内部行为', () => {
  test('drainUpTo 按 FIFO 取出并支持条数与体积双上限', () => {
    const queue = createMemoryQueue({ maxEvents: 10, maxBytes: 10 * 4096 });
    const events = Array.from({ length: 5 }, () => makeEventOfSize(4096));
    for (const event of events) queue.push(event);

    const slice = queue.drainUpTo(10, 2 * 4096);

    expect(slice.events).toHaveLength(2);
    expect(slice.bytes).toBe(2 * 4096);
    expect(queue.size()).toBe(3);
    expect(queue.bytes()).toBe(3 * 4096);
  });

  test('单条事件超过体积上限时仍会单独取出，避免死循环', () => {
    const queue = createMemoryQueue({ maxEvents: 10, maxBytes: 64 * 1024 });
    queue.push(makeEventOfSize(8192));

    const slice = queue.drainUpTo(10, 4096);

    expect(slice.events).toHaveLength(1);
    expect(slice.bytes).toBe(8192);
    expect(queue.size()).toBe(0);
  });

  test('estimateEventBytes 随字符串长度线性增长且大于 JSON 长度下界', () => {
    const small = makeEvent({ attachment: 'a'.repeat(10) });
    const large = makeEvent({ attachment: 'a'.repeat(100) });

    expect(estimateEventBytes(large) - estimateEventBytes(small)).toBe(90);
    expect(estimateEventBytes(small)).toBeGreaterThan(JSON.stringify(small).length);
  });

  test('estimateEventBytes 覆盖 null、布尔、数组与不可序列化的值', () => {
    const event = makeEvent();
    event['nullable'] = null;
    event['flag'] = true;
    event['list'] = [1, 'ab', null];
    event['notify'] = (): void => undefined;

    const expected =
      estimateEventBytes(makeEvent()) +
      'nullable'.length + 4 + 4 +
      'flag'.length + 4 + 5 +
      'list'.length + 4 + (2 + (20 + 1) + ('ab'.length + 2 + 1) + (4 + 1)) +
      'notify'.length + 4 + 0;

    expect(estimateEventBytes(event)).toBe(expected);
  });

  test('没有注入计数器时溢出仍然生效', () => {
    const queue = createMemoryQueue({ maxEvents: 2 });

    queue.push(makeEvent());
    queue.push(makeEvent());
    const result = queue.push(makeEvent());

    expect(result.status).toBe('evicted');
    expect(queue.size()).toBe(2);
  });

  test('clear 清空队列', () => {
    const queue = createMemoryQueue();
    queue.push(makeEvent());
    queue.clear();

    expect(queue.size()).toBe(0);
    expect(queue.bytes()).toBe(0);
  });
});
