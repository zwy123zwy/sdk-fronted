/**
 * webpack 示例的接入方入口。
 *
 * 与 `examples/vite/src/main.ts` 同一形态：只依赖 `@web-report-sdk/browser` 的公开入口，
 * **不做任何 webpack 专属配置**（不写 `resolve.alias`、不改 `conditionNames`）——
 * 这正是指南第 4.2 节要求的"不需要额外配置"。
 */
import { SDK_VERSION, createAssembly } from '@web-report-sdk/browser';

const app = document.querySelector('#app');
if (app) {
  app.textContent = `web-report-sdk ${SDK_VERSION}`;
}

// 暴露给验证脚本：证明 webpack 产出的 bundle 里 `createAssembly` 也真实可用
// （不只是读得到一个 `SDK_VERSION` 常量）。
globalThis.__WEBPACK_EXAMPLE__ = { SDK_VERSION, createAssembly };
