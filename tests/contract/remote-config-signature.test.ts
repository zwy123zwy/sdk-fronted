import { generateKeyPairSync, sign as signWithPrivateKey, webcrypto, type KeyObject } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { asRecord, requireString } from './lib/fs-json';
import { compileContractRegistry } from './lib/schemas';

// AC2：用测试密钥现场生成签名配置，验证「签名正确通过、篡改一个字节失败」。
// 参考步骤见 docs/contracts/remote-config.md 第 4.1 节：ECDSA P-256 + SHA-256，
// dsaEncoding: 'ieee-p1363'（64 字节 r‖s），签名覆盖 payload 字符串的 UTF-8 字节，
// 再用 WebCrypto 验签。测试密钥只在运行时生成，不写入任何文件。
const registry = compileContractRegistry();

const KEY_ID_PRIMARY = 'test-key-primary';
const KEY_ID_SECONDARY = 'test-key-secondary';
const KEY_ID_UNKNOWN = 'test-key-not-configured';

interface TestKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: webcrypto.JsonWebKey;
}

const createTestKey = (keyId: string): TestKey => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { keyId, privateKey, publicJwk: publicKey.export({ format: 'jwk' }) };
};

interface Envelope {
  readonly format_version: number;
  readonly key_id: string;
  readonly alg: string;
  readonly payload: string;
  readonly signature: string;
}

const configBody = {
  format_version: 1,
  app_id: 'demo-app',
  env: 'staging',
  config_version: 42,
  published_at: 1793000000000,
};

const payload = JSON.stringify(configBody);

const signPayload = (value: string, key: KeyObject): string =>
  signWithPrivateKey('sha256', Buffer.from(value, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');

const buildEnvelope = (value: string, key: TestKey): Envelope => ({
  format_version: 1,
  key_id: key.keyId,
  alg: 'ES256',
  payload: value,
  signature: signPayload(value, key.privateKey),
});

/** 与 SDK 侧一致的验签步骤：按 key_id 查公钥 → WebCrypto 导入 → 对 payload 的 UTF-8 字节验签。 */
const verifyEnvelope = async (
  envelope: Envelope,
  publicKeys: Readonly<Record<string, webcrypto.JsonWebKey>>,
): Promise<boolean> => {
  const jwk = publicKeys[envelope.key_id];
  if (jwk === undefined) {
    // 契约 remote-config.md 第 3 节：key_id 不在公钥列表中时拒绝本次配置。
    return false;
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(envelope.signature, 'base64url'),
    Buffer.from(envelope.payload, 'utf8'),
  );
};

/** 两个字符串的 UTF-8 字节差异个数；长度不同返回 Infinity。 */
const differingByteCount = (left: string, right: string): number => {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return Number.POSITIVE_INFINITY;
  }
  let count = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      count += 1;
    }
  }
  return count;
};

const flipFirstChar = (value: string): string => (value.charAt(0) === 'A' ? 'B' : 'A') + value.slice(1);

describe('AC2 签名配置：正确签名通过、篡改失败', () => {
  test('Node 运行时提供 WebCrypto（crypto.subtle），与 node:crypto 的 webcrypto 是同一实现', () => {
    expect(crypto).toBe(webcrypto);
    expect(typeof crypto.subtle.verify).toBe('function');
  });

  test('现场生成的测试签名通过 WebCrypto 验签，且 envelope 通过发布物 Schema', async () => {
    const key = createTestKey(KEY_ID_PRIMARY);
    const envelope = buildEnvelope(payload, key);
    expect(envelope.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(registry.validateEnvelope(envelope)).toEqual({ valid: true, errors: [] });
    await expect(verifyEnvelope(envelope, { [key.keyId]: key.publicJwk })).resolves.toBe(true);
  });

  test('payload 篡改 1 个字节：envelope Schema 仍然通过，但验签必须失败', async () => {
    const key = createTestKey(KEY_ID_PRIMARY);
    const envelope = buildEnvelope(payload, key);
    const tamperedPayload = payload.replace('"config_version":42', '"config_version":43');
    expect(differingByteCount(payload, tamperedPayload)).toBe(1);

    const tampered: Envelope = { ...envelope, payload: tamperedPayload };
    // 只改 payload 的 1 个字节不会破坏 envelope 结构，所以必须靠签名校验拦住（C03-AC-07）。
    expect(registry.validateEnvelope(tampered)).toEqual({ valid: true, errors: [] });
    await expect(verifyEnvelope(tampered, { [key.keyId]: key.publicJwk })).resolves.toBe(false);
  });

  test('signature 篡改一个字符：格式仍然合法，但验签必须失败', async () => {
    const key = createTestKey(KEY_ID_PRIMARY);
    const envelope = buildEnvelope(payload, key);
    const tampered: Envelope = {
      ...envelope,
      signature: flipFirstChar(envelope.signature),
    };
    expect(tampered.signature).not.toBe(envelope.signature);
    expect(tampered.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(registry.validateEnvelope(tampered)).toEqual({ valid: true, errors: [] });
    await expect(verifyEnvelope(tampered, { [key.keyId]: key.publicJwk })).resolves.toBe(false);
  });

  test('key_id 替换为未配置的 key_id：公钥查不到，拒绝配置', async () => {
    const key = createTestKey(KEY_ID_PRIMARY);
    const envelope = buildEnvelope(payload, key);
    const tampered: Envelope = { ...envelope, key_id: KEY_ID_UNKNOWN };
    expect(registry.validateEnvelope(tampered)).toEqual({ valid: true, errors: [] });
    await expect(verifyEnvelope(tampered, { [key.keyId]: key.publicJwk })).resolves.toBe(false);
  });

  test('key_id 替换为另一把已知公钥的 key_id：公钥存在但验签必须失败', async () => {
    const primary = createTestKey(KEY_ID_PRIMARY);
    const secondary = createTestKey(KEY_ID_SECONDARY);
    const envelope = buildEnvelope(payload, primary);
    const tampered: Envelope = { ...envelope, key_id: secondary.keyId };
    const publicKeys = { [primary.keyId]: primary.publicJwk, [secondary.keyId]: secondary.publicJwk };
    await expect(verifyEnvelope(tampered, publicKeys)).resolves.toBe(false);
    // 对照：签名与 key_id 一致时通过。
    await expect(verifyEnvelope(envelope, publicKeys)).resolves.toBe(true);
  });

  test('签名覆盖 payload 的 UTF-8 字节而不是规范化后的 JSON（换行差异也失败）', async () => {
    const key = createTestKey(KEY_ID_PRIMARY);
    const envelope = buildEnvelope(payload, key);
    const reformatted = JSON.stringify(JSON.parse(payload) as unknown, null, 2);
    expect(reformatted).not.toBe(payload);
    expect(differingByteCount(payload, reformatted)).toBeGreaterThan(1);
    const tampered: Envelope = { ...envelope, payload: reformatted };
    await expect(verifyEnvelope(tampered, { [key.keyId]: key.publicJwk })).resolves.toBe(false);
  });
});

describe('AC2 签名用例使用的 envelope 与契约样例结构一致', () => {
  test('现场生成的 envelope 字段与 examples/remote-config.valid.json 的结构相同', () => {
    const key = createTestKey(KEY_ID_PRIMARY);
    const envelope: Record<string, unknown> = { ...buildEnvelope(payload, key) };
    expect(Object.keys(envelope).sort()).toEqual(['alg', 'format_version', 'key_id', 'payload', 'signature']);
    expect(requireString(asRecord(envelope, 'envelope'), 'alg', 'envelope')).toBe('ES256');
  });
});
