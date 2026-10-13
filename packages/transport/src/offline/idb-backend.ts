/**
 * IndexedDB 后端（D004 强制：离线副本只用 IndexedDB）。
 *
 * **落盘点**：所有写操作都在 `IDBTransaction.oncomplete` 之后才 resolve；
 * 任何 `onerror` / `onabort` 都转成 rejection，绝不提前 resolve。
 *
 * 模块顶层不访问 `window` / `indexedDB`（指南第 11 节）：工厂只在调用时解析。
 */
import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_META_STORE,
  OFFLINE_RECORD_STORE,
  OFFLINE_SUMMARY_STORE,
} from './constants';
import { toSummary } from './format';
import type {
  MetaEntry,
  OfflineBackend,
  OfflineOpenResult,
  OfflineRecord,
  OfflineRecordSummary,
} from './types';

export interface IdbBackendOptions {
  readonly dbName?: string | undefined;
  readonly dbVersion?: number | undefined;
  /** 缺省取 `globalThis.indexedDB`；显式 `null` 表示不可用。 */
  readonly idbFactory?: IDBFactory | null | undefined;
}

type OpenOutcome =
  | { readonly kind: 'ok'; readonly db: IDBDatabase }
  | { readonly kind: 'incompatible' }
  | { readonly kind: 'unavailable' };

function resolveFactory(explicit: IDBFactory | null | undefined): IDBFactory | null {
  if (explicit === null) return null;
  if (explicit !== undefined) return explicit;
  const candidate = (globalThis as { indexedDB?: IDBFactory | undefined }).indexedDB;
  return candidate ?? null;
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error('offline backend failure');
}

function abortQuietly(tx: IDBTransaction): void {
  try {
    tx.abort();
  } catch {
    // 事务已经结束；忽略。
  }
}

/** 在事务完成（`oncomplete`）后 resolve；错误/中止转 rejection。 */
function runTransaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([...stores], mode);
    } catch (error) {
      reject(asError(error));
      return;
    }
    let result: T;
    try {
      result = work(tx);
    } catch (error) {
      abortQuietly(tx);
      reject(asError(error));
      return;
    }
    tx.oncomplete = (): void => {
      resolve(result);
    };
    tx.onerror = (): void => {
      reject(asError(tx.error));
    };
    tx.onabort = (): void => {
      reject(asError(tx.error));
    };
  });
}

function createSchema(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(OFFLINE_RECORD_STORE)) {
    db.createObjectStore(OFFLINE_RECORD_STORE, { keyPath: 'batch_id' });
  }
  if (!db.objectStoreNames.contains(OFFLINE_SUMMARY_STORE)) {
    const summaries = db.createObjectStore(OFFLINE_SUMMARY_STORE, { keyPath: 'batch_id' });
    summaries.createIndex('by_enqueued_at', 'enqueued_at', { unique: false });
  }
  if (!db.objectStoreNames.contains(OFFLINE_META_STORE)) {
    db.createObjectStore(OFFLINE_META_STORE, { keyPath: 'key' });
  }
}

function openDatabase(factory: IDBFactory, name: string, version: number): Promise<OpenOutcome> {
  return new Promise<OpenOutcome>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, version);
    } catch {
      resolve({ kind: 'unavailable' });
      return;
    }
    request.onupgradeneeded = (): void => {
      createSchema(request.result);
    };
    request.onsuccess = (): void => {
      resolve({ kind: 'ok', db: request.result });
    };
    request.onerror = (): void => {
      const error = request.error;
      resolve(error !== null && error.name === 'VersionError' ? { kind: 'incompatible' } : { kind: 'unavailable' });
    };
    request.onblocked = (): void => {
      resolve({ kind: 'unavailable' });
    };
  });
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    request.onsuccess = (): void => {
      resolve();
    };
    request.onerror = (): void => {
      resolve();
    };
    request.onblocked = (): void => {
      resolve();
    };
  });
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOfflineRecord(value: unknown): value is OfflineRecord {
  return (
    isObjectLike(value) &&
    typeof value['batch_id'] === 'string' &&
    typeof value['format_version'] === 'number' &&
    typeof value['event_count'] === 'number' &&
    typeof value['critical_count'] === 'number' &&
    typeof value['has_critical'] === 'boolean' &&
    typeof value['bytes'] === 'number' &&
    typeof value['enqueued_at'] === 'number' &&
    isObjectLike(value['batch'])
  );
}

function isSummary(value: unknown): value is OfflineRecordSummary {
  return (
    isObjectLike(value) &&
    typeof value['batch_id'] === 'string' &&
    typeof value['format_version'] === 'number' &&
    typeof value['enqueued_at'] === 'number' &&
    typeof value['has_critical'] === 'boolean' &&
    typeof value['event_count'] === 'number' &&
    typeof value['bytes'] === 'number'
  );
}

function isMetaEntry(value: unknown): value is MetaEntry {
  return isObjectLike(value) && typeof value['key'] === 'string' && typeof value['value'] === 'string';
}

function toSummaries(values: readonly unknown[]): readonly OfflineRecordSummary[] {
  const summaries: OfflineRecordSummary[] = [];
  for (const value of values) {
    if (isSummary(value)) summaries.push(value);
  }
  return summaries;
}

