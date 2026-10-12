#!/usr/bin/env node
/**
 * K02 配置签名 CLI：校验、签名、验签与测试密钥生成。
 *
 * 退出码约定（指南第 11 节：失败时返回非零退出码并输出可读错误）：
 * - 0：命令成功
 * - 1：检查未通过（Schema 校验失败、`config_version` 未递增、疑似令牌、验签失败）
 * - 2：用法或运行环境错误（未知子命令、缺参数、文件不可读、密钥不可解析）
 *
 * 安全约定：本文件只做参数解析与输出转发，**不读取也不打印私钥内容**；
 * 私钥接触面集中在 `signer-source.ts`；所有问题经 `errors.ts` 统一渲染，
 * `Problem` 类型不含原始取值。
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  EXIT_OK,
  EXIT_USAGE,
  isProblem,
  renderProblem,
  toUsageProblem,
  usageProblem,
  type CliIo,
  type Problem,
} from './errors.js';
import { generateKeyPairFiles, readPublicKeys, type PublicKeys } from './keys.js';
import { signConfig, serializeEnvelope } from './sign.js';
import { createSigner, type SignerSource } from './signer-source.js';
import { validateConfig } from './validate.js';
import { pickPreviousVersion } from './version.js';
import { verifyEnvelope } from './verify.js';

/** 子命令。 */
export type Command = 'validate' | 'sign' | 'verify' | 'keygen';

/** 解析后的命令行选项。 */
export interface CliOptions {
  readonly command: Command;
  readonly body?: string;
  readonly envelope?: string;
  readonly out?: string;
  readonly privateKey?: string;
  readonly signCommand?: string;
  readonly signArgs: readonly string[];
  readonly keyId?: string;
  readonly publicKey?: string;
  readonly previous?: string;
  readonly outPrivate?: string;
  readonly outPublic?: string;
  readonly force: boolean;
  readonly allowTokenPaths: readonly string[];
  readonly bodySchema: boolean;
}

/** 参数解析结果：`help` 表示请求了 `--help`。 */
export type ParsedArgs =
  | { readonly ok: true; readonly mode: 'help' }
  | { readonly ok: true; readonly mode: 'run'; readonly options: CliOptions }
  | { readonly ok: false; readonly problem: Problem };

const COMMANDS: readonly Command[] = ['validate', 'sign', 'verify', 'keygen'];

/** key_id 的格式（Schema `$defs/envelope`：`^[A-Za-z0-9_-]{1,64}$`）。 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/** 用法文本。 */
export const USAGE = `用法：web-report-config-signer <子命令> [选项]

子命令：
  validate   按 remote-config.schema.json 校验配置正文（K02-F1、K02-F2）
  sign       校验并用 ES256 签名，输出发布物（K02-F3）
  verify     校验发布物签名与正文，用于发布前自检（K02-F4）
  keygen     生成测试密钥对（K02-F5，只用于测试；生产签名用 --sign-command）

选项：
  --body <文件>             配置正文；也接受契约样例的 decoded_payload 与 cases 文档（validate / sign）
  --envelope <文件>         待验签的发布物（verify；与 --body 等价）
  --previous <文件>         上一份发布物（envelope 或正文）；检查 config_version 严格递增（K02-F2）
  --private-key <文件>      本地私钥 PEM；仅用于测试（与 --sign-command 二选一）
  --sign-command <命令>     外部签名命令（接入方 KMS）；payload 经 stdin 传入，只接收 64 字节裸签名
  --sign-arg <参数>         外部签名命令的参数，可重复（按出现顺序传入）
  --key-id <名称>           发布物的 key_id；keygen 时写入公钥文件
  --public-key <文件>       公钥集合 { key_id: JWK } 或单个 JWK（verify、sign 自检）
  --out <文件>              发布物输出文件；省略时写到标准输出
  --out-private <文件>      keygen 的私钥 PEM 输出（权限 0600）
  --out-public <文件>       keygen 的公钥 JWK 输出
  --force                   keygen 允许覆盖已存在的文件
  --allow-token-path <路径> 放行指定 JSON 指针上的疑似令牌（默认空；每次放行都会打印留痕）
  --no-body-schema          verify 时跳过正文 Schema 校验
  --help                    显示本说明

退出码：0 成功；1 检查未通过；2 用法或运行环境错误。`;

/** 取一个选项值；缺失时返回问题。 */
function takeValue(argv: readonly string[], index: number, flag: string): string | Problem {
  // 不把以 `--` 开头的取值当成缺参：`--sign-arg --sign` 是合法用法，
  // 其余情况下的笔误会在后面的文件解析阶段给出可读错误。
  const value = argv[index + 1];
  if (value === undefined) {
    return usageProblem('usage_error', `${flag} 缺少取值`);
  }
  return value;
}

