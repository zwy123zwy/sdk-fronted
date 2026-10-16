/**
 * webpack 开发服务器（T30 兼容矩阵第 27 格）。
 *
 * 用 Node API 起 `webpack-dev-server`（`webpack.config.mjs` 的配置，**无 SDK 专属配置**），
 * 然后按接入方真实会走的路径验证：
 * 1. `GET /` → HTTP 200 且是 index.html；
 * 2. `GET /main.js` → HTTP 200、非空 JS；
 * 3. 把 `/main.js` 的内容喂给 `verify-bundle.mjs` 沙箱 → `SDK_VERSION` / `createAssembly` /
 *    最小路径 `createAssembly → init → track → flush → 接收方收到批次`；
 * 4. 可选：用**跨平台定位到的、能启动的** Chromium 打开页面，断言 DOM 里出现 `web-report-sdk <版本>`
 *    （定位规则见 `lib/chromium-locate.mjs`）。浏览器一栏失败会让整体结论转红；定位不到记为
 *    `skipped`（**合法豁免，但不计 pass**，见 `checks.browserEvidenceAccounted` 与结果里的
 *    `skipped` 字段，判据在 #2 统一到 `classifyBrowserEvidence`）。
 *    设 `EXAMPLES_REQUIRE_BROWSER=1`（opt-in）时定位不到变 `unavailable` ⇒ 判红（"声明即承担"）。
 *
 * 运行：`node examples/webpack/scripts/dev-server.mjs`
 * 证据：`tests/compat/results/webpack-dev-server.json`
 */
import { get as httpGetRequest } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 与 `tests/compat/**` 共用同一个幂等落盘器（易变字段口径只有一处实现）；反向依赖已有先例，
// 见 `build-production.mjs` 的同一处注释。
import { writeJsonStable } from '../../../tests/compat/lib/stable-write.mjs';
import { classifyBrowserEvidence, expectedSdkVersion, runBundleInSandbox } from './lib/verify-bundle.mjs';
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

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const resultsDir = join(repoRoot, 'tests/compat/results');
const resultsFile = join(resultsDir, 'webpack-dev-server.json');

const requireFromHere = createRequire(new URL('../package.json', import.meta.url));

async function loadBundler() {
  try {
    return {
      webpack: requireFromHere('webpack'),
      createServer: requireFromHere('webpack-dev-server').default ?? requireFromHere('webpack-dev-server'),
      from: 'examples/webpack/node_modules',
    };
  } catch {
    const requireFromRoot = createRequire(join(repoRoot, 'package.json'));
    return {
      webpack: requireFromRoot('webpack'),
      createServer: requireFromRoot('webpack-dev-server').default ?? requireFromRoot('webpack-dev-server'),
      from: 'repo root node_modules（pnpm 提升）',
    };
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = httpGetRequest(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ status: response.statusCode, body, headers: response.headers });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

const { webpack, createServer, from } = await loadBundler();
const configModule = await import(new URL('../webpack.config.mjs', import.meta.url).href);

async function main() {
  const config = await configModule.default({}, { mode: 'development' });
  const { devServer, ...compilerConfig } = config;
  const compiler = webpack(compilerConfig);
  // webpack-dev-server v5 的签名是 `new Server(devServerOptions, compiler)`，
  // 且导出的是 **class**（与 vite 的 `createServer(config)` 完全不同）。
  const server = new createServer({ ...devServer, port: 0 }, compiler);

  const checks = {};
  let exitCode = 0;
  try {
    await server.start();
    const { port } = server.server.address();
    const origin = `http://127.0.0.1:${port}`;

    const html = await httpGet(`${origin}/`);
    checks.indexHtml200 = html.status === 200;
    checks.indexHtmlIsExample = html.body.includes('id="app"');

    const bundle = await httpGet(`${origin}/main.js`);
    checks.bundle200 = bundle.status === 200;
    checks.bundleNonEmpty = bundle.body.length > 1000;
    checks.bundleIsJs = /javascript|ecmascript/u.test(String(bundle.headers['content-type'] ?? ''));

    const sandbox = await runBundleInSandbox(bundle.body, `${origin}/main.js`);
    checks.sandboxStatusPass = sandbox.status === 'pass';

    const browser = await browserCheck(origin);
    // #2（2026-10-15）：此前这里是 `checks.browserStatusPass = browser.status !== 'fail'`，
    // 于是 `skipped`（本机没有 Chromium）**以及任何未知状态**都进了 pass 判据。
    // 现在只接受共用白名单判据（`classifyBrowserEvidence`：`pass` 或**带理由**的 `skipped`），
    // 且把 skipped **显式记账**到 `skipped` 字段——它是合法豁免，但不是"通过"。
    const evidence = classifyBrowserEvidence(browser);
    checks.browserEvidenceAccounted = evidence.accounted;
    if (evidence.skipped) {
      console.warn(`⚠ 浏览器复核已跳过（**不计入 pass 判据**，显式记账）：${evidence.reason}`);
    }

    const result = {
      task: 'T30',
      generatedAt: new Date().toISOString(),
      engine: `webpack ${webpack.version ?? 'unknown'} + webpack-dev-server / node ${process.version}`,
      command: 'node examples/webpack/scripts/dev-server.mjs',
      webpackResolvedFrom: from,
      origin,
      checks,
      http: {
        indexStatus: html.status,
        bundleStatus: bundle.status,
        bundleBytes: Buffer.byteLength(bundle.body, 'utf8'),
        bundleContentType: bundle.headers['content-type'] ?? null,
      },
      sandbox,
      browser,
      // #2：跳过项逐一列出（本脚本只有浏览器一项可跳过）。
      skipped: evidence.skipped ? ['browser'] : [],
      // 定位过程留全：试过哪些路径、各自真实报错（"没有浏览器"这句话必须可审计）。
      browserAttempts: browser.attempts ?? [],
      status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
    };
    // 幂等落盘：易变字段清单比生产构建多两项——`origin` 与 `sandbox.bundlePath` 含
    // `port: 0` 分配到的**随机端口**，逐次必变；`generatedAt` = 本产物上次**实质变化**的时间。
    const write = writeJsonStable(resultsFile, result, [
      'generatedAt',
      'origin',
      'sandbox.bundlePath',
      'sandbox.evaluatedMs',
    ]);
    console.log(JSON.stringify({ origin, checks, sandbox: sandbox.checks, browser, skipped: result.skipped, status: result.status, resultsFile, resultsWritten: write.written }, null, 2));
    if (result.status !== 'pass') exitCode = 1;
  } finally {
    await server.stop();
  }
  return exitCode;
}

/** 真实浏览器复核（可选；定位不到 Chromium 时经 `classifyBrowserEvidence` 显式记账，不算 pass）。 */
async function browserCheck(origin) {
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
    // 默认 `skipped`（带理由的合法豁免）；`EXAMPLES_REQUIRE_BROWSER=1` 时是 `unavailable`
    // ⇒ `classifyBrowserEvidence` 不给 accounted ⇒ `checks.browserEvidenceAccounted=false` ⇒ 判红。
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
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    await page.waitForFunction(
      'document.querySelector("#app") && document.querySelector("#app").textContent.includes("web-report-sdk")',
      undefined,
      { timeout: 10_000 },
    );
    const text = await page.evaluate('document.querySelector("#app").textContent');
    const checks = {
      // 不只看"包含 web-report-sdk"，而是要求渲染出了真实版本号。
      domRenderedSdkVersion: text === `web-report-sdk ${expectedSdkVersion()}`,
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

process.exitCode = await main();
