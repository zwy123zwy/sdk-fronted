/**
 * C02-F5 预启动队列验收测试（C02-AC-10、C02-AC-11）。
 */
import { describe, expect, it } from 'vitest';

import { PRESTART_QUEUE_CAPACITY, createKernel, createPrestartQueue } from '../index';
import type { KernelEvent } from '../index';

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'test_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

describe('C02-F5 预启动队列', () => {
  it('C02-AC-10 配置就绪前 600 条 normal 事件保留最新 500 条，计数 100 并顺序回放', () => {
    const kernel = createKernel();
    kernel.init();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    expect(PRESTART_QUEUE_CAPACITY).toBe(500);

    for (let index = 1; index <= 600; index += 1) {
      kernel.report(makeEvent({ index }));
    }

    expect(kernel.prestartQueue.size()).toBe(500);
    expect(kernel.counters.get('prestart_queue_overflow')).toBe(100);

    kernel.markConfigReady();
    expect(kernel.prestartQueue.size()).toBe(0);
    expect(delivered).toHaveLength(500);
    expect(delivered.map((event) => event['index'])).toEqual(
      Array.from({ length: 500 }, (_, offset) => offset + 101),
    );
  });

  it('C02-AC-11 溢出时淘汰最早的 normal 事件，critical 事件不被淘汰', () => {
    const kernel = createKernel();
    kernel.init();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    kernel.report(makeEvent({ index: 0, priority: 'critical' }));
    for (let index = 1; index < 500; index += 1) {
      kernel.report(makeEvent({ index }));
    }
    expect(kernel.prestartQueue.size()).toBe(500);

    kernel.report(makeEvent({ index: 500 }));

    expect(kernel.counters.get('prestart_queue_overflow')).toBe(1);
    expect(kernel.prestartQueue.size()).toBe(500);

    kernel.markConfigReady();
    const replayed = delivered.map((event) => event['index']);
    expect(replayed).toHaveLength(500);
    expect(replayed[0]).toBe(0);
    expect(replayed).not.toContain(1);
    expect(replayed[replayed.length - 1]).toBe(500);
  });
});

describe('C02-F5 预启动队列补充单元测试', () => {
  it('队列填满 critical 后新事件被拒绝，临界优先级不淘汰已有事件', () => {
    const queue = createPrestartQueue();
    for (let index = 0; index < PRESTART_QUEUE_CAPACITY; index += 1) {
      expect(queue.push(makeEvent({ index, priority: 'critical' })).status).toBe('queued');
    }

    const rejectedNormal = queue.push(makeEvent({ index: 1000 }));
    expect(rejectedNormal.status).toBe('rejected');
    expect(rejectedNormal.event['index']).toBe(1000);

    const rejectedCritical = queue.push(makeEvent({ index: 1001, priority: 'critical' }));
    expect(rejectedCritical.status).toBe('rejected');
    expect(queue.size()).toBe(PRESTART_QUEUE_CAPACITY);

    const drained = queue.drain();
    expect(drained).toHaveLength(PRESTART_QUEUE_CAPACITY);
    expect(drained[0]?.['index']).toBe(0);
    expect(queue.size()).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('溢出时报告被淘汰的事件，临界事件优先于 normal 到达也能正确淘汰', () => {
    const queue = createPrestartQueue({ capacity: 3 });
    expect(queue.capacity()).toBe(3);
    queue.push(makeEvent({ index: 0 }));
    queue.push(makeEvent({ index: 1, priority: 'critical' }));
    queue.push(makeEvent({ index: 2 }));

    const result = queue.push(makeEvent({ index: 3, priority: 'critical' }));
    expect(result.status).toBe('evicted');
    expect(result.evicted?.['index']).toBe(0);
    expect(result.event['index']).toBe(3);
    expect(queue.size()).toBe(3);
    expect(queue.drain().map((event) => event['index'])).toEqual([1, 2, 3]);
  });

  it('clear 清空队列且容量为 500', () => {
    const queue = createPrestartQueue();
    expect(queue.capacity()).toBe(PRESTART_QUEUE_CAPACITY);
    queue.push(makeEvent({ index: 1 }));
    queue.clear();
    expect(queue.size()).toBe(0);
  });

  it('配置就绪后新事件直接进入管线，destroy 清空未回放的队列', () => {
    const kernel = createKernel();
    kernel.init();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    kernel.report(makeEvent({ index: 1 }));
    expect(kernel.prestartQueue.size()).toBe(1);
    expect(kernel.configReady()).toBe(false);

    kernel.destroy();
    expect(kernel.prestartQueue.size()).toBe(0);
    expect(delivered).toHaveLength(0);
  });
});
