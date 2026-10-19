/**
 * 让 `node tests/bench/m01-receiver.mjs` 能直接加载 **M01 源码**（`tools/mock-receiver/src/*.ts`）。
 *
 * 为什么需要：M01 的源码用 TypeScript 编写、内部相对导入写的是 `./x.js`（编译后形态）。
 * Node 24 自带类型擦除（type stripping），但它**不会**把 `./x.js` 改写成 `./x.ts`，
 * 因此裸 `node` 无法 import `tools/mock-receiver/src/index.ts`（实测报 `Cannot find module …server.js`）。
 *
 * 这里只做一件事：相对说明符以 `.js` 结尾、且同名 `.ts` 存在时，解析到 `.ts`；
 * 类型擦除仍由 Node 自己完成。这样基准测的是**当前源码**，而不是一个可能过期的
 * `tools/mock-receiver/dist/`（dist 被 `.gitignore` 忽略；本机实测 dist 比 src 旧）。
 *
 * 不作为通用工具：只在基准进程内注册（见 `m01-receiver.mjs` 顶部）。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @param {string} specifier @param {{ parentURL?: string }} context */
export async function resolve(specifier, context, nextResolve) {
  if (
    context.parentURL !== undefined &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    specifier.endsWith('.js')
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    const candidate = resolvePath(dirname(parentPath), specifier.replace(/\.js$/, '.ts'));
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
