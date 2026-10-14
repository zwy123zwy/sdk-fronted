/**
 * webpack 示例的产物验证库。
 *
 * 两个脚本（生产构建 / 开发服务器）都必须回答同一个问题：**bundler 吐出来的那个 bundle
 * 里，`web-report-sdk` 是不是真的能跑**。所以验证逻辑只写一次，两处共用：
 *
 * 1. 把 bundle 源码喂进 `node:vm` 的沙箱（`window`/`self`/`document`/最小 DOM 面）；
 * 2. 断言全局 `SDK_VERSION` 是字符串（值必须与仓库产物一致，不是"包含字符串"就算过）；
 * 3. 断言 `createAssembly` 是函数，并**真跑一次最小路径**：`createAssembly` → `init()` →
 *    `client.track()` → `flush()`，注入传输替身，断言接收方**真收到批次**且事件名正确。
 *
 * 第 3 条是关键：只验证"能读到 SDK_VERSION"无法区分"真的打进了依赖"与"只是常量被内联"。
 * 注入 `transport` 走的是运行期工厂参数，所以能证明 SDK 的装配与上报链路在 bundle 里是活的。
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 实际跑最小路径时用的假端点（`transport` 替身会截住，绝不出网）。 */
export const FAKE_ENDPOINT = 'https://collect.invalid/ingest';

/** 接收方替身：记录 SDK 发来的每一次请求。 */
function createUploadStub() {
  const requests = [];
  return {
    requests,
    port: {
      send(request) {
        requests.push(request);
        return Promise.resolve({ status: 200, headers: {} });
      },
    },
  };
}

/** 最小 DOM 面：bundle 入口只做 `document.querySelector('#app').textContent = ...`。 */
function createDocumentStub() {
  const app = { textContent: '' };
  return {
    documentElement: { lang: 'zh-CN' },
    querySelector: (selector) => (selector === '#app' ? app : null),
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

/**
 * 在 `node:vm` 沙箱里执行 bundle。
 *
 * 沙箱只有最小可用面（`window`/`self`/`document`/`setTimeout`/`fetch` 的空实现），
 * 刻意**不提供** `CompressionStream`、`crypto`、`navigator.locks`、`indexedDB`——
 * 这些都属于 T30 降级矩阵的格子，不在这里重复；这里只要最小路径能跑通。
 */
export async function runBundleInSandbox(code, bundlePath) {
  const document = createDocumentStub();
  const sandbox = {
    document,
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

  const start = Date.now();
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: bundlePath });
  const evaluatedMs = Date.now() - start;

  // 取用姿势与接入方一致：bundle 是**自执行的**，SDK 的符号不会平铺到全局，
  // 而是入口自己在 `globalThis.__WEBPACK_EXAMPLE__` 上暴露出来（见 src/main.js）。
  const exposed = sandbox.__WEBPACK_EXAMPLE__;
  const sdkVersion = exposed?.SDK_VERSION;
  const createAssembly = exposed?.createAssembly;
  const appText = document.__app.textContent;
  const expectedVersion = expectedSdkVersion();

  const checks = {
    bundleEvaluated: true,
    entryExposedOnGlobal: typeof exposed === 'object' && exposed !== null,
    sdkVersionIsString: typeof sdkVersion === 'string' && sdkVersion.length > 0,
    // 反空转：不是"读到个字符串就算过"，必须与仓库真实包版本一致。
    sdkVersionMatchesPackage: sdkVersion === expectedVersion,
    createAssemblyIsFunction: typeof createAssembly === 'function',
    domRenderedSdkVersion: appText.includes('web-report-sdk'),
  };

  // ---- 最小路径：createAssembly → init → track → flush → 接收方真收到批次 ----
  let batch = null;
  let minimalPathError = null;
  try {
    const upload = createUploadStub();
    const assembly = createAssembly({
      appId: 'webpack-compat',
      endpoint: FAKE_ENDPOINT,
      token: 'webpack-token',
      env: 'test',
      release: '0.0.0',
      consent: 'granted',
      transport: upload.port,
      startHealthReporting: false,
    });
    checks.assemblyCreated = typeof assembly === 'object' && assembly !== null;
    checks.assemblyClientHasTrack = typeof assembly.client?.track === 'function';
    assembly.init();
    assembly.client.track('webpack_probe', { dimensions: { probe: 'webpack-bundle' } });
    assembly.flush();
    // 传输是异步的：给队列一个排空窗口（不是"等网络"，是等本地 Promise 链）。
    const deadline = Date.now() + 2000;
    while (upload.requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    checks.uploadStubReceivedRequest = upload.requests.length > 0;
    const raw = upload.requests[0]?.body;
    if (typeof raw === 'string') {
      batch = JSON.parse(raw);
      checks.batchHasEvents = Array.isArray(batch.events) && batch.events.length > 0;
      checks.batchContainsProbeEvent =
        batch.events?.some((event) => event.event_name === 'webpack_probe') === true;
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

  return {
    bundlePath,
    bundleBytes: Buffer.byteLength(code, 'utf8'),
    evaluatedMs,
    sdkVersion: typeof sdkVersion === 'string' ? sdkVersion : null,
    expectedSdkVersion: expectedVersion,
    domText: appText,
    batchSummary:
      batch === null
        ? null
        : {
            protocolVersion: batch.protocol_version ?? null,
            appId: batch.app_id ?? null,
            eventNames: (batch.events ?? []).map((event) => event.event_name),
          },
    minimalPathError,
    checks,
    status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
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
