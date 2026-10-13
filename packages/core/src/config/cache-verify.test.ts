/**
 * 安全项 8：缓存读取必须重新验签 —— 用例（M6 返工）。
 *
 * 威胁模型：IndexedDB 对同源脚本可读写，任何同源脚本都能改写缓存条目。
 * 因此「写入时验过一次」在读回时不提供任何保护；本文件用**篡改缓存的负向对照**证明
 * 降级路径与 304 路径都会拒绝被篡改的缓存，并用正向对照证明不是「一律拒绝缓存」。
 *
 * `fake-indexeddb`/内存缓存只做逻辑验证；真实浏览器 IDB 行为归 T29。
 */
import { describe, expect, it } from 'vitest';

import { createKernel } from '../kernel';
import { createMemoryCache } from './cache';
import { CONFIG_REASON_CODES } from './constants';
import { createConfigRuntime } from './store';
import { createTestSigner, makeBody } from './test-signing';
import type { CachedConfig, ConfigFetchResponse, ConfigRuntimeOptions } from './types';

const NOW = 1_793_000_000_000;

function base(kernel: ReturnType<typeof createKernel>, publicKeys: ConfigRuntimeOptions['publicKeys']): ConfigRuntimeOptions {
  return {
    kernel,
    appId: 'demo-app',
    env: 'production',
    configEndpoint: 'https://config.example.com',
    sdkVersion: '1.0.0',
    publicKeys,
    consentMode: undefined,
  };
}

/** 篡改 payload（仍是合法 JSON，但字节已变）→ 签名不再匹配。对任何版本号都生效。 */
function tamperPayload(entry: CachedConfig): CachedConfig {
  const envelope = entry.envelope;
  const payload = envelope.payload;
  const nextPayload =
    typeof payload === 'string'
      ? payload.replace(/"config_version":\d+/u, '"config_version":999')
      : '{"tampered":true}';
  if (nextPayload === payload) throw new Error('tamperPayload 未能改变 payload');
  return { ...entry, envelope: { ...envelope, payload: nextPayload } };
}

/** 篡改 signature 的一个字符 → 格式仍合法，但验签必须失败。 */
function tamperSignature(entry: CachedConfig): CachedConfig {
  const signature = entry.envelope.signature;
  const nextSignature = typeof signature === 'string' && signature.startsWith('A') ? `B${signature.slice(1)}` : 'A'.repeat(86);
  return { ...entry, envelope: { ...entry.envelope, signature: nextSignature } };
}

describe('安全项 8：缓存读回必须重新验签', () => {
  it('正向对照：未被篡改的缓存，在拉取失败时被采用（证明不是一律拒绝缓存）', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 7 }));
    const kernel = createKernel({ target: null });
    const cache = createMemoryCache();
    await cache.write({ envelope, etag: '"v7"', stored_at: Date.now() });
    const runtime = createConfigRuntime({
      ...base(kernel, { [signer.keyId]: signer.jwk }),
      cache,
      fetch: () => Promise.resolve({ status: 500, etag: undefined, body: '' }),
    });
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).toBe('cache');
    expect(runtime.current().config_version).toBe(7);
    expect(kernel.counters.get(CONFIG_REASON_CODES.signatureInvalid)).toBe(0);
  });

  it('篡改缓存 payload（无当前配置）→ 不采用、计 config_signature_invalid、保守默认、删除条目', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 7 }));
    const kernel = createKernel({ target: null });
    const cache = createMemoryCache();
    await cache.write({ envelope, etag: '"v7"', stored_at: Date.now() });
    const tampered = tamperPayload({ envelope, etag: '"v7"', stored_at: Date.now() });
    await cache.write(tampered);

    const runtime = createConfigRuntime({
      ...base(kernel, { [signer.keyId]: signer.jwk }),
      cache,
      fetch: () => Promise.resolve({ status: 500, etag: undefined, body: '' }),
    });
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).toBe('conservative');
    expect(runtime.current().source).not.toBe('cache');
    expect(kernel.counters.get(CONFIG_REASON_CODES.signatureInvalid)).toBeGreaterThan(0);
    expect(await cache.read()).toBeUndefined();
  });

  it('篡改缓存 signature（无当前配置）→ 同样拒绝、计数、删除', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 7 }));
    const kernel = createKernel({ target: null });
    const cache = createMemoryCache();
    await cache.write(tamperSignature({ envelope, etag: '"v7"', stored_at: Date.now() }));

    const runtime = createConfigRuntime({
      ...base(kernel, { [signer.keyId]: signer.jwk }),
      cache,
      fetch: () => Promise.resolve({ status: 500, etag: undefined, body: '' }),
    });
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).not.toBe('cache');
    expect(kernel.counters.get(CONFIG_REASON_CODES.signatureInvalid)).toBeGreaterThan(0);
    expect(await cache.read()).toBeUndefined();
  });

  it('304 路径不是绕过验签的旁路：缓存被篡改 → 拒绝，且已有当前配置保持不变', async () => {
    const signer = await createTestSigner('key-a');
    const good = await signer.envelope(makeBody({ config_version: 10 }));
    const kernel = createKernel({ target: null });
    const cache = createMemoryCache();
    let index = 0;
    const runtime = createConfigRuntime({
      ...base(kernel, { [signer.keyId]: signer.jwk }),
      cache,
      fetch: () => {
        index += 1;
        return Promise.resolve<ConfigFetchResponse>(
          index === 1
            ? { status: 200, etag: '"v10"', body: JSON.stringify(good) }
            : { status: 304, etag: '"v10"', body: '' },
        );
      },
    });
    runtime.start();
    await runtime.refresh();
    expect(runtime.current().source).toBe('remote');
    expect(runtime.current().config_version).toBe(10);

    // 同源脚本改写缓存
    const cached = await cache.read();
    expect(cached).toBeDefined();
    if (cached !== undefined) await cache.write(tamperPayload(cached));

    await runtime.refresh();

    // 保持当前生效配置，不采用被篡改的缓存
    expect(runtime.current().source).toBe('remote');
    expect(runtime.current().config_version).toBe(10);
    expect(kernel.counters.get(CONFIG_REASON_CODES.signatureInvalid)).toBeGreaterThan(0);
    expect(await cache.read()).toBeUndefined();
  });

  it('篡改缓存后再次拉取到合法新版本 → 正常采用（缓存拒绝不影响后续拉取）', async () => {
    const signer = await createTestSigner('key-a');
    const v7 = await signer.envelope(makeBody({ config_version: 7 }));
    const v11 = await signer.envelope(makeBody({ config_version: 11 }));
    const kernel = createKernel({ target: null });
    const cache = createMemoryCache();
    await cache.write(tamperPayload({ envelope: v7, etag: '"v7"', stored_at: NOW }));
    let index = 0;
    const runtime = createConfigRuntime({
      ...base(kernel, { [signer.keyId]: signer.jwk }),
      cache,
      fetch: () => {
        index += 1;
        return Promise.resolve<ConfigFetchResponse>(
          index === 1
            ? { status: 500, etag: undefined, body: '' }
            : { status: 200, etag: '"v11"', body: JSON.stringify(v11) },
        );
      },
    });
    runtime.start();
    await runtime.refresh();
    expect(runtime.current().source).toBe('conservative');

    await runtime.refresh();
    expect(runtime.current().source).toBe('remote');
    expect(runtime.current().config_version).toBe(11);
    expect((await cache.read())?.envelope.payload).toContain('"config_version":11');
  });
});
