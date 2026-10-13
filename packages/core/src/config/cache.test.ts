/**
 * C03-F2 配置缓存 —— 用例（M3/M6）：内存、IndexedDB（fake-indexeddb 只做逻辑验证）、回退、删除。
 *
 * 说明：缓存只保存**发布物本体**（供读回后重新验签）；`fake-indexeddb` 只用于逻辑验证，
 * 不代表真实浏览器持久化，真实 IDB 行为归 T29。
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import { createConfigCache, createIndexedDbCache, createMemoryCache, isCacheFresh } from './cache';
import type { CachedConfig, ClockPort } from './types';

const clock: ClockPort = { now: () => Date.now() };

function sampleEntry(configVersion: number): CachedConfig {
  return {
    envelope: {
      format_version: 1,
      key_id: 'key-a',
      alg: 'ES256',
      payload: JSON.stringify({ format_version: 1, config_version: configVersion }),
      signature: 'A'.repeat(86),
    },
    etag: `"v${String(configVersion)}"`,
    stored_at: 1_793_000_000_000,
  };
}

describe('配置缓存', () => {
  it('内存缓存往返 + TTL 判定 + 删除', async () => {
    const cache = createMemoryCache();
    expect(await cache.read()).toBeUndefined();
    await cache.write(sampleEntry(31));
    expect((await cache.read())?.envelope.payload).toContain('"config_version":31');
    expect(isCacheFresh({ ...sampleEntry(31), stored_at: clock.now() }, clock)).toBe(true);
    expect(isCacheFresh({ ...sampleEntry(31), stored_at: clock.now() - 25 * 60 * 60 * 1000 }, clock)).toBe(false);
    await cache.remove();
    expect(await cache.read()).toBeUndefined();
  });

  it('IndexedDB 缓存往返（fake-indexeddb 逻辑验证）', async () => {
    const cache = createConfigCache({ indexedDb: globalThis.indexedDB });
    await cache.write(sampleEntry(32));
    expect((await cache.read())?.envelope.payload).toContain('"config_version":32');
    await cache.write(sampleEntry(33));
    expect((await cache.read())?.envelope.payload).toContain('"config_version":33');
    await cache.remove();
    expect(await cache.read()).toBeUndefined();
  });

  it('IDB 打开失败时回退内存（不抛出、不影响主流程）', async () => {
    const fallback = createMemoryCache();
    const broken = {
      open: () => {
        throw new Error('indexedDB unavailable');
      },
    } as unknown as IDBFactory;
    const cache = createIndexedDbCache(broken, fallback);
    await cache.write(sampleEntry(34));
    expect((await cache.read())?.envelope.payload).toContain('"config_version":34');
    await cache.remove();
    expect(await cache.read()).toBeUndefined();
  });

  it('显式 indexedDb: null 强制内存实现', async () => {
    const cache = createConfigCache({ indexedDb: null });
    await cache.write(sampleEntry(35));
    expect((await cache.read())?.envelope.payload).toContain('"config_version":35');
  });
});
