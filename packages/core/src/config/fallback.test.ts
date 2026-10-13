/**
 * C03-F2 失败与降级 —— fail-first 用例（M0）。
 * 覆盖：C03-AC-06（保守默认）、C03-AC-08（版本过期）、C03-AC-09（format 不认识）、
 * C03-AC-17（scope 不一致）、C03-AC-18（解析失败）、C03-AC-20（无 WebCrypto）。
 *
 * M0 说明：`store.ts` 是桩实现（不拉取、不验签、不合并），本文件预期断言级失败。
 */
import { describe, expect, it } from 'vitest';

import { createKernel } from '../kernel';
import type { Kernel } from '../kernel';
import { CONFIG_REASON_CODES } from './constants';
import { createConfigRuntime } from './store';
import { createTestSigner, makeBody } from './test-signing';
import type { ConfigFetchResponse, ConfigRuntimeOptions } from './types';

interface Harness {
  readonly kernel: Kernel;
  readonly runtime: ReturnType<typeof createConfigRuntime>;
}

function harness(
  kernel: Kernel,
  responses: readonly ConfigFetchResponse[],
  extra: Partial<ConfigRuntimeOptions> = {},
): Harness {
  let index = 0;
  const runtime = createConfigRuntime({
    kernel,
    appId: 'demo-app',
    env: 'production',
    configEndpoint: 'https://config.example.com',
    sdkVersion: '1.0.0',
    publicKeys: {},
    consentMode: undefined,
    fetch: (): Promise<ConfigFetchResponse> => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(response ?? { status: 500, etag: undefined, body: '' });
    },
    ...extra,
  });
  return { kernel, runtime };
}

const notFound: ConfigFetchResponse = { status: 500, etag: undefined, body: '' };

