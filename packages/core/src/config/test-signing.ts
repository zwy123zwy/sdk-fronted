/**
 * 测试用签名辅助（T13）。**仅供 `*.test.ts` 使用，不进入生产导出。**
 *
 * 用 WebCrypto 现场生成 P-256 密钥并签名（`docs/contracts/remote-config.md` 4.1 的浏览器侧做法）：
 * ES256 + IEEE P1363（WebCrypto ECDSA 输出即 64 字节 r‖s）+ base64url。
 * 测试密钥只在运行时生成，不写入任何文件。
 */

/** 发布物结构。 */
export interface TestEnvelope {
  readonly format_version: number;
  readonly key_id: string;
  readonly alg: 'ES256';
  readonly payload: string;
  readonly signature: string;
}

/** 现场生成的测试签名者。 */
export interface TestSigner {
  readonly keyId: string;
  readonly jwk: JsonWebKey;
  sign(payload: string): Promise<string>;
  envelope(body: Readonly<Record<string, unknown>>): Promise<TestEnvelope>;
}

/** 字节数组转 base64url（无填充）。 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return 'privateKey' in value && 'publicKey' in value;
}

/** 现场生成一个测试签名者。 */
export async function createTestSigner(keyId: string): Promise<TestSigner> {
  const generated = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  if (!isCryptoKeyPair(generated)) throw new Error('generateKey 未返回密钥对');
  const jwk = await crypto.subtle.exportKey('jwk', generated.publicKey);
  const sign = async (payload: string): Promise<string> => {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      generated.privateKey,
      new TextEncoder().encode(payload),
    );
    return toBase64Url(new Uint8Array(signature));
  };
  return {
    keyId,
    jwk,
    sign,
    async envelope(body: Readonly<Record<string, unknown>>): Promise<TestEnvelope> {
      const payload = JSON.stringify(body);
      return { format_version: 1, key_id: keyId, alg: 'ES256', payload, signature: await sign(payload) };
    },
  };
}

/** 组装一份最小合法配置正文。 */
export function makeBody(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    format_version: 1,
    app_id: 'demo-app',
    env: 'production',
    config_version: 10,
    published_at: 1_793_000_000_000,
    ...overrides,
  };
}
