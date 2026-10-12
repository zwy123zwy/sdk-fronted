/**
 * K02-AC-02：`config_version` 必须严格大于上一份发布物（K02-F2）。
 */
import { describe, expect, it } from 'vitest';
import {
  INVALID_SAMPLE,
  VALID_SAMPLE,
  makeTempDir,
  run,
  readJsonFile,
  removeTempDir,
  runFail,
  runOk,
  writeJsonFile,
  writeTextFile,
} from './test-support.js';
import { makeBody } from './workflow.js';

describe('K02-AC-02 config_version 单调递增', () => {
  it('上一份为 42 → 42、41 非零退出码，43 通过', async () => {
    const directory = await makeTempDir();
    try {
      const previousPath = await writeJsonFile(`${directory}/previous.json`, makeBody({ config_version: 42 }));
      const expectations: readonly { readonly version: number; readonly ok: boolean }[] = [
        { version: 42, ok: false },
        { version: 41, ok: false },
        { version: 43, ok: true },
      ];
      for (const { version, ok } of expectations) {
        const bodyPath = await writeJsonFile(
          `${directory}/body-${String(version)}.json`,
          makeBody({ config_version: version }),
        );
        const result = await run(['validate', '--body', bodyPath, '--previous', previousPath]);
        if (ok) {
          expect(result.code, `config_version ${String(version)} 应通过：${result.stderr}`).toBe(0);
          continue;
        }
        expect(result.code, `config_version ${String(version)} 应失败`).toBe(1);
        expect(result.stderr).toContain('config_version');
        expect(result.stderr).toContain('42');
        expect(result.stderr).toContain(String(version));
      }
    } finally {
      await removeTempDir(directory);
    }
  });

  it('上一份发布物是 K02 的 envelope 时，从 payload 里取 config_version', async () => {
    const directory = await makeTempDir();
    try {
      const previousBody = makeBody({ config_version: 10 });
      const previousPath = await writeJsonFile(`${directory}/previous-envelope.json`, {
        format_version: 1,
        key_id: 'test-key-2026a',
        alg: 'ES256',
        payload: JSON.stringify(previousBody),
        signature: 'A'.repeat(86),
      });
      const newer = await writeJsonFile(`${directory}/newer.json`, makeBody({ config_version: 11 }));
      await runOk(['validate', '--body', newer, '--previous', previousPath]);
      const same = await writeJsonFile(`${directory}/same.json`, makeBody({ config_version: 10 }));
      const failed = await runFail(['validate', '--body', same, '--previous', previousPath]);
      expect(failed.code).toBe(1);
    } finally {
      await removeTempDir(directory);
    }
  });

  it('上一份发布物是契约样例的 {decoded_payload} 包装时也能取到 config_version（返工 2）', async () => {
    const directory = await makeTempDir();
    try {
      const previousPath = await writeJsonFile(`${directory}/previous-wrapped.json`, {
        _note: '契约样例结构',
        decoded_payload: makeBody({ config_version: 42 }),
      });
      const newer = await writeJsonFile(`${directory}/newer.json`, makeBody({ config_version: 43 }));
      const passed = await runOk(['validate', '--body', newer, '--previous', previousPath]);
      expect(passed.stdout).toContain('config_version 递增检查通过：42 → 43');

      const same = await writeJsonFile(`${directory}/same.json`, makeBody({ config_version: 42 }));
      const failed = await runFail(['validate', '--body', same, '--previous', previousPath]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain('42');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('仓库自带样例 docs/contracts/examples/remote-config.valid.json 可直接做 --previous', async () => {
    // 这是返工 2 的动机：用户拿仓库自带样例做 --previous 不应莫名失败
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(`${directory}/body.json`, makeBody({ config_version: 43 }));
      const result = await runOk(['validate', '--body', bodyPath, '--previous', VALID_SAMPLE]);
      expect(result.stdout).toContain('递增检查通过');
      expect(result.stdout).toContain('42');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('上一份发布物缺 config_version 时按环境错误处理（退出码 2）', async () => {
    const directory = await makeTempDir();
    try {
      const previousPath = await writeJsonFile(`${directory}/previous.json`, {
        format_version: 1,
        app_id: 'demo-app',
      });
      const bodyPath = await writeJsonFile(`${directory}/body.json`, makeBody({ config_version: 43 }));
      const result = await runFail(['validate', '--body', bodyPath, '--previous', previousPath]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('config_version');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('上一份发布物不是合法 JSON 时按环境错误处理（退出码 2）', async () => {
    const directory = await makeTempDir();
    try {
      const previousPath = await writeTextFile(`${directory}/previous.json`, 'not json');
      const bodyPath = await writeJsonFile(`${directory}/body.json`, makeBody({ config_version: 43 }));
      const result = await runFail(['validate', '--body', bodyPath, '--previous', previousPath]);
      expect(result.code).toBe(2);
    } finally {
      await removeTempDir(directory);
    }
  });

  it('上一份发布物不存在时按环境错误处理（退出码 2）', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(`${directory}/body.json`, makeBody({ config_version: 43 }));
      const result = await runFail([
        'validate',
        '--body',
        bodyPath,
        '--previous',
        `${directory}/missing.json`,
      ]);
      expect(result.code).toBe(2);
    } finally {
      await removeTempDir(directory);
    }
  });

  it('对契约非法样例的 cases 文档使用 --previous 属于用法错误', async () => {
    const parsed: unknown = await readJsonFile(INVALID_SAMPLE);
  const sample = parsed as { cases: unknown[] };
    expect(sample.cases.length).toBeGreaterThan(0);
    const directory = await makeTempDir();
    try {
      const previousPath = await writeJsonFile(`${directory}/previous.json`, makeBody());
      const result = await runFail(['validate', '--body', INVALID_SAMPLE, '--previous', previousPath]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--previous');
    } finally {
      await removeTempDir(directory);
    }
  });
});
