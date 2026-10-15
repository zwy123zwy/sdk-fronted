/**
 * 信标累计额度特性刻画探针（**与 SDK 实现无关**，只调用真实浏览器 API）。
 *
 * 目的：量出「同一次离页 burst 里能送多少字节」——单次上限已知（T29：80 KB → false），
 * 但 `docs/reports/e2e-real-browser.md` 追加节实测还有一层**累计在途额度**（≈64 KiB），
 * 且该节尚未回答「分几次、每次间隔多久才稳定」。参数选择必须有实测支撑，故独立成探针。
 *
 * 只做观测（把 `sendBeacon` 的返回值与耗时原样交回 Node 侧），判定全部在 spec 里做。
 * 不加载任何 SDK 产物、不修改实现。
 *
 * 口径（#4，2026-10-15）：**已如实降级**——这里发的是裸字节（`Uint8Array`，连信封都不是），
 * 证明的是**浏览器信标通道的容量**，与 SDK 组批、与 transport 的切片实现都无关。
 */

function payload(bytes) {
  const body = new globalThis.Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) body[i] = i % 251;
  return new globalThis.Blob([body], { type: 'text/plain' });
}

/** 让出主线程（可选）：用来切开「同一个同步回合」与「跨任务」两种情形。 */
function yieldToBrowser(mode) {
  if (mode === 'raf') {
    return new Promise((resolve) => globalThis.requestAnimationFrame(() => resolve()));
  }
  if (mode === 'timeout') {
    return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
  return Promise.resolve();
}

globalThis.window.__beaconQuota = {
  /** 真实 sendBeacon 可用性（前置）。 */
  config() {
    return {
      hasSendBeacon: typeof globalThis.navigator.sendBeacon === 'function',
      userAgent: globalThis.navigator.userAgent,
      hardwareConcurrency: globalThis.navigator.hardwareConcurrency ?? null,
    };
  },

  /**
   * 按 `{bytes, delayMs?, sync?}` 序列连续调用真实 `sendBeacon`。
   * `delayMs` 在**上一次调用之后**等待；`sync: true` 表示不等待（同一同步回合）。
   * @param {{url: string, steps: ReadonlyArray<{bytes: number, delayMs?: number, sync?: boolean}>}} options
   */
  async plan(options) {
    const steps = [];
    let elapsedMs = 0;
    for (const step of options.steps) {
      const delayMs = step.delayMs ?? 0;
      const sync = step.sync === true;
      if (delayMs > 0) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
        elapsedMs += delayMs;
      } else if (!sync) {
        const started = globalThis.performance.now();
        await yieldToBrowser('raf');
        elapsedMs += globalThis.performance.now() - started;
      }
      const started = globalThis.performance.now();
      let accepted = false;
      let error = null;
      try {
        accepted = globalThis.navigator.sendBeacon(options.url, payload(step.bytes));
      } catch (caught) {
        error = String(caught);
      }
      const callMs = globalThis.performance.now() - started;
      elapsedMs += callMs;
      steps.push({ bytes: step.bytes, accepted, error, callMs, elapsedMs });
    }
    return { steps, plannedBytes: options.steps.reduce((sum, step) => sum + step.bytes, 0) };
  },
};

globalThis.window.__beaconQuotaReady = true;
