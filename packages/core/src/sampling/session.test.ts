/**
 * C03-F3 会话级采样 —— 用例（M4）。
 * 覆盖：C03-AC-10（同会话刷新稳定）、C03-AC-11（10,000 会话命中比例）、C03-AC-12（白名单）。
 */
import { describe, expect, it } from 'vitest';

import type { ConfigReader, EffectiveConfig, ResolvedSampling } from '../config/types';
import { createBuiltinConfig } from '../config/defaults';
import { createSessionSampling } from './session';
import type { SessionStorePort, UserLike } from './types';

function readerWith(sampling: ResolvedSampling): ConfigReader {
  const config: EffectiveConfig = { ...createBuiltinConfig('essential_only'), sampling };
  return { current: () => config, subscribe: () => () => undefined };
}

function memoryStore(): SessionStorePort {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
  };
}

/** 确定性 PRNG（避免门禁内统计用例抖动）。 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function toHex(buffer: ArrayBuffer): string {
  let hex = '';
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

describe('C03-F3 会话级采样', () => {
  it('C03-AC-10 同一会话（同一持久化存储）刷新 10 次，命中结果与随机数都相同', () => {
    const storage = memoryStore();
    const config = readerWith({ session_rate: 0.3, allow_users: [], rules: [] });
    // 不注入 random：依赖持久化，才能证明「刷新后仍是同一个会话随机数」
    const samplings = Array.from({ length: 10 }, () => createSessionSampling({ config, storage }));
    const randoms = new Set(samplings.map((sampling) => sampling.sessionRandom()));
    const hits = new Set(samplings.map((sampling) => sampling.isHit()));
    expect(randoms.size).toBe(1);
    expect(hits.size).toBe(1);

    // 正/负对照：证明命中判定真的读了 session_rate
    const always = createSessionSampling({
      config: readerWith({ session_rate: 1, allow_users: [], rules: [] }),
      storage: memoryStore(),
      random: () => 0.99,
    });
    const never = createSessionSampling({
      config: readerWith({ session_rate: 0, allow_users: [], rules: [] }),
      storage: memoryStore(),
      random: () => 0,
    });
    expect(always.isHit()).toBe(true);
    expect(never.isHit()).toBe(false);
  });

  it('C03-AC-11 10,000 个模拟会话、session_rate 0.3：命中比例在 0.28–0.32', () => {
    const random = seeded(20261013);
    let hits = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const config = readerWith({ session_rate: 0.3, allow_users: [], rules: [] });
      const sampling = createSessionSampling({ config, storage: memoryStore(), random });
      if (sampling.isHit()) hits += 1;
    }
    const ratio = hits / 10_000;
    expect(ratio).toBeGreaterThanOrEqual(0.28);
    expect(ratio).toBeLessThanOrEqual(0.32);
  });

  it('C03-AC-12 白名单用户所在会话随机数未命中：仍全量采集', () => {
    const user: UserLike = { id: 'vip-user-1' };
    const config = readerWith({ session_rate: 0.3, allow_users: ['vip-user-1'], rules: [] });
    const sampling = createSessionSampling({
      config,
      storage: memoryStore(),
      random: () => 0.99,
      getUser: () => user,
    });
    expect(sampling.allowUser()).toBe(true);
    expect(sampling.isHit()).toBe(true);
  });

  it('白名单哈希：预计算 SHA-256 后同步匹配（异步路径不进同步护栏）', async () => {
    const rawId = 'user-raw-1';
    const hex = toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawId)));
    const config = readerWith({ session_rate: 0, allow_users: [hex], rules: [] });
    const sampling = createSessionSampling({
      config,
      storage: memoryStore(),
      random: () => 0.99,
      getUser: () => ({ id: rawId }),
    });
    expect(sampling.allowUser()).toBe(false);
    await sampling.updateUserHash();
    expect(sampling.allowUser()).toBe(true);
    expect(sampling.isHit()).toBe(true);
  });

  it('未取得同意时随机数只存内存：不写入持久化存储', () => {
    const storage = memoryStore();
    const config = readerWith({ session_rate: 0.5, allow_users: [], rules: [] });
    createSessionSampling({ config, storage, random: () => 0.1, consentGranted: () => false });
    expect(storage.read('wr_session:session')).toBeUndefined();
  });
});
