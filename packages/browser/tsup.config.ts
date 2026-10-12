import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // npm 产物：依赖的工作区包保持外部引用，由接入方的构建工具做 tree-shaking
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'es2020',
    platform: 'browser',
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
  },
  {
    // <script> 引入产物（指南第 3 节）：全部打进一个文件，挂到 window.WebReportSDK
    entry: { 'web-report-sdk': 'src/index.ts' },
    format: ['iife'],
    globalName: 'WebReportSDK',
    target: 'es2020',
    platform: 'browser',
    minify: true,
    sourcemap: true,
    noExternal: [/^@web-report-sdk\//],
    outExtension: () => ({ js: '.iife.js' }),
  },
]);
