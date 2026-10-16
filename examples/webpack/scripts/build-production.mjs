/**
 * webpack 生产构建（T30 兼容矩阵第 26 格）。
 *
 * 流程：用 `examples/webpack/webpack.config.mjs`（无任何 SDK 专属配置）跑一次
 * `webpack --mode production`，产出 `examples/webpack/dist/main.js`，然后把**这个产物**
 * 喂给 `verify-bundle.mjs` 的沙箱：断言 `SDK_VERSION`、`createAssembly`，并真跑一次
 * `createAssembly → init → track → flush → 接收方收到批次`。
 *
 * 若本机能定位到**可启动的** Chromium（跨平台解析见 `lib/chromium-locate.mjs`：Playwright 官方的
 * `executablePath()` + 本机已装 `chromium-*` 构建 + `PW_CHROMIUM_EXE`，**真的启动成功**才算可用），
 * 额外用真实浏览器打开 `dist/index.html` 复核一次；**浏览器一栏失败会让整体结论转红**，
 * 定位不到（`skipped`）不影响沙箱结论，但会**显式记进 `skipped` 字段**（#2：不是算 pass）。
 * CI 的 gates job 不装浏览器，所以 `skipped` 在 CI 上是常态；未知状态（不是 pass/skipped）
 * 一律判红——那正是此前 `browser.status !== 'fail'` 的漏洞所在。
 *
 * `EXAMPLES_REQUIRE_BROWSER=1`（opt-in）：**声明"这次运行必须有真实浏览器"**。定位不到时状态
 * 从 `skipped` 变 `unavailable` ⇒ 整体 `fail` / exit 1。默认不设，因为 gates job 本就不装浏览器
 * （默认值要服务这个事实）；设了就是显式承担。
 *
 * 运行：`node examples/webpack/scripts/build-production.mjs`
 * 证据：`tests/compat/results/webpack-production.json`、`examples/webpack/dist/**`
 */
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 与 `tests/compat/**` 共用同一个幂等落盘器（T30 证据的易变字段口径只有一处实现）。
// 反向依赖已有先例：`tests/compat/receiver-contract-gate.test.ts` 直接 import 本目录的
// `lib/verify-bundle.mjs`。
import { writeJsonStable } from '../../../tests/compat/lib/stable-write.mjs';
import {
  classifyBrowserEvidence,
  expectedSdkVersion,
  runBundleInSandbox,
  summarizeStats,
} from './lib/verify-bundle.mjs';
import {
  requiredBrowserHint,
  resolveLaunchableChromium,
  unavailableReason,
  unavailableStatus,
} from './lib/chromium-locate.mjs';

/**
 * `chromium.executablePath()` 在"该版本期望的构建没装"时**仍会返回一条路径**（只是不存在），
 * 也可能在异常环境下直接抛错。这里只把它当作**一个候选**，取不到就交给后面的候选
 * （本机已装构建 / `PW_CHROMIUM_EXE`），不让它把整条复核打断。
 */
function safeExecutablePath(chromium) {
  try {
    return chromium.executablePath();
  } catch {
    return '';
  }
}

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

/** 真实浏览器复核（可选；定位不到 Chromium 时经 `classifyBrowserEvidence` 显式记账，不算 pass）。 */
async function browserCheck() {
  const { chromium } = await import('@playwright/test');
  // 跨平台定位：**不写死任何平台路径**（此前写死 `$HOME/Library/Caches/ms-playwright/chromium-1223/
  // chrome-mac-arm64/…`，于是 Linux CI 上这条复核**从来没跑过**，只留下一句 skipped）。
  // 定位规则见 `lib/chromium-locate.mjs` 头注释：Playwright 官方的 `executablePath()` +
  // 本机已装 `chromium-*` 构建（按 revision 从新到旧），**真的启动成功**才算可用。
  const located = await resolveLaunchableChromium({
    launch: (options) => chromium.launch(options),
    playwrightPath: safeExecutablePath(chromium),
  });
  if (located.browser === null) {
    // 默认 `skipped`（带理由的合法豁免）；`EXAMPLES_REQUIRE_BROWSER=1` 时是 `unavailable` ⇒ 判红。
    const status = unavailableStatus();
    const reason = `本机没有可用（能启动）的 Chromium：${unavailableReason(located.attempts)}`;
    if (status === 'unavailable') {
      console.error(`✗ 浏览器复核失败：${reason}\n  ${requiredBrowserHint()}`);
    }
    return { status, reason, attempts: located.attempts };
  }
  const browser = located.browser;
  const chromePath = located.executablePath;
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
      chromeSource: located.source,
      attempts: located.attempts,
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

// #2（2026-10-15）：此前这里写的是 `browser.status !== 'fail'`——于是 `skipped`（本机没有
// Chromium）**以及任何未知状态**都被算作 pass。现在改用共用的白名单判据
// （`classifyBrowserEvidence`：只有 `pass` 与**带理由**的 `skipped` 是"已交代"），
// skipped 从 pass 判据里**剔除**并在 `skipped` 字段里显式记账（见下）。
// 声明了 `EXAMPLES_REQUIRE_BROWSER=1` 时定位不到浏览器会返回 `unavailable`，
// 它不是白名单状态 ⇒ `accounted: false` ⇒ 整体 `fail` / exit 1（"声明即承担"）。
const evidence = classifyBrowserEvidence(browser);
if (evidence.skipped) {
  console.warn(`⚠ 浏览器复核已跳过（**不计入 pass 判据**，显式记账）：${evidence.reason}`);
}

const result = {
  task: 'T30',
  generatedAt: new Date().toISOString(),
  engine: `webpack ${webpack.version ?? 'unknown'} / node ${process.version}`,
  command: 'node examples/webpack/scripts/build-production.mjs',
  entry: fileURLToPath(new URL('../src/main.js', import.meta.url)),
  build: statsSummary,
  sandbox,
  browser: { status: browser.status, checks: browser.checks, attempts: browser.attempts, detail: browser },
  // #2：跳过项**逐一列出**（不是"没看见"，也不是"算过了"）。本脚本只有浏览器一项可跳过。
  skipped: evidence.skipped ? ['browser'] : [],
  status:
    statsSummary.hasErrors === false && sandbox.status === 'pass' && evidence.accounted
      ? 'pass'
      : 'fail',
};

// 幂等落盘：除易变字段（`generatedAt` = 本产物上次**实质变化**的时间；`sandbox.evaluatedMs`
// = 沙箱墙钟耗时）外内容未变则**不重写**文件——重跑 `pnpm examples:build` 不再弄脏工作区。
const write = writeJsonStable(resultsFile, result, ['generatedAt', 'sandbox.evaluatedMs']);
console.log(
  JSON.stringify(
    {
      webpack: result.engine,
      build: { hasErrors: statsSummary.hasErrors, sdkModules: statsSummary.sdkModules },
      sandbox: { status: sandbox.status, checks: sandbox.checks, sdkVersion: sandbox.sdkVersion },
      browser: { status: evidence.status, accounted: evidence.accounted, reason: evidence.reason },
      skipped: result.skipped,
      status: result.status,
      resultsFile,
      resultsWritten: write.written,
      resultsWriteReason: write.reason,
    },
    null,
    2,
  ),
);

if (result.status !== 'pass') process.exitCode = 1;
