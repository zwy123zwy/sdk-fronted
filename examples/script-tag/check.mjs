// 验证 IIFE 产物能在没有构建工具的环境中通过 <script> 引入（指南第 4.2 节）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const file = require.resolve('@web-report-sdk/browser/iife');
const code = readFileSync(file, 'utf8');

const context = { window: {} };
context.self = context.window;
vm.createContext(context);
vm.runInContext(`${code}\n;window.WebReportSDK = typeof WebReportSDK === 'undefined' ? undefined : WebReportSDK;`, context);

const sdk = context.window.WebReportSDK;
if (!sdk || typeof sdk.SDK_VERSION !== 'string') {
  console.error('IIFE 产物没有暴露 WebReportSDK.SDK_VERSION');
  process.exit(1);
}
console.log(`script-tag ok: WebReportSDK.SDK_VERSION = ${sdk.SDK_VERSION}`);
