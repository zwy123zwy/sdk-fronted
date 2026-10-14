#!/usr/bin/env node
/**
 * C05-AC-13 的产物扫描：「只引入错误插件构建 → 产物中不包含其他插件代码」。
 *
 * 为什么放在 `scripts/`（构建期脚本域）而不是包内单元测试：
 * `packages/plugins` 是**浏览器包**，其 `tsconfig.json` 刻意是 `"types": []`。
 * 为了让一个测试能 `import 'node:fs'` 而给整包打开 node types，等于允许实现代码
 * 随手使用 `fs`/`path`/`process` —— 这些在浏览器里会直接炸。
 * 因此这类"读产物"的检查隔离在构建脚本域（`.mjs`，不参与包的 tsconfig）。
 *
 * 由 `packages/plugins/package.json` 的 `build` 脚本在 `tsup` 之后调用；
 * 任一条断言失败即以非零码退出（门禁红）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, '../dist/error-entry/index.js');

/** 其他插件的可识别符号：错误入口产物出现任一个即判违约。 */
const FOREIGN_MARKERS = [
  'web_vitals',
  'web_long_task',
  'web_pageview',
  'web_http',
  'PerformanceObserver',
  'createPerfCapture',
  'createRouteCapture',
  'createHttpCapture',
  'createApmDualWritePlugin',
  'traceparent',
];

/** 错误插件必须存在的符号（防止"产物为空也算通过"的空转）。 */
const REQUIRED_MARKERS = ['web_js_error', 'window_error'];

let source;
try {
  source = readFileSync(bundlePath, 'utf8');
} catch {
  console.error(`[AC-13] 未找到「仅错误插件」构建产物：${bundlePath}`);
  console.error('[AC-13] 请先运行 pnpm --filter @web-report-sdk/plugins run build');
  process.exit(1);
}

const problems = [];

for (const marker of REQUIRED_MARKERS) {
  if (!source.includes(marker)) {
    problems.push(`产物缺少错误插件的必需符号：${marker}`);
  }
}

for (const marker of FOREIGN_MARKERS) {
  if (source.includes(marker)) {
    problems.push(`产物包含其他插件的代码：${marker}`);
  }
}

if (problems.length > 0) {
  console.error(`[AC-13] 错误插件产物检查未通过（${bundlePath}）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `[AC-13] 通过：仅错误插件产物 ${(source.length / 1024).toFixed(2)} KB，` +
    `含 ${REQUIRED_MARKERS.join('/')}，不含 perf/route/http/apm-dual-write 符号。`,
);
