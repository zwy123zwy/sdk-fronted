/**
 * webpack 示例的产物验证库。
 *
 * 两个脚本（生产构建 / 开发服务器）都必须回答同一个问题：**bundler 吐出来的那个 bundle
 * 里，`web-report-sdk` 是不是真的能跑**。所以验证逻辑只写一次，两处共用：
 *
 * 1. 把 bundle 源码喂进 `node:vm` 的沙箱（`window`/`self`/`document`/最小 DOM 面）；
 * 2. 断言全局 `SDK_VERSION` 是字符串（值必须与仓库产物一致，不是"包含字符串"就算过）；
 * 3. 断言 `createAssembly` 是函数，并**真跑一次最小路径**：`createAssembly` → `init()` →
 *    `client.track()` → `flush()`，注入传输替身，断言接收方**真收到批次**且事件名正确；
 *    并进一步要求该批次**通过 `docs/contracts/schemas/batch.schema.json` 的 Ajv 校验**
 *    （D-06：只解析不校验结构会让违约批次被当成"送达成功"）。
 *
 * 第 3 条是关键：只验证"能读到 SDK_VERSION"无法区分"真的打进了依赖"与"只是常量被内联"。
 * 注入 `transport` 走的是运行期工厂参数，所以能证明 SDK 的装配与上报链路在 bundle 里是活的。
 *
 * ## 复用（#1/#2，2026-10-15）
 *
 * `runBundleInSandbox` 只做"**bundle 文本**喂沙箱"，因此 bundler 无关：vite 的生产产物
 * （`examples/vite/scripts/verify-build.mjs`）与 script-tag 的 IIFE（`examples/script-tag/check.mjs`、
 * `examples/script-tag/scripts/verify-build.mjs`）都用它，只通过 `options` 换"入口把符号挂在哪个
 * 全局键上"。`installBrowserGlobals()` 是同一份最小浏览器面的"装到宿主 `globalThis`"版本，
 * 给 node-import 示例（真实 `import` 产物、没有 bundle 文本）用。
 * `expectedSdkVersion()` 给"版本必须与包清单一致"这条断言用（五个例子共用同一份真值）。
 * **最小投递路径只实现一次**，四个例子共用同一套断言（含 Ajv 契约校验）。
 *
 * `classifyBrowserEvidence()`（#2，2026-10-15）也是**唯一实现**：两个 webpack 脚本此前各自写
 * `browser.status !== 'fail'`，等于把 `skipped` 与任何未知状态算成 pass；现在两处共用一份白名单判据。
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { inspectBatchText } from '../../../../tests/compat/lib/batch-contract.mjs';

/** 实际跑最小路径时用的假端点（`transport` 替身会截住，绝不出网）。 */
export const FAKE_ENDPOINT = 'https://collect.invalid/ingest';

/**
 * 接收方替身：记录 SDK 发来的每一次请求，并记录**拒收**（`rejections`）。
 *
 * 口径（D-06）：它自称"接收方真收到批次"，因此必须按 `batch.schema.json` 校验结构——
 * 只解析不校验会让 D-01（`common.page_id: null`）这类违约批次被当成"送达成功"。
 */
export function createUploadStub() {
  const requests = [];
  const rejections = [];
  return {
    requests,
    rejections,
    port: {
      send(request) {
        requests.push(request);
        const body = typeof request?.body === 'string' ? request.body : '';
        const outcome = inspectBatchText(body);
        if (!outcome.ok) {
          rejections.push({ body, code: outcome.code, errors: outcome.errors });
        }
        return Promise.resolve({ status: outcome.ok ? 200 : 400, headers: {} });
      },
    },
    accepted: () => requests.length - rejections.length,
    allAccepted: () => requests.length > 0 && rejections.length === 0,
  };
}

/**
 * 最小 DOM 面：bundle 入口只做 `document.querySelector('#app').textContent = ...`。
 *
 * `querySelectorAll` 与 `MutationObserver` 是给 **vite 产物**的：vite 会在入口前注入一段
 * modulepreload polyfill（`document.createElement('link').relList` → `querySelectorAll` →
 * `new MutationObserver(...)`），webpack 产物不碰它们。两个桩都是空实现（不发真实请求、不观察）。
 */
