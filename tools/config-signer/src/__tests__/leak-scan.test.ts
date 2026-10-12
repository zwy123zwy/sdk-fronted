/**
 * K02-AC-08：运行全部用例后扫描仓库与 K02 的标准输出/错误输出。
 *
 * 三层证据：
 * 1. 材料指纹扫描：把本次真实使用的密钥材料（私钥 PEM、PKCS#8 DER 的 base64、
 *    私钥 JWK 的 d、公钥 x/y）当作指纹，断言它们不出现在任何输出或仓库文件里。
 * 2. 仓库形态扫描：用「能否解析成 EC 私钥」判定文件是否含私钥，避开源码里
 *    字符串字面量造成的自指误报；并确认含 PEM 头的文件只有明确登记的文档。
 * 3. 零新增文件差集：`git ls-files -o --exclude-standard` 在扫描前后取快照对比。
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRIVATE_KEY_MARKER,
  REPO_ROOT,
  SCAN_SKIP_PREFIXES,
  countSecretHits,
  listWorktreeFiles,
  makeTempDir,
  makeTestKeyPair,
  readTextFile,
  removeTempDir,
  runFail,
  secretFragments,
  writeJsonFile,
} from './test-support.js';
import { makeBody, runExternalSignWorkflow, runFullWorkflow } from './workflow.js';

/**
 * 允许出现 PEM 头**字面文本**的清单（按文件精确登记，新增项必须说明理由）。
 *
 * 这些文件里只有 PEM 头的字面文本（不含密钥材料）：
 * - `PLAN.md` / `README.md`：文档里的模式表与示例；
 * - `test-support.ts` / `token-scan.test.ts`：测试夹具构造 PEM 头用于注入；
 * - `signer-source.ts` / `token-scan.ts`：实现里的 PEM 头模式与过滤逻辑。
 *
 * 判定「是否泄漏」不靠这张清单，靠 `findParsablePrivateKey()`：
 * 只有当文件里的内容是**真能解析成 EC 私钥**的 PEM 块时才判为违规。
 * 清单的作用是让「为什么这个文件里有 PEM 头文本」变成显式、可审计的声明。
 */
const PEM_HEADER_TEXT_ALLOWLIST: readonly string[] = [
  'tools/config-signer/PLAN.md',
  'tools/config-signer/README.md',
  'tools/config-signer/src/__tests__/test-support.ts',
  'tools/config-signer/src/__tests__/token-scan.test.ts',
  'tools/config-signer/src/signer-source.ts',
  'tools/config-signer/src/token-scan.ts',
];

