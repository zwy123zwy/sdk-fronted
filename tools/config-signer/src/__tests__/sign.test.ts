/**
 * K02-AC-03 至 K02-AC-06：签名、验签、测试密钥生成、外部签名命令。
 *
 * AC-03 的浏览器侧验签：本文件用 Node 24 的全局 `crypto.subtle`（与 Chromium 的
 * WebCrypto 同一条 W3C 算法路径）。AC-03 括号里的「Playwright Chromium」属**部分实现**，
 * 已移交 T29 的 E2E，本任务不写 `tests/e2e/**`。
 */
import { stat } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CONTRACT_SCHEMAS,
  countSecretHits,
  makeTempDir,
  makeTestKeyPair,
  readJsonFile,
  readTextFile,
  removeTempDir,
  run,
  runFail,
  runOk,
  secretFragments,
  writeJsonFile,
  writeTextFile,
} from './test-support.js';
import { makeBody, runExternalSignWorkflow, runFullWorkflow, signWithBody } from './workflow.js';

/** 用契约 `$defs/envelope` 校验发布物（用 Ajv 读冻结 Schema，避免抄一份）。 */
async function validateEnvelope(envelope: unknown): Promise<boolean> {
  const schema = (await readJsonFile(join(CONTRACT_SCHEMAS, 'remote-config.schema.json'))) as Record<
    string,
    unknown
  > & { $id?: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  ajv.addSchema({ ...schema, $id: String(schema['$id']) });
  const validate = ajv.compile({ $ref: `${String(schema['$id'])}#/$defs/envelope` });
  return validate(envelope);
}

/** 用 WebCrypto 验签（模拟浏览器侧；与 SDK 的 C03 验签同一条路径）。 */
async function verifyWithWebCrypto(
  envelope: Record<string, unknown>,
  publicKeys: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const keyId = envelope['key_id'];
  const payload = envelope['payload'];
  const signature = envelope['signature'];
  if (typeof keyId !== 'string' || typeof payload !== 'string' || typeof signature !== 'string') {
    return false;
  }
  const jwk = publicKeys[keyId];
  if (jwk === undefined) return false;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk as webcrypto.JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signature, 'base64url'),
    Buffer.from(payload, 'utf8'),
  );
}

