/**
 * T30 真实浏览器核心路径（Chromium）。
 *
 * 运行：
 * ```
 * node tests/compat/scripts/browser-core-path.mjs
 * ```
 * 结论写 `tests/compat/results/browser-core-path.json`。
 *
 * 口径与边界：
 * - **跨平台定位**（本轮修）：此前写死一条 macOS 专属路径
 *   `$HOME/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/…`，
 *   在 Linux CI（`~/.cache/ms-playwright/…`、`chrome-linux/chrome`）上**必然不存在**——脚本会直接抛
 *   "找不到可执行文件"，而上一轮落盘的证据 JSON 还留在原处（看起来像"有证据"）。现在通过
 *   `scripts/lib/chromium-launch.mjs` 复用 `examples/webpack/scripts/lib/chromium-locate.mjs` 的跨平台
 *   定位（`PW_CHROMIUM_EXE` → `chromium.executablePath()` → 本机缓存，**真启动成功**才算可用）；
 * - 定位不到时**不假装有**：证据 JSON 写成 `status: "blocked"` + `browser.status: "blocked"` +
 *   逐条尝试与真实报错，终端打显式告警，**exit 1**（`checks.browserAvailable=false` 会让
 *   `scripts/summarize.mjs` 在矩阵里落一格 `fail`，不会静默消失）；
 * - 显式指定可执行文件的环境变量统一为 **`PW_CHROMIUM_EXE`**（与 `tests/e2e/lib/browsers.mjs`、
 *   `examples/webpack` 同一个名字）。本脚本此前单独认一个未文档化的 `T30_CHROMIUM_PATH`：
 *   **旧名仍然识别**（先打一次弃用告警，见 `scripts/lib/chromium-launch.mjs` 的裁定 (c) 注释），
 *   新名优先；不静默移除旧名，是因为静默失效的症状是"没有证据/跳过"而不是报错。
 * - 页面由本脚本内的 node http 服务提供（同源，因此不涉及 CORS 差异）；
 *   接收方就是脚本内的 `/ingest`，收到什么写进结果 JSON——**不伪造任何数字**；
 * - 只跑 Chromium：Firefox 必须在 DSH 文件沙箱之外运行、WebKit 会泄漏辅助进程且存储写入被沙箱
 *   静默阻塞（见 `docs/reports/handover.md` 第 2 节 T29 小节），因此它们的格子归 T29。
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { redactPaths } from '../lib/redact-paths.mjs';
import { createBatchIngestHandler } from '../lib/ingest-receiver.mjs';
import { browserEvidence, launchChromium, warnUnavailable } from './lib/chromium-launch.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const iifePath = join(repoRoot, 'packages/browser/dist/web-report-sdk.iife.js');
const resultsDir = join(repoRoot, 'tests/compat/results');
const resultFile = join(resultsDir, 'browser-core-path.json');

/**
 * 落一份证据。**成功与"本机没有浏览器"都要落**：允许"没有证据"这个结论，
 * 但不允许上次的 `pass` 留在原处被当成本次结论。
 */
function writeResult(result) {
  mkdirSync(resultsDir, { recursive: true });
  // 落盘前脱敏：证据要提交进仓库，绝对路径会泄露本机用户名（口径见 `lib/redact-paths.mjs`）。
  writeFileSync(resultFile, `${JSON.stringify(redactPaths(result), null, 2)}\n`, 'utf8');
}

