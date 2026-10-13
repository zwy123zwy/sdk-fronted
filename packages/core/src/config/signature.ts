/**
 * 配置签名校验（T13，安全核心）。
 *
 * 契约 `remote-config.md` 第 4 节：ES256（ECDSA P-256 + SHA-256）、IEEE P1363（r‖s 64 字节）、
 * base64url、签名覆盖 `payload` 字符串的 UTF-8 字节；公钥由 `config_public_keys` 传入。
 *
 * 安全底线（安全负责人 2026-10-13 批准）：
 * - 签名缺失/失败、`key_id` 未知、`alg` 非 ES256、签名长度非法 → 一律拒绝，无任何豁免分支；
 * - JWK 含私钥成员 `d` 一律拒绝；额外成员忽略；只接受 `kty: EC` / `crv: P-256`；
 * - 运行环境不支持 WebCrypto → `config_signature_unavailable`（调用方只用保守默认、不得用缓存）；
 * - 只用 `globalThis.crypto.subtle`，零运行时依赖；模块顶层不访问 `crypto`。
 */
import { CONFIG_REASON_CODES } from './constants';
import { validateEnvelopeShape } from './validate';
import type { WebCryptoLike } from './types';

/** 验签结果；失败时给出原因码。 */
export interface VerifyResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** 解析 `globalThis.crypto` 的 WebCrypto 视图（调用时解析，模块顶层无副作用）。 */
export function resolveWebCrypto(): WebCryptoLike {
  const scope = globalThis as { crypto?: { subtle?: SubtleCrypto | undefined } | undefined };
  const subtle = scope.crypto?.subtle;
  return subtle === undefined ? { subtle: undefined } : { subtle };
}

/** 公钥可用性：EC / P-256 / x,y 非空；含私钥成员 `d` 一律拒绝。 */
function isUsablePublicJwk(jwk: unknown): jwk is JsonWebKey {
  if (!isRecord(jwk)) return false;
  if ('d' in jwk) return false;
  if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256') return false;
  return isString(jwk['x']) && jwk['x'].length > 0 && isString(jwk['y']) && jwk['y'].length > 0;
}

/** base64url → 字节；非法字符或长度不符返回 undefined。 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  try {
    const binary = atob(normalized + padding);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * 校验发布物并验签。
 *
 * @param envelope 已 JSON 解析的发布物
 * @param publicKeys `{ key_id: JWK }`
 * @param webcrypto 可注入的 WebCrypto 视图；缺省在调用时解析 `globalThis.crypto`
 */
export async function verifyEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  publicKeys: Readonly<Record<string, JsonWebKey>>,
  webcrypto?: WebCryptoLike,
): Promise<VerifyResult> {
  const shape = validateEnvelopeShape(envelope);
  if (!shape.ok) return { ok: false, reason: shape.reason ?? CONFIG_REASON_CODES.signatureInvalid };

  const keyId = envelope['key_id'];
  if (!isString(keyId)) return { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };
  const jwk = publicKeys[keyId];
  if (jwk === undefined) return { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };
  if (!isUsablePublicJwk(jwk)) return { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };

  const subtle = (webcrypto ?? resolveWebCrypto()).subtle;
  if (subtle === undefined) return { ok: false, reason: CONFIG_REASON_CODES.signatureUnavailable };

  const signature = envelope['signature'];
  const payload = envelope['payload'];
  if (!isString(signature) || !isString(payload)) {
    return { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };
  }
  const signatureBytes = decodeBase64Url(signature);
  if (signatureBytes === undefined || signatureBytes.length !== 64) {
    return { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };
  }

  try {
    const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const valid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signatureBytes,
      new TextEncoder().encode(payload),
    );
    return valid ? { ok: true, reason: undefined } : { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };
  } catch {
    return { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };
  }
}
