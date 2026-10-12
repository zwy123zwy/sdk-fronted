/**
 * K02 测试支持（非 `.test.ts`，不会被 Vitest 收集）。
 *
 * 只用 Node 内置模块：定位仓库契约样例、制造临时目录、现场生成测试密钥、
 * 在进程内运行 CLI 并记录所有输出（供 K02-AC-08 的泄漏扫描复用）。
 *
 * 安全约定：
 * - 测试密钥在运行时生成，只写操作系统临时目录，绝不写入仓库；
 * - 私钥材料优先留在内存（`Uint8Array`），只在需要 CLI 读取时才落到 tmpdir；
 * - `PEM_HEADER_*` 用字符串拼接构造，故意不让 `-----BEGIN ... PRIVATE KEY-----`
 *   的完整字面量出现在源码里，避免 AC-08 的仓库扫描出现自指命中。
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../cli.js';
import type { CliIo } from '../errors.js';

/** 仓库根目录。 */
export const REPO_ROOT = resolveRepoRoot();

function resolveRepoRoot(): string {
  try {
    const candidate = fileURLToPath(new URL('../../../../', import.meta.url));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {
    // happy-dom 下 import.meta.url 可能不是 file: URL，走 cwd 兜底
  }
  const candidate = resolve(process.cwd());
  if (existsSync(join(candidate, 'package.json'))) return candidate;
  throw new Error('找不到仓库根目录，请在仓库根目录运行测试');
}

/** 契约样例目录。 */
export const CONTRACT_EXAMPLES = join(REPO_ROOT, 'docs/contracts/examples');
/** 契约 Schema 目录。 */
export const CONTRACT_SCHEMAS = join(REPO_ROOT, 'docs/contracts/schemas');
/** 合法配置样例（含 `decoded_payload`）。 */
export const VALID_SAMPLE = join(CONTRACT_EXAMPLES, 'remote-config.valid.json');
/** 非法配置样例（`cases` 数组）。 */
export const INVALID_SAMPLE = join(CONTRACT_EXAMPLES, 'remote-config.invalid.json');

/** 当前测试工作目录（用于 AC-08 的「仓库零新增文件」差集）。 */
export const WORKTREE_ROOT = REPO_ROOT;

/**
 * 私钥 PEM 头/尾：用 `join` 在运行时拼出，源码里不出现完整字面量
 * （避免 AC-08 的仓库扫描出现自指命中）。
 */
export const PEM_HEADER_PREFIX = ['-----BEGIN ', 'PRIVATE', ' KEY-----'].join('');
export const PEM_HEADER_SUFFIX = ['-----END ', 'PRIVATE', ' KEY-----'].join('');
/** 通用的 PEM 头探测（扫描用）。 */
export const PEM_HEAD_MARKER = '-----BEGIN ';
/** 供扫描器拼接的私钥头（避免源码里出现完整串）。 */
export const PRIVATE_KEY_MARKER = [PEM_HEAD_MARKER, 'PRIVATE KEY-----'].join('');

/** 在进程内运行 CLI 时收集的输出。 */
export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** CLI 在一组参数下「意外失败」时的测试错误。 */
export interface CliFailure extends Error {
  readonly result: CliResult;
}

/** 构造测试用的失败错误。 */
export function unexpectedCliFailure(result: CliResult): CliFailure {
  const error = new Error(
    `CLI 意外失败（退出码 ${String(result.code)}）：${result.stderr.trim()}`,
  ) as Error & { result: CliResult };
  error.name = 'UnexpectedCliFailure';
  error.result = result;
  return error;
}

/** 计算某段文本中命中了多少个敏感片段（只返回数量，绝不返回片段本身）。 */
export function countSecretHits(targets: readonly string[], fragments: readonly string[]): number {
  let hits = 0;
  for (const fragment of fragments) {
    for (const target of targets) {
      if (target.includes(fragment)) hits += 1;
    }
  }
  return hits;
}

/** 进程内运行 CLI。 */
export async function run(args: readonly string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  const code = await runCli(args, io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** 运行 CLI 并要求成功（退出码 0），否则抛出带输出的错误。 */
export async function runOk(args: readonly string[]): Promise<CliResult> {
  const result = await run(args);
  if (result.code !== 0) throw unexpectedCliFailure(result);
  return result;
}

/**
 * 运行 CLI 并要求失败（非零退出码）。
 *
 * `acceptCodes` 允许指定「可接受的非零退出码」集合；不传时任意非零都算通过。
 */
export async function runFail(
  args: readonly string[],
  acceptCodes?: readonly number[],
): Promise<CliResult> {
  const result = await run(args);
  if (result.code === 0) {
    throw new Error(`CLI 本应失败但返回 0：\n${result.stdout}`);
  }
  if (acceptCodes !== undefined && !acceptCodes.includes(result.code)) {
    throw new Error(
      `CLI 退出码 ${String(result.code)} 不在可接受集合 ${acceptCodes.join('/')} 内：\n${result.stderr}`,
    );
  }
  return result;
}

/** 现场生成的测试密钥对。 */
export interface TestKeyPair {
  /** 私钥 JWK（含 `d`，属敏感材料）。 */
  readonly privateJwk: Readonly<Record<string, string>>;
  /** 私钥 PKCS#8 DER（敏感材料，只用于比对是否泄漏）。 */
  readonly privateDer: Uint8Array;
  /** 私钥 PEM（敏感材料）。 */
  readonly privatePem: string;
  /** 私钥 PEM 的每一行（去掉空行）。 */
  readonly privatePemLines: readonly string[];
  /** 公钥 JWK，只含 kty/crv/x/y。 */
  readonly publicJwk: Readonly<Record<string, string>>;
  /** 公钥 JWK 的 x 值（敏感材料，泄漏即可还原公钥）。 */
  readonly publicX: string;
  readonly publicY: string;
}

/** 生成一对测试密钥。 */
export function makeTestKeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' }) as unknown as Record<string, string>;
  const publicJwk = publicKey.export({ format: 'jwk' }) as unknown as Record<string, string>;
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  // `KeyObject.export` 的返回类型是 `string | Buffer`，PEM 形态运行时一定是 string
  const privatePem = String(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const x = publicJwk['x'];
  const y = publicJwk['y'];
  if (x === undefined || y === undefined) throw new Error('公钥 JWK 缺少 x/y');
  return {
    privateJwk,
    privateDer,
    privatePem,
    privatePemLines: privatePem.split('\n').filter((line) => line.trim() !== ''),
    publicJwk,
    publicX: x,
    publicY: y,
  };
}

/** 由私钥材料派生出的全部片段，用于 AC-08 的「材料指纹」比对。 */
export function secretFragments(pair: TestKeyPair): readonly string[] {
  const fragments = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.length >= 8) fragments.add(value);
  };
  add(pair.privateJwk['d']);
  add(pair.publicX);
  add(pair.publicY);
  add(pair.privatePem);
  for (const line of pair.privatePemLines) add(line);
  add(Buffer.from(pair.privateDer).toString('base64'));
  add(Buffer.from(pair.privateDer).toString('base64url'));
  return [...fragments];
}

/** 建立临时目录（操作系统临时目录，不在仓库内）。 */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'k02-'));
}

