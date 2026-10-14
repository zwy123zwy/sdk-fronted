/**
 * C05-F2 性能采集插件。
 *
 * 约束：
 * - C05-AC-07：浏览器不支持某个条目类型时不抛错、跳过该指标，其余照常；
 * - C05-AC-14：远程配置关闭性能插件 → **观察器断开**，之后不再上报；
 * - 采集回调只做最小工作（不序列化、不组装批次），自身不得产生 50 ms 以上长任务；
 * - 与 C08 分工：只采宿主页面的性能条目，不做 SDK 自监控耗时；
 * - 上报时机照抄 AC-05：FCP/LCP/TTFB 在加载完成时、INP 在交互后、CLS 在页面隐藏时。
 */
import type { Plugin, PluginContext } from '@web-report-sdk/core';

import { OBSERVED_ENTRY_TYPES, createVitalsAccumulator, normalizeLongTask } from './vitals';
import type { VitalsAccumulator } from './vitals';
import type {
  LongTaskEvent,
  PerfEntryLike,
  PerfObserverCallback,
  PerfObserverFactory,
  PerfObserverLike,
  PerfPorts,
  VitalsEvent,
} from './types';

/** 插件 id，与 `remote-config.schema.json` 的 `pluginName` 枚举一致。 */
export const PERF_PLUGIN_ID = 'perf';

/** 性能事件的出口。 */
export interface PerfSink {
  readonly vitals: (event: VitalsEvent) => void;
  readonly longTask: (event: LongTaskEvent) => void;
}

/** 性能采集运行端口。 */
export interface PerfCapture {
  /** 已创建的观察者清单（AC-14 断言 `disconnect` 被调用）。 */
  observers(): readonly PerfObserverLike[];
  /** 读数：已上报的指标事件数与长任务事件数。 */
  stats(): { readonly vitals: number; readonly longTasks: number };
  /** 卸载：断开全部观察器、移除监听；幂等。 */
  uninstall(): void;
}

/** 采集插件定义：可直接交给 `kernel.registerPlugin`。 */
export interface PerfPlugin extends Plugin {
  readonly id: typeof PERF_PLUGIN_ID;
  readonly capture: PerfCapture;
}

/** 缺省的观察者工厂：使用宿主真实的 `PerformanceObserver`；不可用时返回 `undefined`（降级）。 */
function resolveObserverFactory(
  injected: PerfObserverFactory | undefined,
): PerfObserverFactory | undefined {
  if (injected !== undefined) return injected;
  if (typeof PerformanceObserver === 'undefined') return undefined;
  return (callback: PerfObserverCallback): PerfObserverLike => {
    const observer = new PerformanceObserver((list) => {
      callback({ getEntries: () => list.getEntries() });
    });
    return observer;
  };
}

/** 采集状态：观察者、完成时机订阅与读数。 */
interface PerfState {
  readonly capture: PerfCapture;
  /**
   * 接上完成时机（加载完成 / 交互后 / 页面隐藏）。
   *
   * `context` 为 `undefined` 时只用注入的 `ports.completion`（测试入口）；
   * 传入内核上下文时，未注入的时机回落到内核的原生监听注册表。
   */
  attach(context?: PluginContext): void;
}

