/**
 * Node 24 原生类型剥离下，把 mock-receiver 源码里的 `./x.js` 说明符解析到 `./x.ts`。
 * M01 的源码用 `.js` 后缀写 ESM 说明符（由 tsc/tsup 解析），Node 直接跑需要这层映射。
 * 只在 POC 内使用，不修改 M01。
 */
import fs from 'node:fs';

export async function resolve(specifier, context, next) {
  if (
    context.parentURL &&
    specifier.endsWith('.js') &&
    (specifier.startsWith('./') || specifier.startsWith('../'))
  ) {
    const asJs = new URL(specifier, context.parentURL);
    const asTs = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    try {
      if (fs.existsSync(asTs) && !fs.existsSync(asJs)) {
        return { url: asTs.href, shortCircuit: true, format: 'module-typescript' };
      }
    } catch {
      /* 落到默认解析 */
    }
  }
  return next(specifier, context);
}
