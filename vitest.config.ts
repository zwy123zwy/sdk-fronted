import { defineConfig } from 'vitest/config';

// 覆盖率阈值见指南第 6 节：核心包不低于 90%，其余不低于 80%
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts'],
          environment: 'happy-dom',
        },
      },
      {
        test: {
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // T31（安全与隐私测试）的所有权目录是 `tests/security/`；若无此 project，该目录不会被任
        // 何 project 收集、测试根本不会执行。2026-10-13 经负责人批准新增。
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // T30（兼容矩阵）的所有权目录是 `tests/compat/`。此前该目录不在任何 project 的 include
        // 里 → `pnpm test` / `pnpm gates` 从不执行它，兼容矩阵的守卫（`webpack-matrix`、
        // D-06 的 `receiver-contract-gate`、`import-matrix`、`apm-coexistence`、`degradation`）
        // 全部在门禁之外（2026-10-15 报备、2026-10-15 经负责人批准新增本 project）。
        //
        // 为什么单开一个 project、而不是并进 `contract`：本目录的用例交叉引用**落盘证据**
        // （`results/*.json`，由 `examples/webpack` 与 `tests/compat/scripts/` 生成），失败语义是
        // "证据缺失/过期"，与 `tests/contract` 的"冻结契约被违反"是两类事，分开展示才看得出来。
        // 另外 `--project contract`（`pnpm test:contract`）的口径不应被兼容矩阵悄悄改宽。
        //
        // 环境是 node（兼容性结论要在接入方真实解析到的产物上得出）；需要 DOM 的文件自己带
        // `// @vitest-environment happy-dom`（如 `apm-coexistence.test.ts`）。
        //
        // 依赖：用例读 `packages/*/dist` 与 `examples/webpack/dist` → 必须**先 `pnpm build` 与
        // `pnpm examples:build`**（`pnpm gates` 的顺序本来就是 build → test）。产物缺失时用例
        // 必须红，不做跳过。
        test: {
          name: 'compat',
          include: ['tests/compat/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'tools/*/src/**/*.ts'],
      // index.ts 只做重新导出、cli.ts 只做参数转发（逻辑放在独立模块中，由单元测试覆盖）
      exclude: ['**/*.test.ts', '**/index.ts', 'tools/*/src/cli.ts'],
      thresholds: {
        'packages/core/src/**': { lines: 90, branches: 80 },
        'packages/transport/src/**': { lines: 90, branches: 80 },
        'packages/plugins/src/**': { lines: 80, branches: 70 },
        'tools/*/src/**': { lines: 80, branches: 70 },
      },
    },
  },
});