/** 解析命令行参数；遇到非法用法返回 `Problem`。 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let command: Command | null = null;
  let help = false;
  let body: string | undefined;
  let envelope: string | undefined;
  let out: string | undefined;
  let privateKey: string | undefined;
  let signCommand: string | undefined;
  let keyId: string | undefined;
  let publicKey: string | undefined;
  let previous: string | undefined;
  let outPrivate: string | undefined;
  let outPublic: string | undefined;
  let force = false;
  let bodySchema = true;
  const signArgs: string[] = [];
  const allowTokenPaths: string[] = [];

  const fail = (message: string): ParsedArgs => ({
    ok: false,
    problem: usageProblem('usage_error', message),
  });

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    switch (flag) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--body':
      case '--envelope': {
        const value = takeValue(argv, index, flag);
        if (isProblem(value)) return { ok: false, problem: value };
        if (flag === '--body') body = value;
        else envelope = value;
        index += 1;
        break;
      }
      case '--out':
      case '--private-key':
      case '--sign-command':
      case '--key-id':
      case '--public-key':
      case '--previous':
      case '--out-private':
      case '--out-public':
      case '--allow-token-path': {
        const value = takeValue(argv, index, flag);
        if (isProblem(value)) return { ok: false, problem: value };
        switch (flag) {
          case '--out':
            out = value;
            break;
          case '--private-key':
            privateKey = value;
            break;
          case '--sign-command':
            signCommand = value;
            break;
          case '--key-id':
            keyId = value;
            break;
          case '--public-key':
            publicKey = value;
            break;
          case '--previous':
            previous = value;
            break;
          case '--out-private':
            outPrivate = value;
            break;
          case '--out-public':
            outPublic = value;
            break;
          default:
            allowTokenPaths.push(value);
        }
        index += 1;
        break;
      }
      case '--sign-arg': {
        const value = takeValue(argv, index, flag);
        if (isProblem(value)) return { ok: false, problem: value };
        signArgs.push(value);
        index += 1;
        break;
      }
      case '--force':
        force = true;
        break;
      case '--no-body-schema':
        bodySchema = false;
        break;
      default: {
        if (flag.startsWith('-')) return fail(`未知参数：${flag}`);
        if (command !== null) return fail(`多余的位置参数：${flag}`);
        if (!(COMMANDS as readonly string[]).includes(flag)) return fail(`未知子命令：${flag}`);
        command = flag as Command;
      }
    }
  }

  if (help) return { ok: true, mode: 'help' };
  if (command === null) {
    return fail('缺少子命令；可用子命令：validate、sign、verify、keygen');
  }
  return {
    ok: true,
    mode: 'run',
    options: {
      command,
      ...(body === undefined ? {} : { body }),
      ...(envelope === undefined ? {} : { envelope }),
      ...(out === undefined ? {} : { out }),
      ...(privateKey === undefined ? {} : { privateKey }),
      ...(signCommand === undefined ? {} : { signCommand }),
      signArgs,
      ...(keyId === undefined ? {} : { keyId }),
      ...(publicKey === undefined ? {} : { publicKey }),
      ...(previous === undefined ? {} : { previous }),
      ...(outPrivate === undefined ? {} : { outPrivate }),
      ...(outPublic === undefined ? {} : { outPublic }),
      force,
      allowTokenPaths,
      bodySchema,
    },
  };
}

/** 分派子命令，返回退出码。 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    io.stderr(renderProblem(parsed.problem));
    io.stderr(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.mode === 'help') {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  try {
    switch (parsed.options.command) {
      case 'validate':
        return await runValidate(parsed.options, io);
      case 'sign':
        return await runSign(parsed.options, io);
      case 'verify':
        return await runVerify(parsed.options, io);
      case 'keygen':
        return await runKeygen(parsed.options, io);
      default:
        io.stderr(renderProblem(usageProblem('usage_error', '未知子命令')));
        return EXIT_USAGE;
    }
  } catch (error) {
    io.stderr(renderProblem(toUsageProblem(error)));
    return EXIT_USAGE;
  }
}

/** 输出一个问题并返回它的退出码。 */
function emitProblem(io: CliIo, problem: Problem): number {
  io.stderr(renderProblem(problem));
  return problem.kind === 'usage' ? EXIT_USAGE : 1;
}

/** 输出一组问题，返回汇总退出码。 */
function emitProblems(io: CliIo, problems: readonly Problem[]): number {
  for (const problem of problems) io.stderr(renderProblem(problem));
  return problems.some((problem) => problem.kind === 'usage') ? EXIT_USAGE : 1;
}

