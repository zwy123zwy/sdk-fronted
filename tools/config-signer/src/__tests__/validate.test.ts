/**
 * K02-AC-01：按 `remote-config.schema.json` 校验配置正文（K02-F1）。
 *
 * 数据来自已冻结的契约样例：
 * - `docs/contracts/examples/remote-config.valid.json` 的 `decoded_payload`
 * - `docs/contracts/examples/remote-config.invalid.json` 的 `cases`
 */
import { describe, expect, it } from 'vitest';
import {
  INVALID_SAMPLE,
  VALID_SAMPLE,
  readJsonFile,
  runFail,
  runOk,
  writeJsonFile,
  makeTempDir,
  removeTempDir,
} from './test-support.js';
import { makeBody } from './workflow.js';

interface ValidSample {
  readonly decoded_payload: Record<string, unknown>;
}

interface InvalidSample {
  readonly cases: readonly Record<string, unknown>[];
}

async function loadValidPayload(): Promise<Record<string, unknown>> {
  const parsed: unknown = await readJsonFile(VALID_SAMPLE);
  return (parsed as ValidSample).decoded_payload;
}

async function loadInvalidCases(): Promise<readonly Record<string, unknown>[]> {
  const parsed: unknown = await readJsonFile(INVALID_SAMPLE);
  return (parsed as InvalidSample).cases;
}

describe('K02-AC-01 validate 子命令', () => {
  it('契约合法样例的 decoded_payload 退出码 0', async () => {
    const directory = await makeTempDir();
    try {
      const payload = await loadValidPayload();
      const bodyPath = await writeJsonFile(`${directory}/valid.json`, payload);
      const result = await runOk(['validate', '--body', bodyPath]);
      expect(result.stdout).toContain('K02 validate 通过');
      expect(result.stdout).toContain('config_version=42');
      expect(result.stderr).toBe('');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('正文里的未知字段被忽略（契约：SDK 必须忽略不认识的字段）', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(
        `${directory}/unknown-field.json`,
        makeBody({ future_field: { nested: true } }),
      );
      const result = await runOk(['validate', '--body', bodyPath]);
      expect(result.stdout).toContain('K02 validate 通过');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('契约非法样例的每个 case 都非零退出码，且错误信息含字段路径', async () => {
    const directory = await makeTempDir();
    try {
      const cases = await loadInvalidCases();
      expect(cases.length).toBeGreaterThanOrEqual(6);
      // 每个 case 在「父对象」上的 required 失败都会补出具体字段路径，
      // 因此字段路径断言用 JSON 指针字面量，而不是 `_why` 文案（文案里会提到字段名）
      const expectedPaths: readonly string[] = [
        '/config_version',
        '/sampling/session_rate',
        '/endpoints/ingest',
        '/overrides/0/patch',
        '/plugins/replay',
        '/privacy/consent_mode',
      ];
      for (const [index, entry] of cases.entries()) {
        const rawWhy = entry['_why'];
        const why = typeof rawWhy === 'string' ? rawWhy : `case ${String(index)}`;
        const body = { ...entry };
        delete body['_why'];
        const bodyPath = await writeJsonFile(`${directory}/case-${String(index)}.json`, body);
        const result = await runFail(['validate', '--body', bodyPath]);
        expect(result.stderr, `${why} 应给出问题输出`).toContain('K02 问题');
        const expected = expectedPaths[index];
        if (expected !== undefined) {
          expect(result.stderr, `${why} 应含字段路径 ${expected}`).toContain(expected);
        }
      }
    } finally {
      await removeTempDir(directory);
    }
  });

  it('缺 config_version 的 case 报 /config_version 路径', async () => {
    const directory = await makeTempDir();
    try {
      const body = { ...makeBody() };
      delete body['config_version'];
      const bodyPath = await writeJsonFile(`${directory}/missing-version.json`, body);
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.stderr).toContain('/config_version');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('采样率越界时报 /sampling/session_rate 路径', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(
        `${directory}/rate.json`,
        makeBody({ sampling: { session_rate: 1.5 } }),
      );
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.stderr).toContain('/sampling/session_rate');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('consent_mode: full 非零退出码并提示 D002', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(
        `${directory}/consent-full.json`,
        makeBody({ privacy: { consent_mode: 'full' } }),
      );
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.stderr).toContain('/privacy/consent_mode');
      expect(result.stderr).toContain('D002');
      expect(result.stderr).toContain('full');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('consent_mode 为其他未知取值时仍然是通用 Schema 错误（只对 full 打 D002）', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(
        `${directory}/consent-always.json`,
        makeBody({ privacy: { consent_mode: 'always' } }),
      );
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.stderr).toContain('/privacy/consent_mode');
      expect(result.stderr).not.toContain('D002');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('consent_mode 取 buffer / essential_only 时通过', async () => {
    const directory = await makeTempDir();
    try {
      for (const mode of ['buffer', 'essential_only']) {
        const bodyPath = await writeJsonFile(
          `${directory}/consent-${mode}.json`,
          makeBody({ privacy: { consent_mode: mode } }),
        );
        await runOk(['validate', '--body', bodyPath]);
      }
    } finally {
      await removeTempDir(directory);
    }
  });

  it('缺少 --body 时退出码为用法错误 2', async () => {
    const result = await runFail(['validate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--body');
  });

  it('正文不是合法 JSON 时退出码 2 且提示文件路径', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = `${directory}/broken.json`;
      const { writeTextFile } = await import('./test-support.js');
      await writeTextFile(bodyPath, '{ not json');
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('broken.json');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('正文文件不存在时退出码 2', async () => {
    const result = await runFail(['validate', '--body', '/nonexistent/k02-body.json']);
    expect(result.code).toBe(2);
  });

  it('未提供 --previous 时明确说明已跳过递增检查', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(`${directory}/body.json`, makeBody());
      const result = await runOk(['validate', '--body', bodyPath]);
      expect(result.stdout).toContain('已跳过 config_version 递增检查');
    } finally {
      await removeTempDir(directory);
    }
  });
});
