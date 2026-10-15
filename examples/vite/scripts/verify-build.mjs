/**
 * vite 示例的**产物验证**（#1）。
 *
 * 为什么需要它：`examples/vite` 的 `test` 此前是 `node -e "process.exit(0)"`——**永远绿**，
 * 而 `examples:test` 是 `pnpm gates` 的一步。也就是说"vite 例子通过"这件事当时什么都没证明。
 *
 * 现在它验证的是**接入方真正关心的事**，且复用 `examples/webpack` 已经建立的形态
 * （`runBundleInSandbox`：同一份沙箱 + 同一份"装配根跑最小投递路径"断言 + 同一份
 * `batch.schema.json` 的 Ajv 契约校验），只通过 `options` 换入口挂符号的全局键：
 *
 *   1. `vite build` 产出真实产物（不是另造一个测试专用 bundle）；
 *   2. 从 `dist/index.html` 里解析出入口 `<script src>`（产物文件名带 hash，不能写死）；
 *   3. 把该文件喂进 `runBundleInSandbox` → 断言 `SDK_VERSION` 与包版本一致、
 *      `createAssembly` 是函数、并**真跑一次** `createAssembly → init → track → flush`，
 *      接收方必须收到**通过契约 Schema 的**批次；
 *   4. 任一项为 false → exit 1（可失败，不是恒绿）。
 *
 * 判别性证明：把 `src/main.ts` 暴露的 `createAssembly` 去掉（模拟"必需符号从产物里消失"），
 * 本脚本必须以 `createAssemblyIsFunction=false` / `status=fail` / exit 1 转红。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBundleInSandbox } from '../../webpack/scripts/lib/verify-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const distDir = join(root, 'dist');
const htmlPath = join(distDir, 'index.html');

/** 用 vite 的 Node API 跑真实生产构建（配置与 `pnpm build` 完全一致）。 */
async function buildWithVite() {
  const vite = await import('vite');
  await vite.build({ root, logLevel: 'warn' });
}

/** 从产物 HTML 里取入口脚本的真实路径（哈希文件名不能写死）。 */
function readEntryScriptPath() {
  const html = readFileSync(htmlPath, 'utf8');
  const match = /<script[^>]*\bsrc="([^"]+)"/u.exec(html);
  const src = match?.[1];
  if (src === undefined || src.length === 0) {
    throw new Error(`dist/index.html 里找不到入口 <script src=...>：${htmlPath}`);
  }
  return join(distDir, src.replace(/^\//u, ''));
}

await buildWithVite();
const entryPath = readEntryScriptPath();
const sandbox = await runBundleInSandbox(readFileSync(entryPath, 'utf8'), entryPath, {
  exposedKey: '__VITE_EXAMPLE__',
  appId: 'vite-compat',
  probeEventName: 'vite_probe',
  probeDimensions: { probe: 'vite-bundle' },
});

console.log(
  JSON.stringify(
    {
      task: 'vite-example',
      entryPath,
      bundleBytes: sandbox.bundleBytes,
      checks: sandbox.checks,
      batchSummary: sandbox.batchSummary,
      evaluationError: sandbox.evaluationError,
      minimalPathError: sandbox.minimalPathError,
      status: sandbox.status,
    },
    null,
    2,
  ),
);

if (sandbox.status !== 'pass') {
  console.error('vite 示例产物验证失败：见上面的 checks / minimalPathError');
  process.exitCode = 1;
}
