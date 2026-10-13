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
