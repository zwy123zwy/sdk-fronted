/**
 * C07 离线存储的测试夹具。
 *
 * **仅供 `*.test.ts` 使用，不从 `src/index.ts` 导出**（tsup 只打包 `src/index.ts`
 * 可达的模块，因此它不进产物；覆盖率会统计它，由测试本身覆盖）。
 */
import type { BatchEnvelope, BatchHeader, EventPriority, QueueEvent } from '../batch/types';
import { toSummary } from './format';
import type { MetaEntry, OfflineBackend, OfflineRecord, OfflineRecordSummary } from './types';

/** 契约允许的时间戳下界（`batch.schema.json` 的 `timestamp.minimum`）。 */
export const TEST_START = 1793000000000;

export const TEST_APP_ID = 'demo-app';

export const TEST_HEADER: BatchHeader = {
  protocol_version: 1,
  app_id: TEST_APP_ID,
  env: 'staging',
  release: '1.4.0',
  sdk_name: 'web-report-sdk',
  sdk_version: '0.1.0',
  device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
  session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
  clock_offset: 0,
};

/** 生成合法 UUID v4 形状（满足 `batch.schema.json` 的 `uuid` 模式）。 */
export function testUuid(counter: number): string {
  const suffix = String(counter % 0xffffffff).padStart(12, '0');
  return `e0000001-0000-4000-8000-${suffix}`;
}

let eventSeq = 0;

/** 造一条合法队列事件。 */
export function makeEvent(
  overrides: {
    readonly priority?: EventPriority;
    readonly bytes?: number;
    readonly occurredAt?: number;
  } = {},
): QueueEvent {
  eventSeq += 1;
  const padding = overrides.bytes === undefined ? '' : 'x'.repeat(Math.max(0, overrides.bytes));
  return {
    event_id: testUuid(eventSeq),
    event_name: 'task_submit_complete',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: overrides.occurredAt ?? TEST_START + eventSeq,
    priority: overrides.priority ?? 'critical',
    ...(padding === '' ? {} : { attachment: padding }),
  };
}

let batchSeq = 0;

/** 造一个合法批次（默认 1 条 critical 事件）。 */
export function makeBatch(
  overrides: {
    readonly events?: readonly QueueEvent[];
    readonly batchId?: string;
    readonly appId?: string;
    readonly sessionId?: string;
    readonly sentAt?: number;
  } = {},
): BatchEnvelope {
  batchSeq += 1;
  const events = overrides.events ?? [makeEvent()];
  return {
    ...TEST_HEADER,
    ...(overrides.appId === undefined ? {} : { app_id: overrides.appId }),
    ...(overrides.sessionId === undefined ? {} : { session_id: overrides.sessionId }),
    batch_id: overrides.batchId ?? testUuid(100000 + batchSeq),
    sent_at: overrides.sentAt ?? TEST_START + batchSeq,
    events,
  };
}

/** 事件序列化后的近似体积（测试里只需要一个稳定、可比较的值）。 */
export function batchBytes(batch: BatchEnvelope): number {
  return JSON.stringify(batch).length;
}

/** 内存后端：用于不依赖 IndexedDB 的确定性测试（节流、上限、暴露窗口逻辑）。 */
export interface RecordingBackend {
  readonly records: Map<string, OfflineRecord>;
  readonly summaries: Map<string, OfflineRecordSummary>;
  readonly metas: Map<string, MetaEntry>;
  readonly writes: OfflineRecord[][];
  readonly deletes: string[][];
  readonly backend: OfflineBackend;
  /** 让下一次 `commit` 以指定错误拒绝（测试配额/中止路径）。 */
  failNextCommit(error: Error): void;
}

export function createRecordingBackend(): RecordingBackend {
  const records = new Map<string, OfflineRecord>();
  const summaries = new Map<string, OfflineRecordSummary>();
  const metas = new Map<string, MetaEntry>();
  const writes: OfflineRecord[][] = [];
  const deletes: string[][] = [];
  let nextError: Error | null = null;

  const backend: OfflineBackend = {
    open: () => Promise.resolve('ok' as const),
    reset: () => {
      records.clear();
      summaries.clear();
      metas.clear();
      return Promise.resolve();
    },
    commit: (next, nextMetas) => {
      if (nextError !== null) {
        const error = nextError;
        nextError = null;
        return Promise.reject(error);
      }
      writes.push([...next]);
      for (const record of next) {
        records.set(record.batch_id, record);
        summaries.set(record.batch_id, toSummary(record));
      }
      if (nextMetas !== undefined) {
        for (const entry of nextMetas) metas.set(entry.key, entry);
      }
      return Promise.resolve();
    },
    putSummaries: (next) => {
      for (const summary of next) summaries.set(summary.batch_id, summary);
      return Promise.resolve();
    },
    readSummaries: (limit) => Promise.resolve([...summaries.values()].slice(0, limit)),
    read: (batchId) => Promise.resolve(records.get(batchId) ?? null),
    remove: (batchIds) => {
      deletes.push([...batchIds]);
      for (const id of batchIds) {
        records.delete(id);
        summaries.delete(id);
      }
      return Promise.resolve();
    },
    clear: () => {
      records.clear();
      summaries.clear();
      metas.clear();
      return Promise.resolve();
    },
    putMeta: (entry) => {
      metas.set(entry.key, entry);
      return Promise.resolve();
    },
    readMeta: (key) => Promise.resolve(metas.get(key) ?? null),
    listMeta: (prefix) =>
      Promise.resolve([...metas.values()].filter((entry) => entry.key.startsWith(prefix))),
    deleteMeta: (keys) => {
      for (const key of keys) metas.delete(key);
      return Promise.resolve();
    },
    close: () => undefined,
  };

  return {
    records,
    summaries,
    metas,
    writes,
    deletes,
    backend,
    failNextCommit(error: Error): void {
      nextError = error;
    },
  };
}

/** 计数器探针。 */
export interface CountersSpy {
  readonly counts: Map<string, number>;
  readonly port: { count(reason: string, delta?: number): void };
  get(reason: string): number;
}

export function createCountersSpy(): CountersSpy {
  const counts = new Map<string, number>();
  return {
    counts,
    port: {
      count(reason: string, delta = 1): void {
        counts.set(reason, (counts.get(reason) ?? 0) + delta);
      },
    },
    get(reason: string): number {
      return counts.get(reason) ?? 0;
    },
  };
}
