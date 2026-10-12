import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/temp/**',
      'docs/**',
      'poc/**',
      // 接入示例模拟接入方环境，由各自的 build / test 验证
      'examples/**',
      'scripts/gate-fixtures/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', 'scripts/*.mjs', 'packages/*/tsup.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // 指南第 6 节：禁止用 eslint-disable 绕过门禁
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' }],
      'no-restricted-syntax': [
        'error',
        { selector: 'ClassDeclaration', message: '用函数式工厂和闭包组织代码，不用类（指南第 11 节）' },
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      // 模块顶层不访问 window / document（指南第 11 节）在 T11 补充为自定义规则
      'no-console': 'error',
    },
  },
  {
    // 指南第 6 节的「已批准豁免」（2026-10-12，批准人 wenye.zhang）。
    // 验收用例 C01-AC-12 与 C08-AC-08 要求调试模式向控制台输出原因码，
    // 与上一段对 packages/*/src/** 的全局 no-console 冲突。
    // 豁免范围收窄到唯一一个调试输出模块：packages/core/src/api/console-sink.ts。
    // 其余 SDK 代码仍然禁止 console；若该文件被改名或移动，此处豁免失效，lint 会立刻报错提醒。
    // 该豁免记录在 docs/tasks/board.md 的阻塞与升级记录，以及 docs/reports/wave1-lanes.md。
    files: ['packages/core/src/api/console-sink.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='skip']", message: '不得跳过测试（指南第 6 节）' },
        { selector: "CallExpression[callee.property.name='only']", message: '不得提交 .only' },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
