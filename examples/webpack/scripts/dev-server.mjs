/**
 * webpack 开发服务器（T30 兼容矩阵第 27 格）。
 *
 * 用 Node API 起 `webpack-dev-server`（`webpack.config.mjs` 的配置，**无 SDK 专属配置**），
 * 然后按接入方真实会走的路径验证：
 * 1. `GET /` → HTTP 200 且是 index.html；
 * 2. `GET /main.js` → HTTP 200、非空 JS；
 * 3. 把 `/main.js` 的内容喂给 `verify-bundle.mjs` 沙箱 → `SDK_VERSION` / `createAssembly` /
 *    最小路径 `createAssembly → init → track → flush → 接收方收到批次`；
 * 4. 可选：用真实 Chromium 打开页面，断言 DOM 里出现 `web-report-sdk <版本>`。
 *    浏览器一栏失败会让整体结论转红；缺 Chromium 记为 `skipped`（**合法豁免，但不计 pass**，
 *    见 `checks.browserEvidenceAccounted` 与结果里的 `skipped` 字段，判据在 #2 统一到
 *    `classifyBrowserEvidence`）。
 *
 * 运行：`node examples/webpack/scripts/dev-server.mjs`
 * 证据：`tests/compat/results/webpack-dev-server.json`
 */
import { get as httpGetRequest } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyBrowserEvidence, expectedSdkVersion, runBundleInSandbox } from './lib/verify-bundle.mjs';

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
      status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
    };
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(resultsFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ origin, checks, sandbox: sandbox.checks, browser, skipped: result.skipped, status: result.status, resultsFile }, null, 2));
    if (result.status !== 'pass') exitCode = 1;
  } finally {
    await server.stop();
  }
  return exitCode;
}

/** 真实浏览器复核（可选；缺 Chromium 记为 skipped，并带理由——由 #2 的白名单判据处置）。 */
async function browserCheck(origin) {
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
      domText: text,
      pageErrors,
      checks,
    };
  } finally {
    await browser.close();
  }
}

process.exitCode = await main();