/** 页面上跑的脚本（字符串：浏览器全局不出现在 node 侧的类型/lint 语境里）。 */
const pageScript = String.raw`
window.__COMPAT = { features: {}, steps: [], windowErrors: [], listenTypes: [] };
// 浏览器侧自证：真实未捕获异常确实触发了 window 的 error 事件（用于与 SDK 是否采集对照）。
window.addEventListener('error', function (event) {
  window.__COMPAT.windowErrors.push(String(event.message));
});
// 记录 SDK 在 window 上注册了哪些事件监听（判断"监听器是否真的装上"）。
(function () {
  var original = window.addEventListener.bind(window);
  window.addEventListener = function (type, listener, options) {
    window.__COMPAT.listenTypes.push(String(type));
    return original(type, listener, options);
  };
})();
(function () {
  var features = window.__COMPAT.features;
  features.CompressionStream = typeof CompressionStream === 'function';
  features.webLocks = typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
  features.broadcastChannel = typeof BroadcastChannel === 'function';
  features.indexedDB = typeof indexedDB !== 'undefined';
  features.sendBeacon = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
  features.randomUUID = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
  features.cookieEnabled = navigator.cookieEnabled;

  var sdk = window.WebReportSDK;
  window.__COMPAT.sdkVersion = sdk && sdk.SDK_VERSION;

  var assembly = sdk.createAssembly({
    appId: 't30-compat',
    endpoint: window.location.origin + '/ingest',
    token: 't30-token',
    env: 'test',
    release: '0.0.0',
    consent: 'granted',
    startHealthReporting: false,
    plugins: { http: true, error: true }
  });
  window.__COMPAT.steps.push('assembly');
  assembly.init();
  window.__COMPAT.steps.push('init');
  assembly.client.track('compat_probe', { dimensions: { probe: 'core-path' } });
  window.__COMPAT.steps.push('track');
  assembly.client.captureError(new Error('compat-capture-error'));
  window.__COMPAT.steps.push('captureError');
  // 真实未捕获异常：应当触发 window 的 error 事件（这是 happy-dom 下判不了的那条路径）。
  setTimeout(function () { throw new Error('compat-uncaught'); }, 0);
  window.__COMPAT.steps.push('uncaughtScheduled');
  window.__COMPAT.flush = function () { assembly.flush(); };
  window.__COMPAT.trackAgain = function () {
    assembly.client.track('compat_probe_2', { dimensions: { probe: 'second-batch' } });
  };
  window.__COMPAT.destroy = function () { assembly.destroy(); };
  window.__COMPAT.done = true;
})();
`;

/**
 * 接收端（HTTP `POST /ingest`）：**按 `batch.schema.json` 校验结构**（D-06）。
 * 与判别性用例共用 `tests/compat/lib/ingest-receiver.mjs` 的同一实现——"收到字节"不等于
 * "收到合法批次"，违约批次一律 400 拒收并逐条记录 Ajv 错误。
 */
const ingest = createBatchIngestHandler();
/** 收到的全部批次（含被拒的）；`ingest` 原地追加，别名保持下面的读取逻辑不变。 */
const batches = ingest.batches;
let server;

