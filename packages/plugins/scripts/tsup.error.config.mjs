import { defineConfig } from 'tsup';

/**
 * 「仅错误插件」的构建配置（C05-AC-13）。
 *
 * AC-13 要求「只引入错误插件构建 → 产物中不包含其他插件代码」。
 * 入口只有 `src/error/index.ts`，因此 treeshake 后产物中不应出现 perf / route / http 的符号；
 * 产物路径 `dist/error-entry/index.js` 由 `src/error/build-size.test.ts` 扫描。
 */
export default defineConfig({
  entry: { 'error-entry/index': 'src/error/index.ts' },
  outDir: 'dist',
  format: ['esm'],
  target: 'es2020',
  platform: 'browser',
  dts: false,
  sourcemap: false,
  clean: false,
  treeshake: true,
  external: ['@web-report-sdk/core'],
});
