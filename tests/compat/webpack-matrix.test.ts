/**
 * T30 接入方式：**webpack 生产构建 + 开发服务器**（指南第 4.2 节）。
 *
 * 指南原文要求 webpack 的**生产构建**与**开发服务器**都要能直接导入 SDK、不需要额外配置。
 * 本任务开始前这两格是 `blocked`（仓库没有 webpack、没有 webpack example）；负责人批准新增
 * `examples/webpack` 与 webpack 开发依赖后，两格改为**实测结论**。
 *
 * 证据的产生方式（本文件只**登记 + 核对**，不重复跑构建，避免用例变成慢门禁）：
 * ```
 * node examples/webpack/scripts/build-production.mjs   # 写 results/webpack-production.json
 * node examples/webpack/scripts/dev-server.mjs         # 写 results/webpack-dev-server.json
 * ```
 * 两个脚本都以 `examples/webpack/webpack.config.mjs` 为准，**没有任何 SDK 专属配置**
 * （无 `resolve.alias`、无 `conditionNames` 覆盖）——这正是"不需要额外配置"的检验点。
 *
 * 为什么状态由落盘文件推导、而不是像 `import-matrix.test.ts` 那样由探针推导：
 * 这两格的实测必须真的跑 webpack（构建 + 起服务），放进 vitest 会让"跑兼容矩阵"变成
 * 一分钟起步的重活；脚本已经把 checks 明细写进 JSON，本文件断言 JSON 的**形状与结论一致**。
 * 文件缺失 = 没跑 = 不得下结论 → 登记为 `fail`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, test } from 'vitest';

import { writeCells } from './lib/matrix';
import type { MatrixCell } from './lib/matrix';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const resultsDir = `${repoRoot}tests/compat/results`;
const exampleDir = `${repoRoot}examples/webpack`;

const command =
  'node examples/webpack/scripts/build-production.mjs && node examples/webpack/scripts/dev-server.mjs';

interface WebpackResult {
  readonly status: string;
  readonly engine: string;
  readonly sandbox?: { readonly status: string; readonly checks?: Readonly<Record<string, boolean>> };
  readonly checks?: Readonly<Record<string, boolean>>;
  readonly build?: { readonly hasErrors: boolean };
  readonly browser?: { readonly status: string };
}

function readResult(name: string): WebpackResult | undefined {
  const file = `${resultsDir}/${name}.json`;
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as WebpackResult) : undefined;
}

const production = readResult('webpack-production');
const devServer = readResult('webpack-dev-server');

const cells: MatrixCell[] = [
  {
    id: 'import.webpack.production',
    requirement: '指南 4.2：webpack 生产构建直接导入',
    dimension: '接入方式 / webpack 生产构建',
    engine: production?.engine ?? '—',
    status: production?.status === 'pass' ? 'pass' : 'fail',
    command: 'node examples/webpack/scripts/build-production.mjs',
    evidence: 'tests/compat/results/webpack-production.json + examples/webpack/dist/main.js',
    notes:
      production === undefined
        ? '证据文件不存在：脚本没跑，不得下结论。'
        : `沙箱 status=${production.sandbox?.status ?? '?'}；` +
          `checks=${Object.entries(production.sandbox?.checks ?? {})
            .map(([key, value]) => `${key}=${String(value)}`)
            .join('、')}；` +
          `构建 hasErrors=${String(production.build?.hasErrors)}；` +
          `浏览器复核=${production.browser?.status ?? '未记录'}。`,
  },
  {
    id: 'import.webpack.devServer',
    requirement: '指南 4.2：webpack 开发服务器直接导入',
    dimension: '接入方式 / webpack 开发服务器',
    engine: devServer?.engine ?? '—',
    status: devServer?.status === 'pass' ? 'pass' : 'fail',
    command: 'node examples/webpack/scripts/dev-server.mjs',
    evidence: 'tests/compat/results/webpack-dev-server.json',
    notes:
      devServer === undefined
        ? '证据文件不存在：脚本没跑，不得下结论。'
        : `checks=${Object.entries(devServer.checks ?? {})
            .map(([key, value]) => `${key}=${String(value)}`)
            .join('、')}；` +
          `沙箱 status=${devServer.sandbox?.status ?? '?'}；` +
          `浏览器复核=${devServer.browser?.status ?? '未记录'}。`,
  },
];

afterAll(() => {
  writeCells('webpack-matrix', cells);
});

describe('接入方式：webpack（生产构建 / 开发服务器）', () => {
  test('webpack example 工程存在，且构建与 dev server 接入方式都在其中', () => {
    expect(existsSync(`${exampleDir}/package.json`)).toBe(true);
    expect(existsSync(`${exampleDir}/webpack.config.mjs`)).toBe(true);
    expect(existsSync(`${exampleDir}/scripts/build-production.mjs`)).toBe(true);
    expect(existsSync(`${exampleDir}/scripts/dev-server.mjs`)).toBe(true);
  });

  test('webpack 生产构建：证据落盘且结论为 pass（沙箱真跑最小路径）', () => {
    expect(production, 'results/webpack-production.json 不存在：先跑 build-production.mjs').toBeDefined();
    expect(production?.build?.hasErrors).toBe(false);
    expect(production?.sandbox?.status).toBe('pass');
    const checks = production?.sandbox?.checks ?? {};
    // 反空转：不只看 status，逐条要求关键断言为真。
    expect(checks['sdkVersionMatchesPackage']).toBe(true);
    expect(checks['createAssemblyIsFunction']).toBe(true);
    expect(checks['minimalPathRan']).toBe(true);
    expect(checks['batchContainsProbeEvent']).toBe(true);
    expect(production?.status).toBe('pass');
  });

  test('webpack 开发服务器：证据落盘且结论为 pass（HTTP 200 + bundle 可执行）', () => {
    expect(devServer, 'results/webpack-dev-server.json 不存在：先跑 dev-server.mjs').toBeDefined();
    const checks = devServer?.checks ?? {};
    expect(checks['indexHtml200']).toBe(true);
    expect(checks['bundle200']).toBe(true);
    expect(checks['bundleNonEmpty']).toBe(true);
    expect(checks['sandboxStatusPass']).toBe(true);
    expect(devServer?.sandbox?.checks?.['minimalPathRan']).toBe(true);
    expect(devServer?.status).toBe('pass');
  });
});
