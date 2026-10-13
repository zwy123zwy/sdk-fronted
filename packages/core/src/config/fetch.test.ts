/**
 * C03-F2 拉取、304、降级与缓存 —— 用例（M3）。
 * 覆盖：C03-AC-03、C03-AC-04、C03-AC-05、C03-AC-19、C03-AC-23。
 */
import { describe, expect, it } from 'vitest';

import { createKernel } from '../kernel';
import type { Kernel } from '../kernel';
import { createMemoryCache } from './cache';
import { CONFIG_REASON_CODES } from './constants';
import { createConfigRuntime } from './store';
import { createTestSigner, makeBody } from './test-signing';
import type { CachedConfig, ConfigFetchRequest, ConfigFetchResponse, ConfigRuntimeOptions } from './types';

interface FetchCall {
  readonly url: string;
  readonly etag: string | undefined;
}

function baseOptions(kernel: Kernel): ConfigRuntimeOptions {
  return {
    kernel,
    appId: 'demo-app',
    env: 'production',
    configEndpoint: 'https://config.example.com',
    sdkVersion: '1.0.0',
    publicKeys: {},
    consentMode: undefined,
  };
}

function makeRuntime(options: Partial<ConfigRuntimeOptions> & { readonly kernel: Kernel }): {
  readonly runtime: ReturnType<typeof createConfigRuntime>;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const runtime = createConfigRuntime({
    ...baseOptions(options.kernel),
    fetch: (request: ConfigFetchRequest): Promise<ConfigFetchResponse> => {
      calls.push({ url: request.url, etag: request.etag });
      return Promise.resolve({ status: 200, etag: '"v1"', body: '{}' });
    },
    ...options,
  });
  return { runtime, calls };
}

describe('C03-F2 拉取时序', () => {
  it('C03-AC-03 初始化不等待拉取；拉取完成后生效', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 10 }));
    const kernel = createKernel({ target: null });
    let resolveFetch: ((value: ConfigFetchResponse) => void) | undefined;
    const pending = new Promise<ConfigFetchResponse>((resolve) => {
      resolveFetch = resolve;
    });
    const runtime = createConfigRuntime({
      ...baseOptions(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => pending,
    });

    // start() 必须同步返回，且此刻不依赖任何拉取结果
    runtime.start();
    expect(runtime.current().source).toBe('builtin');

    resolveFetch?.({ status: 200, etag: '"v10"', body: JSON.stringify(envelope) });
    await runtime.refresh();
    expect(runtime.current().source).toBe('remote');
    expect(runtime.current().config_version).toBe(10);
  });

  it('C03-AC-04 第二次拉取带 If-None-Match；304 不重新解析、继续使用缓存', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 10 }));
    const kernel = createKernel({ target: null });
    const calls: FetchCall[] = [];
    let index = 0;
    const runtime = createConfigRuntime({
      ...baseOptions(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: (request) => {
        calls.push({ url: request.url, etag: request.etag });
        index += 1;
        return Promise.resolve(
          index === 1
            ? { status: 200, etag: '"v10"', body: JSON.stringify(envelope) }
            : { status: 304, etag: '"v10"', body: '' },
        );
      },
    });
    runtime.start();
    await runtime.refresh();
    expect(runtime.current().config_version).toBe(10);

    await runtime.refresh();
    expect(calls[1]?.etag).toBe('"v10"');
    expect(runtime.current().config_version).toBe(10);
  });
});

describe('C03-F2 降级与缓存', () => {
  it('C03-AC-05 接口 500 且有未过期缓存：读回后重新验签通过 → 使用缓存并计数 config_fetch_failed', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 7 }));
    const kernel = createKernel({ target: null });
    const cache = createMemoryCache();
    await cache.write({ envelope, etag: '"v7"', stored_at: Date.now() });
    const { runtime } = makeRuntime({
      kernel,
      cache,
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 500, etag: undefined, body: '' }),
    });
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).toBe('cache');
    expect(runtime.current().config_version).toBe(7);
    expect(kernel.counters.get(CONFIG_REASON_CODES.fetchFailed)).toBeGreaterThan(0);
  });

  it('C03-AC-19 缓存写入时间为 25 小时前且拉取失败：不用缓存，用保守默认，计两个原因码', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 7 }));
    const kernel = createKernel({ target: null });
    const cache = createMemoryCache();
    const expired: CachedConfig = {
      envelope,
      etag: '"v7"',
      stored_at: Date.now() - 25 * 60 * 60 * 1000,
    };
    await cache.write(expired);
    const { runtime } = makeRuntime({
      kernel,
      cache,
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 500, etag: undefined, body: '' }),
    });
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).toBe('conservative');
    expect(kernel.counters.get(CONFIG_REASON_CODES.cacheExpired)).toBeGreaterThan(0);
    expect(kernel.counters.get(CONFIG_REASON_CODES.fetchFailed)).toBeGreaterThan(0);
  });

  it('C03-AC-23 未传 config_endpoint 不发起请求、使用内置默认；传了则必须请求（正对照）', async () => {
    const kernel = createKernel({ target: null });
    const { runtime, calls } = makeRuntime({ kernel, configEndpoint: undefined });
    runtime.start();
    await runtime.refresh();
    expect(calls).toHaveLength(0);
    expect(runtime.current().source).toBe('builtin');

    const withEndpoint = makeRuntime({ kernel: createKernel({ target: null }) });
    withEndpoint.runtime.start();
    await withEndpoint.runtime.refresh();
    expect(withEndpoint.calls.length).toBeGreaterThan(0);
  });
});
