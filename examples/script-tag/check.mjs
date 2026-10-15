/**
 * 验证 IIFE 产物能在没有构建工具的环境中通过 <script> 引入（指南第 4.2 节）。
 *
 * #2（2026-10-15）：此前只断言 `typeof sdk.SDK_VERSION === 'string'`——它确实**求值了产物**
 * （比只 `import` 常量的 node-import 强），但仍不证明"SDK 在 `<script>` 场景下真的能用"：
 * 一个只内联了 `SDK_VERSION`、`createAssembly` 被摇掉的产物同样能过。
 *
 * 现在**复用** `examples/webpack` 建立的最小投递形态（不另造）：同一个沙箱形态由
 * `createBrowserSandbox()` 提供，然后跑 `createAssembly → init → track → flush`，
 * 接收方必须收到**通过 `batch.schema.json` 的 Ajv 校验**的批次。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

import {
  createBrowserSandbox,
  runAssemblyMinimalPath,
} from '../webpack/scripts/lib/verify-bundle.mjs';

const require = createRequire(import.meta.url);
const file = require.resolve('@web-report-sdk/browser/iife');
const code = readFileSync(file, 'utf8');

// `window === self === 沙箱全局`（与浏览器一致）；IIFE 的顶层 `var WebReportSDK` 落在这个全局上。
const sandbox = createBrowserSandbox();
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: file });

const sdk = sandbox.WebReportSDK;
if (!sdk || typeof sdk.SDK_VERSION !== 'string') {
  console.error('IIFE 产物没有暴露 WebReportSDK.SDK_VERSION');
  process.exit(1);
}
if (typeof sdk.createAssembly !== 'function') {
  console.error('IIFE 产物暴露了 SDK_VERSION，但没有 createAssembly（装配根被摇掉了）');
  process.exit(1);
}

const minimal = await runAssemblyMinimalPath({
  createAssembly: sdk.createAssembly,
  appId: 'script-tag-compat',
  probeEventName: 'script_tag_probe',
  probeDimensions: { probe: 'script-tag-iife' },
});

const result = {
  task: 'script-tag-example',
  file,
  sdkVersion: sdk.SDK_VERSION,
  checks: minimal.checks,
  minimalPathError: minimal.minimalPathError,
  status: Object.values(minimal.checks).every(Boolean) ? 'pass' : 'fail',
};
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'pass') {
  console.error('script-tag 示例验证失败：IIFE 产物能求值，但装配/投递没跑通');
  process.exitCode = 1;
}