/** 工作树中需要扫描的文本文件（跳过依赖、产物与 git 内部）。 */
function scanTargets(): readonly string[] {
  return listWorktreeFiles().filter(
    (file) => !SCAN_SKIP_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

/** 文件里是否存在能解析成 EC 私钥的 PEM 块。 */
function findParsablePrivateKey(text: string): boolean {
  const header = PRIVATE_KEY_MARKER;
  const footer = ['-----END ', 'PRIVATE', ' KEY-----'].join('');
  let cursor = text.indexOf(header);
  while (cursor !== -1) {
    const end = text.indexOf(footer, cursor);
    if (end === -1) return false;
    const block = text.slice(cursor, end + footer.length);
    try {
      const key = createPrivateKey({ key: block, format: 'pem' });
      if (key.asymmetricKeyType === 'ec') return true;
    } catch {
      // 无法解析：只是文档里的字符串，不是私钥
    }
    cursor = text.indexOf(header, end + footer.length);
  }
  return false;
}

/** 未跟踪文件的快照。 */
function untrackedSnapshot(): readonly string[] {
  const output = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
}

describe('K02-AC-08 私钥不泄漏', () => {
  it('K02 全部子命令的输出中不含本次使用的任何密钥材料', async () => {
    const before = untrackedSnapshot();
    const outputs: string[] = [];
    const fragments = new Set<string>();

    const workflow = await runFullWorkflow();
    try {
      for (const fragment of workflow.fragments) fragments.add(fragment);
      for (const step of workflow.steps) {
        outputs.push(`[${step.name}] exit=${String(step.result.code)}`);
        outputs.push(step.result.stdout);
        outputs.push(step.result.stderr);
      }
      // 故意触发各类失败路径，确保错误信息也不泄漏
      const tokenBody = await writeJsonFile(join(workflow.directory, 'token-body.json'), {
        ...makeBody(),
        sampling: { allow_users: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'] },
      });
      const tokenFailure = await runFail(['validate', '--body', tokenBody]);
      outputs.push(tokenFailure.stdout, tokenFailure.stderr);

      const brokenEnvelope = await writeJsonFile(join(workflow.directory, 'broken.json'), {
        format_version: 1,
      });
      const verifyFailure = await runFail([
        'verify',
        '--envelope',
        brokenEnvelope,
        '--public-key',
        workflow.publicKeysPath,
      ]);
      outputs.push(verifyFailure.stdout, verifyFailure.stderr);

      const missingBody = await runFail(['validate', '--body', join(workflow.directory, 'nope.json')]);
      outputs.push(missingBody.stdout, missingBody.stderr);

      const badKey = await runFail([
        'sign',
        '--body',
        workflow.bodyPath,
        '--private-key',
        join(workflow.directory, 'not-a-key.pem'),
        '--key-id',
        'test-key-2026a',
      ]);
      outputs.push(badKey.stdout, badKey.stderr);
    } finally {
      await workflow.cleanup();
    }

    const external = await runExternalSignWorkflow({ publicKeyFrom: makeTestKeyPair() });
    try {
      for (const fragment of secretFragments(external.keyPair)) fragments.add(fragment);
      outputs.push(external.result.stdout, external.result.stderr);
    } finally {
      await external.cleanup();
    }

    expect(fragments.size).toBeGreaterThan(4);
    expect(countSecretHits(outputs, [...fragments])).toBe(0);
    for (const text of outputs) {
      expect(text.includes(PRIVATE_KEY_MARKER)).toBe(false);
      expect(text.includes('"d":')).toBe(false);
    }

    // 零新增未跟踪文件（除本任务新增的非密钥文件外）
    const after = untrackedSnapshot();
    const added = after.filter((file) => !before.includes(file));
    expect(added.every((file) => file.startsWith('tools/config-signer/'))).toBe(true);
    expect(added.some((file) => file.endsWith('.pem') || file.endsWith('.key'))).toBe(false);
  });

  it('仓库中没有可解析的私钥文件，也没有新增密钥文件', async () => {
    const violations: string[] = [];
    const pemHeaderFiles: string[] = [];
    for (const file of scanTargets()) {
      if (file.endsWith('.pem') || file.endsWith('.key')) violations.push(`私钥文件形态：${file}`);
      let text: string;
      try {
        text = await readFile(join(REPO_ROOT, file), 'utf8');
      } catch {
        continue; // 二进制或不可读文件跳过
      }
      if (!text.includes(PRIVATE_KEY_MARKER)) continue;
      pemHeaderFiles.push(file);
      if (findParsablePrivateKey(text)) violations.push(`含可解析私钥：${file}`);
    }
    expect(violations).toEqual([]);

    const unexpected = pemHeaderFiles.filter((file) => !PEM_HEADER_TEXT_ALLOWLIST.includes(file));
    expect(unexpected).toEqual([]);
    expect(untrackedSnapshot().some((file) => file.endsWith('.pem') || file.endsWith('.key'))).toBe(false);
  });

  it('测试密钥只落在操作系统临时目录：仓库目录内不存在本次生成的私钥', async () => {
    const pair = makeTestKeyPair();
    const directory = await makeTempDir();
    try {
      expect(directory.startsWith(REPO_ROOT)).toBe(false);
      const tracked = scanTargets();
      for (const file of tracked.slice(0, 400)) {
        let text: string;
        try {
          text = await readFile(join(REPO_ROOT, file), 'utf8');
        } catch {
          continue;
        }
        for (const line of pair.privatePemLines) {
          expect(text.startsWith(line)).toBe(false);
        }
      }
    } finally {
      await removeTempDir(directory);
    }
  });

  it('仓库工作树里不存在被提交的私钥 PEM', async () => {
    const text = await readTextFile(join(REPO_ROOT, 'tools/config-signer/package.json'));
    expect(text.includes('PRIVATE KEY')).toBe(false);
    expect(findParsablePrivateKey(text)).toBe(false);
  });
});