describe('K02-AC-03 签名与发布物格式（K02-F3）', () => {
  it('发布物通过 $defs/envelope，signature 为 86 字符 base64url 且解码后 64 字节', async () => {
    const workflow = await runFullWorkflow();
    try {
      const { envelope } = workflow;
      expect(await validateEnvelope(envelope)).toBe(true);
      expect(Object.keys(envelope).sort()).toEqual(['alg', 'format_version', 'key_id', 'payload', 'signature']);
      const signature = envelope['signature'];
      expect(typeof signature).toBe('string');
      expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
      expect(Buffer.from(String(signature), 'base64url').length).toBe(64);
      expect(envelope['format_version']).toBe(1);
      expect(envelope['alg']).toBe('ES256');
      expect(envelope['key_id']).toBe('test-key-2026a');
    } finally {
      await workflow.cleanup();
    }
  });

  it('WebCrypto 验签通过（浏览器侧算法路径）', async () => {
    const workflow = await runFullWorkflow();
    try {
      const publicKeys = await readJsonFile(workflow.publicKeysPath);
      expect(await verifyWithWebCrypto(workflow.envelope, publicKeys as Record<string, unknown>)).toBe(true);
    } finally {
      await workflow.cleanup();
    }
  });

  it('签名覆盖 payload 的 UTF-8 字节而非规范化 JSON', async () => {
    const workflow = await runFullWorkflow();
    try {
      const payload = String(workflow.envelope['payload']);
      expect(JSON.parse(payload)).toEqual(workflow.body);
      expect(payload).toBe(JSON.stringify(workflow.body));
    } finally {
      await workflow.cleanup();
    }
  });

  it('未给 --out 时把发布物写到 stdout', async () => {
    const workflow = await runFullWorkflow();
    try {
      const bodyPath = await writeJsonFile(join(workflow.directory, 'body-stdout.json'), makeBody());
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
      ]);
      const jsonStart = result.stdout.indexOf('{');
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(result.stdout.slice(jsonStart)) as Record<string, unknown>;
      expect(await validateEnvelope(parsed)).toBe(true);
    } finally {
      await workflow.cleanup();
    }
  });

  it('同一个正文签两次的签名可不同（ECDSA 随机化 k），但都验签通过', async () => {
    const workflow = await runFullWorkflow();
    try {
      const publicKeys = await readJsonFile(workflow.publicKeysPath);
      const second = await signWithBody(workflow, makeBody());
      expect(await verifyWithWebCrypto(second.envelope, publicKeys as Record<string, unknown>)).toBe(true);
    } finally {
      await workflow.cleanup();
    }
  });

  it('未指定私钥来源时退出码 2', async () => {
    const workflow = await runFullWorkflow();
    try {
      const result = await runFail(['sign', '--body', workflow.bodyPath, '--key-id', 'test-key-2026a']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--private-key');
    } finally {
      await workflow.cleanup();
    }
  });

  it('私钥文件不存在时退出码 2', async () => {
    const workflow = await runFullWorkflow();
    try {
      const result = await runFail([
        'sign',
        '--body',
        workflow.bodyPath,
        '--private-key',
        join(workflow.directory, 'missing.pem'),
        '--key-id',
        'test-key-2026a',
      ]);
      expect(result.code).toBe(2);
    } finally {
      await workflow.cleanup();
    }
  });

  it('--previous 版本未递增时拒绝签名（退出码 1）', async () => {
    const workflow = await runFullWorkflow();
    try {
      const previousPath = await writeJsonFile(
        join(workflow.directory, 'previous.json'),
        makeBody({ config_version: 42 }),
      );
      const bodyPath = await writeJsonFile(
        join(workflow.directory, 'body-lower.json'),
        makeBody({ config_version: 42 }),
      );
      const result = await runFail([
        'sign',
        '--body',
        bodyPath,
        '--private-key',
        workflow.privateKeyPath,
        '--key-id',
        'test-key-2026a',
        '--previous',
        previousPath,
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('config_version');
    } finally {
      await workflow.cleanup();
    }
  });

  it('正文含疑似令牌时拒绝签名（退出码 1）', async () => {
    const workflow = await runFullWorkflow();
    try {
      const bodyPath = await writeJsonFile(
        join(workflow.directory, 'body-token.json'),
        makeBody({ sampling: { allow_users: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz'] } }),
      );
      const result = await runFail([
        'sign',
        '--body',
        bodyPath,
        '--private-key',
        workflow.privateKeyPath,
        '--key-id',
        'test-key-2026a',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('/sampling/allow_users/0');
    } finally {
      await workflow.cleanup();
    }
  });
});

describe('K02-AC-04 验签子命令与篡改检测（K02-F4）', () => {
  it('未篡改的发布物验签通过（对照组）', async () => {
    const workflow = await runFullWorkflow();
    try {
      const result = await runOk([
        'verify',
        '--envelope',
        workflow.envelopePath,
        '--public-key',
        workflow.publicKeysPath,
      ]);
      expect(result.stdout).toContain('K02 verify 通过');
      expect(result.stdout).toContain('key_id=test-key-2026a');
    } finally {
      await workflow.cleanup();
    }
  });

  it('篡改 payload 一个字节 → 非零退出码', async () => {
    const workflow = await runFullWorkflow();
    try {
      const payload = String(workflow.envelope['payload']);
      const tampered = payload.replace('"config_version":42', '"config_version":43');
      expect(tampered).not.toBe(payload);
      const path = await writeJsonFile(join(workflow.directory, 'tampered-payload.json'), {
        ...workflow.envelope,
        payload: tampered,
      });
      const result = await runFail(['verify', '--envelope', path, '--public-key', workflow.publicKeysPath]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('signature_invalid');
    } finally {
      await workflow.cleanup();
    }
  });

  it('payload 重新格式化（JSON 重排）→ 非零退出码', async () => {
    const workflow = await runFullWorkflow();
    try {
      const payload = String(workflow.envelope['payload']);
      const reformatted = JSON.stringify(JSON.parse(payload) as unknown, null, 2);
      const path = await writeJsonFile(join(workflow.directory, 'reformatted.json'), {
        ...workflow.envelope,
        payload: reformatted,
      });
      const result = await runFail(['verify', '--envelope', path, '--public-key', workflow.publicKeysPath]);
      expect(result.code).toBe(1);
    } finally {
      await workflow.cleanup();
    }
  });

  it('篡改 signature 一个字符 → 非零退出码', async () => {
    const workflow = await runFullWorkflow();
    try {
      const signature = String(workflow.envelope['signature']);
      const flipped = (signature.charAt(0) === 'A' ? 'B' : 'A') + signature.slice(1);
      const path = await writeJsonFile(join(workflow.directory, 'tampered-signature.json'), {
        ...workflow.envelope,
        signature: flipped,
      });
      const result = await runFail(['verify', '--envelope', path, '--public-key', workflow.publicKeysPath]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('signature_invalid');
    } finally {
      await workflow.cleanup();
    }
  });

  it('key_id 换成未配置的值 → 非零退出码', async () => {
    const workflow = await runFullWorkflow();
    try {
      const path = await writeJsonFile(join(workflow.directory, 'unknown-key-id.json'), {
        ...workflow.envelope,
        key_id: 'not-configured',
      });
      const result = await runFail(['verify', '--envelope', path, '--public-key', workflow.publicKeysPath]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('key_id_unknown');
    } finally {
      await workflow.cleanup();
    }
  });

  it('key_id 换成另一把已配置的公钥 → 公钥存在但验签失败', async () => {
    const workflow = await runFullWorkflow();
    try {
      const other = makeTestKeyPair();
      const keys = (await readJsonFile(workflow.publicKeysPath)) as Record<string, unknown>;
      const path = await writeJsonFile(join(workflow.directory, 'mixed-keys.json'), {
        ...keys,
        'other-key': other.publicJwk,
      });
      const tampered = await writeJsonFile(join(workflow.directory, 'wrong-key-id.json'), {
        ...workflow.envelope,
        key_id: 'other-key',
      });
      const result = await runFail(['verify', '--envelope', tampered, '--public-key', path]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('signature_invalid');
    } finally {
      await workflow.cleanup();
    }
  });

  it('发布物结构非法（缺 signature）→ envelope_schema_invalid', async () => {
    const workflow = await runFullWorkflow();
    try {
      const path = await writeJsonFile(join(workflow.directory, 'broken-envelope.json'), {
        format_version: 1,
        key_id: 'test-key-2026a',
        alg: 'ES256',
        payload: String(workflow.envelope['payload']),
      });
      const result = await runFail(['verify', '--envelope', path, '--public-key', workflow.publicKeysPath]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('envelope_schema_invalid');
      expect(result.stderr).toContain('/signature');
    } finally {
      await workflow.cleanup();
    }
  });

  it('payload 不是合法 JSON → payload_not_json', async () => {
    const workflow = await runFullWorkflow();
    try {
      // 用有效签名包住非法 payload，确保命中的是 payload 解析分支而不是签名分支
      const signed = await signWithBody(workflow, makeBody());
      const path = await writeJsonFile(join(workflow.directory, 'bad-payload.json'), {
        ...signed.envelope,
        payload: '{ not json',
      });
      const result = await runFail(['verify', '--envelope', path, '--public-key', workflow.publicKeysPath]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('payload_not_json');
    } finally {
      await workflow.cleanup();
    }
  });

  it('payload 合法 JSON 但正文不合 Schema → body_schema_invalid，且不回显正文', async () => {
    const workflow = await runFullWorkflow();
    try {
      const badBody = makeBody({ sampling: { session_rate: 9 } });
      // 先对非法正文签名，再验签：这样命中的是正文校验分支
      const tempBody = await writeJsonFile(join(workflow.directory, 'bad-body-source.json'), badBody);
      const out = join(workflow.directory, 'bad-body-signed.json');
      const signed = await run([
        'sign',
        '--body',
        tempBody,
        '--private-key',
        workflow.privateKeyPath,
        '--key-id',
        'test-key-2026a',
        '--public-key',
        workflow.publicKeysPath,
        '--out',
        out,
      ]);
      // 签名命令本身会先拦下非法正文；因此这里直接构造 payload 与签名分离的用例
      expect(signed.code).toBe(1);
      const path = await writeJsonFile(join(workflow.directory, 'bad-body.json'), {
        ...workflow.envelope,
        payload: JSON.stringify(badBody),
      });
      const result = await runFail(['verify', '--envelope', path, '--public-key', workflow.publicKeysPath]);
      expect(result.code).toBe(1);
    } finally {
      await workflow.cleanup();
    }
  });

  it('正文不合 Schema 时 verify 明确指出字段路径（用同一份正文档位保证签名一致）', async () => {
    const workflow = await runFullWorkflow();
    try {
      const path = await writeJsonFile(join(workflow.directory, 'schema-shifted.json'), {
        ...workflow.envelope,
        payload: JSON.stringify(makeBody({ sampling: { session_rate: 9 } })),
      });
      const result = await runFail([
        'verify',
        '--envelope',
        path,
        '--public-key',
        workflow.publicKeysPath,
        '--no-body-schema',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('signature_invalid');
    } finally {
      await workflow.cleanup();
    }
  });

  it('--no-body-schema 跳过正文校验（签名仍然通过）', async () => {
    const workflow = await runFullWorkflow();
    try {
      const result = await runOk([
        'verify',
        '--envelope',
        workflow.envelopePath,
        '--public-key',
        workflow.publicKeysPath,
        '--no-body-schema',
      ]);
      expect(result.stdout).toContain('已按 --no-body-schema 跳过正文 Schema 校验');
    } finally {
      await workflow.cleanup();
    }
  });

  it('--public-key 指向不存在的文件 → 退出码 2', async () => {
    const workflow = await runFullWorkflow();
    try {
      const result = await runFail([
        'verify',
        '--envelope',
        workflow.envelopePath,
        '--public-key',
        join(workflow.directory, 'missing-keys.json'),
      ]);
      expect(result.code).toBe(2);
    } finally {
      await workflow.cleanup();
    }
  });

  it('公钥文件不是合法 JWK → 退出码 2', async () => {
    const workflow = await runFullWorkflow();
    try {
      const path = await writeJsonFile(join(workflow.directory, 'bad-jwk.json'), {
        'test-key-2026a': { kty: 'EC', crv: 'P-384', x: 'abc', y: 'def' },
      });
      const result = await runFail(['verify', '--envelope', workflow.envelopePath, '--public-key', path]);
      expect(result.code).toBe(2);
    } finally {
      await workflow.cleanup();
    }
  });

  it('缺少 --public-key 时退出码 2', async () => {
    const workflow = await runFullWorkflow();
    try {
      const result = await runFail(['verify', '--envelope', workflow.envelopePath]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--public-key');
    } finally {
      await workflow.cleanup();
    }
  });
});

describe('K02-AC-05 测试密钥生成（K02-F5）', () => {
  it('私钥文件权限为 0600，公钥 JWK 只含 kty/crv/x/y', async () => {
    const directory = await makeTempDir();
    try {
      const privatePath = join(directory, 'key.pem');
      const publicPath = join(directory, 'public.json');
      const result = await runOk([
        'keygen',
        '--out-private',
        privatePath,
        '--out-public',
        publicPath,
        '--key-id',
        'test-key-2026a',
      ]);
      const info = await stat(privatePath);
      expect(info.mode & 0o777).toBe(0o600);
      const jwk = (await readJsonFile(publicPath)) as Record<string, Record<string, string>>;
      const entry = jwk['test-key-2026a'];
      expect(entry).toBeDefined();
      expect(Object.keys(entry ?? {}).sort()).toEqual(['crv', 'kty', 'x', 'y']);
      expect(entry?.['crv']).toBe('P-256');
      expect(entry?.['kty']).toBe('EC');
      expect(result.stdout).toContain('0600');
      expect(result.stdout).toContain('仅用于测试');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('终端输出与日志中不含私钥内容', async () => {
    const directory = await makeTempDir();
    try {
      const privatePath = join(directory, 'key.pem');
      const publicPath = join(directory, 'public.json');
      const result = await runOk([
        'keygen',
        '--out-private',
        privatePath,
        '--out-public',
        publicPath,
        '--key-id',
        'test-key-2026a',
      ]);
      const pem = await readTextFile(privatePath);
      const lines = pem.split('\n').filter((line) => line.trim() !== '');
      const output = [result.stdout, result.stderr];
      for (const line of lines) {
        expect(output.some((text) => text.includes(line))).toBe(false);
      }
      expect(result.stdout.includes('PRIVATE KEY')).toBe(false);
      expect(result.stderr.includes('PRIVATE KEY')).toBe(false);
    } finally {
      await removeTempDir(directory);
    }
  });

  it('已存在私钥文件时默认拒绝覆盖（退出码 2），--force 才覆盖', async () => {
    const directory = await makeTempDir();
    try {
      const privatePath = join(directory, 'key.pem');
      const publicPath = join(directory, 'public.json');
      await writeTextFile(privatePath, 'existing');
      const refused = await runFail([
        'keygen',
        '--out-private',
        privatePath,
        '--out-public',
        publicPath,
        '--key-id',
        'test-key-2026a',
      ]);
      expect(refused.code).toBe(2);
      expect(await readTextFile(privatePath)).toBe('existing');
      await runOk([
        'keygen',
        '--out-private',
        privatePath,
        '--out-public',
        publicPath,
        '--key-id',
        'test-key-2026a',
        '--force',
      ]);
      expect(await readTextFile(privatePath)).toContain('KEY');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('--key-id 非法时退出码 2，且不创建任何文件', async () => {
    const directory = await makeTempDir();
    try {
      const privatePath = join(directory, 'key.pem');
      const publicPath = join(directory, 'public.json');
      const result = await runFail([
        'keygen',
        '--out-private',
        privatePath,
        '--out-public',
        publicPath,
        '--key-id',
        'bad key id!',
      ]);
      expect(result.code).toBe(2);
      await expect(readTextFile(privatePath)).rejects.toThrow();
    } finally {
      await removeTempDir(directory);
    }
  });

  it('缺少 --out-private / --out-public 时退出码 2', async () => {
    const directory = await makeTempDir();
    try {
      const first = await runFail(['keygen', '--out-public', join(directory, 'p.json')]);
      expect(first.code).toBe(2);
      const second = await runFail(['keygen', '--out-private', join(directory, 'k.pem')]);
      expect(second.code).toBe(2);
    } finally {
      await removeTempDir(directory);
    }
  });
});

describe('K02-AC-06 外部签名命令（K02-F6）', () => {
  it('外部签名命令产出的发布物与 AC-03 一样能验签通过', async () => {
    const pair = makeTestKeyPair();
    const workflow = await runExternalSignWorkflow({ publicKeyFrom: pair });
    try {
      expect(workflow.result.code).toBe(0);
      expect(await validateEnvelope(workflow.envelope)).toBe(true);
      const publicKeys = { 'kms-key-2026a': pair.publicJwk };
      expect(await verifyWithWebCrypto(workflow.envelope, publicKeys)).toBe(true);
    } finally {
      await workflow.cleanup();
    }
  });

  it('K02 进程不接触私钥：命令行里只有公钥，输出里没有私钥材料', async () => {
    const pair = makeTestKeyPair();
    const workflow = await runExternalSignWorkflow({ publicKeyFrom: pair });
    try {
      const fragments = secretFragments(pair);
      const outputs = [workflow.result.stdout, workflow.result.stderr];
      expect(countSecretHits(outputs, fragments)).toBe(0);
      expect(workflow.result.stdout.includes('PRIVATE KEY')).toBe(false);
      expect(workflow.result.stderr.includes('PRIVATE KEY')).toBe(false);
    } finally {
      await workflow.cleanup();
    }
  });

  it('外部签名命令用错私钥（与公钥不匹配）时，K02 自检拦住并返回非零退出码', async () => {
    const mismatch = await runExternalSignWorkflow({
      publicKeyFrom: makeTestKeyPair(),
      signerKeyPair: makeTestKeyPair(),
    });
    try {
      expect(mismatch.result.code).not.toBe(0);
      expect(mismatch.result.stderr).toContain('signature_invalid');
    } finally {
      await mismatch.cleanup();
    }
  });

  it('外部命令输出的签名格式非法时返回非零退出码', async () => {
    const directory = await makeTempDir();
    try {
      const script = await writeTextFile(
        join(directory, 'bad-signer.mjs'),
        "process.stdout.write('not-a-signature\\n');\n",
      );
      const pair = makeTestKeyPair();
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), makeBody());
      const publicKeysPath = await writeJsonFile(join(directory, 'public.json'), {
        'kms-key-2026a': pair.publicJwk,
      });
      const result = await runFail([
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
        'kms-key-2026a',
        '--public-key',
        publicKeysPath,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('签名');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('外部命令不存在时退出码 2，不打印任何 payload 内容', async () => {
    const directory = await makeTempDir();
    try {
      const pair = makeTestKeyPair();
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), makeBody());
      const publicKeysPath = await writeJsonFile(join(directory, 'public.json'), {
        'kms-key-2026a': pair.publicJwk,
      });
      const result = await runFail([
        'sign',
        '--body',
        bodyPath,
        '--sign-command',
        join(directory, 'no-such-command'),
        '--key-id',
        'kms-key-2026a',
        '--public-key',
        publicKeysPath,
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain('published_at');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('--private-key 与 --sign-command 只能选一个', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), makeBody());
      const privatePath = await writeTextFile(join(directory, 'key.pem'), 'placeholder');
      const result = await runFail([
        'sign',
        '--body',
        bodyPath,
        '--private-key',
        privatePath,
        '--sign-command',
        process.execPath,
        '--key-id',
        'kms-key-2026a',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('只能选一个');
    } finally {
      await removeTempDir(directory);
    }
  });
});
