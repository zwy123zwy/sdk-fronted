/**
 * C05-F2 性能插件在**内核上下文**下的接线用例（生产路径的覆盖率与行为）。
 *
 * 与 `vitals.test.ts` / `kill-switch.test.ts` 的区别：那两个用注入的 `completion` 端口，
 * 这里用假的 `PluginContext`，验证**没有注入端口时**由内核监听注册表兜底的路径：
 * `load` → FCP/LCP/TTFB、`pointerdown`/`keydown` → INP、`visibilitychange(hidden)`/`pagehide` → CLS，
 * 以及卸载时把监听与观察器一起回收。
 */
import { describe, expect, it } from 'vitest';

import { PERF_PLUGIN_ID, createPerfPlugin, installPerfCapture } from './index';
import type { PerfEntryLike, PerfObserverCallback, PerfObserverLike, VitalsEvent } from './index';

/** 记录型内核上下文：保存 `listen` 注册的处理器与 `schedule` 的清理函数。 */
function createContext(): {
  context: Record<string, unknown>;
  listeners: Map<string, (() => void)[]>;
  disposed: number[];
} {
  const listeners = new Map<string, (() => void)[]>();
  const disposed: number[] = [];
  const context: Record<string, unknown> = {
    pluginId: PERF_PLUGIN_ID,
    counters: { count: () => undefined, get: () => 0, snapshot: () => ({}), reset: () => undefined },
    pipeline: { register: () => () => undefined, process: () => ({}), size: () => 0, dispose: () => undefined },
    registry: {
      listen: () => () => undefined,
      listenGlobal: () => () => undefined,
      hook: () => () => undefined,
      schedule: () => () => undefined,
      scheduleRepeat: () => () => undefined,
      stats: () => ({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 }),
      dispose: () => undefined,
    },
    capabilities: {
      register: () => () => undefined,
      has: () => false,
      get: () => undefined,
      names: () => [],
      dispose: () => undefined,
    },
    addProcessor: () => () => undefined,
    listen: (type: string, handler: () => void): (() => void) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
      const index = disposed.length;
      disposed.push(0);
      return () => {
        disposed[index] = (disposed[index] ?? 0) + 1;
      };
    },
    hook: () => () => undefined,
    schedule: () => () => undefined,
    scheduleRepeat: () => () => undefined,
    registerCapability: () => () => undefined,
    onDispose: () => undefined,
  };
  return { context, listeners, disposed };
}

/** 触发某类型的所有已注册处理器。 */
function fire(listeners: Map<string, (() => void)[]>, type: string): void {
  for (const handler of listeners.get(type) ?? []) handler();
}

