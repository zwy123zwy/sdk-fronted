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
 * - 仓库锁定的 `@playwright/test@1.64.0` 期望的浏览器本机**没装**（需 chromium-1248），
 *   本机只有 chromium-1223，因此用 `executablePath` 指向它（只读使用已装缓存，不安装任何东西）；
 * - 页面由本脚本内的 node http 服务提供（同源，因此不涉及 CORS 差异）；
 *   接收方就是脚本内的 `/ingest`，收到什么写进结果 JSON——**不伪造任何数字**；
 * - 只跑 Chromium：Firefox 必须在 DSH 文件沙箱之外运行、WebKit 会泄漏辅助进程且存储写入被沙箱
 *   静默阻塞（见 `docs/reports/handover.md` 第 2 节 T29 小节），因此它们的格子归 T29。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { createBatchIngestHandler } from '../lib/ingest-receiver.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const iifePath = join(repoRoot, 'packages/browser/dist/web-report-sdk.iife.js');
const resultsDir = join(repoRoot, 'tests/compat/results');

/** 本机已装的 Chromium（仓库锁定的 1.64.0 期望 chromium-1248，本机没有）。 */
const macChrome =
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const candidates = [
  process.env['T30_CHROMIUM_PATH'],
  join(
    process.env['HOME'] ?? '',
    'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
    macChrome,
  ),
  join(
    process.env['HOME'] ?? '',
    'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64',
    macChrome,
  ),
].filter((value) => typeof value === 'string' && value.length > 0);

function resolveExecutable() {
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // 继续找下一个
    }
  }
  return undefined;
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
  const executablePath = resolveExecutable();
  if (executablePath === undefined) {
    throw new Error('本机找不到可用的 Chromium 可执行文件（见脚本内 candidates）');
  }
  const origin = await startServer();
  const browser = await chromium.launch({ executablePath });
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
      playwright: '1.64.0（仓库锁定；浏览器用 executablePath 指向本机 chromium-1223）',
      executablePath,
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
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, 'browser-core-path.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
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
