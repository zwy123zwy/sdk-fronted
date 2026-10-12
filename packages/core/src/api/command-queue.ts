/**
 * C01-F2 命令队列（T12）：SDK 未就绪时缓存公共 API 调用。
 *
 * - 上限 200 条（指南第 11 节）；溢出时**保留最早的 200 次**，丢弃新到达的命令，
 *   每个被丢弃的命令计数一次 `command_queue_overflow`（C01-AC-05）。
 * - 只做数据结构，不依赖内核；回放逻辑在 `client.ts`。
 * - 队列本身不发声、不抛错。
 */
import { COMMAND_QUEUE_CAPACITY } from './values';

/** 入队结果。 */
export interface CommandQueuePushResult {
  /** queued：入队成功；rejected：队列已满，新命令被丢弃。 */
  readonly status: 'queued' | 'rejected';
}

/** 队列中的一条命令：公共方法名 + 原始参数 + 调用当时的快照。 */
export interface QueuedCommand {
  readonly kind: string;
  readonly name?: string | undefined;
  readonly args?: readonly unknown[] | undefined;
  /** 调用当时生成的 UUID v4（去重依据；补发与重试不变）。 */
  readonly eventId: string;
  /** 调用当时的客户端时钟（UTC 毫秒）。 */
  readonly occurredAt: number;
  /** 调用当时的位置快照；缺省时回放阶段再解析。 */
  readonly pageId?: string | undefined;
  readonly url?: string | undefined;
}

/** 命令队列接口。 */
export interface CommandQueue {
  /** 入队；队列已满时返回 rejected（调用方计数原因码），不淘汰已有命令。 */
  push(command: QueuedCommand): CommandQueuePushResult;
  /** 按调用顺序取出下一条命令；队列为空返回 undefined。 */
  shift(): QueuedCommand | undefined;
  size(): number;
  capacity(): number;
  clear(): void;
}

/** 创建命令队列。 */
export function createCommandQueue(options: { readonly capacity?: number | undefined } = {}): CommandQueue {
  const capacity = options.capacity ?? COMMAND_QUEUE_CAPACITY;
  /** 环形缓冲：head 为最早命令的下标，count 为有效长度；避免 shift 的 O(n) 搬移。 */
  const ring: (QueuedCommand | undefined)[] = new Array<QueuedCommand | undefined>(capacity);
  let head = 0;
  let count = 0;

  return {
    push(command: QueuedCommand): CommandQueuePushResult {
      if (capacity <= 0 || count >= capacity) return { status: 'rejected' };
      ring[(head + count) % capacity] = command;
      count += 1;
      return { status: 'queued' };
    },
    shift(): QueuedCommand | undefined {
      if (count === 0) return undefined;
      const command = ring[head];
      ring[head] = undefined;
      head = (head + 1) % capacity;
      count -= 1;
      return command;
    },
    size(): number {
      return count;
    },
    capacity(): number {
      return capacity;
    },
    clear(): void {
      ring.fill(undefined);
      head = 0;
      count = 0;
    },
  };
}
