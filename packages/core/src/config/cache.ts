/**
 * 配置缓存端口（T13，C03-F2）。
 *
 * 口径：只缓存**已验签通过**的配置正文；TTL 24 小时（`CACHE_TTL_MS`）；**不使用 `localStorage`**
 * （与 D004 对存储的口径一致）。默认实现为 IndexedDB 主 + 内存回退，覆盖跨页面刷新的降级场景。
 */
import { CACHE_TTL_MS } from './constants';
import type { CachedConfig, ClockPort, ConfigCachePort } from './types';

const DB_NAME = 'web-report-sdk-config';
const STORE_NAME = 'remote-config';
const ENTRY_KEY = 'current';
const DB_VERSION = 1;

/** 内存缓存（测试与无 IDB 环境的回退）。 */
export function createMemoryCache(): ConfigCachePort {
  let entry: CachedConfig | undefined;
  return {
    read(): Promise<CachedConfig | undefined> {
      return Promise.resolve(entry === undefined ? undefined : { ...entry });
    },
    write(next: CachedConfig): Promise<void> {
      entry = { ...next };
      return Promise.resolve();
    },
    remove(): Promise<void> {
      entry = undefined;
      return Promise.resolve();
    },
  };
}

/** 缓存条目是否仍然有效（不超过 24 小时）。 */
export function isCacheFresh(entry: CachedConfig, clock: ClockPort): boolean {
  return clock.now() - entry.stored_at < CACHE_TTL_MS;
}

function resolveIndexedDb(): IDBFactory | null {
  const scope = globalThis as { indexedDB?: IDBFactory | undefined };
  return scope.indexedDB ?? null;
}

function openDatabase(factory: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('config cache open failed'));
    };
  });
}

function readEntry(factory: IDBFactory, dbName: string): Promise<CachedConfig | undefined> {
  return openDatabase(factory, dbName).then(
    (db) =>
      new Promise<CachedConfig | undefined>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(ENTRY_KEY);
        request.onsuccess = () => {
          const value: unknown = request.result;
          resolve(typeof value === 'object' && value !== null ? (value as CachedConfig) : undefined);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('config cache read failed'));
        };
      }),
  );
}

function writeEntry(factory: IDBFactory, dbName: string, entry: CachedConfig): Promise<void> {
  return openDatabase(factory, dbName).then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(entry, ENTRY_KEY);
        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          reject(transaction.error ?? new Error('config cache write failed'));
        };
        transaction.onabort = () => {
          reject(transaction.error ?? new Error('config cache write aborted'));
        };
      }),
  );
}

function removeEntry(factory: IDBFactory, dbName: string): Promise<void> {
  return openDatabase(factory, dbName).then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(ENTRY_KEY);
        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onerror = () => {
          reject(transaction.error ?? new Error('config cache remove failed'));
        };
        transaction.onabort = () => {
          reject(transaction.error ?? new Error('config cache remove aborted'));
        };
      }),
  );
}

/** IndexedDB 缓存；任何失败都回退到内存实现，避免影响主流程。 */
export function createIndexedDbCache(factory: IDBFactory, fallback: ConfigCachePort): ConfigCachePort {
  return {
    async read(): Promise<CachedConfig | undefined> {
      try {
        return await readEntry(factory, DB_NAME);
      } catch {
        return fallback.read();
      }
    },
    async write(entry: CachedConfig): Promise<void> {
      try {
        await writeEntry(factory, DB_NAME, entry);
      } catch {
        await fallback.write(entry);
      }
    },
    async remove(): Promise<void> {
      try {
        await removeEntry(factory, DB_NAME);
      } catch {
        await fallback.remove();
      }
    },
  };
}

/**
 * 默认缓存：优先 IndexedDB，缺省或不可用时退回内存。
 * `indexedDb: null` 显式强制内存（测试与隐私模式）。
 */
export function createConfigCache(options: {
  readonly indexedDb?: IDBFactory | null | undefined;
}): ConfigCachePort {
  const memory = createMemoryCache();
  const factory = options.indexedDb === undefined ? resolveIndexedDb() : options.indexedDb;
  return factory === null ? memory : createIndexedDbCache(factory, memory);
}
