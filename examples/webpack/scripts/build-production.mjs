/**
 * webpack 生产构建（T30 兼容矩阵第 26 格）。
 *
 * 流程：用 `examples/webpack/webpack.config.mjs`（无任何 SDK 专属配置）跑一次
 * `webpack --mode production`，产出 `examples/webpack/dist/main.js`，然后把**这个产物**
 * 喂给 `verify-bundle.mjs` 的沙箱：断言 `SDK_VERSION`、`createAssembly`，并真跑一次
 * `createAssembly → init → track → flush → 接收方收到批次`。
 *
 * 若本机存在 Chromium（与 `tests/compat/scripts/vite-dev-server.mjs` 用同一路径），
 * 额外用真实浏览器打开 `dist/index.html` 复核一次（这一步失败不影响沙箱结论，会单独记录）。
 *
 * 运行：`node examples/webpack/scripts/build-production.mjs`
 * 证据：`tests/compat/results/webpack-production.json`、`examples/webpack/dist/**`
 */
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedSdkVersion, runBundleInSandbox, summarizeStats } from './lib/verify-bundle.mjs';

const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const resultsDir = join(repoRoot, 'tests/compat/results');
const resultsFile = join(resultsDir, 'webpack-production.json');

/** 从 example 自己的 node_modules 解析（不保证一定提升到仓库根）。 */
const requireFromHere = createRequire(new URL('../package.json', import.meta.url));

async function loadWebpack() {
  try {
    return requireFromHere('webpack');
  } catch {
    // 回退：pnpm 把依赖提升到了仓库根时，从根解析。
    return createRequire(join(repoRoot, 'package.json'))('webpack');
  }
}

const webpack = await loadWebpack();
const configModule = await import(
  new URL('../webpack.config.mjs', import.meta.url).href
);

async function build() {
  const config = await configModule.default({}, { mode: 'production' });
  const compiler = webpack(config);
  const stats = await new Promise((resolve, reject) => {
    compiler.run((error, result) => {
      if (error) reject(error);
      else if (result === undefined) reject(new Error('webpack 没有返回 stats'));
      else resolve(result);
    });
  });
  await new Promise((resolve, reject) => {
    compiler.close((error) => (error ? reject(error) : resolve()));
  });
  return { config, stats };
}

/** 真实浏览器复核（可选；缺 Chromium 时记为 skipped，而不是 pass）。 */
async function browserCheck() {
  const chromePath = join(
    process.env['HOME'] ?? '',
    'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  );
  if (!existsSync(chromePath)) {
    return { status: 'skipped', reason: `未找到 Chromium：${chromePath}` };
  }
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ executablePath: chromePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(new URL('../dist/index.html', import.meta.url).href, { waitUntil: 'load' });
    const text = await page.evaluate('document.querySelector("#app")?.textContent ?? null');
    const exposed = await page.evaluate(
      'typeof globalThis.__WEBPACK_EXAMPLE__ === "object" && typeof globalThis.__WEBPACK_EXAMPLE__.createAssembly === "function"',
    );
    const version = await page.evaluate(
      'globalThis.__WEBPACK_EXAMPLE__?.SDK_VERSION ?? null',
    );
    const checks = {
      // 真实浏览器里读到的版本必须与仓库包清单一致（不是"包含某字符串"）。
      domRenderedSdkVersion: text === `web-report-sdk ${expectedSdkVersion()}`,
      sdkVersionMatchesPackage: version === expectedSdkVersion(),
      createAssemblyExposed: exposed === true,
      noPageErrors: pageErrors.length === 0,
    };
    return {
      status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
      chromePath,
      domText: text,
      pageErrors,
      checks,
    };
  } finally {
    await browser.close();
  }
}

const { config, stats } = await build();
const statsSummary = summarizeStats(stats, 'production');

// 让 `index.html` 能直接以 `file://` 打开复核（构建产物本身只含 main.js）。
mkdirSync(join(exampleRoot, 'dist'), { recursive: true });
cpSync(join(exampleRoot, 'index.html'), join(exampleRoot, 'dist/index.html'));

const bundlePath = join(config.output.path, 'main.js');
const sandbox = existsSync(bundlePath)
  ? await runBundleInSandbox(readFileSync(bundlePath, 'utf8'), bundlePath)
  : { status: 'fail', checks: { bundleEmitted: false }, bundlePath };

// 浏览器复核是**可选增强**：它抛错也不能吞掉沙箱证据，因此这里兜住并记为 fail（绝不记成 pass）。
let browser;
try {
  browser = await browserCheck();
} catch (error) {
  browser = {
    status: 'fail',
    reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

const result = {
  task: 'T30',
  generatedAt: new Date().toISOString(),
  engine: `webpack ${webpack.version ?? 'unknown'} / node ${process.version}`,
  command: 'node examples/webpack/scripts/build-production.mjs',
  entry: fileURLToPath(new URL('../src/main.js', import.meta.url)),
  build: statsSummary,
  sandbox,
  browser: { status: browser.status, checks: browser.checks, detail: browser },
  // Chromium 缺失（status === 'skipped'）不算失败，但浏览器一栏会如实写明 skipped。
  status:
    statsSummary.hasErrors === false && sandbox.status === 'pass' && browser.status !== 'fail'
      ? 'pass'
      : 'fail',
};

mkdirSync(resultsDir, { recursive: true });
writeFileSync(resultsFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(
  JSON.stringify(
    {
      webpack: result.engine,
      build: { hasErrors: statsSummary.hasErrors, sdkModules: statsSummary.sdkModules },
      sandbox: { status: sandbox.status, checks: sandbox.checks, sdkVersion: sandbox.sdkVersion },
      browser: result.browser,
      status: result.status,
      resultsFile,
    },
    null,
    2,
  ),
);

if (result.status !== 'pass') process.exitCode = 1;
