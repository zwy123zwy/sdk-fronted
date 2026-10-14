/**
 * 预启动队列（C02-F5）：配置就绪前缓存事件。
 *
 * **两个上限同时生效**：
 * - 条数上限 `capacity`（缺省 500，契约值）；
 * - 体积上限 `maxBytes`（缺省 `PRESTART_QUEUE_MAX_BYTES` = 256 KB，T11 非功能目标）。
 *
 * 溢出时淘汰**最早的 normal** 事件；critical 事件永不淘汰；没有可淘汰的 normal 时
 * 新到事件被丢弃（`rejected`）。队列本身只做数据结构，原因码由内核计数：内核按
 * 「本次 push 不是 queued」计一次 `prestart_queue_overflow`——**与本次修改前一致**
 * （一次 push 计一次，不随被淘汰条数增加）。
 *
 * 为什么在条数之外还要字节上限：T20 实测「生产上界形态」事件每条约 650 B，500 条 = 317 KB
 * > 256 KB；而 C04 允许单个字符串值 256 字符（512 B），计条数无法约束字节。见
 * `constants.ts` 的 `PRESTART_QUEUE_MAX_BYTES` 注释（含与 C06 的 512 KB 为何不同的理由）。
 *
 * 实现顺序（与修改前逐条等价）：**先**按上限淘汰已有事件为候选腾空间，**再**入队候选；
 * 因此「全是 critical + 新到 normal」仍然被拒绝（候选不参与淘汰），不会出现
 * 「先把候选压进去、再把自己淘汰掉」这类与既有语义不符的中间态。
 */
import { PRESTART_QUEUE_CAPACITY, PRESTART_QUEUE_MAX_BYTES } from './constants';
import type { KernelEvent, PrestartQueue, PrestartQueuePush } from './types';

export interface PrestartQueueOptions {
  /** 条数上限，缺省 500（契约值）。 */
  readonly capacity?: number | undefined;
  /** 体积上限（JSON 码元数），缺省 256 KB（T11 非功能目标）。 */
  readonly maxBytes?: number | undefined;
  /** 自定义事件体积测量；缺省 `measureEventBytes`。 */
  readonly measure?: ((event: KernelEvent) => number) | undefined;
}

/**
 * 事件体积估算（默认口径）：JSON 序列化后的 **UTF-16 码元数**。
 *
 * 与 `event-standard.md` 第 4 节、`tests/bench/lib/memory.ts` 的 `totalJsonUnits` 一致；
 * V8 对全 Latin-1 字符串按 1 B/码元存储，因此它也是内存的良好近似。非 Latin-1 时
 * 实际内存是码元数 ×2，属保守方向（估算值偏小 → 队列可能比 256 KB 略多占内存）。
 *
 * 不可序列化的事件（循环引用、BigInt）无法度量，按「超预算」处理：直接返回无穷大，
 * 让 push 拒绝它——这种事件本来也无法发送，不应占用暂存区。
 */
export function measureEventBytes(event: KernelEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** 创建预启动队列。 */
export function createPrestartQueue(options: PrestartQueueOptions = {}): PrestartQueue {
  const capacity = options.capacity ?? PRESTART_QUEUE_CAPACITY;
  const maxBytes = options.maxBytes ?? PRESTART_QUEUE_MAX_BYTES;
  const measure = options.measure ?? measureEventBytes;
  const events: KernelEvent[] = [];
  const sizes: number[] = [];
  let totalBytes = 0;

  /** 最早的 normal 事件下标；全部为 critical 时返回 -1。 */
  function firstNormalIndex(): number {
    return events.findIndex((queued) => queued.priority !== 'critical');
  }

  return {
    push(event: KernelEvent): PrestartQueuePush {
      const size = measure(event);
      let evicted: KernelEvent | undefined;

      // 先为候选腾出空间：条数与体积任一超限就继续淘汰最早的 normal。
      while (events.length >= capacity || totalBytes + size > maxBytes) {
        const index = firstNormalIndex();
        if (index < 0) return { status: 'rejected', event };
        const removed = events[index];
        const removedSize = sizes[index] ?? 0;
        events.splice(index, 1);
        sizes.splice(index, 1);
        totalBytes -= removedSize;
        if (removed !== undefined && evicted === undefined) evicted = removed;
      }

      events.push(event);
      sizes.push(size);
      totalBytes += size;
      return evicted === undefined ? { status: 'queued', event } : { status: 'evicted', event, evicted };
    },
    drain(): readonly KernelEvent[] {
      const drained = events.splice(0, events.length);
      sizes.length = 0;
      totalBytes = 0;
      return drained;
    },
    size(): number {
      return events.length;
    },
    capacity(): number {
      return capacity;
    },
    bytes(): number {
      return totalBytes;
    },
    maxBytes(): number {
      return maxBytes;
    },
    clear(): void {
      events.length = 0;
      sizes.length = 0;
      totalBytes = 0;
    },
  };
}
