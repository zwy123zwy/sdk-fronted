/**
 * 入库与去重（M01-F2、RR-05、RR-06）。
 *
 * 内存 Map：键为 `app_id` + `event_id`（用 `\u0000` 分隔，避免拼接歧义）。
 * `common` 字段在入库前展开到每条事件，事件体中的值优先；`auth` 字段在持久化前删除（RR-13）。
 * 已知限制：进程重启后数据不保留（mock 只用于测试，见 README）。
 */
import { stripSecrets } from './logger.js';
import { MAX_EVENT_BYTES } from './validate.js';

export interface StoredEvent {
  app_id: string;
  event_id: string;
  event_name: string;
  [key: string]: unknown;
}

export interface BatchLike {
  events?: unknown;
  common?: unknown;
  [key: string]: unknown;
}

export interface StoreBatchResult {
  /** 首次入库的事件数。 */
  stored: number;
  /** 命中去重的事件数。 */
  duplicate: number;
  /** 超过 16 KB 被单独拒绝的事件数。 */
  oversized: number;
}

export interface StoreOptions {
  maxEventBytes?: number;
}

export interface Store {
  storeBatch: (appId: string, batch: BatchLike) => StoreBatchResult;
  /** 按入库顺序返回事件副本。 */
  list: (appId?: string) => StoredEvent[];
  size: (appId?: string) => number;
  clear: () => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 展开 `common`：对象字段合并（事件优先），标量字段由事件覆盖。 */
export function mergeEvent(common: Record<string, unknown>, event: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(common)) {
    if (!(key in event)) {
      merged[key] = value;
      continue;
    }
    const override = event[key];
    if (isPlainObject(value) && isPlainObject(override)) {
      merged[key] = mergeEvent(value, override);
    } else {
      merged[key] = override;
    }
  }
  for (const [key, value] of Object.entries(event)) {
    if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

/** 创建内存存储。 */
export function createStore(options: StoreOptions = {}): Store {
  const maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
  const byKey = new Map<string, StoredEvent>();
  const order: string[] = [];

  return {
    storeBatch: (appId: string, batch: BatchLike): StoreBatchResult => {
      const common = isPlainObject(batch.common) ? batch.common : {};
      const events = Array.isArray(batch.events) ? batch.events : [];
      let stored = 0;
      let duplicate = 0;
      let oversized = 0;

      for (const raw of events) {
        if (!isPlainObject(raw)) continue;
        const merged = stripSecrets(mergeEvent(common, raw));
        const eventId = typeof merged['event_id'] === 'string' ? merged['event_id'] : null;
        if (eventId === null) continue;
        if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > maxEventBytes) {
          oversized += 1;
          continue;
        }
        const key = `${appId}\u0000${eventId}`;
        if (byKey.has(key)) {
          duplicate += 1;
          continue;
        }
        byKey.set(key, { app_id: appId, ...merged, event_id: eventId } as StoredEvent);
        order.push(key);
        stored += 1;
      }

      return { stored, duplicate, oversized };
    },
    list: (appId?: string): StoredEvent[] => {
      const keys = appId === undefined
        ? order
        : order.filter((key) => key.startsWith(`${appId}\u0000`));
      return keys.map((key) => {
        const event = byKey.get(key);
        return event === undefined ? undefined : structuredClone(event);
      }).filter((event): event is StoredEvent => event !== undefined);
    },
    size: (appId?: string): number => {
      if (appId === undefined) return byKey.size;
      let count = 0;
      for (const key of byKey.keys()) {
        if (key.startsWith(`${appId}\u0000`)) count += 1;
      }
      return count;
    },
    clear: () => {
      byKey.clear();
      order.length = 0;
    },
  };
}
