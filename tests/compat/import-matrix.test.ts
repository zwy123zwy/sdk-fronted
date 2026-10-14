/**
 * T30 接入方式兼容矩阵（指南第 4.2 节）。
 *
 * 指南 4.2 原文要求：「在主流构建工具（Vite、webpack）的生产构建、开发服务器，以及
 * Vitest、Jest 测试环境中，SDK 都必须能直接导入，不需要额外配置」。
 *
 * 本文件覆盖**进程内可判定**的部分，并且**断言的是实际行为**，不是"实现里应该有"：
 * - ESM 导入（构建产物 `packages/browser/dist/index.js`）；
 * - 纯 Node（无 DOM）导入不抛错（SSR / 测试环境的前提）；
 * - `<script>` 引入的 IIFE 全局（权威证据是 `pnpm examples:test` 的 `examples/script-tag`）；
 * - `exports` 映射的实际形状，以及 **CJS `require()` 的真实结果**（这里是**真实缺口**，见下）；
 * - Vite 生产构建（权威证据是 `pnpm examples:build`，本文件只核对其产物存在）。
 *
 * 不在本文件（见 `docs/reports/compat-matrix.md`）：
 * - Vite 开发服务器 → `scripts/vite-dev-server.mjs`；
 * - webpack 生产构建 / 开发服务器 → `examples/webpack/` 的两个脚本，
 *   结果登记在 `tests/compat/webpack-matrix.test.ts`（2026-10-14 经负责人批准新增该 example 后，
 *   两格已由 `blocked` 改为实测结论）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { afterAll, describe, expect, test } from 'vitest';

import { derivedCell, writeCells } from './lib/matrix';
import type { MatrixCell, ProbeTable } from './lib/matrix';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const browserDist = `${repoRoot}packages/browser/dist/index.js`;
const browserIife = `${repoRoot}packages/browser/dist/web-report-sdk.iife.js`;
const packageJsonPath = `${repoRoot}packages/browser/package.json`;
const compatCommand =
  'pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false';

/** 每个探针的实测结论；由用例写入，矩阵状态从它推导（用例抛错则保持 `undefined` → `fail`）。 */
const probe: ProbeTable = {};

/** 由实测结论推导矩阵格。 */
function cell(
  id: string,
  input: Parameters<typeof derivedCell>[3],
): MatrixCell {
  return derivedCell(probe, compatCommand, id, input);
}

interface ExportsEntry {
  readonly [condition: string]: unknown;
}

interface BrowserPackageJson {
  readonly exports: Readonly<Record<string, ExportsEntry>>;
  readonly private?: boolean;
}

const manifest = JSON.parse(
  readFileSync(packageJsonPath, 'utf8'),
) as BrowserPackageJson;

afterAll(() => {
  const cells: MatrixCell[] = [
    cell('import.esm.node', {
      requirement: '指南 4.2：Vite/Vitest 等 ESM 环境直接导入',
      dimension: '接入方式 / ESM 导入',
      engine: 'node 24',
      evidence: browserDist,
      notes: '导入构建产物并读取命名导出与 SDK_VERSION。',
    }),
    cell('import.node.no-dom', {
      requirement: '指南 4.2：不需要额外配置即可导入（含 SSR/无 DOM 环境）',
      dimension: '接入方式 / 无 DOM 导入',
      engine: 'node 24（无 window/document）',
      evidence: '子进程 node --input-type=module 动态 import，无 window/document',
      notes: '导入期不得访问 window/document（模块顶层无副作用）。',
    }),
    cell('import.iife.global', {
      requirement: '指南 4.2：`<script>` 引入',
      dimension: '接入方式 / IIFE 全局',
      engine: 'node vm（模拟无构建工具的页面）',
      evidence: browserIife,
      notes: '权威证据是 `pnpm examples:test` 里 examples/script-tag 的 check.mjs（已 exit 0）。',
    }),
    cell('import.exports.conditions', {
      requirement: '指南 4.2：构建工具直接导入',
      dimension: '接入方式 / exports 条件映射',
      engine: 'node 24',
      evidence: packageJsonPath,
      notes: '`.` 与 `./iife` 两个入口的条件齐全性。',
    }),
    cell('import.cjs.require', {
      requirement: '指南 4.2：Jest（默认 CJS）与 webpack `require` 场景',
      dimension: '接入方式 / CJS require',
      engine: 'node 24',
      evidence: 'ERR_PACKAGE_PATH_NOT_EXPORTED（见用例内断言与报告）',
      notes:
        '`exports` 没有 `require` 条件，CJS `require("@web-report-sdk/browser")` 直接失败；' +
        '现有 Jest 示例靠 `--experimental-vm-modules` + `.mjs` 才能跑（属额外配置）。**真实缺口，需决策**。',
    }),
    cell('import.vite.build', {
      requirement: '指南 4.2：Vite 生产构建',
      dimension: '接入方式 / Vite 生产构建',
      engine: 'vite 8.3.4',
      evidence: 'temp/t30-examples.log（pnpm examples:build exit 0）',
      notes: '权威证据是仓库脚本 `pnpm examples:build`；本用例只核对产物存在。',
    }),
  ];
  writeCells('import-matrix', cells);
});

