/**
 * 双上限内存队列（C06-F1）。
 *
 * - 条数 500 与体积 512 KB 同时生效；
 * - 溢出时淘汰最早的 normal 事件并计数 `queue_evicted`（C06-AC-01、AC-02）；
 * - critical 事件不被淘汰；队列中已无 normal 可淘汰时，把新到的 critical 事件转离线存储，
 *   没有可用的离线存储时按 `storage_unavailable` 降级计数（C06-AC-03）；
 * - 队列全是 critical 时，新到的 normal 事件被丢弃并计数 `queue_evicted`。
 *
 * 实现用「头指针 + 尾追加」代替 `Array.shift`：稳态下入队与淘汰都是摊还 O(1)，
 * 满足「入队 P99 ≤ 0.01 ms」的非功能目标；头指针超过阈值时压缩一次数组，回收被淘汰元素的引用。
 */
import type { QueueEvent } from '../batch/types';
import {
  QUEUE_MAX_BYTES,
  QUEUE_MAX_EVENTS,
  REASON_QUEUE_EVICTED,
  REASON_STORAGE_UNAVAILABLE,
} from './constants';
import { estimateEventBytes } from './size';
import type {
  CountersPort,
  MemoryQueue,
  MemoryQueueOptions,
  QueuePushResult,
  QueueSlice,
} from './types';

const noopCounters: CountersPort = {
  count: (): void => undefined,
};

/** 头指针超过该值时考虑压缩底层数组。 */
const COMPACT_THRESHOLD = 64;

/** 创建双上限内存队列。 */
export function createMemoryQueue(options: MemoryQueueOptions = {}): MemoryQueue {
  const maxEvents = options.maxEvents ?? QUEUE_MAX_EVENTS;
  const maxBytes = options.maxBytes ?? QUEUE_MAX_BYTES;
  const counters = options.counters ?? noopCounters;
  const measure = options.measure ?? estimateEventBytes;
  const offline = options.offline;

  let events: QueueEvent[] = [];
  let sizes: number[] = [];
  let head = 0;
  let totalBytes = 0;

  function length(): number {
    return events.length - head;
  }

  function overLimit(): boolean {
    return length() > maxEvents || totalBytes > maxBytes;
  }

  /** 回收队头之前已淘汰元素的引用；摊还 O(1)。 */
  function compactIfNeeded(): void {
    if (head > COMPACT_THRESHOLD && head * 2 >= events.length) {
      events = events.slice(head);
      sizes = sizes.slice(head);
      head = 0;
    }
  }

  /** 最早的 normal 事件下标；全部为 critical 时返回 -1。 */
  function firstNormalIndex(): number {
    for (let index = head; index < events.length; index += 1) {
      const event = events[index];
      if (event !== undefined && event.priority !== 'critical') return index;
    }
    return -1;
  }

  function removeAt(index: number): QueueEvent | undefined {
    const removed = events[index];
    if (removed === undefined) return undefined;
    const removedSize = sizes[index] ?? 0;
    if (index === head) {
      head += 1;
    } else if (index === events.length - 1) {
      events.pop();
      sizes.pop();
    } else {
      events.splice(index, 1);
      sizes.splice(index, 1);
    }
    totalBytes -= removedSize;
    compactIfNeeded();
    return removed;
  }

  /** 溢出转离线；返回是否被离线存储受理。 */
  function spill(event: QueueEvent): boolean {
    if (offline !== undefined) {
      try {
        if (offline.spill(event, 'queue_overflow')) return true;
      } catch {
        // 离线存储抛错按不可用处理：不向业务抛错，继续走降级计数
      }
    }
    counters.count(REASON_STORAGE_UNAVAILABLE);
    return false;
  }

  return {
    push(event: QueueEvent): QueuePushResult {
      const size = measure(event);
      events.push(event);
      sizes.push(size);
      totalBytes += size;

      const evicted: QueueEvent[] = [];
      while (overLimit()) {
        const index = firstNormalIndex();
        if (index < 0) break;
        const removed = removeAt(index);
        if (removed === undefined) break;
        evicted.push(removed);
        counters.count(REASON_QUEUE_EVICTED);
      }

      if (overLimit()) {
        // 走到这里说明队列中已无 normal 事件，刚入队的事件必然是 critical（normal 会被上面的循环淘汰）。
        removeAt(events.length - 1);
        const accepted = spill(event);
        return {
          status: accepted ? 'spilled' : 'spill_failed',
          event,
          evicted: evicted.length > 0 ? evicted : undefined,
        };
      }

      const pushedEvicted = evicted.some((item) => item.event_id === event.event_id);
      return {
        status: pushedEvicted ? 'rejected' : evicted.length > 0 ? 'evicted' : 'queued',
        event,
        evicted: evicted.length > 0 ? evicted : undefined,
      };
    },

    drainUpTo(limitEvents: number, limitBytes: number): QueueSlice {
      const available = length();
      let count = 0;
      let bytes = 0;
      while (count < limitEvents && count < available) {
        const size = sizes[head + count] ?? 0;
        // 至少取一条：单条事件超过体积上限时单独成批，避免调用方死循环
        if (count > 0 && bytes + size > limitBytes) break;
        bytes += size;
        count += 1;
      }
      const taken = events.slice(head, head + count);
      head += count;
      totalBytes -= bytes;
      compactIfNeeded();
      return { events: taken, bytes };
    },

    size(): number {
      return length();
    },

    bytes(): number {
      return totalBytes;
    },

    clear(): void {
      events = [];
      sizes = [];
      head = 0;
      totalBytes = 0;
    },
  };
}
