/**
 * T30 缺陷复现：SDK 先装、第三方 APM 后装时，`destroy()` 会抹掉第三方的包装层。
 *
 * 复现（不触网、不依赖 happy-dom）：
 * ```
 * node tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs
 * ```
 * 期望（Q7 第 4 条"卸载时只还原自己装上的那一层"）：`globalThis.fetch` 在 destroy 后**仍是**第三方包装。
 * 实测：变回 SDK 首次 hook 之前的原生引用 —— 第三方的包装被抹掉，此后它采集不到任何业务请求。
 *
 * 根因（只读定位，未修改实现）：`packages/core/src/kernel/global-registry.ts` 的 `dispose()`
 * 对每条 hook 链**无条件**执行 `chain.holder[chain.key] = chain.base`；
 * 而增量注销路径（同一个文件里的 `registerHook` 返回的 dispose）已经做了正确判断
 * （`chain.holder[key] !== currentComposite` 时不动当前值）。
 */
const native = () => Promise.resolve({ status: 200 });

globalThis.fetch = native;

const { createAssembly } = await import('../../../packages/browser/dist/index.js');

const port = {
  send: () => Promise.resolve({ status: 202, headers: {} }),
};

const assembly = createAssembly({
  appId: 'repro',
  endpoint: 'https://collect.example/ingest',
  token: 'token',
  consent: 'granted',
  transport: port,
  plugins: { http: true },
  startHealthReporting: false,
});
assembly.init();

// 第三方 APM 在 SDK 之上再包一层（这就是"SDK 先装、第三方后装"的顺序）。
const apmWrapper = () => Promise.resolve({ status: 204 });
globalThis.fetch = apmWrapper;
console.log('安装第三方包装后：globalThis.fetch 是第三方包装 =', globalThis.fetch === apmWrapper);

assembly.destroy();

const stillApm = globalThis.fetch === apmWrapper;
const backToNative = globalThis.fetch === native;
console.log('destroy 后：仍是第三方包装 =', stillApm, '｜变回 SDK hook 前的原生引用 =', backToNative);
console.log(stillApm ? '结论：符合 Q7 第 4 条' : '结论：**缺陷**——第三方的包装被 destroy 抹掉');
process.exitCode = stillApm ? 0 : 1;