/** 创建性能采集状态。 */
function createPerfState(sink: PerfSink, ports?: PerfPorts): PerfState {
  const now = ports?.now ?? ((): number => Date.now());
  const accumulator: VitalsAccumulator = createVitalsAccumulator({
    now,
    ...(ports?.responseStartProvider === undefined
      ? {}
      : { responseStartProvider: ports.responseStartProvider }),
  });
  const factory = resolveObserverFactory(ports?.createObserver);
  const observers: PerfObserverLike[] = [];
  const disposers: (() => void)[] = [];
  let disposed = false;
  let vitalsCount = 0;
  let longTaskCount = 0;

  /** 组装并上报一条核心指标（`take` 取走，保证只上报一次）。 */
  const emitVitals = (metricName: 'FCP' | 'LCP' | 'CLS' | 'INP' | 'TTFB'): void => {
    const event = accumulator.take(metricName);
    if (event === undefined) return;
    vitalsCount += 1;
    sink.vitals(event);
  };

  const handleEntries = (entries: readonly PerfEntryLike[]): void => {
    // 卸载后即使宿主仍调用回调也不得上报（AC-14）。
    if (disposed) return;
    for (const entry of entries) {
      if (entry.entryType === 'longtask') {
        longTaskCount += 1;
        sink.longTask(normalizeLongTask(entry, now()));
        continue;
      }
      accumulator.observe(entry);
    }
  };

  // 每种条目类型单独 observe 并各自捕获异常：某个类型不可用不影响其余类型（AC-07）。
  if (factory !== undefined) {
    const observer = factory((list) => {
      handleEntries(list.getEntries());
    });
    observers.push(observer);
    for (const type of OBSERVED_ENTRY_TYPES) {
      try {
        observer.observe({ type, buffered: true });
      } catch {
        // 该条目类型在当前浏览器不可用：跳过它，其余类型照常（AC-07）。
      }
    }
  }

  const capture: PerfCapture = {
    observers(): readonly PerfObserverLike[] {
      return observers;
    },
    stats(): { readonly vitals: number; readonly longTasks: number } {
      return { vitals: vitalsCount, longTasks: longTaskCount };
    },
    uninstall(): void {
      if (disposed) return;
      disposed = true;
      // 断开观察器：远程配置关闭性能插件后不再上报（AC-14）。
      for (const observer of observers) {
        observer.disconnect();
      }
      for (const dispose of disposers.splice(0)) dispose();
    },
  };

  return {
    capture,
    attach(context?: PluginContext): void {
      const completion = ports?.completion;
      // 没有注入时机且没有内核上下文时无从接线（例如只创建端口不安装）。
      if (context === undefined && completion === undefined) return;
      if (completion?.onLoad !== undefined) {
        disposers.push(
          completion.onLoad(() => {
            if (disposed) return;
            emitVitals('FCP');
            emitVitals('LCP');
            emitVitals('TTFB');
          }),
        );
      } else if (context !== undefined) {
        disposers.push(
          context.listen('load', (): void => {
            if (disposed) return;
            emitVitals('FCP');
            emitVitals('LCP');
            emitVitals('TTFB');
          }),
        );
      }
      if (completion?.onInteraction !== undefined) {
        disposers.push(
          completion.onInteraction(() => {
            if (disposed) return;
            emitVitals('INP');
          }),
        );
      } else if (context !== undefined) {
        const onInteraction = (): void => {
          if (disposed) return;
          emitVitals('INP');
        };
        disposers.push(context.listen('pointerdown', onInteraction));
        disposers.push(context.listen('keydown', onInteraction));
      }
      if (completion?.onHidden !== undefined) {
        disposers.push(
          completion.onHidden(() => {
            if (disposed) return;
            emitVitals('CLS');
          }),
        );
      } else if (context !== undefined) {
        disposers.push(
          context.listen('visibilitychange', (): void => {
            const visibility = typeof document === 'undefined' ? undefined : document.visibilityState;
            if (visibility !== 'hidden' || disposed) return;
            emitVitals('CLS');
          }),
        );
        disposers.push(
          context.listen('pagehide', (): void => {
            if (disposed) return;
            emitVitals('CLS');
          }),
        );
      }
    },
  };
}

/**
 * 用注入端口创建一个性能采集实例（测试入口）。
 *
 * 测试通过 `ports.completion` 提供确定性的完成时机，不依赖真实 `document`/`window`。
 */
export function createPerfCapture(sink: PerfSink, ports?: PerfPorts): PerfCapture {
  const state = createPerfState(sink, ports);
  // 测试入口没有内核上下文：只接注入的完成时机（`ports.completion`）。
  state.attach();
  return state.capture;
}

/** 从内核安装上下文创建并安装性能采集（装配根使用）。 */
export function installPerfCapture(
  context: PluginContext,
  sink: PerfSink,
  ports?: PerfPorts,
): PerfCapture {
  const state = createPerfState(sink, ports);
  state.attach(context);
  return state.capture;
}

/** 创建性能采集插件。 */
export function createPerfPlugin(sink: PerfSink, ports?: PerfPorts): PerfPlugin {
  const state = createPerfState(sink, ports);
  return {
    id: PERF_PLUGIN_ID,
    install(context: PluginContext): void {
      state.attach(context);
    },
    capture: state.capture,
  };
}