function toMetaEntries(values: readonly unknown[]): readonly MetaEntry[] {
  const entries: MetaEntry[] = [];
  for (const value of values) {
    if (isMetaEntry(value)) entries.push(value);
  }
  return entries;
}

/** 创建 IndexedDB 后端。 */
export function createIdbBackend(options: IdbBackendOptions = {}): OfflineBackend {
  const dbName = options.dbName ?? OFFLINE_DB_NAME;
  const dbVersion = options.dbVersion ?? OFFLINE_DB_VERSION;
  const factory = resolveFactory(options.idbFactory);
  let db: IDBDatabase | null = null;

  function requireDb(): IDBDatabase {
    if (db === null) throw new Error('offline database is not open');
    return db;
  }

  function attachVersionGuard(handle: IDBDatabase): void {
    handle.onversionchange = (): void => {
      // 另一个标签页用更高版本打开：主动让位，避免后续写入静默失败（R6）。
      handle.close();
      db = null;
    };
  }

  return {
    open(): Promise<OfflineOpenResult> {
      if (factory === null) return Promise.resolve('unavailable');
      return openDatabase(factory, dbName, dbVersion).then((outcome) => {
        if (outcome.kind === 'ok') {
          db = outcome.db;
          attachVersionGuard(outcome.db);
          return 'ok';
        }
        return outcome.kind;
      });
    },

    reset(): Promise<void> {
      if (db !== null) {
        db.close();
        db = null;
      }
      if (factory === null) return Promise.resolve();
      return deleteDatabase(factory, dbName);
    },

    commit(records: readonly OfflineRecord[], metas?: readonly MetaEntry[]): Promise<void> {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE, OFFLINE_SUMMARY_STORE, OFFLINE_META_STORE],
        'readwrite',
        (tx) => {
          const recordStore = tx.objectStore(OFFLINE_RECORD_STORE);
          const summaryStore = tx.objectStore(OFFLINE_SUMMARY_STORE);
          for (const record of records) {
            recordStore.put(record);
            summaryStore.put(toSummary(record));
          }
          if (metas !== undefined) {
            const metaStore = tx.objectStore(OFFLINE_META_STORE);
            for (const entry of metas) metaStore.put(entry);
          }
        },
      );
    },

    putSummaries(summaries: readonly OfflineRecordSummary[]): Promise<void> {
      const handle = requireDb();
      return runTransaction(handle, [OFFLINE_SUMMARY_STORE], 'readwrite', (tx) => {
        const store = tx.objectStore(OFFLINE_SUMMARY_STORE);
        for (const summary of summaries) store.put(summary);
      });
    },

    readSummaries(limit: number): Promise<readonly OfflineRecordSummary[]> {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_SUMMARY_STORE],
        'readonly',
        (tx) => tx.objectStore(OFFLINE_SUMMARY_STORE).getAll(undefined, limit),
      ).then((request) => toSummaries(request.result));
    },

    read(batchId: string): Promise<OfflineRecord | null> {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE],
        'readonly',
        (tx) => tx.objectStore(OFFLINE_RECORD_STORE).get(batchId),
      ).then((request) => (isOfflineRecord(request.result) ? request.result : null));
    },

    remove(batchIds: readonly string[]): Promise<void> {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE, OFFLINE_SUMMARY_STORE],
        'readwrite',
        (tx) => {
          const recordStore = tx.objectStore(OFFLINE_RECORD_STORE);
          const summaryStore = tx.objectStore(OFFLINE_SUMMARY_STORE);
          for (const batchId of batchIds) {
            recordStore.delete(batchId);
            summaryStore.delete(batchId);
          }
        },
      );
    },

    clear(): Promise<void> {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_RECORD_STORE, OFFLINE_SUMMARY_STORE, OFFLINE_META_STORE],
        'readwrite',
        (tx) => {
          tx.objectStore(OFFLINE_RECORD_STORE).clear();
          tx.objectStore(OFFLINE_SUMMARY_STORE).clear();
          tx.objectStore(OFFLINE_META_STORE).clear();
        },
      );
    },

    putMeta(entry: MetaEntry): Promise<void> {
      const handle = requireDb();
      return runTransaction(handle, [OFFLINE_META_STORE], 'readwrite', (tx) => {
        tx.objectStore(OFFLINE_META_STORE).put(entry);
      });
    },

    readMeta(key: string): Promise<MetaEntry | null> {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_META_STORE],
        'readonly',
        (tx) => tx.objectStore(OFFLINE_META_STORE).get(key),
      ).then((request) => (isMetaEntry(request.result) ? request.result : null));
    },

    listMeta(prefix: string): Promise<readonly MetaEntry[]> {
      const handle = requireDb();
      return runTransaction(
        handle,
        [OFFLINE_META_STORE],
        'readonly',
        (tx) => tx.objectStore(OFFLINE_META_STORE).getAll(),
      ).then((request) =>
        toMetaEntries(request.result).filter((entry) => entry.key.startsWith(prefix)),
      );
    },

    deleteMeta(keys: readonly string[]): Promise<void> {
      const handle = requireDb();
      return runTransaction(handle, [OFFLINE_META_STORE], 'readwrite', (tx) => {
        const store = tx.objectStore(OFFLINE_META_STORE);
        for (const key of keys) store.delete(key);
      });
    },

    close(): void {
      if (db !== null) {
        db.close();
        db = null;
      }
    },
  };
}