/**
 * 读取并解析 JSON 文件。
 *
 * 失败时抛出普通 `Error`，message 直接复用 `usageProblem` 的文案（不含文件内容）；
 * 由 `runCli` 顶层兜底转成退出码 2。
 */
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, { encoding: 'utf8' });
  } catch (error) {
    const reason = error instanceof Error ? error.name : '读取失败';
    throw new Error(usageProblem('usage_error', `无法读取文件 ${path}（${reason}）`).message, {
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(usageProblem('usage_error', `文件 ${path} 不是合法 JSON`).message);
  }
}

/** 读取正文：`-` 表示从 stdin 读取。 */
async function readBodySource(source: string): Promise<unknown> {
  if (source !== '-') return readJson(source);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(usageProblem('usage_error', 'stdin 不是合法 JSON').message);
  }
}

/** 读 `--previous` 文件并取 config_version。 */
async function readPreviousVersion(path: string): Promise<number> {
  const parsed = await readJson(path);
  const version = pickPreviousVersion(parsed);
  if (version === null) {
    throw new Error(
      usageProblem(
        'usage_error',
        `上一份发布物 ${path} 里没有整数 config_version（接受 envelope 的 payload 或正文）`,
      ).message,
    );
  }
  return version;
}

/** 取单份正文；cases 文档不能用于签名。 */
function extractSingleBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(usageProblem('usage_error', '正文必须是 JSON 对象').message);
  }
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record['cases'])) {
    throw new Error(
      usageProblem('usage_error', 'cases 文档包含多份正文，不能用于签名；请逐个正文签名').message,
    );
  }
  const decoded = record['decoded_payload'];
  if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
    return decoded as Record<string, unknown>;
  }
  return record;
}

/** 从公钥文件里取指定 key_id 的 JWK 对象。 */
async function readPublicKeyObject(path: string, keyId: string): Promise<Record<string, unknown>> {
  const keys: PublicKeys | Problem = await readPublicKeys(path, keyId);
  if (isProblem(keys)) throw new Error(keys.message);
  const jwk = keys[keyId];
  if (jwk === undefined) {
    throw new Error(usageProblem('usage_error', `--public-key 中没有 key_id=${keyId} 的公钥`).message);
  }
  return jwk;
}

/** 从私钥文件推导公钥 JWK（不导出也不回显私钥材料）。 */
async function derivePublicJwk(privateKeyPath: string): Promise<Record<string, unknown>> {
  let pem: string;
  try {
    pem = await readFile(privateKeyPath, { encoding: 'utf8' });
  } catch {
    throw new Error(
      usageProblem('usage_error', '无法读取私钥文件以推导公钥（文件内容不会回显）').message,
    );
  }
  try {
    const publicKey = createPublicKey(createPrivateKey({ key: pem, format: 'pem' }));
    return publicKey.export({ format: 'jwk' });
  } catch {
    throw new Error(
      usageProblem('usage_error', '无法从私钥文件推导公钥；请用 --public-key 提供公钥（文件内容不会回显）')
        .message,
    );
  }
}

/** `validate`：校验正文 + 递增检查 + 令牌扫描。 */
async function runValidate(options: CliOptions, io: CliIo): Promise<number> {
  if (options.body === undefined) {
    return emitProblem(io, usageProblem('usage_error', 'validate 需要 --body <文件>（- 表示 stdin）'));
  }
  const raw = await readBodySource(options.body);
  const previous = options.previous === undefined ? null : await readPreviousVersion(options.previous);
  const result = validateConfig({
    raw,
    previous,
    allowTokenPaths: options.allowTokenPaths,
  });
  for (const message of result.messages) io.stdout(message);
  for (const path of result.allowlistedHits) io.stdout(`已放行 ${path}`);
  if (!result.ok) return emitProblems(io, result.problems);
  return EXIT_OK;
}

