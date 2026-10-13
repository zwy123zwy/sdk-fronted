/**
 * 签名校验的 JWK / 格式边界 —— 用例（M4，覆盖率补强）。
 */
import { describe, expect, it } from 'vitest';

import { CONFIG_REASON_CODES } from './constants';
import { verifyEnvelope } from './signature';
import { createTestSigner, makeBody } from './test-signing';

describe('签名校验边界', () => {
  it('JWK 含私钥成员 d / 非 EC / 非 P-256 / 缺 x,y：一律拒绝', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const withPrivate = { ...signer.jwk, d: 'private' };
    const rsa = { kty: 'RSA', n: 'x', e: 'AQAB' };
    const p384 = { ...signer.jwk, crv: 'P-384' };
    const missingY = { kty: 'EC', crv: 'P-256', x: signer.jwk.x };

    for (const jwk of [withPrivate, rsa, p384, missingY]) {
      const result = await verifyEnvelope({ ...envelope }, { 'key-a': jwk as JsonWebKey });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(CONFIG_REASON_CODES.signatureInvalid);
    }
  });

  it('WebCrypto 不可用 → config_signature_unavailable', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const result = await verifyEnvelope({ ...envelope }, { 'key-a': signer.jwk }, { subtle: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(CONFIG_REASON_CODES.signatureUnavailable);
  });

  it('签名解码后长度不是 64 字节 → 拒绝', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    // 86 个合法 base64url 字符但内容不是 64 字节的 r‖s
    const bogus = 'A'.repeat(86);
    const result = await verifyEnvelope({ ...envelope, signature: bogus }, { 'key-a': signer.jwk });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(CONFIG_REASON_CODES.signatureInvalid);
  });

  it('公钥形状合法但不可导入（x/y 为占位）→ 捕获异常并拒绝', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const bogus = { kty: 'EC', crv: 'P-256', x: 'AAAA', y: 'AAAA' };
    const result = await verifyEnvelope({ ...envelope }, { 'key-a': bogus });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(CONFIG_REASON_CODES.signatureInvalid);
  });

  it('发布物含额外字段（合法 JSON 但不符 Schema）→ config_schema_invalid', async () => {
    const signer = await createTestSigner('key-a');
    const envelope = await signer.envelope(makeBody());
    const result = await verifyEnvelope({ ...envelope, extra: true }, { 'key-a': signer.jwk });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(CONFIG_REASON_CODES.schemaInvalid);
  });
});
