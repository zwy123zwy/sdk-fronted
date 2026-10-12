/**
 * 测试密钥对生成与公钥读取（K02-F5）。
 *
 * `keygen` 只用于测试（任务卡 K02-F5「生成测试密钥对（只用于测试）」）：
 * - 私钥以 PKCS#8 PEM 写入，权限 0600（`open(..., 'wx', 0o600)` + `fchmod` 双保险），
 *   已存在时默认拒绝覆盖；
 * - 公钥写成 `{ [key_id]: JWK }`，与 SDK 的 `config_public_keys`（R-002）同形，
 *   JWK 只含 `kty`、`crv`、`x`、`y`；
 * - stdout 只给路径、权限与提示，**不含任何密钥内容**。
 */
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { usageProblem, type Problem } from './errors.js';

/** 私钥文件权限（K02-AC-05）。 */
export const PRIVATE_KEY_MODE = 0o600;
const PUBLIC_KEY_MODE = 0o644;

/** keygen 参数。 */
export interface KeygenOptions {
  readonly outPrivate: string;
  readonly outPublic: string;
  readonly keyId: string;
  readonly force: boolean;
}

/** keygen 结果。 */
export interface KeygenResult {
  readonly messages: readonly string[];
}

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** 公钥 JWK 只保留公有字段。 */
function toPublicJwk(jwk: Record<string, unknown>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const field of ['kty', 'crv', 'x', 'y'] as const) {
    const value = jwk[field];
    if (typeof value === 'string') picked[field] = value;
  }
  return picked;
}

/** 写文件：`wx` 保证「已存在则不覆盖」，并显式设置权限。 */
async function writeNewFile(
  path: string,
  text: string,
  mode: number,
  force: boolean,
): Promise<Problem | null> {
  await mkdir(dirname(path), { recursive: true });
  const flags = force ? 'w' : 'wx';
  try {
    const handle = await open(path, flags, mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await chmod(path, mode);
    return null;
  } catch (error) {
    const code = isRecord(error) ? error['code'] : undefined;
    if (code === 'EEXIST') {
      return usageProblem('usage_error', `文件已存在，拒绝覆盖：${path}（如确认要覆盖请加 --force）`);
    }
    const reason = error instanceof Error ? error.name : '写入失败';
    return usageProblem('usage_error', `无法写入 ${path}（${reason}）`);
  }
}

/** 生成测试密钥对。 */
export async function generateKeyPairFiles(
  options: KeygenOptions,
): Promise<KeygenResult | Problem> {
  if (!KEY_ID_PATTERN.test(options.keyId)) {
    return usageProblem('usage_error', '--key-id 不合法：只允许字母、数字、下划线与连字符，长度 1–64');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // `KeyObject.export` 的返回类型是 `string | Buffer`，PEM 形态运行时一定是 string
  const privatePem = String(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const publicJwk = toPublicJwk(publicKey.export({ format: 'jwk' }));
  const publicText = `${JSON.stringify({ [options.keyId]: publicJwk }, null, 2)}\n`;

  const privateError = await writeNewFile(options.outPrivate, privatePem, PRIVATE_KEY_MODE, options.force);
  if (privateError !== null) return privateError;
  const publicError = await writeNewFile(options.outPublic, publicText, PUBLIC_KEY_MODE, options.force);
  if (publicError !== null) return publicError;

  return {
    messages: [
      `K02 keygen 完成：key_id=${options.keyId}`,
      `私钥（仅用于测试，权限 0600，切勿提交）：${options.outPrivate}`,
      `公钥 JWK（可传给 config_public_keys）：${options.outPublic}`,
      '提示：测试密钥仅用于测试与本地联调，生产签名请使用 --sign-command 接入 KMS。',
    ],
  };
}

/** 公钥集合：`{ [key_id]: JWK }`，与 SDK 的 `config_public_keys` 同形。 */
export type PublicKeys = Readonly<Record<string, Record<string, unknown>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验一个公钥 JWK 是否可用（EC P-256，含 x/y）。 */
function isUsablePublicJwk(value: Record<string, unknown>): boolean {
  return value['kty'] === 'EC' && value['crv'] === 'P-256' && typeof value['x'] === 'string' && typeof value['y'] === 'string';
}

/** 读取公钥文件：既接受 `{ key_id: JWK }`，也接受单个 JWK（用 --key-id 指定名字）。 */
export async function readPublicKeys(
  path: string,
  singleKeyId?: string,
): Promise<PublicKeys | Problem> {
  let text: string;
  try {
    text = await readFile(path, { encoding: 'utf8' });
  } catch (error) {
    const reason = error instanceof Error ? error.name : '读取失败';
    return usageProblem('usage_error', `无法读取公钥文件 ${path}（${reason}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return usageProblem('usage_error', `公钥文件 ${path} 不是合法 JSON`);
  }
  if (!isRecord(parsed)) return usageProblem('usage_error', `公钥文件 ${path} 必须是 JSON 对象`);

  const keys: Record<string, Record<string, unknown>> = {};
  if (typeof parsed['kty'] === 'string') {
    const keyId = singleKeyId;
    if (keyId === undefined) {
      return usageProblem('usage_error', `公钥文件 ${path} 是单个 JWK，需要 --key-id 指定它的 key_id`);
    }
    if (!isUsablePublicJwk(parsed)) {
      return usageProblem('usage_error', `公钥文件 ${path} 的 JWK 不是可用的 EC P-256 公钥（需要 kty/crv/x/y）`);
    }
    keys[keyId] = parsed;
    return keys;
  }
  for (const [keyId, value] of Object.entries(parsed)) {
    if (!isRecord(value) || !isUsablePublicJwk(value)) {
      return usageProblem('usage_error', `公钥文件 ${path} 中 key_id=${keyId} 的 JWK 不是可用的 EC P-256 公钥（需要 kty/crv/x/y）`);
    }
    keys[keyId] = value;
  }
  if (Object.keys(keys).length === 0) {
    return usageProblem('usage_error', `公钥文件 ${path} 里没有任何公钥`);
  }
  return keys;
}