/** 删除临时目录。 */
export async function removeTempDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

/** 写 JSON 文件并返回路径。 */
export async function writeJsonFile(path: string, value: unknown): Promise<string> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

/** 写文本文件并返回路径。 */
export async function writeTextFile(path: string, text: string): Promise<string> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
  return path;
}

/** 读 JSON 文件。 */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, { encoding: 'utf8' })) as unknown;
}

/** 读文本文件。 */
export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/**
 * 外部签名脚本（K02-F6、K02-AC-06 的测试替身）。
 *
 * 用法：`node external-signer.mjs --sign`，payload 从 stdin 读取，
 * 私钥从环境变量 `K02_FIXTURE_PRIVATE_JWK` 读取，stdout 只输出 64 字节
 * 裸签名的 base64url。脚本本身不写任何日志，避免把私钥带进输出。
 */
export const EXTERNAL_SIGNER_SCRIPT = `import { createPrivateKey, sign } from 'node:crypto';
const args = process.argv.slice(2);
if (args[0] !== '--sign') {
  process.stderr.write('external-signer: 只支持 --sign\\n');
  process.exit(2);
}
const jwkRaw = process.env.K02_FIXTURE_PRIVATE_JWK;
if (jwkRaw === undefined) {
  process.stderr.write('external-signer: 缺少 K02_FIXTURE_PRIVATE_JWK\\n');
  process.exit(2);
}
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = Buffer.concat(chunks);
const key = createPrivateKey({ key: JSON.parse(jwkRaw), format: 'jwk' });
process.stdout.write(sign('sha256', payload, { key, dsaEncoding: 'ieee-p1363' }).toString('base64url') + '\\n');
`;

/** 外部签名脚本的路径（落在临时目录）。 */
export async function makeExternalSigner(directory: string): Promise<string> {
  return writeTextFile(join(directory, 'external-signer.mjs'), EXTERNAL_SIGNER_SCRIPT);
}

/** 进程执行外部脚本（测试里只用来独立验证脚本本身可用）。 */
export function runExternalScript(script: string, env: Record<string, string>, input: string): string {
  return execFileSync(process.execPath, [script, '--sign'], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim();
}

/** 列出仓库中的跟踪文件与未跟踪文件（相对仓库根目录）。 */
export function listWorktreeFiles(): readonly string[] {
  const tracked = execFileSync('git', ['ls-files'], { cwd: WORKTREE_ROOT, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], {
    cwd: WORKTREE_ROOT,
    encoding: 'utf8',
  });
  const all = `${tracked}${untracked}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return [...new Set(all)].sort();
}

/** 工作树中需要跳过的目录（依赖、产物、git 内部与临时工作树）。 */
export const SCAN_SKIP_PREFIXES: readonly string[] = [
  'node_modules/',
  'dist/',
  'coverage/',
  'temp/',
  'playwright-report/',
  'test-results/',
];
