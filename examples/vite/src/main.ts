import { SDK_VERSION, createAssembly } from '@web-report-sdk/browser';

const app = document.querySelector('#app');
if (app) {
  app.textContent = `web-report-sdk ${SDK_VERSION}`;
}

// 暴露给验证脚本（`scripts/verify-build.mjs`）：证明 vite 产出的 bundle 里 `createAssembly`
// 也**真实可用**，而不只是"读得到一个 SDK_VERSION 常量"。与 `examples/webpack/src/main.js`
// 同一形态（那里挂在 `globalThis.__WEBPACK_EXAMPLE__`）。
// `main.ts` 里 `globalThis` 没有这个键的声明，故用 `unknown` 收窄——不用 `any`、不用 `@ts-expect-error`。
(globalThis as unknown as { __VITE_EXAMPLE__?: unknown }).__VITE_EXAMPLE__ = {
  SDK_VERSION,
  createAssembly,
};