function createDocumentStub() {
  const app = { textContent: '' };
  return {
    documentElement: { lang: 'zh-CN' },
    querySelector: (selector) => (selector === '#app' ? app : null),
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {},
    removeEventListener() {},
    get cookie() {
      return '';
    },
    get visibilityState() {
      return 'visible';
    },
    get readyState() {
      return 'complete';
    },
    __app: app,
  };
}

/** `MutationObserver` 的空替身（vite 的 modulepreload polyfill 会 `new` 一个）。 */
function MutationObserverStub() {
  this.observe = () => {};
  this.disconnect = () => {};
  this.takeRecords = () => [];
}

/**
 * 最小浏览器全局面：`window`/`self`/`document`/`setTimeout`/`fetch` 的空实现。
 *
 * 刻意**不提供** `CompressionStream`、`crypto`、`navigator.locks`、`indexedDB`——
 * 这些都属于 T30 降级矩阵的格子，不在这里重复；这里只要最小路径能跑通。
 */
export function createBrowserSandbox() {
  const document = createDocumentStub();
  const sandbox = {
    document,
    MutationObserver: MutationObserverStub,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    console,
    fetch: () => Promise.reject(new Error('sandbox: 不应发起真实网络请求')),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/**
 * 把最小浏览器全局面**临时**装到宿主的 `globalThis` 上，并返回 `restore()`。
 *
 * 用途（#2）：`examples/node-import` 的用例要**真实 `import` 产物**（不是 bundle 文本），
 * 然后在 Node 里跑 `createAssembly → init → track → flush`；Node 没有 DOM，所以借用同一份面。
 * **必须** `restore()`，否则会污染同进程里的其它用例。
 */
export function installBrowserGlobals() {
  const previous = {
    window: globalThis.window,
    self: globalThis.self,
    document: globalThis.document,
  };
  const document = createDocumentStub();
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = document;
  const restoreKey = (key, value) => {
    if (value === undefined) {
      delete globalThis[key];
    } else {
      globalThis[key] = value;
    }
  };
  return {
    restore: () => {
      restoreKey('window', previous.window);
      restoreKey('self', previous.self);
      restoreKey('document', previous.document);
    },
  };
}

/**
 * 在 `node:vm` 沙箱里执行 **bundle 文本**，并跑一次最小投递路径。
 *
 * `options`（全部可选，默认值保持 webpack 例子的原行为）：
 *   - `exposedKey`：入口把 SDK 符号挂在沙箱全局的哪个键上（vite 用 `__VITE_EXAMPLE__`）；
 *   - `appId` / `probeEventName` / `probeDimensions`：最小路径用的上报身份与探针事件。
 *
 * 求值失败**不再直接抛出**：`checks.bundleEvaluated` 是真实检查（#3），失败时转 `false`
 * 并把原因记进 `evaluationError`，让"产物到底有没有被求值"变成可观测、可失败的检查项。
 */
export async function runBundleInSandbox(code, bundlePath, options = {}) {
  const exposedKey = options.exposedKey ?? '__WEBPACK_EXAMPLE__';
  const appId = options.appId ?? 'webpack-compat';
  const probeEventName = options.probeEventName ?? 'webpack_probe';
  const probeDimensions = options.probeDimensions ?? { probe: 'webpack-bundle' };

  const sandbox = createBrowserSandbox();
  const document = sandbox.document;

  const start = Date.now();
  vm.createContext(sandbox);
  let evaluated = false;
  let evaluationError = null;
  try {
    vm.runInContext(code, sandbox, { filename: bundlePath });
    evaluated = true;
  } catch (error) {
    evaluationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const evaluatedMs = Date.now() - start;

  // 取用姿势与接入方一致：bundle 是**自执行的**，SDK 的符号不会平铺到全局，
  // 而是入口自己在 `globalThis.__WEBPACK_EXAMPLE__`（或 `options.exposedKey`）上暴露出来。
  const exposed = sandbox[exposedKey];
  const sdkVersion = exposed?.SDK_VERSION;
  const createAssembly = exposed?.createAssembly;
  const appText = document.__app.textContent;
  const expectedVersion = expectedSdkVersion();

  const checks = {
    // #3（2026-10-15）：此前是字面量 `true`——恒真、什么都证明不了。现在它**可失败**：
    // 产物模块级求值抛错 → false（并记录 `evaluationError`），而不是把这个事实藏起来。
    bundleEvaluated: evaluated,
    entryExposedOnGlobal: typeof exposed === 'object' && exposed !== null,
    sdkVersionIsString: typeof sdkVersion === 'string' && sdkVersion.length > 0,
    // 反空转：不是"读到个字符串就算过"，必须与仓库真实包版本一致。
    sdkVersionMatchesPackage: sdkVersion === expectedVersion,
    createAssemblyIsFunction: typeof createAssembly === 'function',
    domRenderedSdkVersion: appText.includes('web-report-sdk'),
  };

  // ---- 最小路径（唯一实现，见 runAssemblyMinimalPath）：装配根 → init → track → flush ----
  const minimal = await runAssemblyMinimalPath({
    createAssembly,
    appId,
    probeEventName,
    probeDimensions,
  });
  Object.assign(checks, minimal.checks);

  return {
    bundlePath,
    bundleBytes: Buffer.byteLength(code, 'utf8'),
    evaluatedMs,
    sdkVersion: typeof sdkVersion === 'string' ? sdkVersion : null,
    expectedSdkVersion: expectedVersion,
    domText: appText,
    batchSummary:
      minimal.batch === null
        ? null
        : {
            protocolVersion: minimal.batch.protocol_version ?? null,
            appId: minimal.batch.app_id ?? null,
            eventNames: (minimal.batch.events ?? []).map((event) => event.event_name),
          },
    minimalPathError: minimal.minimalPathError,
    evaluationError,
    checks,
    status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
  };
}

/**
 * 最小投递路径的**唯一实现**（四个例子共用；#1/#2 靠它复用而不是各写各的）。
 *
 * 传入的 `createAssembly` 可以是**沙箱里的**（bundler 产物，`runBundleInSandbox` 用），
 * 也可以是**真实 `import` 来的**（`examples/node-import` 用）——区别只在"符号从哪儿来"。
 *
 * 断言（每条都能因真实缺陷转红）：
 *   - `assemblyCreated` / `assemblyClientHasTrack`：装配根真的建起来了、`track` 在；
 *   - `uploadStubReceivedRequest`：`flush()` 之后接收方**真收到**请求（等到本地 Promise 链排空）；
 *   - `batchPassesContractSchema`：收到的批次必须**通过 `batch.schema.json` 的 Ajv 校验**
 *     （D-06：只解析不校验结构会让违约批次被当成"送达成功"）；
 *   - `batchHasEvents` / `batchContainsProbeEvent`：批次里有事件、且就是我们 track 的那条；
 *   - `minimalPathRan`：以上几条的合取（反空转，防止单点检查被删掉后仍算过）。
 */
export async function runAssemblyMinimalPath(options) {
  const {
    createAssembly,
    appId = 'webpack-compat',
    probeEventName = 'webpack_probe',
    probeDimensions = { probe: 'webpack-bundle' },
  } = options;

  const checks = {};
  let batch = null;
  let minimalPathError = null;
  try {
    const upload = createUploadStub();
    const assembly = createAssembly({
      appId,
      endpoint: FAKE_ENDPOINT,
      token: 'example-token',
      env: 'test',
      release: '0.0.0',
      consent: 'granted',
      transport: upload.port,
      startHealthReporting: false,
    });
    checks.assemblyCreated = typeof assembly === 'object' && assembly !== null;
    checks.assemblyClientHasTrack = typeof assembly.client?.track === 'function';
    assembly.init();
    assembly.client.track(probeEventName, { dimensions: probeDimensions });
    assembly.flush();
    // 传输是异步的：给队列一个排空窗口（不是"等网络"，是等本地 Promise 链）。
    const deadline = Date.now() + 2000;
    while (upload.requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    checks.uploadStubReceivedRequest = upload.requests.length > 0;
    // D-06：接收方必须按 `batch.schema.json` 校验结构——"收到字节"不等于"收到合法批次"。
    // 反空转：必须在真收到请求的前提下、且没有任何一次被拒收。
    checks.batchPassesContractSchema =
      upload.requests.length > 0 && upload.rejections.length === 0;
    const raw = upload.requests[0]?.body;
    if (typeof raw === 'string') {
      batch = JSON.parse(raw);
      checks.batchHasEvents = Array.isArray(batch.events) && batch.events.length > 0;
      checks.batchContainsProbeEvent =
        batch.events?.some((event) => event.event_name === probeEventName) === true;
    } else {
      checks.batchHasEvents = false;
      checks.batchContainsProbeEvent = false;
    }
    assembly.destroy();
  } catch (error) {
    minimalPathError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    checks.minimalPathRan = false;
  }
  if (checks.minimalPathRan !== false) {
    checks.minimalPathRan =
      checks.assemblyCreated === true &&
      checks.assemblyClientHasTrack === true &&
      checks.uploadStubReceivedRequest === true &&
      checks.batchContainsProbeEvent === true;
  }
  return { checks, batch, minimalPathError };
}

/**
 * 浏览器复核证据的分类（#2，2026-10-15）。两个 webpack 脚本共用这一份判据。
 *
 * 背景：两个脚本此前都写 `checks.browserStatusPass = browser.status !== 'fail'`（或同义的
 * `browser.status !== 'fail'`）——于是 `skipped`（本机没有 Chromium）与**任何未知状态**
 * （`undefined`、拼写错误、将来新增的状态）都算 pass。"真实浏览器复核过"这句话因此
 * 在缺浏览器的机器上变成了"没跑"，而且**永远不会失败**。
 *
 * 为什么**不**把 skipped 判成 fail：缺 Chromium 是"本环境不支持该检查"的**合法**状态——
 * `examples:build` / `examples:test` 是 CI gates job 的步骤（`.github/workflows/ci.yml`），
 * 而那个 job **不装浏览器**（只有 e2e job 装 `playwright install`），且这里探测的是 macOS
 * 固定路径，在 Linux CI 上必然不存在。判 fail 会把门禁在 CI 上弄红，且红的原因是环境而非 SDK。
 *
 * 正确处置 = **显式记账**（白名单，不是"非 fail 即过"）：
 *   - `pass`：跑了且通过；
 *   - `skipped`：环境不支持，**必须带非空 `reason`**（没有理由的豁免不可审计，按未交代处理）；
 * 其余（`fail`、未知状态、无理由的 skipped）→ `accounted: false`，调用方**必须**让整体结论转红。
 */
export function classifyBrowserEvidence(browser) {
  const status = browser?.status;
  const reason =
    typeof browser?.reason === 'string' && browser.reason.length > 0 ? browser.reason : null;
  if (status === 'pass') {
    return { status: 'pass', accounted: true, skipped: false, reason };
  }
  if (status === 'skipped' && reason !== null) {
    return { status: 'skipped', accounted: true, skipped: true, reason };
  }
  return {
    status: typeof status === 'string' && status.length > 0 ? status : 'missing',
    accounted: false,
    skipped: false,
    reason,
  };
}

/** 从 webpack 的 `stats` 里摘出解析到 SDK 的真实文件路径（证明裸包名被解析了）。 */
export function resolvedSdkModules(stats) {
  // 注意：`toJson({ all: false, modules: true })` 在 webpack 5 上返回空数组（实测），
  // 所以这里只用 `{ modules: true }`（默认会带上 concatenated modules 的 `modules` 子表）。
  const json = stats.toJson({ modules: true });
  const names = [];
  const walk = (modules) => {
    for (const module of modules ?? []) {
      const name = String(module.name ?? module.identifier ?? '');
      if (name.includes('web-report-sdk') || name.includes('packages/browser/dist/')) {
        names.push(name);
      }
      if (Array.isArray(module.modules)) walk(module.modules);
    }
  };
  walk(json.modules);
  return names;
}

/** 期望的 SDK 版本：从真实的包清单读取，避免把"任意非空字符串"当成通过。 */
export function expectedSdkVersion() {
  const manifestPath = fileURLToPath(new URL('../../../../packages/browser/package.json', import.meta.url));
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version;
}

/** 把 `stats` 的摘要压成可落盘的形状（不塞整个 stats，太大）。 */
export function summarizeStats(stats, mode) {
  const json = stats.toJson({ errors: true, warnings: true, assets: true, modules: true });
  return {
    mode,
    hasErrors: stats.hasErrors(),
    errors: (json.errors ?? []).map((error) => error.message ?? String(error)),
    warnings: (json.warnings ?? []).map((warning) => warning.message ?? String(warning)),
    assets: (json.assets ?? []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      emitted: asset.emitted,
    })),
    sdkModules: resolvedSdkModules(stats),
  };
}
