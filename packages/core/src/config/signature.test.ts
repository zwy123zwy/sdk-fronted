/**
 * C03-F2 / C03 安全：签名校验 —— fail-first 用例（M0）。
 * 覆盖：C03-AC-07（篡改 payload）、C03-AC-16（key_id 未知），并含正对照。
 *
 * M0 说明：`signature.ts` 是桩实现（恒拒绝），正对照预期失败——这正是判别力所在：
 * 如果只保留「篡改必须被拒」的断言，桩实现会假绿。
 */
import { describe, expect, it } from 'vitest';

import { createKernel } from '../kernel';
import { CONFIG_REASON_CODES } from './constants';
import { createConfigRuntime } from './store';
import { verifyEnvelope } from './signature';
import { createTestSigner, makeBody } from './test-signing';

describe('C03 安全：WebCrypto 验签（正/负对照）', () => {
  it('正对照：与 key_id 匹配的正确签名必须通过', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const result = await verifyEnvelope({ ...envelope }, { [signer.keyId]: signer.jwk });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('C03-AC-07 payload 篡改 1 个字节：结构仍合法，但验签必须失败并计 config_signature_invalid', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const tampered = { ...envelope, payload: envelope.payload.replace('"config_version":10', '"config_version":11') };
    expect(tampered.payload).not.toBe(envelope.payload);
    expect(tampered.payload.length).toBe(envelope.payload.length);

    const result = await verifyEnvelope(tampered, { [signer.keyId]: signer.jwk });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(CONFIG_REASON_CODES.signatureInvalid);
  });

  it('C03-AC-16 key_id 不在 config_public_keys 中：拒绝并计 config_signature_invalid', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const result = await verifyEnvelope({ ...envelope, key_id: 'key-unknown' }, { [signer.keyId]: signer.jwk });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(CONFIG_REASON_CODES.signatureInvalid);
  });

  it('替换为另一把已知公钥的 key_id：公钥存在但验签必须失败', async () => {
    const primary = await createTestSigner('key-a');
    const secondary = await createTestSigner('key-b');
    const envelope = await primary.envelope(makeBody());
    const keys = { [primary.keyId]: primary.jwk, [secondary.keyId]: secondary.jwk };

    const swapped = await verifyEnvelope({ ...envelope, key_id: secondary.keyId }, keys);
    expect(swapped.ok).toBe(false);
    const correct = await verifyEnvelope({ ...envelope }, keys);
    expect(correct.ok).toBe(true);
  });

  it('签名缺失 / alg 非 ES256：一律拒绝，不得进入通过路径', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const missing = { format_version: 1, key_id: signer.keyId, alg: 'ES256', payload: envelope.payload };
    const wrongAlg = { ...envelope, alg: 'ES384' };

    expect((await verifyEnvelope(missing, { [signer.keyId]: signer.jwk })).ok).toBe(false);
    expect((await verifyEnvelope(wrongAlg, { [signer.keyId]: signer.jwk })).ok).toBe(false);
  });

  it('集成：验签失败的发布物不得成为生效配置（计 config_signature_invalid）', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody({ config_version: 10 }));
    const tampered = { ...envelope, payload: envelope.payload.replace('"config_version":10', '"config_version":11') };
    const kernel = createKernel({ target: null });
    const runtime = createConfigRuntime({
      kernel,
      appId: 'demo-app',
      env: 'production',
      configEndpoint: 'https://config.example.com',
      sdkVersion: '1.0.0',
      publicKeys: { [signer.keyId]: signer.jwk },
      consentMode: undefined,
      fetch: () => Promise.resolve({ status: 200, etag: '"v10"', body: JSON.stringify(tampered) }),
    });
    runtime.start();
    await runtime.refresh();

    expect(runtime.current().source).not.toBe('remote');
    expect(kernel.counters.get(CONFIG_REASON_CODES.signatureInvalid)).toBeGreaterThan(0);
  });
});
