/**
 * 会话采样：存储与哈希的边界 —— 用例（M4，覆盖率补强）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBuiltinConfig } from '../config/defaults';
import type { ConfigReader, EffectiveConfig, ResolvedSampling } from '../config/types';
import { createSessionSampling } from './session';
import type { SessionStorePort } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function readerWith(sampling: ResolvedSampling): ConfigReader {
  const config: EffectiveConfig = { ...createBuiltinConfig('essential_only'), sampling };
  return { current: () => config, subscribe: () => () => undefined };
}

function memoryStore(seed?: string): SessionStorePort {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set('wr_session:session', seed);
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
  };
}

describe('会话采样存储边界', () => {
  it('存储中的非法值被丢弃并重新生成写入', () => {
    const storage = memoryStore('not-a-number');
    const sampling = createSessionSampling({
      config: readerWith({ session_rate: 1, allow_users: [], rules: [] }),
      storage,
      random: () => 0.25,
    });
    expect(sampling.sessionRandom()).toBe(0.25);
    expect(storage.read('wr_session:session')).toBe('0.25');
  });

  it('未注入 storage 时使用缺省实现（sessionStorage 或内存回退）', () => {
    const sampling = createSessionSampling({
      config: readerWith({ session_rate: 1, allow_users: [], rules: [] }),
      random: () => 0.1,
    });
    expect(sampling.sessionRandom()).toBe(0.1);
    expect(sampling.isHit()).toBe(true);
  });

  it('sessionStorage 缺失时回退内存实现', () => {
    vi.stubGlobal('sessionStorage', undefined);
    const sampling = createSessionSampling({
      config: readerWith({ session_rate: 0.5, allow_users: [], rules: [] }),
      random: () => 0.9,
    });
    expect(sampling.sessionRandom()).toBe(0.9);
  });

  it('同意后写入存储；consentGranted 为 true 时持久化生效', () => {
    const storage = memoryStore();
    createSessionSampling({
      config: readerWith({ session_rate: 0.5, allow_users: [], rules: [] }),
      storage,
      random: () => 0.3,
      consentGranted: () => true,
    });
    expect(storage.read('wr_session:session')).toBe('0.3');
  });
});

describe('会话采样哈希边界', () => {
  it('已是哈希的用户：updateUserHash 为空操作，原样比较', async () => {
    const config = readerWith({ session_rate: 0, allow_users: ['hash-abc'], rules: [] });
    const sampling = createSessionSampling({
      config,
      storage: memoryStore(),
      random: () => 0.9,
      getUser: () => ({ id: 'hash-abc', hashed: true }),
    });
    await sampling.updateUserHash();
    expect(sampling.allowUser()).toBe(true);
  });

  it('WebCrypto 不可用时 updateUserHash 静默返回，不影响同步路径', async () => {
    vi.stubGlobal('crypto', {});
    const config = readerWith({ session_rate: 0, allow_users: ['some-hash'], rules: [] });
    const sampling = createSessionSampling({
      config,
      storage: memoryStore(),
      random: () => 0.9,
      getUser: () => ({ id: 'raw-user' }),
    });
    await expect(sampling.updateUserHash()).resolves.toBeUndefined();
    expect(sampling.allowUser()).toBe(false);
  });
});