async function startServer() {
  const iife = readFileSync(iifePath, 'utf8');
  server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/sdk.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(iife);
      return;
    }
    if (ingest.handle(request, response)) return;
    if (url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>T30</title></head><body>' +
          '<script src="/sdk.js"></script><script>' +
          pageScript +
          '</script></body></html>',
      );
      return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function main() {
  // 跨平台定位 + **真启动**（候选存在不算数，起不来不算可用）。日志逐候选打进 stdout。
  const located = await launchChromium((line) => console.log(line));
  if (located.browser === null) {
    // 显式记账"本机没有浏览器"：证据 JSON 写 blocked（覆盖上一次的 pass，不留陈旧结论）、
    // 终端打逐条尝试与补测步骤、退出码 1。
    const warning = warnUnavailable(located, 'T30 真实浏览器核心路径（/ingest）');
    writeResult({
      task: 'T30',
      generatedAt: new Date().toISOString(),
      engine: 'chromium',
      browser: browserEvidence(located),
      checks: { browserAvailable: false },
      status: 'blocked',
      warning,
    });
    process.exitCode = 1;
    return;
  }
  const browser = located.browser;
  const origin = await startServer();
  const checks = {};
  let pageResult;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => {
      consoleErrors.push(String(error));
    });
    // 采集真实 `window` 的 error 事件，判断 SDK 是否产出了 web_js_error。
    await page.goto(`${origin}/page`, { waitUntil: 'load' });
    await page.waitForFunction('window.__COMPAT && window.__COMPAT.done === true', undefined, {
      timeout: 10_000,
    });
    // C05 错误插件按 1 秒去重窗聚合（`DEFAULT_DEDUP_WINDOW_MS = 1000`），并且只在窗口到期时
    // 结算——因此必须等过一个窗口再 flush，否则会把"还没到结算时刻"误判成"没采集到"。
    await page.waitForTimeout(2500);
    await page.evaluate('window.__COMPAT.flush()');
    // 等接收方确实收到第一批（不猜时长，按条件等）。
    let deadline = Date.now() + 10_000;
    while (batches.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    // 第二批：第一批的响应用来测 `X-Server-Time` → C04 时钟校准（校准状态在下一次组批时可见）。
    await page.evaluate('window.__COMPAT.trackAgain()');
    await page.evaluate('window.__COMPAT.flush()');
    deadline = Date.now() + 10_000;
    while (batches.length < 2 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    pageResult = await page.evaluate('window.__COMPAT');

    const eventNames = batches.flatMap((batch) =>
      Array.isArray(batch.body?.events)
        ? batch.body.events.map((event) => String(event.event_name))
        : [],
    );
    // 消息文本用来区分「captureError 手动上报」与「真实未捕获异常」两条路径
    // （只看 event_name 会把两者混为一谈，是假阳性）。
    const messages = batches.flatMap((batch) =>
      Array.isArray(batch.body?.events)
        ? batch.body.events.map((event) =>
            String(event.dimensions?.message ?? event.attachment ?? ''),
          )
        : [],
    );
    checks.serverReceivedBatch = batches.length > 0;
    // D-06：接收端按 `batch.schema.json` 校验结构。反空转：必须在真收到批次、且**一次都没被
    // 拒收**的前提下才算过——"收到字节"不等于"收到合法批次"。
    checks.batchSchemaValid = ingest.rejected.length === 0 && ingest.accepted.length > 0;
    checks.corePath = ['assembly', 'init', 'track', 'captureError'].every((step) =>
      pageResult.steps.includes(step),
    );
    checks.sdkVersion = typeof pageResult.sdkVersion === 'string';
    checks.trackedEventDelivered = eventNames.includes('compat_probe');
    checks.captureErrorDelivered = messages.some((message) =>
      message.includes('compat-capture-error'),
    );
    checks.uncaughtErrorDelivered = messages.some((message) =>
      message.includes('compat-uncaught'),
    );
    checks.browserWindowErrorFired = pageResult.windowErrors.some((message) =>
      message.includes('compat-uncaught'),
    );
    checks.protocolVersion = String(batches[0]?.body?.protocol_version ?? '') === '1';
    checks.appId = String(batches[0]?.body?.app_id ?? '') === 't30-compat';
    checks.secondBatchDelivered = batches.length >= 2;
    // `X-Server-Time` → C04 时钟校准端口（装配根接线义务 ③）：第一批的响应校准后，
    // 第二批的批次头应当带上 `clock_calibrated: true`。
    checks.clockCalibrated = batches[1]?.body?.clock_calibrated === true;

    const result = {
      task: 'T30',
      generatedAt: new Date().toISOString(),
      engine: 'chromium',
      // 浏览器记账（成功也写）：用的是哪个驱动、哪个二进制、怎么定位到的、试过哪些候选。
      browser: browserEvidence(located),
      playwright: browserEvidence(located).driver,
      executablePath: located.executablePath,
      browserVersion: browser.version(),
      features: pageResult.features,
      steps: pageResult.steps,
      listenTypes: pageResult.listenTypes,
      windowErrors: pageResult.windowErrors,
      batchesReceived: batches.length,
      acceptedBatches: ingest.accepted.length,
      rejectedBatches: ingest.rejected.map((record) => ({
        at: record.at,
        bytes: record.bytes,
        code: record.code,
        errors: record.errors,
      })),
      eventNames,
      messages,
      firstBatch: batches[0] ?? null,
      pageErrors: consoleErrors,
      checks,
      status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
    };
    writeResult(result);
    console.log(JSON.stringify({ checks, browserVersion: result.browserVersion, batches: batches.length, eventNames, features: result.features }, null, 2));
    if (result.status !== 'pass') process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

await main();
