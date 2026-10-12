/**
 * K02 端到端场景夹具（非 `.test.ts`）。
 *
 * 供 AC-03…AC-08 复用：现场生成测试密钥 → `keygen` → `sign` → `verify`，
 * 并记录每一步的退出码与输出。AC-08 用它拿到「本次真实使用的完整密钥材料」，
 * 再断言这些材料没有出现在任何输出或仓库文件里。
 *
 * 私钥只写操作系统临时目录；`sign` 之外的命令不应接触私钥文件。
 */
import { join } from 'node:path';
import type { CliResult } from './test-support.js';
import {
  makeExternalSigner,
  makeTempDir,
  makeTestKeyPair,
  readJsonFile,
  removeTempDir,
  run,
  runOk,
  secretFragments,
  writeJsonFile,
  writeTextFile,
  type TestKeyPair,
} from './test-support.js';



/** 一次完整场景的产物与记录。 */
export interface K02Workflow {
  readonly directory: string;
  readonly keyPair: TestKeyPair;
  /** 本次用到的全部敏感片段，用于泄漏比对。 */
  readonly fragments: readonly string[];
  readonly privateKeyPath: string;
  readonly publicKeysPath: string;
  readonly body: Record<string, unknown>;
  readonly bodyPath: string;
  readonly envelopePath: string;
  readonly envelope: Record<string, unknown>;
  /** 按顺序记录的每一步输出。 */
  readonly steps: readonly { readonly name: string; readonly result: CliResult }[];
  readonly cleanup: () => Promise<void>;
}

/** 最小合法配置正文（与契约样例的必需字段一致）。 */
export function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 1,
    app_id: 'demo-app',
    env: 'staging',
    config_version: 42,
    published_at: 1793000000000,
    ...overrides,
  };
}

/**
 * 跑一遍完整场景：keygen → validate → sign → verify。
 *
 * 调用方负责 `cleanup()`。
 */
export async function runFullWorkflow(
  options: { readonly body?: Record<string, unknown>; readonly keyId?: string } = {},
): Promise<K02Workflow> {
  const directory = await makeTempDir();
  const keyId = options.keyId ?? 'test-key-2026a';
  const keyPair = makeTestKeyPair();
  const fragments = secretFragments(keyPair);
  const steps: { name: string; result: CliResult }[] = [];
  const record = async (name: string, args: readonly string[]): Promise<CliResult> => {
    const result = await run(args);
    steps.push({ name, result });
    return result;
  };

  const body = options.body ?? makeBody();
  const bodyPath = await writeJsonFile(join(directory, 'body.json'), body);
  const privateKeyPath = join(directory, 'test-key.pem');
  const publicKeysPath = await writeJsonFile(join(directory, 'public-keys.json'), {
    [keyId]: keyPair.publicJwk,
  });
  const envelopePath = join(directory, 'remote-config.json');

  const privatePemPath = join(directory, 'test-key.pem');
  const keygen = await record('keygen', [
    'keygen',
    '--out-private',
    privatePemPath,
    '--out-public',
    publicKeysPath,
    '--key-id',
    keyId,
  ]);
  if (keygen.code !== 0) {
    // 骨架上 keygen 尚未实现：补写测试私钥，让后续步骤各自失败并给出可读信息
    await writeTextFile(privateKeyPath, keyPair.privatePem);
  }
  await record('validate', ['validate', '--body', bodyPath]);
  await record('sign', [
    'sign',
    '--body',
    bodyPath,
    '--private-key',
    privateKeyPath,
    '--key-id',
    keyId,
    '--public-key',
    publicKeysPath,
    '--out',
    envelopePath,
  ]);
  await record('verify', ['verify', '--envelope', envelopePath, '--public-key', publicKeysPath]);

  const envelope = (await readJsonFile(envelopePath)) as Record<string, unknown>;
  return {
    directory,
    keyPair,
    fragments,
    privateKeyPath,
    publicKeysPath,
    body,
    bodyPath,
    envelopePath,
    envelope,
    steps,
    cleanup: () => removeTempDir(directory),
  };
}

/** 外部签名场景（AC-06）：K02 命令行里只有公钥，私钥在测试替身脚本的环境变量里。 */
export interface ExternalSignWorkflow {
  readonly directory: string;
  readonly keyPair: TestKeyPair;
  readonly result: CliResult;
  readonly envelope: Record<string, unknown>;
  readonly cleanup: () => Promise<void>;
}

/** 用外部签名命令跑一次 `sign`；`signerKeyPair` 用于模拟「KMS 里的那把私钥」。 */
export async function runExternalSignWorkflow(
  options: { readonly publicKeyFrom: TestKeyPair; readonly signerKeyPair?: TestKeyPair } = {
    publicKeyFrom: makeTestKeyPair(),
  },
): Promise<ExternalSignWorkflow> {
  const directory = await makeTempDir();
  // 默认用同一把密钥签名与验签；传入另一把则用于模拟「KMS 与公钥不匹配」。
  const signerKeyPair = options.signerKeyPair ?? options.publicKeyFrom;
  const keyId = 'kms-key-2026a';
  const script = await makeExternalSigner(directory);
  const channel = 'K02_FIXTURE_PRIVATE_JWK';
  const previous = process.env[channel];
  process.env[channel] = JSON.stringify(signerKeyPair.privateJwk);
  try {
    const bodyPath = await writeJsonFile(join(directory, 'body.json'), makeBody());
    const publicKeysPath = await writeJsonFile(join(directory, 'public-keys.json'), {
      [keyId]: options.publicKeyFrom.publicJwk,
    });
    const envelopePath = join(directory, 'remote-config.json');
    const result = await run([
      'sign',
      '--body',
      bodyPath,
      '--sign-command',
      process.execPath,
      '--sign-arg',
      script,
      '--sign-arg',
      '--sign',
      '--key-id',
      keyId,
      '--public-key',
      publicKeysPath,
      '--out',
      envelopePath,
    ]);
    let envelope: Record<string, unknown> = {};
    if (result.code === 0) {
      envelope = (await readJsonFile(envelopePath)) as Record<string, unknown>;
    }
    return {
      directory,
      keyPair: signerKeyPair,
      result,
      envelope,
      cleanup: async () => {
        if (previous === undefined) Reflect.deleteProperty(process.env, channel);
        else process.env[channel] = previous;
        await removeTempDir(directory);
      },
    };
  } catch (error) {
    if (previous === undefined) Reflect.deleteProperty(process.env, channel);
    else process.env[channel] = previous;
    await removeTempDir(directory);
    throw error;
  }
}

/** 用准备好的工作流换一份新正文重新签名（供篡改类用例复用密钥）。 */
export async function signWithBody(
  workflow: K02Workflow,
  body: Record<string, unknown>,
  extraArgs: readonly string[] = [],
): Promise<{ readonly result: CliResult; readonly envelope: Record<string, unknown> }> {
  const bodyPath = await writeJsonFile(join(workflow.directory, 'body-2.json'), body);
  const out = join(workflow.directory, 'remote-config-2.json');
  const result = await runOk([
    'sign',
    '--body',
    bodyPath,
    '--private-key',
    workflow.privateKeyPath,
    '--key-id',
    'test-key-2026a',
    '--public-key',
    workflow.publicKeysPath,
    '--out',
    out,
    ...extraArgs,
  ]);
  return { result, envelope: (await readJsonFile(out)) as Record<string, unknown> };
}
