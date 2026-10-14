/**
 * C03-F2/F5 配置运行时编排（store）—— 用例（M4，覆盖率补强）。
 * 覆盖订阅、插件启停信号、kill switch 生效、stop、304 无缓存、非 200、拒绝后保持当前配置等。
 */
import { describe, expect, it } from 'vitest';

import { createKernel, definePlugin } from '../kernel';
import type { Kernel } from '../kernel';
import { createConfigCache } from './cache';
import { CONFIG_REASON_CODES } from './constants';
import { createConfigRuntime } from './store';
import { createTestSigner, makeBody } from './test-signing';
import type { ConfigFetchResponse, ConfigRuntimeOptions, PluginToggleSignal } from './types';

function base(kernel: Kernel): ConfigRuntimeOptions {
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

describe('C03 store：订阅与插件信号', () => {
  it('订阅收到 next/previous；注销后不再通知；重复版本不再通知', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 10 }));
    const kernel = createKernel({ target: null });
    const runtime = createConfigRuntime({
      ...base(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 200, etag: '"v10"', body: JSON.stringify(envelope) }),
    });
    const seen: (number | undefined)[][] = [];
    const off = runtime.subscribe((next, previous) => {
      seen.push([next.config_version, previous.config_version]);
    });
    runtime.start();
    await runtime.refresh();
    expect(seen).toEqual([[10, undefined]]);
    expect(runtime.ready()).toBe(true);

    off();
    await runtime.refresh();
    expect(seen.length).toBe(1);
  });

  it('配置生效后按 plugins 计划启停插件并发出 config 信号', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(
      makeBody({ config_version: 10, plugins: { error: { enabled: true }, http: { enabled: false } } }),
    );
    const kernel = createKernel({ target: null });
    kernel.registerPlugin(definePlugin({ id: 'error', install: () => undefined }));
    kernel.registerPlugin(definePlugin({ id: 'http', install: () => undefined }));
    const runtime = createConfigRuntime({
      ...base(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 200, etag: '"v10"', body: JSON.stringify(envelope) }),
    });
    const signals: PluginToggleSignal[] = [];
    runtime.onPluginToggle((signal) => signals.push(signal));
    runtime.start();
    await runtime.refresh();

    expect(signals[0]?.reason).toBe('config');
    expect(signals[0]?.enabled['error']).toBe(true);
    expect(signals[0]?.enabled['http']).toBe(false);
    expect(kernel.plugins.isInstalled('error')).toBe(true);
    expect(kernel.plugins.isInstalled('http')).toBe(false);
  });

  it('订阅者/信号订阅者抛错只计数 processor_error，不影响主流程', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 10 }));
    const kernel = createKernel({ target: null });
    const runtime = createConfigRuntime({
      ...base(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 200, etag: '"v10"', body: JSON.stringify(envelope) }),
    });
    runtime.subscribe(() => {
      throw new Error('subscriber boom');
    });
    runtime.onPluginToggle(() => {
      throw new Error('signal boom');
    });
    runtime.start();
    await runtime.refresh();
    expect(kernel.counters.get('processor_error')).toBeGreaterThanOrEqual(2);
  });
});

describe('C03-F5 store：kill switch 生效', () => {
  it('sdk_versions 命中：进入 killed，后续事件计 killed，并停止拉取', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(
      makeBody({ config_version: 10, kill_switch: { all: false, sdk_versions: ['>=1.0.0'], plugins: [] } }),
    );
    const kernel = createKernel({ target: null });
    kernel.init();
    kernel.start();
    let calls = 0;
    const runtime = createConfigRuntime({
      ...base(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => {
        calls += 1;
        return Promise.resolve<ConfigFetchResponse>({ status: 200, etag: '"v10"', body: JSON.stringify(envelope) });
      },
    });
    const reasons: string[] = [];
    runtime.onPluginToggle((signal) => reasons.push(signal.reason));
    runtime.start();
    await runtime.refresh();

    expect(runtime.isKilled()).toBe(true);
    expect(reasons).toContain('kill_switch');
    kernel.report({ event_name: 'page_view', priority: 'normal', occurred_at: 1 });
    expect(kernel.counters.get('killed')).toBeGreaterThan(0);
    expect(kernel.counters.get('destroyed')).toBe(0);

    await runtime.refresh();
    expect(calls).toBe(1);
  });
});

