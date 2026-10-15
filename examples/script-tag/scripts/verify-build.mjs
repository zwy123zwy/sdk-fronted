/**
 * script-tag 示例的**构建产物验证**（#1，2026-10-15）。
 *
 * 为什么需要它：本示例的 `build` 此前是 `node -e "process.exit(0)"`——**空脚本**，
 * 而 `pnpm examples:build` 是门禁步骤（见 `package.json` 的 `gates` 与 `.github/workflows/ci.yml`）。
 * 也就是说"examples 全部构建通过"对本示例**什么都没证明**。
 *
 * 本示例的产物形态是 **IIFE**（无构建工具，`<script src>` 直接引入），与 node-import 的
 * "包导入"形态不同，所以这里的验证贴合 IIFE 形态：
 *
 *   1. `index.html` 里写死的 `<script src>` 必须真的存在且非空——那是接入方唯一会加载的文件；
 *      包改了出口/文件名时浏览器里只会 **404**，门禁不查就没人发现；
 *   2. 该文件必须与包 `exports` 的 `./iife` 出口**是同一个文件**（HTML 与包出口不得漂移）；
 *   3. **真的解析它**（`node:vm` + 与 `examples/webpack` **同一份**最小浏览器面
 *      `createBrowserSandbox()`），断言全局 `WebReportSDK.SDK_VERSION` 与包清单一致、
 *      `createAssembly` 是函数。
 *
 * 行为级验证（真跑最小投递路径 + Ajv 契约校验）在 `check.mjs`（`test`）里，复用
 * `runAssemblyMinimalPath`——本节不重造，只回答"产物在不在、能不能解析/加载"。
 * 与 node-import 同因，这里也不重跑 `packages/browser` 的构建（`gates` / CI 已先跑 `pnpm build`）。
 *
 * 判别性证明（实测）：把 `packages/browser/dist/web-report-sdk.iife.js` 移走后运行本脚本 →
 * `htmlScriptExists=false` → **exit 1**；恢复后 exit 0。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  createBrowserSandbox,
  expectedSdkVersion,
} from '../../webpack/scripts/lib/verify-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

/** 取接入方真正会加载的 `<script src>`（与 `index.html` 一致，不写死第二个路径）。 */
function readHtmlScriptSrc() {
  const htmlPath = join(root, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  const match = /<script[^>]*\bsrc="([^"]+)"/u.exec(html);
  const src = match?.[1];
  if (src === undefined || src.length === 0) {
    throw new Error(`index.html 里找不到入口 <script src=...>：${htmlPath}`);
  }
  return src;
}

const src = readHtmlScriptSrc();
const scriptPath = join(root, src);
const expectedVersion = expectedSdkVersion();

let iifePath = null;
let resolveError = null;
try {
  iifePath = require.resolve('@web-report-sdk/browser/iife');
} catch (error) {
  resolveError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const stats = statSync(scriptPath, { throwIfNoEntry: false });
const checks = {
  packageIifeExportResolves: iifePath !== null,
  htmlScriptIsDistArtifact: /\/dist\//u.test(scriptPath),
  htmlScriptExists: stats !== undefined && stats.isFile(),
  htmlScriptNonEmpty: stats !== undefined && stats.isFile() && stats.size > 0,
  htmlScriptMatchesPackageExport: false,
  iifeEvaluated: false,
  sdkVersionIsString: false,
  sdkVersionMatchesPackage: false,
  createAssemblyIsFunction: false,
};

if (checks.htmlScriptExists && iifePath !== null) {
  checks.htmlScriptMatchesPackageExport = realpathSync(scriptPath) === realpathSync(iifePath);
}

let evaluationError = null;
let sdk = null;
if (checks.htmlScriptNonEmpty) {
  const sandbox = createBrowserSandbox();
  vm.createContext(sandbox);
  try {
    vm.runInContext(readFileSync(scriptPath, 'utf8'), sandbox, { filename: scriptPath });
    checks.iifeEvaluated = true;
    sdk = sandbox.WebReportSDK;
  } catch (error) {
    evaluationError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}
checks.sdkVersionIsString = typeof sdk?.SDK_VERSION === 'string' && sdk.SDK_VERSION.length > 0;
checks.sdkVersionMatchesPackage = sdk?.SDK_VERSION === expectedVersion;
checks.createAssemblyIsFunction = typeof sdk?.createAssembly === 'function';

const result = {
  task: 'example-script-tag',
  form: 'iife',
  htmlScriptSrc: src,
  scriptPath,
  packageIifePath: iifePath,
  expectedSdkVersion: expectedVersion,
  resolveError,
  evaluationError,
  checks,
  status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
};
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'pass') {
  console.error(
    'script-tag 示例构建验证失败：index.html 的 <script src> 必须存在、与包 exports 的 ./iife 同一个文件、' +
      '可解析，且暴露 WebReportSDK.SDK_VERSION（与包清单一致）与 createAssembly；' +
      '产物缺失时先运行 pnpm build',
  );
  process.exitCode = 1;
}
