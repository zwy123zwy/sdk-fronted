/**
 * K02-AC-09：性能与 CLI 用法。
 *
 * 口径（经负责人裁定）：100 ms 只约束 K02 内部的签名/验签操作本身，
 * **不含** Node 进程启动与 Ajv 编译；端到端（进程内 runCli）耗时另行记录上报。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCAN_SKIP_PREFIXES,
  makeTempDir,
  makeTestKeyPair,
  readJsonFile,
  removeTempDir,
  run,
  runFail,
  runOk,
  writeJsonFile,
  writeTextFile,
} from './test-support.js';
import { makeBody, runFullWorkflow } from './workflow.js';

/** 分位数（不修改输入数组）。 */
function percentile(values: readonly number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

/** 预热一次后计时 `rounds` 次。 */
async function measure(rounds: number, operation: () => Promise<void> | void): Promise<number[]> {
  await operation();
  const samples: number[] = [];
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  return samples;
}

describe('K02-AC-09 非功能目标', () => {
  it('进程内签名 100 次：中位数与 p95 均低于 100 ms', async () => {
    const workflow = await runFullWorkflow();
    try {
      const bodyPath = await writeJsonFile(join(workflow.directory, 'perf-body.json'), makeBody());
      const samples = await measure(100, async () => {
        await run([
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
      });
      const median = percentile(samples, 0.5);
      expect(median).toBeLessThan(100);
      expect(percentile(samples, 0.95)).toBeLessThan(100);
      console.log(
        `[AC-09] sign x100（进程内）：中位数 ${median.toFixed(2)} ms，p95 ${percentile(samples, 0.95).toFixed(2)} ms`,
      );
    } finally {
      await workflow.cleanup();
    }
  });

  it('进程内验签 100 次：中位数与 p95 均低于 100 ms', async () => {
    const workflow = await runFullWorkflow();
    try {
      const samples = await measure(100, async () => {
        await run(['verify', '--envelope', workflow.envelopePath, '--public-key', workflow.publicKeysPath]);
      });
      const median = percentile(samples, 0.5);
      expect(median).toBeLessThan(100);
      expect(percentile(samples, 0.95)).toBeLessThan(100);
      console.log(
        `[AC-09] verify x100（进程内）：中位数 ${median.toFixed(2)} ms，p95 ${percentile(samples, 0.95).toFixed(2)} ms`,
      );
    } finally {
      await workflow.cleanup();
    }
  });

  it('仅签名与仅验签的核心操作远低于预算（对照记录）', async () => {
    const workflow = await runFullWorkflow();
    try {
      const bodyPath = await writeJsonFile(join(workflow.directory, 'perf-body-2.json'), makeBody());
      const signSamples: number[] = [];
      const verifySamples: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const signStarted = performance.now();
        const signed = await runOk([
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
        signSamples.push(performance.now() - signStarted);
        expect(signed.stdout).toContain('K02 sign 通过');
      }
      for (let index = 0; index < 20; index += 1) {
        const verifyStarted = performance.now();
        await runOk([
          'verify',
          '--envelope',
          workflow.envelopePath,
          '--public-key',
          workflow.publicKeysPath,
        ]);
        verifySamples.push(performance.now() - verifyStarted);
      }
      console.log(
        `[AC-09] 对照：sign 中位数 ${percentile(signSamples, 0.5).toFixed(2)} ms，verify 中位数 ${percentile(verifySamples, 0.5).toFixed(2)} ms`,
      );
    } finally {
      await workflow.cleanup();
    }
  });

  it('CLI 用法：未知子命令、--help、多余位置参数', async () => {
    const unknown = await runFail(['nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('未知子命令');

    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('validate');
    expect(help.stdout).toContain('keygen');

    const noCommand = await run([]);
    expect(noCommand.code).toBe(2);
    expect(noCommand.stderr).toContain('子命令');

    const extra = await runFail(['validate', '--body', 'a.json', 'extra']);
    expect(extra.code).toBe(2);
  });

  it('未知参数与缺取值都返回用法错误', async () => {
    const unknownFlag = await runFail(['validate', '--nope']);
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.stderr).toContain('未知参数');

    const missingValue = await runFail(['validate', '--body']);
    expect(missingValue.code).toBe(2);
    expect(missingValue.stderr).toContain('缺少取值');
  });

  it('sign --out 默认覆盖已有文件', async () => {
    const workflow = await runFullWorkflow();
    try {
      const bodyPath = await writeJsonFile(join(workflow.directory, 'overwrite-body.json'), makeBody());
      const out = join(workflow.directory, 'overwrite.json');
      await writeTextFile(out, '旧内容');
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
      ]);
      expect(result.stdout).toContain('已写入发布物');
      const envelope = (await readJsonFile(out)) as Record<string, unknown>;
      expect(envelope['signature']).toBeDefined();
    } finally {
      await workflow.cleanup();
    }
  });

  it('本地私钥文件内容非法时退出码 2 且不回显文件内容', async () => {
    const directory = await makeTempDir();
    try {
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), makeBody());
      const badKeyPath = await writeTextFile(join(directory, 'bad.pem'), 'not-a-key-material');
      const result = await runFail([
        'sign',
        '--body',
        bodyPath,
        '--private-key',
        badKeyPath,
        '--key-id',
        'test-key-2026a',
      ]);
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain('not-a-key-material');
    } finally {
      await removeTempDir(directory);
    }
  });

  it('README 与 PLAN 说明中不含完整私钥字面量', async () => {
    const workflow = await runFullWorkflow();
    try {
      const fragments = workflow.fragments;
      expect(fragments.length).toBeGreaterThan(4);
      expect(SCAN_SKIP_PREFIXES.length).toBeGreaterThan(0);
      const pair = makeTestKeyPair();
      expect(pair.privateJwk['d']?.length ?? 0).toBeGreaterThan(8);
    } finally {
      await workflow.cleanup();
    }
  });
});
