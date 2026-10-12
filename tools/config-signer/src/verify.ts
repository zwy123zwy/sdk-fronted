/**
 * 验签子命令（K02-F4），用于发布前自检。
 *
 * 与 SDK 侧（C03）保持同一条验签路径：按 `key_id` 找公钥 → 对 `payload` 的
 * UTF-8 字节验 ECDSA P-256 + SHA-256 → 再校验解码后的正文 Schema。
 */
import { createPublicKey, verify } from 'node:crypto';
import { EXIT_CHECK_FAILED, checkProblem, type Problem } from './errors.js';
import { getEnvelopeValidator, toSchemaProblems, type Envelope } from './schema.js';
import { validateConfig } from './validate.js';
import type { PublicKeys } from './keys.js';

/** 验签请求。 */
export interface VerifyRequest {
  readonly envelope: unknown;
  readonly publicKeys: PublicKeys;
  /** 是否再校验解码后的正文 Schema（默认 true）。 */
  readonly checkBodySchema?: boolean;
  readonly allowTokenPaths?: readonly string[];
}

/** 验签结果。 */
export interface VerifyResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly problems: readonly Problem[];
  readonly messages: readonly string[];
}

/** 从 envelope 里取字符串字段。 */
function pickString(envelope: Record<string, unknown>, field: string): string | undefined {
  const value = envelope[field];
  return typeof value === 'string' ? value : undefined;
}

/** 用公钥 JWK 验签。 */
function verifyWithJwk(payload: string, signature: string, jwk: Record<string, unknown>): boolean {
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    return verify(
      'sha256',
      Buffer.from(payload, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** 验签。 */
export function verifyEnvelope(request: VerifyRequest): VerifyResult {
  const validator = getEnvelopeValidator();
  if (!validator(request.envelope)) {
    return {
      ok: false,
      exitCode: EXIT_CHECK_FAILED,
      problems: toSchemaProblems(validator.errors).map((problem) => ({
        ...problem,
        code: 'envelope_schema_invalid',
      })),
      messages: [],
    };
  }
  const envelope = request.envelope as Envelope;
  const publicKey = request.publicKeys[envelope.key_id];
  if (publicKey === undefined) {
    return {
      ok: false,
      exitCode: EXIT_CHECK_FAILED,
      problems: [
        checkProblem(
          'key_id_unknown',
          `key_id=${envelope.key_id} 不在提供的公钥列表中，无法验签（SDK 侧会判为 config_signature_invalid）`,
          '/key_id',
        ),
      ],
      messages: [],
    };
  }

  const messages: string[] = [];
  if (request.checkBodySchema !== false) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(envelope.payload) as unknown;
    } catch {
      return {
        ok: false,
        exitCode: EXIT_CHECK_FAILED,
        problems: [checkProblem('payload_not_json', 'payload 不是合法 JSON，无法校验正文', '/payload')],
        messages: [],
      };
    }
    const validation = validateConfig({
      raw: decoded,
      previous: null,
      ...(request.allowTokenPaths === undefined ? {} : { allowTokenPaths: request.allowTokenPaths }),
    });

    if (!validation.ok) {
      return {
        ok: false,
        exitCode: validation.exitCode,
        problems: validation.problems,
        messages: [],
      };
    }
    messages.push('正文 Schema 校验通过。');
  } else {
    messages.push('已按 --no-body-schema 跳过正文 Schema 校验。');
  }

  if (!verifyWithJwk(envelope.payload, envelope.signature, publicKey)) {
    return {
      ok: false,
      exitCode: EXIT_CHECK_FAILED,
      problems: [
        checkProblem(
          'signature_invalid',
          '签名校验失败：payload 或 signature 与公钥不匹配（篡改一个字节都会失败）',
          '/signature',
        ),
      ],
      messages: [],
    };
  }

  messages.push(`K02 verify 通过：key_id=${envelope.key_id} alg=${envelope.alg} format_version=${String(envelope.format_version)}`);
  return { ok: true, exitCode: 0, problems: [], messages };
}

/** 从 envelope 里取 config_version（供 CLI 打印摘要）。 */
export function envelopeConfigVersion(envelope: unknown): number | null {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return null;
  const payload = pickString(envelope as Record<string, unknown>, 'payload');
  if (payload === undefined) return null;
  try {
    const decoded = JSON.parse(payload) as Record<string, unknown>;
    const version = decoded['config_version'];
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}