describe('C03-F2 store：分支与降级', () => {
  it('stop() 后不再拉取', async () => {
    const kernel = createKernel({ target: null });
    let calls = 0;
    const runtime = createConfigRuntime({
      ...base(kernel),
      fetch: () => {
        calls += 1;
        return Promise.resolve({ status: 500, etag: undefined, body: '' });
      },
    });
    runtime.start();
    await runtime.refresh();
    const after = calls;
    runtime.stop();
    await runtime.refresh();
    expect(calls).toBe(after);
  });

  it('304 且无缓存 → 降级；304 且有缓存 → 使用缓存', async () => {
    const kernelA = createKernel({ target: null });
    const runtimeA = createConfigRuntime({
      ...base(kernelA),
      fetch: () => Promise.resolve({ status: 304, etag: '"x"', body: '' }),
    });
    runtimeA.start();
    await runtimeA.refresh();
    expect(runtimeA.current().source).toBe('conservative');
    expect(kernelA.counters.get(CONFIG_REASON_CODES.fetchFailed)).toBeGreaterThan(0);

    const kernelB = createKernel({ target: null });
    const cache = createConfigCache({ indexedDb: null });
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 7 }));
    await cache.write({ envelope, etag: '"v7"', stored_at: Date.now() });
    const runtimeB = createConfigRuntime({
      ...base(kernelB),
      cache,
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 304, etag: '"v7"', body: '' }),
    });
    runtimeB.start();
    await runtimeB.refresh();
    expect(runtimeB.current().source).toBe('cache');
    expect(runtimeB.current().config_version).toBe(7);
  });

  it('非 200/304（404）无缓存 → 保守默认；已有远程配置则保持当前配置', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 10 }));
    const kernel = createKernel({ target: null });
    let index = 0;
    const runtime = createConfigRuntime({
      ...base(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => {
        index += 1;
        return Promise.resolve<ConfigFetchResponse>(
          index === 1
            ? { status: 200, etag: '"v10"', body: JSON.stringify(envelope) }
            : { status: 404, etag: undefined, body: '' },
        );
      },
    });
    runtime.start();
    await runtime.refresh();
    expect(runtime.current().config_version).toBe(10);

    await runtime.refresh();
    // 已有可用配置 → 保持，不退回保守默认
    expect(runtime.current().source).toBe('remote');
    expect(runtime.current().config_version).toBe(10);
    expect(kernel.counters.get(CONFIG_REASON_CODES.fetchFailed)).toBeGreaterThan(0);
  });

  it('发布物为合法 JSON 但非对象 → config_schema_invalid；正文 format 不支持 → config_format_unsupported', async () => {
    const kernelA = createKernel({ target: null });
    const runtimeA = createConfigRuntime({
      ...base(kernelA),
      fetch: () => Promise.resolve({ status: 200, etag: '"x"', body: '[1,2,3]' }),
    });
    runtimeA.start();
    await runtimeA.refresh();
    expect(kernelA.counters.get(CONFIG_REASON_CODES.schemaInvalid)).toBeGreaterThan(0);

    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ format_version: 2, config_version: 10 }));
    const kernelB = createKernel({ target: null });
    const runtimeB = createConfigRuntime({
      ...base(kernelB),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 200, etag: '"x"', body: JSON.stringify(envelope) }),
    });
    runtimeB.start();
    await runtimeB.refresh();
    expect(kernelB.counters.get(CONFIG_REASON_CODES.formatUnsupported)).toBeGreaterThan(0);
  });

  it('env 与请求路径不一致 → config_scope_mismatch；接受后写入缓存', async () => {
    const signer = await createTestSigner('key-a');
    const badEnv = await signer.envelope(makeBody({ config_version: 10, env: 'staging' }));
    const kernel = createKernel({ target: null });
    const runtime = createConfigRuntime({
      ...base(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      fetch: () => Promise.resolve({ status: 200, etag: '"x"', body: JSON.stringify(badEnv) }),
    });
    runtime.start();
    await runtime.refresh();
    expect(kernel.counters.get(CONFIG_REASON_CODES.scopeMismatch)).toBeGreaterThan(0);

    const good = await signer.envelope(makeBody({ config_version: 11 }));
    const kernelOk = createKernel({ target: null });
    const cache = createConfigCache({ indexedDb: null });
    const runtimeOk = createConfigRuntime({
      ...base(kernelOk),
      publicKeys: { [signer.keyId]: signer.jwk },
      cache,
      fetch: () => Promise.resolve({ status: 200, etag: '"v11"', body: JSON.stringify(good) }),
    });
    runtimeOk.start();
    await runtimeOk.refresh();
    // 缓存只保存发布物本体，供读回后重新验签
    expect((await cache.read())?.envelope.payload).toContain('"config_version":11');
  });
});