describe('C05-AC-05 内核上下文兜底路径：五类指标按 AC 的时机上报', () => {
  it('load → FCP/LCP/TTFB；pointerdown → INP；visibilitychange(hidden) → CLS', () => {
    const vitals: VitalsEvent[] = [];
    let callback: PerfObserverCallback | undefined;
    const harness = createContext();

    installPerfCapture(
      harness.context as unknown as Parameters<typeof installPerfCapture>[0],
      {
        vitals: (event) => {
          vitals.push(event);
        },
        longTask: () => undefined,
      },
      {
        createObserver: (cb): PerfObserverLike => {
          callback = cb;
          return {
            observe(): void {
              // 无
            },
            disconnect(): void {
              // 无
            },
          };
        },
        now: () => 1_700_000_000_000,
        responseStartProvider: () => 90,
      },
    );

    const entries: readonly PerfEntryLike[] = [
      { entryType: 'paint', name: 'first-contentful-paint', startTime: 700, duration: 0 },
      { entryType: 'largest-contentful-paint', name: '', startTime: 2100, duration: 0 },
    ];
    callback?.({ getEntries: () => entries });

    fire(harness.listeners, 'load');
    expect(vitals.map((event) => event.dimensions.metric_name)).toEqual(['FCP', 'LCP', 'TTFB']);

    callback?.({ getEntries: () => [{ entryType: 'event', name: 'click', startTime: 1, duration: 120 }] });
    fire(harness.listeners, 'pointerdown');
    expect(vitals.map((event) => event.dimensions.metric_name)).toContain('INP');

    callback?.({ getEntries: () => [{ entryType: 'layout-shift', name: '', startTime: 2, duration: 0, value: 0.3 }] });
    fire(harness.listeners, 'visibilitychange');
    // happy-dom 下 visibilityState 可能不是 hidden，这里再用 pagehide 兜底触发
    fire(harness.listeners, 'pagehide');
    expect(vitals.map((event) => event.dimensions.metric_name)).toContain('CLS');
    expect(vitals.find((event) => event.dimensions.metric_name === 'CLS')?.dimensions.rating).toBe('poor');
  });

  it('keydown 也能触发 INP；卸载后监听被回收且不再上报', () => {
    const vitals: VitalsEvent[] = [];
    let callback: PerfObserverCallback | undefined;
    const harness = createContext();
    const capture = installPerfCapture(
      harness.context as unknown as Parameters<typeof installPerfCapture>[0],
      {
        vitals: (event) => {
          vitals.push(event);
        },
        longTask: () => undefined,
      },
      {
        createObserver: (cb): PerfObserverLike => {
          callback = cb;
          return {
            observe(): void {
              // 无
            },
            disconnect(): void {
              // 无
            },
          };
        },
        now: () => 1_700_000_000_000,
      },
    );

    callback?.({ getEntries: () => [{ entryType: 'event', name: 'keydown', startTime: 1, duration: 80 }] });
    fire(harness.listeners, 'keydown');
    expect(vitals.map((event) => event.dimensions.metric_name)).toEqual(['INP']);

    capture.uninstall();
    expect(harness.disposed.some((count) => count > 0), '卸载必须注销内核监听').toBe(true);
    fire(harness.listeners, 'load');
    expect(vitals, '卸载后不再上报').toHaveLength(1);
  });

  it('没有 PerformanceObserver 时静默降级：不抛错、不产生事件、监听仍可注册', () => {
    const vitals: VitalsEvent[] = [];
    const harness = createContext();
    // 用 Reflect 读写以避免"类型上必然存在"的判定：这里要模拟不支持的浏览器
    const hadObserver = Reflect.has(globalThis, 'PerformanceObserver');
    const originalObserver: unknown = Reflect.get(globalThis, 'PerformanceObserver');
    Reflect.deleteProperty(globalThis, 'PerformanceObserver');
    try {
      expect(() => {
        installPerfCapture(
          harness.context as unknown as Parameters<typeof installPerfCapture>[0],
          {
            vitals: (event) => {
              vitals.push(event);
            },
            longTask: () => undefined,
          },
        );
      }, '缺少 PerformanceObserver 时不得抛错').not.toThrow();
      fire(harness.listeners, 'load');
      // 没有任何条目被观察到 → 不产生事件（也说明 take 语义不会伪造 0 值）
      expect(vitals).toHaveLength(0);
    } finally {
      if (hadObserver) Reflect.set(globalThis, 'PerformanceObserver', originalObserver);
    }
  });
});

describe('C05-F2 createPerfPlugin 与 C02 插件宿主形状', () => {
  it('plugin.id 为 perf，install 后可观察、可卸载', () => {
    const observed: string[] = [];
    const plugin = createPerfPlugin(
      { vitals: () => undefined, longTask: () => undefined },
      {
        createObserver: (): PerfObserverLike => ({
          observe(options): void {
            observed.push(options.type);
          },
          disconnect(): void {
            // 无
          },
        }),
        now: () => 1,
      },
    );
    const harness = createContext();
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);
    expect(plugin.id).toBe(PERF_PLUGIN_ID);
    expect(observed).toContain('longtask');
    expect(plugin.capture.observers()).toHaveLength(1);
    plugin.capture.uninstall();
    expect(plugin.capture.stats()).toEqual({ vitals: 0, longTasks: 0 });
  });
});