describe('接入方式：ESM 与 IIFE', () => {
  test('构建产物是 ESM，命名导出与 SDK_VERSION 可用', async () => {
    const text = readFileSync(browserDist, 'utf8');
    expect(text).toMatch(/^export\s|\nexport\s/m);
    const mod = (await import(browserDist)) as {
      SDK_VERSION?: unknown;
      createAssembly?: unknown;
    };
    expect(typeof mod.SDK_VERSION).toBe('string');
    expect(typeof mod.createAssembly).toBe('function');
    probe['import.esm.node'] = true;
  });

  test('在没有 window/document 的纯 node 里导入不抛错', () => {
    const script =
      "if (typeof window !== 'undefined') { throw new Error('unexpected window'); }" +
      `const m = await import(${JSON.stringify(browserDist)});` +
      "process.stdout.write(String(typeof m.SDK_VERSION));";
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('string');
    probe['import.node.no-dom'] = true;
  });

  test('IIFE 产物在没有构建工具的环境里暴露全局 WebReportSDK', () => {
    const code = readFileSync(browserIife, 'utf8');
    const context: Record<string, unknown> = { window: {} };
    context['self'] = context['window'];
    vm.createContext(context);
    vm.runInContext(
      `${code}\n;window.WebReportSDK = typeof WebReportSDK === 'undefined' ? undefined : WebReportSDK;`,
      context,
    );
    const sdk = (context['window'] as { WebReportSDK?: { SDK_VERSION?: unknown } })
      .WebReportSDK;
    expect(typeof sdk?.SDK_VERSION).toBe('string');
    probe['import.iife.global'] = true;
  });
});

describe('接入方式：包导出映射（含 CJS 的真实行为）', () => {
  test('`.` 与 `./iife` 的条件映射齐全（source/types/import）', () => {
    const root = manifest.exports['.'];
    expect(root).toBeDefined();
    expect(Object.keys(root ?? {}).sort()).toEqual(['import', 'source', 'types']);
    expect(manifest.exports['./iife']).toBe('./dist/web-report-sdk.iife.js');
    probe['import.exports.conditions'] = true;
  });

  test('CJS require：记录真实结果（当前为失败）', () => {
    const require = createRequire(new URL('../../examples/node-import/x.mjs', import.meta.url));
    let error: unknown;
    try {
      require('@web-report-sdk/browser');
    } catch (caught) {
      error = caught;
    }
    const code = (error as { code?: unknown } | undefined)?.code;
    // 事实记录：exports 无 require 条件 → 包级 require 被拒。
    expect(error).toBeDefined();
    expect(code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    // 反空转：同一份产物用文件路径 require 是成功的（说明限制来自 exports 映射，不是产物本身）。
    const direct = require(browserDist) as { SDK_VERSION?: unknown };
    expect(typeof direct.SDK_VERSION).toBe('string');
    // 结论：CJS 接入当前**不成立**（缺口），因此该格记为 fail 而不是 pass。
    probe['import.cjs.require'] = false;
  });

  test('Vite 生产构建产物存在（权威证据：pnpm examples:build）', () => {
    const dist = `${repoRoot}examples/vite/dist`;
    expect(existsSync(`${dist}/index.html`)).toBe(true);
    expect(existsSync(`${dist}/assets`)).toBe(true);
    probe['import.vite.build'] = true;
  });
});
