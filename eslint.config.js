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
      // `tests/e2e/leave-slice.spec.mjs` 的 beforeAll 会从 dist 现场重新生成这个变异体
      // （构建产物，不是手写源码）；一旦生成就会让 eslint 报错。仅忽略这一条路径。
      'tests/e2e/probes/mutant-transport.js',
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
    // 共两个文件，各自都是「必须向控制台输出、且无法复用 core 的 sink」的场景：
    // 1) packages/core/src/api/console-sink.ts —— 验收用例 C01-AC-12 与 C08-AC-08
    //    要求调试模式向控制台输出原因码，与上一段对 packages/*/src/** 的全局
    //    no-console 冲突；
    // 2) packages/browser/src/loading-stub.ts —— 加载桩按设计是内联到页面头部的
    //    独立脚本，不 import 任何模块（用不了 core 的 console-sink），但队列溢出时
    //    需要告警。该文件**曾经**用 root['console'] 间接访问来规避本规则，
    //    经复核认定为 lint 躲避，已改为直接使用 console 并在本处显式豁免。
    // 其余 SDK 代码仍然禁止 console；任一文件被改名或移动，该条豁免失效、lint 立刻报错。
    // 该豁免记录在 docs/tasks/board.md 的阻塞与升级记录，以及 docs/reports/wave1-lanes.md。
    files: ['packages/core/src/api/console-sink.ts', 'packages/browser/src/loading-stub.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // 指南第 6 节：不得跳过测试。
    // 2026-10-15 起同时覆盖 `.mjs` 用例与 `tests/**` 下的 `.mjs` 支持代码——此前只覆盖 `.ts`，
    // 于是 `tests/e2e/leave-slice.spec.mjs` 里**写死**的 `test.skip(({ browserName }) => …)` 不会被
    // lint 拦住（`docs/reports/t33-access-blockers.md` 第 6 条）。
    // 这里保留基块的 ClassDeclaration 禁令：本块会**替换**该规则的整个数组，不收回来就等于放宽。
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.mjs', '**/*.spec.mjs', 'tests/**/*.ts', 'tests/**/*.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ClassDeclaration', message: '用函数式工厂和闭包组织代码，不用类（指南第 11 节）' },
        { selector: "CallExpression[callee.property.name='skip']", message: '不得跳过测试（指南第 6 节）' },
        { selector: "CallExpression[callee.property.name='only']", message: '不得提交 .only' },
      ],
    },
  },
  {
    // 「环境起不来就跳过」是 e2e 里唯一合法的跳过，它必须**只**出现在这一个文件里
    // （`tests/e2e/lib/skip-audit.mjs` 的 `skipUnavailableBrowser()`）。
    // 这**不是**整文件豁免：本块把规则换成更窄的一条——只放行**由运行时探测结果驱动**的跳过形状
    // `test.skip(<非字面量表达式>, 原因)`；而 `test.skip()`（无条件）、`test.skip(true, …)`、
    // `test.skip(browserName !== …)`（写死引擎名单）在本文件里同样报错。
    // 净效果：全仓唯一一处 `test.skip` 也必须带运行时条件 + 真实原因，判据另有确定性自检
    // （`node tests/e2e/lib/skip-audit-selftest.mjs`）。
    files: ['tests/e2e/lib/skip-audit.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ClassDeclaration', message: '用函数式工厂和闭包组织代码，不用类（指南第 11 节）' },
        { selector: "CallExpression[callee.property.name='only']", message: '不得提交 .only' },
        {
          selector: "CallExpression[callee.property.name='skip'][arguments.length=0]",
          message: '不得无条件跳过测试（指南第 6 节）',
        },
        {
          selector:
            "CallExpression[callee.property.name='skip'][arguments.0.type=/^(Literal|BinaryExpression|LogicalExpression|ArrowFunctionExpression|TemplateLiteral)$/]",
          message:
            '写死的跳过：只允许 test.skip(<运行时探测结果表达式>, 原因)（first arg 不得是字面量/比较/逻辑/箭头函数）',
        },
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
