/**
 * 预启动队列（C02-F5）：配置就绪前缓存事件。
 * 上限 500 条；溢出时淘汰最早的 normal 事件，critical 事件永不淘汰；
 * 全部为 critical 时丢弃新到达的事件。队列本身只做数据结构，原因码由内核计数。
 */
import { PRESTART_QUEUE_CAPACITY } from './constants';
import type { KernelEvent, PrestartQueue, PrestartQueuePush } from './types';

export interface PrestartQueueOptions {
  /** 队列上限，缺省 500（契约值）。 */
  readonly capacity?: number | undefined;
}

/** 创建预启动队列。 */
export function createPrestartQueue(options: PrestartQueueOptions = {}): PrestartQueue {
  const capacity = options.capacity ?? PRESTART_QUEUE_CAPACITY;
  const events: KernelEvent[] = [];

  return {
    push(event: KernelEvent): PrestartQueuePush {
      if (events.length < capacity) {
        events.push(event);
        return { status: 'queued', event };
      }
      const index = events.findIndex((queued) => queued.priority !== 'critical');
      if (index < 0) return { status: 'rejected', event };

      const evicted = events[index];
      events.splice(index, 1);
      events.push(event);
      return evicted === undefined ? { status: 'evicted', event } : { status: 'evicted', event, evicted };
    },
    drain(): readonly KernelEvent[] {
      return events.splice(0, events.length);
    },
    size(): number {
      return events.length;
    },
    capacity(): number {
      return capacity;
    },
    clear(): void {
      events.length = 0;
    },
  };
}
