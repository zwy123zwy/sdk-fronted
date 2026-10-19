/**
 * T30 接入方式：**Vite 开发服务器**（指南第 4.2 节明确要求"开发服务器"也要能直接导入）。
 *
 * 现有 `examples/vite` 只被 `pnpm examples:build`（生产构建）覆盖，**开发服务器没有任何验证**。
 * 本脚本以 `examples/vite` 为接入方，程序化起 dev server，然后：
 * 1. 取回 `index.html`；
 * 2. 取回 `/src/main.ts` 的**转换结果**，从中找出 Vite 对 `@web-report-sdk/browser` 的解析目标；
 * 3. 取回那个解析目标（HTTP 200 + 非空 JS）——证明"不需要额外配置即可导入"在 dev server 下成立；
 * 4. 用真实 Chromium 打开 dev server 页面，断言 DOM 里出现 `SDK_VERSION`（端到端）。
 *
 * 运行：`node tests/compat/scripts/vite-dev-server.mjs`；结论写 `results/vite-dev-server.json`。
 *
 * 跨平台（本轮修）：第 4 步此前用一条**写死的 macOS 路径**
 * （`$HOME/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/…`）。在 Linux CI 上那条路径
 * 必然不存在 —— `chromium.launch()` 直接抛 `Executable doesn't exist`，脚本在"证据没落地"的状态下
 * 失败，而上一轮的 `results/vite-dev-server.json` 仍留在原处。现在改走
 * `scripts/lib/chromium-launch.mjs`（复用 `examples/webpack/scripts/lib/chromium-locate.mjs` 的
 * 跨平台定位 + 真启动）；**定位不到时不假装有**：`browser.status="blocked"`、整体
 * `status="blocked"`（HTTP 检查有失败则 `fail`）、终端显式告警、`exit 1`。
 * 显式指定可执行文件用 `PW_CHROMIUM_EXE`（本脚本不再单独认别的名字）。
 */
import { get as httpGetRequest } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { browserEvidence, launchChromium, warnUnavailable } from './lib/chromium-launch.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const viteRoot = join(repoRoot, 'examples/vite');
const resultsDir = join(repoRoot, 'tests/compat/results');
const resultFile = join(resultsDir, 'vite-dev-server.json');

/** Vite 只装在 `examples/vite`（接入方），所以按文件路径导入，而不是裸包名。 */
const viteEntry = join(viteRoot, 'node_modules/vite/dist/node/index.js');

/** 落证据：成功与"本机没有浏览器"都落（不留上一次的陈旧结论）。 */
function writeResult(result) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
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

const { createServer } = await import(pathToFileURL(viteEntry).href);

const server = await createServer({
  root: viteRoot,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});

let exitCode = 0;
try {
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  const checks = {};
  const html = await httpGet(`${origin}/`);
  checks.indexHtml = html.status === 200 && html.body.includes('src/main.ts');

  const main = await httpGet(`${origin}/src/main.ts`);
  checks.mainTransformed = main.status === 200;
  // Vite dev 把裸导入改写成 dev 可解析的 URL。实测（vite 8.3.4）：
  // `@web-report-sdk/browser` → `/@fs/<仓库>/packages/browser/dist/index.js`
  // ——即解析到 **dist**（不是 src），所以接入方首次跑 dev server 之前必须先 build SDK 仓库。
  const specifier = /from\s+"([^"]+)"/u.exec(main.body)?.[1] ?? /from\s+'([^']+)'/u.exec(main.body)?.[1];
  checks.specifierResolved =
    typeof specifier === 'string' && (specifier.startsWith('/') || specifier.startsWith('http'));
  checks.resolvedToDistArtifact =
    typeof specifier === 'string' && specifier.includes('packages/browser/dist/');
  const resolvedUrl = typeof specifier === 'string' ? new URL(specifier, origin).href : '';
  const resolved = resolvedUrl === '' ? { status: 0, body: '' } : await httpGet(resolvedUrl);
  checks.resolvedModuleServed = resolved.status === 200 && resolved.body.length > 0;
  checks.resolvedModuleExportsSdkVersion =
    resolved.body.includes('SDK_VERSION') || resolved.body.includes('createAssembly');

  /** dev server 起的版本（两种结局都要写进证据）。 */
  const viteVersion = (
    await import(pathToFileURL(join(viteRoot, 'node_modules/vite/package.json')).href, {
      with: { type: 'json' },
    })
  ).default.version;

  const located = await launchChromium((line) => console.log(line));
  if (located.browser === null) {
    // **不假装有浏览器**：dev server 的模块解析检查照常落盘，浏览器那格显式记 blocked。
    const warning = warnUnavailable(located, 'T30 Vite 开发服务器（真实浏览器渲染）');
    const httpChecksPass = Object.values(checks).every(Boolean);
    const result = {
      task: 'T30',
      generatedAt: new Date().toISOString(),
      engine: `vite ${viteVersion}`,
      origin,
      resolvedSpecifier: specifier ?? null,
      resolvedUrl,
      // HTTP 那几项照实保留（它们**不需要**浏览器），再补一条 `browserAvailable: false`：
      // 浏览器结论**没有**产出，`summarize.mjs` 会据此落一格 `fail`，不会因为 checks 里没东西
      // 而从矩阵里静默消失。
      checks: { ...checks, browserAvailable: false },
      browser: browserEvidence(located),
      status: httpChecksPass ? 'blocked' : 'fail',
      warning,
    };
    writeResult(result);
    console.log(JSON.stringify({ check: result.checks, resolvedUrl, status: result.status }, null, 2));
    exitCode = 1;
  } else {
    const browser = located.browser;
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => {
        pageErrors.push(String(error));
      });
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await page.waitForFunction(
        'document.querySelector("#app") && document.querySelector("#app").textContent.includes("web-report-sdk")',
        undefined,
        { timeout: 10_000 },
      );
      const text = await page.evaluate('document.querySelector("#app").textContent');
      checks.browserRenderedSdkVersion = typeof text === 'string' && text.includes('web-report-sdk');
      checks.noPageErrors = pageErrors.length === 0;

      const result = {
        task: 'T30',
        generatedAt: new Date().toISOString(),
        engine: `vite ${viteVersion}`,
        origin,
        resolvedSpecifier: specifier ?? null,
        resolvedUrl,
        domText: text,
        pageErrors,
        checks,
        browser: browserEvidence(located),
        status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
      };
      writeResult(result);
      console.log(JSON.stringify({ check: result.checks, resolvedUrl, domText: text }, null, 2));
      if (result.status !== 'pass') exitCode = 1;
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}

process.exitCode = exitCode;