describe('C03-F2 失败与降级', () => {
  it('C03-AC-06 拉取失败且无缓存：使用保守默认（只保留 critical 与 JS 错误）', async () => {
    const { kernel, runtime } = harness(createKernel({ target: null }), [notFound]);
    runtime.start();
    await runtime.refresh();

    const config = runtime.current();
    expect(config.source).toBe('conservative');
    expect(config.plugins.error.enabled).toBe(true);
    expect(config.plugins.perf.enabled).toBe(false);
    expect(config.plugins.route.enabled).toBe(false);
    expect(config.plugins.http.enabled).toBe(false);
    expect(config.sampling.session_rate).toBe(1);
    expect(kernel.counters.get(CONFIG_REASON_CODES.fetchFailed)).toBeGreaterThan(0);
  });

  it('C03-AC-08 config_version 不大于当前生效版本：拒绝，保持当前配置', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const first = await signer.envelope(makeBody({ config_version: 10 }));
    const older = await signer.envelope(makeBody({ config_version: 9 }));
    const { runtime } = harness(
      kernel,
      [
        { status: 200, etag: '"v10"', body: JSON.stringify(first) },
        { status: 200, etag: '"v9"', body: JSON.stringify(older) },
      ],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();
    expect(runtime.current().config_version).toBe(10);

    await runtime.refresh();
    expect(runtime.current().config_version).toBe(10);
    expect(kernel.counters.get(CONFIG_REASON_CODES.versionStale)).toBeGreaterThan(0);
  });

  it('C03-AC-09 format_version 为 2：拒绝并计 config_format_unsupported', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const envelope = await signer.envelope(makeBody({ format_version: 2, config_version: 11 }));
    const { runtime } = harness(
      kernel,
      [{ status: 200, etag: '"v11"', body: JSON.stringify(envelope) }],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).not.toBe('remote');
    expect(kernel.counters.get(CONFIG_REASON_CODES.formatUnsupported)).toBeGreaterThan(0);
  });

  it('C03-AC-17 正文 app_id/env 与请求路径不一致（签名正确）：拒绝并计 config_scope_mismatch', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const envelope = await signer.envelope(makeBody({ app_id: 'other-app', config_version: 12 }));
    const { runtime } = harness(
      kernel,
      [{ status: 200, etag: '"v12"', body: JSON.stringify(envelope) }],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).not.toBe('remote');
    expect(kernel.counters.get(CONFIG_REASON_CODES.scopeMismatch)).toBeGreaterThan(0);
  });

  it('C03-AC-18 响应体不是合法 JSON：拒绝、不抛错、计 config_parse_failed', async () => {
    const kernel = createKernel({ target: null });
    const { runtime } = harness(kernel, [{ status: 200, etag: '"x"', body: 'not-json{' }]);
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).not.toBe('remote');
    expect(kernel.counters.get(CONFIG_REASON_CODES.parseFailed)).toBeGreaterThan(0);
  });

  it('C03-AC-18 payload 不是合法 JSON（签名正确）：拒绝、不抛错、计 config_parse_failed', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const payload = 'not-json{';
    const envelope = { format_version: 1, key_id: signer.keyId, alg: 'ES256', payload, signature: await signer.sign(payload) };
    const { runtime } = harness(
      kernel,
      [{ status: 200, etag: '"x"', body: JSON.stringify(envelope) }],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).not.toBe('remote');
    expect(kernel.counters.get(CONFIG_REASON_CODES.parseFailed)).toBeGreaterThan(0);
  });

  it('C03-AC-20 运行环境不支持 WebCrypto：不验签、只用保守默认、计 config_signature_unavailable', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const envelope = await signer.envelope(makeBody({ config_version: 13 }));
    const { runtime } = harness(
      kernel,
      [{ status: 200, etag: '"v13"', body: JSON.stringify(envelope) }],
      { publicKeys: { [signer.keyId]: signer.jwk }, webcrypto: { subtle: undefined } },
    );
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).toBe('conservative');
    expect(kernel.counters.get(CONFIG_REASON_CODES.signatureUnavailable)).toBeGreaterThan(0);
  });

  it('C03-AC-24 合法 JSON 但不符合 Schema（无当前配置）：整份拒绝 + config_schema_invalid + 保守默认', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const envelope = await signer.envelope(
      makeBody({ config_version: 14, sampling: { session_rate: 1.5 } }),
    );
    const { runtime } = harness(
      kernel,
      [{ status: 200, etag: '"v14"', body: JSON.stringify(envelope) }],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).toBe('conservative');
    expect(kernel.counters.get(CONFIG_REASON_CODES.schemaInvalid)).toBeGreaterThan(0);
  });

  it('C03-AC-24 合法 JSON 但不符合 Schema（已有当前配置）：保持当前配置不变，不得打回保守默认', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const good = await signer.envelope(makeBody({ config_version: 16, sampling: { session_rate: 0.5 } }));
    const bad = await signer.envelope(makeBody({ config_version: 17, sampling: { session_rate: 1.5 } }));
    const { runtime } = harness(
      kernel,
      [
        { status: 200, etag: '"v16"', body: JSON.stringify(good) },
        { status: 200, etag: '"v17"', body: JSON.stringify(bad) },
      ],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();
    expect(runtime.current().config_version).toBe(16);

    await runtime.refresh();
    // 保持当前生效配置，而不是退回保守默认（AC-24 修正后的口径 / 失败表第 48 行）
    expect(runtime.current().source).toBe('remote');
    expect(runtime.current().config_version).toBe(16);
    expect(runtime.current().sampling.session_rate).toBe(0.5);
    expect(kernel.counters.get(CONFIG_REASON_CODES.schemaInvalid)).toBeGreaterThan(0);
  });

  it('C03-AC-24 sdk_versions 使用未列出的语法：整份拒绝，不得静默当作不命中（CR-003）', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const envelope = await signer.envelope(
      makeBody({ config_version: 15, kill_switch: { all: false, sdk_versions: ['1.2.3 - 2.0.0'] } }),
    );
    const { runtime } = harness(
      kernel,
      [{ status: 200, etag: '"v15"', body: JSON.stringify(envelope) }],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).not.toBe('remote');
    expect(runtime.current().source).toBe('conservative');
    expect(kernel.counters.get(CONFIG_REASON_CODES.schemaInvalid)).toBeGreaterThan(0);
  });

  it('C03-AC-24 sdk_versions 未列出语法（已有当前配置）：保持当前配置，kill switch 不得被当作不命中', async () => {
    const signer = await createTestSigner('key-a');
    const kernel = createKernel({ target: null });
    const good = await signer.envelope(makeBody({ config_version: 18 }));
    const bad = await signer.envelope(
      makeBody({ config_version: 19, kill_switch: { all: false, sdk_versions: ['>=1.2.3-beta.1'] } }),
    );
    const { runtime } = harness(
      kernel,
      [
        { status: 200, etag: '"v18"', body: JSON.stringify(good) },
        { status: 200, etag: '"v19"', body: JSON.stringify(bad) },
      ],
      { publicKeys: { [signer.keyId]: signer.jwk } },
    );
    runtime.start();
    await runtime.refresh();
    await runtime.refresh();

    expect(runtime.current().config_version).toBe(18);
    expect(runtime.isKilled()).toBe(false);
    expect(kernel.counters.get(CONFIG_REASON_CODES.schemaInvalid)).toBeGreaterThan(0);
  });
});