/** `sign`：校验后签名，输出发布物。 */
async function runSign(options: CliOptions, io: CliIo): Promise<number> {
  if (options.body === undefined) {
    return emitProblem(io, usageProblem('usage_error', 'sign 需要 --body <文件>（- 表示 stdin）'));
  }
  if (options.keyId === undefined) {
    return emitProblem(io, usageProblem('usage_error', 'sign 需要 --key-id <名称>'));
  }
  const keyId = options.keyId;
  if (!KEY_ID_PATTERN.test(keyId)) {
    return emitProblem(
      io,
      usageProblem('usage_error', '--key-id 不合法：只允许字母、数字、下划线与连字符，长度 1–64'),
    );
  }
  if (options.privateKey === undefined && options.signCommand === undefined) {
    return emitProblem(
      io,
      usageProblem(
        'usage_error',
        'sign 需要 --private-key <文件>（仅测试）或 --sign-command <命令>（接入 KMS）',
      ),
    );
  }
  if (options.privateKey !== undefined && options.signCommand !== undefined) {
    return emitProblem(
      io,
      usageProblem('usage_error', '--private-key 与 --sign-command 只能选一个'),
    );
  }

  const source: SignerSource =
    options.signCommand !== undefined
      ? { kind: 'external-command', signCommand: { command: options.signCommand, args: options.signArgs } }
      : { kind: 'local-file', privateKeyPath: options.privateKey ?? '' };
  const created = await createSigner(source);
  if (isProblem(created)) return emitProblem(io, created);

  const raw = await readBodySource(options.body);
  const body = extractSingleBody(raw);
  const previous = options.previous === undefined ? null : await readPreviousVersion(options.previous);

  // 发布物自检用的公钥：优先 --public-key，其次从本地私钥推导。
  let publicJwk: Record<string, unknown> | undefined;
  if (options.publicKey !== undefined) {
    publicJwk = await readPublicKeyObject(options.publicKey, keyId);
  } else if (options.privateKey !== undefined) {
    publicJwk = await derivePublicJwk(options.privateKey);
  }

  const result = await signConfig({
    body,
    keyId,
    signer: created.signer,
    ...(publicJwk === undefined ? {} : { publicJwk }),
    ...(previous === null ? {} : { previous }),
    ...(options.allowTokenPaths.length === 0 ? {} : { allowTokenPaths: options.allowTokenPaths }),
  });
  for (const message of result.messages) io.stdout(message);
  for (const path of result.allowlistedHits) io.stdout(`已放行 ${path}`);
  if (!result.ok) return emitProblems(io, result.problems);

  const text = serializeEnvelope(result.envelope);
  if (options.out === undefined) {
    io.stdout(text.trimEnd());
  } else {
    await writeFile(options.out, text, 'utf8');
    io.stdout(`已写入发布物：${options.out}`);
  }
  return EXIT_OK;
}

/** `verify`：校验发布物与签名。 */
async function runVerify(options: CliOptions, io: CliIo): Promise<number> {
  const envelopePath = options.envelope ?? options.body;
  if (envelopePath === undefined) {
    return emitProblem(io, usageProblem('usage_error', 'verify 需要 --envelope <文件>'));
  }
  if (options.publicKey === undefined) {
    return emitProblem(io, usageProblem('usage_error', 'verify 需要 --public-key <文件>'));
  }
  const envelope = await readJson(envelopePath);
  const keys = await readPublicKeys(options.publicKey, options.keyId);
  if (isProblem(keys)) return emitProblem(io, keys);
  const result = verifyEnvelope({
    envelope,
    publicKeys: keys,
    checkBodySchema: options.bodySchema,
    ...(options.allowTokenPaths.length === 0 ? {} : { allowTokenPaths: options.allowTokenPaths }),
  });
  for (const message of result.messages) io.stdout(message);
  if (!result.ok) return emitProblems(io, result.problems);
  return EXIT_OK;
}

/** `keygen`：生成测试密钥对。 */
async function runKeygen(options: CliOptions, io: CliIo): Promise<number> {
  if (options.outPrivate === undefined || options.outPublic === undefined) {
    return emitProblem(
      io,
      usageProblem('usage_error', 'keygen 需要 --out-private <文件> 与 --out-public <文件>'),
    );
  }
  const result = await generateKeyPairFiles({
    outPrivate: options.outPrivate,
    outPublic: options.outPublic,
    keyId: options.keyId ?? 'test-key',
    force: options.force,
  });
  if (isProblem(result)) return emitProblem(io, result);
  for (const message of result.messages) io.stdout(message);
  return EXIT_OK;
}

/** 直接执行 `cli.js`（或源码 `cli.ts`）时运行命令。 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const name = entry.slice(entry.lastIndexOf('/') + 1);
  return name === 'cli.js' || name === 'cli.ts';
}

if (isMainModule()) {
  // 兜底：任何未捕获异常都转成退出码 2，只输出错误类型，不回显可能含敏感数据的内容。
  process.on('uncaughtException', (error: Error) => {
    process.stderr.write(`${renderProblem(toUsageProblem(error))}\n`);
    process.exitCode = EXIT_USAGE;
  });
  process.on('unhandledRejection', () => {
    process.stderr.write(`${renderProblem(usageProblem('internal_error', '未处理的 Promise 拒绝'))}\n`);
    process.exitCode = EXIT_USAGE;
  });
  runCli(process.argv.slice(2), {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${renderProblem(toUsageProblem(error))}\n`);
      process.exitCode = EXIT_USAGE;
    });
}
