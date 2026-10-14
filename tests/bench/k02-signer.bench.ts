/**
 * K02 配置签名 CLI 基准（T20 是契约目标值的权威验证方；单元护栏见
 * `tools/config-signer/src/__tests__/performance.test.ts`）。
 *
 * 契约目标值（K02-AC-09）：**签名与验签各执行 100 次，单次不超过 100 ms**。
 *
 * 口径（经负责人裁定，与单元护栏一致）：100 ms 只约束 K02 **进程内的签名/验签操作**，
 * 不含 Node 进程启动与 Ajv 首次编译。这里用 `tools/config-signer` 的测试支撑直接调用
 * `runCli`（**不启子进程**），预热一次后计时 100 次，报 P50/P95/P99/最小值。
 */
import { afterAll, describe, expect, test } from 'vitest';

import { loadK02Support } from './lib/entries';
import { createBenchReport } from './lib/report';
import { summarize } from './lib/stats';

const report = createBenchReport('k02-signer');

/** 契约目标：单次签名/验签。 */
const K02_TARGET_MS = 100;
const ROUNDS = 100;

afterAll(() => {
  report.finish();
});

describe('T20 基准：K02 签名与验签', () => {
  test('进程内签名 100 次（契约单次 ≤ 100 ms）', async () => {
    const support = await loadK02Support();
    const workflow = await support.runFullWorkflow();
    try {
      const args = [
        'sign',
        '--body',
        workflow.bodyPath,
        '--private-key',
        workflow.privateKeyPath,
        '--key-id',
        'test-key-2026a',
        '--public-key',
        workflow.publicKeysPath,
      ];
      // 预热一次并做正断言：签名确实成功
      const warm = await support.run(args);
      expect(warm.code).toBe(0);

      const samples: number[] = [];
      for (let index = 0; index < ROUNDS; index += 1) {
        const startedAt = performance.now();
        const result = await support.run(args);
        samples.push(performance.now() - startedAt);
        expect(result.code).toBe(0);
      }
      const stats = summarize(samples);
      report.record({
        metric: 'K02 进程内签名（sign）单次耗时',
        stat: 'p95',
        value: stats.p95,
        unit: 'ms',
        samples: stats.samples,
        target: K02_TARGET_MS,
        targetText: '单次 ≤ 100 ms',
        source: 'tests/acceptance/K02.md K02-AC-09',
        note: 'AC-09 的判定统计量是 p95',
        extra: { p50: stats.p50, p99: stats.p99, min: stats.min, max: stats.max },
      });
    } finally {
      await workflow.cleanup();
    }
  });

  test('进程内验签 100 次（契约单次 ≤ 100 ms）', async () => {
    const support = await loadK02Support();
    const workflow = await support.runFullWorkflow();
    try {
      const args = ['verify', '--envelope', workflow.envelopePath, '--public-key', workflow.publicKeysPath];
      const warm = await support.run(args);
      expect(warm.code).toBe(0);

      const samples: number[] = [];
      for (let index = 0; index < ROUNDS; index += 1) {
        const startedAt = performance.now();
        const result = await support.run(args);
        samples.push(performance.now() - startedAt);
        expect(result.code).toBe(0);
      }
      const stats = summarize(samples);
      report.record({
        metric: 'K02 进程内验签（verify）单次耗时',
        stat: 'p95',
        value: stats.p95,
        unit: 'ms',
        samples: stats.samples,
        target: K02_TARGET_MS,
        targetText: '单次 ≤ 100 ms',
        source: 'tests/acceptance/K02.md K02-AC-09',
        note: 'AC-09 的判定统计量是 p95',
        extra: { p50: stats.p50, p99: stats.p99, min: stats.min, max: stats.max },
      });
    } finally {
      await workflow.cleanup();
    }
  });
});
