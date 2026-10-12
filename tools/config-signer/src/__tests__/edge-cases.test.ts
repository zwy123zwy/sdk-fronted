/**
 * 边界与错误分支补充用例（提高可靠性，不新增需求编号）。
 *
 * 覆盖正常路径之外的输入形态：`decoded_payload` 包装、`cases` 文档的非法形态、
 * 单 JWK 公钥文件、schema 路径解析、以及 CLI 顶层异常兜底。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeTempDir,
  makeTestKeyPair,
  removeTempDir,
  run,
  runFail,
  runOk,
  writeJsonFile,
  writeTextFile,
} from './test-support.js';
import { makeBody, runFullWorkflow } from './workflow.js';

describe('正文包装形态', () => {
  it('decoded_payload 包装：只校验 decoded_payload，并把 _note 作为提示', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(join(directory, 'wrapped.json'), {
        _note: '契约样例的说明',
        decoded_payload: makeBody(),
      });
      const result = await runOk(['validate', '--body', bodyPath]);
      expect(result.stdout).toContain('K02 validate 通过');
      expect(result.stdout).toContain('config_version=42');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('--previous 指向 decoded_payload 包装时也能取到 config_version（严格递增仍然生效）', async () => {
    const directory = await makeTempDir();
    try {
      const previous = await writeJsonFile(join(directory, 'previous.json'), {
        decoded_payload: makeBody({ config_version: 42 }),
      });
      const higher = await writeJsonFile(join(directory, 'higher.json'), makeBody({ config_version: 43 }));
      const passed = await runOk(['validate', '--body', higher, '--previous', previous]);
      expect(passed.stdout).toContain('42 → 43');

      const lower = await writeJsonFile(join(directory, 'lower.json'), makeBody({ config_version: 41 }));
      const failed = await runFail(['validate', '--body', lower, '--previous', previous]);
      expect(failed.code).toBe(1);

      // 真的缺 config_version 才算用法错误
      const empty = await writeJsonFile(join(directory, 'empty.json'), { decoded_payload: { app_id: 'demo-app' } });
      const missing = await runFail(['validate', '--body', higher, '--previous', empty]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('config_version');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('cases 文档：空数组属于用法错误', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(join(directory, 'empty.json'), { cases: [] });
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('/cases');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('cases 文档：元素不是对象时指出下标', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(join(directory, 'bad-case.json'), { cases: ['nope'] });
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('/cases/0');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('正文不是 JSON 对象（数组）时返回用法错误', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(join(directory, 'array.json'), [1, 2, 3]);
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('JSON 对象');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('cases 文档不能用于 sign', async () => {
    const directory = await makeTempDir();
    try {
      const workflow = await runFullWorkflow();
      try {
        const casesPath = await writeJsonFile(join(directory, 'cases.json'), {
          cases: [makeBody(), makeBody({ config_version: 43 })],
        });
        const result = await runFail([
          'sign',
          '--body',
          casesPath,
          '--private-key',
          workflow.privateKeyPath,
          '--key-id',
          'test-key-2026a',
        ]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('cases');
      } finally {
        await workflow.cleanup();
      }
    } finally {
      await removeTempDir(directory);
    }
  });
});

describe('公钥文件形态', () => {
  it('单个 JWK 需要 --key-id 才能使用', async () => {
    const workflow = await runFullWorkflow();
    try {
      const pair = makeTestKeyPair();
      const directory = await makeTempDir();
      try {
        const single = await writeJsonFile(join(directory, 'single.json'), pair.publicJwk);
        const missingId = await runFail([
          'verify',
          '--envelope',
          workflow.envelopePath,
          '--public-key',
          single,
        ]);
        expect(missingId.code).toBe(2);
        expect(missingId.stderr).toContain('--key-id');

        const wrongId = await runFail([
          'verify',
          '--envelope',
          workflow.envelopePath,
          '--public-key',
          single,
          '--key-id',
          'test-key-2026a',
        ]);
        expect(wrongId.code).toBe(1);
      } finally {
        await removeTempDir(directory);
      }
    } finally {
      await workflow.cleanup();
    }
  });

  it('公钥文件不是合法 JSON / 不是对象 / 为空都返回用法错误', async () => {
    const workflow = await runFullWorkflow();
    try {
      const directory = await makeTempDir();
      try {
        const notJson = await writeTextFile(join(directory, 'broken.json'), 'not json');
        const arrayFile = await writeJsonFile(join(directory, 'array.json'), [1]);
        const emptyFile = await writeJsonFile(join(directory, 'empty.json'), {});
        for (const path of [notJson, arrayFile, emptyFile]) {
          const result = await runFail(['verify', '--envelope', workflow.envelopePath, '--public-key', path]);
          expect(result.code).toBe(2);
        }
      } finally {
        await removeTempDir(directory);
      }
    } finally {
      await workflow.cleanup();
    }
  });

  it('公钥文件里某个 key_id 的 JWK 不可用时返回用法错误', async () => {
    const workflow = await runFullWorkflow();
    try {
      const directory = await makeTempDir();
      try {
        const path = await writeJsonFile(join(directory, 'bad-entry.json'), {
          'good-key': makeTestKeyPair().publicJwk,
          'bad-key': { kty: 'RSA', n: 'x', e: 'AQAB' },
        });
        const result = await runFail(['verify', '--envelope', workflow.envelopePath, '--public-key', path]);
        expect(result.code).toBe(2);
      } finally {
        await removeTempDir(directory);
      }
    } finally {
      await workflow.cleanup();
    }
  });
});

describe('sign 的 key_id 与公钥要求', () => {
  it('--key-id 缺失或非法时返回用法错误', async () => {
    const workflow = await runFullWorkflow();
    try {
      const withoutKeyId = await runFail([
        'sign',
        '--body',
        workflow.bodyPath,
        '--private-key',
        workflow.privateKeyPath,
      ]);
      expect(withoutKeyId.code).toBe(2);
      expect(withoutKeyId.stderr).toContain('--key-id');

      const badKeyId = await runFail([
        'sign',
        '--body',
        workflow.bodyPath,
        '--private-key',
        workflow.privateKeyPath,
        '--key-id',
        'bad key id!',
        '--public-key',
        workflow.publicKeysPath,
      ]);
      expect(badKeyId.code).toBe(2);
      expect(badKeyId.stderr).toContain('--key-id');
    } finally {
      await workflow.cleanup();
    }
  });

  it('--public-key 里没有指定 key_id 时返回用法错误', async () => {
    const workflow = await runFullWorkflow();
    try {
      const directory = await makeTempDir();
      try {
        const other = await writeJsonFile(join(directory, 'other.json'), {
          'other-key': makeTestKeyPair().publicJwk,
        });
        const result = await runFail([
          'sign',
          '--body',
          workflow.bodyPath,
          '--private-key',
          workflow.privateKeyPath,
          '--key-id',
          'test-key-2026a',
          '--public-key',
          other,
        ]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('key_id=test-key-2026a');
      } finally {
        await removeTempDir(directory);
      }
    } finally {
      await workflow.cleanup();
    }
  });

  it('不给 --public-key 时从本地私钥推导公钥做自检', async () => {
    const workflow = await runFullWorkflow();
    try {
      const directory = await makeTempDir();
      try {
        const out = join(directory, 'derived.json');
        await runOk([
          'sign',
          '--body',
          workflow.bodyPath,
          '--private-key',
          workflow.privateKeyPath,
          '--key-id',
          'test-key-2026a',
          '--out',
          out,
        ]);
        const verify = await runOk(['verify', '--envelope', out, '--public-key', workflow.publicKeysPath]);
        expect(verify.stdout).toContain('K02 verify 通过');
      } finally {
        await removeTempDir(directory);
      }
    } finally {
      await workflow.cleanup();
    }
  });
});

describe('通过 stdin 读取正文', () => {
  it('缺少 --body 与 --envelope 时的用法错误', async () => {
    const sign = await runFail(['sign']);
    expect(sign.code).toBe(2);
    const verify = await runFail(['verify']);
    expect(verify.code).toBe(2);
  });
});

describe('CLI 顶层兜底', () => {
  it('help 输出含全部子命令与关键选项', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    for (const token of ['validate', 'sign', 'verify', 'keygen', '--previous', '--allow-token-path', '--sign-command']) {
      expect(help.stdout).toContain(token);
    }
  });

  it('位置参数多余时报用法错误', async () => {
    const result = await runFail(['validate', 'sign']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('多余的位置参数');
  });

  it('未知参数在子命令之后也会被拦下', async () => {
    const result = await runFail(['keygen', '--nope']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('未知参数');
  });
});
