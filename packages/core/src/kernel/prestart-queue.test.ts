/**
 * C02-F5 预启动队列验收测试（C02-AC-10、C02-AC-11）。
 */
import { describe, expect, it } from 'vitest';

import { PRESTART_QUEUE_CAPACITY, createKernel, createPrestartQueue } from '../index';
import type { KernelEvent } from '../index';
import { PRESTART_QUEUE_MAX_BYTES } from './constants';

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

/**
 * C02-F5 的**字节配额**（T20 实测：生产上界形态 500 条 = 317 KB > 256 KB 预算）。
 *
 * 口径：体积按 `event-standard.md` 第 4 节的 **JSON 码元数**（与 `tests/bench/lib/memory.ts`
 * 的 `totalJsonUnits`、以及实现里默认的 `measureEventBytes` 一致）。T11 的验收用例只按
 * 「条数」口径给了 500；单条事件的每个字符串值上限 256 字符（C04 的
 * `MAX_DIMENSION_VALUE_LENGTH`）就意味着单个值 512 B，因此**计条数无法约束字节**——
 * 这正是本组用例存在的理由。
 */
const BYTE_BUDGET = PRESTART_QUEUE_MAX_BYTES;

describe('C02-F5 预启动队列字节配额', () => {
  /** 造一条体积随 `note` 线性增长的事件。 */
  function makeSizedEvent(
    index: number,
    noteLength: number,
    priority: 'normal' | 'critical' = 'normal',
  ): KernelEvent {
    return makeEvent({ index, priority, note: 'x'.repeat(noteLength) });
  }

  /** 一批事件的 JSON 码元数（仓库体积口径）。 */
  function bytesOf(events: readonly KernelEvent[]): number {
    return events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
  }

  it('默认体积上限是 256 KB，且可以通过 bytes()/maxBytes() 观察', () => {
    expect(BYTE_BUDGET).toBe(256 * 1024);
    const queue = createPrestartQueue();
    expect(queue.maxBytes()).toBe(BYTE_BUDGET);

    const first = makeSizedEvent(0, 600);
    const second = makeSizedEvent(1, 600);
    queue.push(first);
    queue.push(second);
    expect(queue.bytes()).toBe(bytesOf([first, second]));
  });

  it('大事件填满时按最早优先淘汰 normal，体积不超过 256 KB', () => {
    const queue = createPrestartQueue();
    const pushed = Array.from({ length: 500 }, (_unused, index) => makeSizedEvent(index, 600));
    for (const event of pushed) queue.push(event);

    const size = queue.size();
    const drained = queue.drain();

    // 无字节上限时 size === 500、体积约 345 KB —— 这两条就是本用例的断言级判据。
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(500);
    expect(bytesOf(drained)).toBeLessThanOrEqual(BYTE_BUDGET);
    expect(queue.bytes()).toBe(0);
    // 最早优先：保留的必须是最后入队的 size 条
    expect(drained.map((event) => event['index'])).toEqual(
      Array.from({ length: size }, (_unused, offset) => 500 - size + offset),
    );
  });

  it('条数上限与字节上限并存：小事件仍保留最新 500 条', () => {
    const queue = createPrestartQueue();
    for (let index = 0; index < 600; index += 1) queue.push(makeSizedEvent(index, 0));

    expect(queue.size()).toBe(500);
    const drained = queue.drain();
    expect(bytesOf(drained)).toBeLessThanOrEqual(BYTE_BUDGET);
    expect(drained[0]?.['index']).toBe(100);
    expect(drained).toHaveLength(500);
  });

  it('critical 不被字节配额淘汰：无 normal 可淘汰时新事件被拒绝', () => {
    const queue = createPrestartQueue();
    let firstRejected = -1;
    for (let index = 0; index < 60; index += 1) {
      const result = queue.push(makeSizedEvent(index, 6000, 'critical'));
      if (result.status === 'rejected' && firstRejected < 0) firstRejected = index;
    }

    const drained = queue.drain();
    expect(drained.length).toBeGreaterThan(0);
    expect(drained.every((event) => event.priority === 'critical')).toBe(true);
    expect(bytesOf(drained)).toBeLessThanOrEqual(BYTE_BUDGET);
    // 没有任何 critical 被淘汰：保留的是最早入队的那些
    expect(drained.map((event) => event['index'])).toEqual(drained.map((_event, offset) => offset));
    expect(firstRejected).toBeGreaterThan(0);
  });

  it('有 normal 可淘汰时：字节溢出淘汰最早的 normal，critical 保留', () => {
    const queue = createPrestartQueue();
    queue.push(makeSizedEvent(0, 6000, 'critical'));
    const normals = Array.from({ length: 100 }, (_unused, index) => makeSizedEvent(index + 1, 6000));
    for (const event of normals) queue.push(event);

    const drained = queue.drain();
    expect(drained[0]?.['index']).toBe(0);
    expect(drained[0]?.priority).toBe('critical');
    expect(bytesOf(drained)).toBeLessThanOrEqual(BYTE_BUDGET);
    expect(drained.length).toBeLessThan(101);
  });

  it('体积上限可注入，且淘汰返回最早被淘汰的 normal', () => {
    // 每条事件按固定 1000 计：上限 2500 时最多存 2 条。
    const queue = createPrestartQueue({ maxBytes: 2500, measure: () => 1000 });
    expect(queue.maxBytes()).toBe(2500);
    expect(queue.push(makeSizedEvent(0, 0)).status).toBe('queued');
    expect(queue.push(makeSizedEvent(1, 0)).status).toBe('queued');
    const third = queue.push(makeSizedEvent(2, 0));

    expect(third.status).toBe('evicted');
    expect(third.evicted?.['index']).toBe(0);
    expect(queue.size()).toBe(2);
    expect(queue.bytes()).toBe(2000);
    expect(queue.drain().map((event) => event['index'])).toEqual([1, 2]);
  });

  it('生产上界形态（200 字符长值 + 一处伪造 PII）填 500 条后体积仍 ≤ 256 KB', () => {
    // 形状逐字对齐 `tests/bench/lib/fixtures.ts` 的 makeKernelEvent（T20 实测 650 B/条、
    // 500 条 = 317 KB 的那条夹具；另加一个 `index` 用于校验淘汰顺序）。这里用确定性断言
    // 替代基准的墙钟/内存测量。
    const makeWorstCase = (index: number): KernelEvent =>
      makeEvent({
        index,
        event_id: '00000000-0000-4000-8000-000000000001',
        event_name: 'task_complete',
        event_type: 'custom',
        schema_version: 1,
        occurred_at: 1_793_000_000_000,
        page_id: '/task/:id',
        view_id: '00000000-0000-4000-8000-000000000002',
        url: 'https://a.example/task/123?tab=detail',
        dimensions: {
          task_id: 't-1',
          tenant: 'acme',
          contact: 'mail alice.smith+tag@example.co.uk or 13800138000',
          note: 'x'.repeat(200),
        },
        metrics: { duration_ms: 42, retry_count: 0 },
      });

    const queue = createPrestartQueue();
    for (let index = 0; index < 500; index += 1) queue.push(makeWorstCase(index));

    const size = queue.size();
    const drained = queue.drain();
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(500);
    expect(bytesOf(drained)).toBeLessThanOrEqual(BYTE_BUDGET);
    // 最早优先：保留最后 size 条
    expect(drained[0]?.['index']).toBe(500 - size);
    expect(drained[drained.length - 1]?.['index']).toBe(499);
  });
});