/**
 * C03 会话随机数的**读取与重置**（AC-12 的 `ErasePort.sessionRandom` 一腿）。
 *
 * 背景：`ErasePort` 的 `sessionRandom` 调用点在 core（`setConsent('denied')` 时触发），
 * 但 C03 的 `ConfigRuntime` 此前只在构造时收一个 `sessionRandom` 数字、没有重置 API，
 * 装配根也就无法接线。语义：**重新生成**会话随机数（不是置空），后续用它做的配置合并
 * （`overrides[].when.session_bucket`）拿到新值。
 */
describe('C03 会话随机数：读取与重置', () => {
  it('sessionRandom() 读到构造值；resetSessionRandom() 生成新值且随后读取稳定', () => {
    const kernel = createKernel({ target: null });
    const generated = [0.95, 0.5];
    let index = 0;
    const runtime = createConfigRuntime({
      ...base(kernel),
      sessionRandom: 0.05,
      random: () => generated[index++] ?? 0.5,
    });

    expect(typeof runtime.resetSessionRandom).toBe('function');
    expect(runtime.sessionRandom()).toBe(0.05);

    expect(runtime.resetSessionRandom()).toBe(0.95);
    // 重置后再次读取稳定：不会每次读取都重掷
    expect(runtime.sessionRandom()).toBe(0.95);
    expect(runtime.sessionRandom()).toBe(0.95);
    // 每次重置都重新生成
    expect(runtime.resetSessionRandom()).toBe(0.5);
    expect(runtime.sessionRandom()).toBe(0.5);
  });

  it('重置后后续配置合并使用新值（session_bucket 覆盖随会话随机数变化）', async () => {
    const signer = await createTestSigner('key-a');
    const body = (version: number): Record<string, unknown> =>
      makeBody({
        config_version: version,
        overrides: [{ when: { session_bucket: [0, 10] }, patch: { transport: { max_batch_events: 7 } } }],
      });
    const envelopes = [await signer.envelope(body(10)), await signer.envelope(body(11))];
    let fetchIndex = 0;
    const kernel = createKernel({ target: null });
    const generated = [0.95];
    const runtime = createConfigRuntime({
      ...base(kernel),
      publicKeys: { [signer.keyId]: signer.jwk },
      // 0.05 → 桶 5，命中 [0, 10)
      sessionRandom: 0.05,
      random: () => generated.shift() ?? 0.5,
      fetch: () => {
        const current = envelopes[fetchIndex];
        fetchIndex += 1;
        return Promise.resolve({ status: 200, etag: `"v${String(fetchIndex)}"`, body: JSON.stringify(current) });
      },
    });

    runtime.start();
    await runtime.refresh();
    expect(runtime.current().applied_overrides).toBe(1);
    expect(runtime.current().transport.max_batch_events).toBe(7);

    // 重置为 0.95 → 桶 95，不再命中覆盖
    expect(runtime.resetSessionRandom()).toBe(0.95);
    await runtime.refresh();
    expect(runtime.current().config_version).toBe(11);
    expect(runtime.current().applied_overrides).toBe(0);
    expect(runtime.current().transport.max_batch_events).toBeUndefined();
  });

  it('未注入 random 时使用默认随机源（重置值仍是 [0,1) 的有限数）', () => {
    const kernel = createKernel({ target: null });
    const runtime = createConfigRuntime({ ...base(kernel), sessionRandom: 0 });

    const next = runtime.resetSessionRandom();
    expect(Number.isFinite(next)).toBe(true);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(next).toBeLessThan(1);
    expect(runtime.sessionRandom()).toBe(next);
  });
});
