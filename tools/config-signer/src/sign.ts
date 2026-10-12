/**
 * ES256 签名与发布物组装（K02-F3）。
 *
 * - 算法：ECDSA P-256 + SHA-256；签名覆盖 `payload` 字符串的 UTF-8 字节，不做 JSON 规范化。
 * - 格式：IEEE P1363（r‖s，64 字节），base64url 无填充 → 86 字符（`remote-config.md` 第 4 节）。
 * - 签名前固定执行 Schema 校验 + 递增检查 + 令牌扫描；不提供跳过校验的开关。
 * - 签名后用公钥自检一次，保证产出的发布物一定自洽。
 */
import { createPublicKey, verify } from 'node:crypto';
import {
  EXIT_CHECK_FAILED,
  EXIT_USAGE,
  checkProblem,
  usageProblem,
  type Problem,
} from './errors.js';
import { getEnvelopeValidator, toSchemaProblems, type Envelope } from './schema.js';
import type { Signer } from './signer-source.js';
import { validateConfig } from './validate.js';

/** 签名请求。 */
export interface SignRequest {
  readonly body: Record<string, unknown>;
  readonly keyId: string;
  readonly signer: Signer;
  /** 发布前自检用的公钥 JWK（可选：本地私钥来源可以从私钥推导）。 */
  readonly publicJwk?: Record<string, unknown>;
  readonly previous?: number | null;
  readonly allowTokenPaths?: readonly string[];
}

/** 签名结果。 */
export type SignResult =
  | {
      readonly ok: true;
      readonly envelope: Envelope;
      readonly messages: readonly string[];
      readonly allowlistedHits: readonly string[];
    }
  | { readonly ok: false; readonly exitCode: number; readonly problems: readonly Problem[]; readonly messages: readonly string[]; readonly allowlistedHits: readonly string[] };

/** key_id 的格式（Schema `$defs/envelope`）。 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** 组装发布物。 */
export function renderEnvelope(payload: string, keyId: string, signature: string): Envelope {
  return { format_version: 1, key_id: keyId, alg: 'ES256', payload, signature };
}

/** 序列化发布物（固定 2 空格缩进 + 末尾换行）。 */
export function serializeEnvelope(envelope: Envelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** 用公钥 JWK 验签（K02 内部自检；SDK 侧用 WebCrypto，两者算法路径一致）。 */
export function verifySignatureWithJwk(
  payload: string,
  signature: string,
  publicJwk: Record<string, unknown>,
): boolean {
  try {
    const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
    return verify(
      'sha256',
      Buffer.from(payload, 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

/** 签名并返回发布物。 */
export async function signConfig(request: SignRequest): Promise<SignResult> {
  if (!KEY_ID_PATTERN.test(request.keyId)) {
    return {
      ok: false,
      exitCode: EXIT_USAGE,
      problems: [
        usageProblem(
          'usage_error',
          `--key-id 不合法：只允许字母、数字、下划线与连字符，长度 1–64（当前长度 ${String(request.keyId.length)}）`,
        ),
      ],
      messages: [],
      allowlistedHits: [],
    };
  }
  const validation = validateConfig({
    raw: request.body,
    previous: request.previous ?? null,
    ...(request.allowTokenPaths === undefined ? {} : { allowTokenPaths: request.allowTokenPaths }),
  });
  if (!validation.ok) {
    return {
      ok: false,
      exitCode: validation.exitCode,
      problems: validation.problems,
      messages: validation.messages,
      allowlistedHits: validation.allowlistedHits,
    };
  }
  const payload = JSON.stringify(request.body);
  const signature = await request.signer(Buffer.from(payload, 'utf8'));
  const envelope = renderEnvelope(payload, request.keyId, signature);

  const envelopeValidate = getEnvelopeValidator();
  if (!envelopeValidate(envelope)) {
    return {
      ok: false,
      exitCode: EXIT_CHECK_FAILED,
      problems: toSchemaProblems(envelopeValidate.errors),
      messages: validation.messages,
      allowlistedHits: validation.allowlistedHits,
    };
  }

  if (request.publicJwk !== undefined) {
    if (!verifySignatureWithJwk(payload, signature, request.publicJwk)) {
      return {
        ok: false,
        exitCode: EXIT_CHECK_FAILED,
        problems: [
          checkProblem(
            'signature_invalid',
            '签名后自检失败：产出的发布物无法用提供的公钥验签。请检查私钥与公钥是否匹配、外部签名命令是否返回了正确的签名。',
          ),
        ],
        messages: validation.messages,
        allowlistedHits: validation.allowlistedHits,
      };
    }
  }

  const messages = [
    ...validation.messages,
    `K02 sign 通过：key_id=${request.keyId} alg=ES256 signature=${String(signature.length)} 字符 base64url`,
  ];
  return { ok: true, envelope, messages, allowlistedHits: validation.allowlistedHits };
}
