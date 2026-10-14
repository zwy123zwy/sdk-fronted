/**
 * C05-F2 五类核心指标用例（C05-AC-05、AC-07）。
 *
 * 口径：
 * - AC-05 要求正常加载后上报 FCP、LCP、TTFB，交互后上报 INP，页面隐藏时上报 CLS；
 * - 值必须来自注入的 `PerformanceObserver` 条目，**不得自行计时**；
 * - AC-07 要求不支持某条目类型时不抛错、跳过该指标、其余照常。
 */
import { describe, expect, it } from 'vitest';

import { METRIC_NAMES, createPerfCapture } from './index';
import type {
  PerfEntryLike,
  PerfObserverCallback,
  PerfObserverLike,
  VitalsEvent,
} from './index';

/** 伪造的 `PerformanceObserver`：记录 observe/disconnect，并允许测试手动投递条目。 */
interface FakeObserver extends PerfObserverLike {
  readonly observedTypes: string[];
  readonly disconnected: number;
  emit(entries: readonly PerfEntryLike[]): void;
}

/** 观察者工厂桩：可配置某个条目类型在 `observe` 时抛错（模拟浏览器不支持）。 */
function createObserverFactory(options: { readonly throwOn?: string | undefined } = {}): {
  observers: FakeObserver[];
  factory: (callback: PerfObserverCallback) => PerfObserverLike;
} {
  const observers: FakeObserver[] = [];
  const factory = (callback: PerfObserverCallback): PerfObserverLike => {
    const observedTypes: string[] = [];
    let disconnected = 0;
    const observer: FakeObserver = {
      observedTypes,
      get disconnected(): number {
        return disconnected;
      },
      observe(observeOptions): void {
        if (options.throwOn !== undefined && observeOptions.type === options.throwOn) {
          throw new Error(`unsupported entry type: ${observeOptions.type}`);
        }
        observedTypes.push(observeOptions.type);
      },
      disconnect(): void {
        disconnected += 1;
      },
      emit(entries: readonly PerfEntryLike[]): void {
        callback({ getEntries: () => entries });
      },
    };
    observers.push(observer);
    return observer;
  };
  return { observers, factory };
}

/** 造一条伪造性能条目。 */
function entry(partial: Partial<PerfEntryLike> & { readonly entryType: string }): PerfEntryLike {
  return {
    name: '',
    startTime: 100,
    duration: 0,
    ...partial,
  };
}

/** 装好性能采集，返回事件数组与完成时机触发器。 */
function setup(options: { readonly throwOn?: string | undefined } = {}): {
  vitals: VitalsEvent[];
  longTasks: number;
  observers: FakeObserver[];
  hide: () => void;
  interact: () => void;
  load: () => void;
  factory: (callback: PerfObserverCallback) => PerfObserverLike;
} {
  const { observers, factory } = createObserverFactory(options);
  const vitals: VitalsEvent[] = [];
  let longTasks = 0;
  const hiddenCallbacks: (() => void)[] = [];
  const interactionCallbacks: (() => void)[] = [];
  const loadCallbacks: (() => void)[] = [];

  createPerfCapture(
    {
      vitals: (event) => {
        vitals.push(event);
      },
      longTask: () => {
        longTasks += 1;
      },
    },
    {
      createObserver: factory,
      now: () => 1_700_000_000_000,
      responseStartProvider: () => 123.5,
      completion: {
        onHidden: (callback) => {
          hiddenCallbacks.push(callback);
          return () => undefined;
        },
        onInteraction: (callback) => {
          interactionCallbacks.push(callback);
          return () => undefined;
        },
        onLoad: (callback) => {
          loadCallbacks.push(callback);
          return () => undefined;
        },
      },
    },
  );

  return {
    vitals,
    get longTasks(): number {
      return longTasks;
    },
    observers,
    hide: () => {
      for (const callback of hiddenCallbacks) callback();
    },
    interact: () => {
      for (const callback of interactionCallbacks) callback();
    },
    load: () => {
      for (const callback of loadCallbacks) callback();
    },
    factory,
  };
}

describe('C05-AC-05 五类核心指标各自上报', () => {
  it('FCP/LCP/TTFB 在加载完成时上报，INP 在交互后上报，CLS 在隐藏时上报', () => {
    const harness = setup();
    const observer = harness.observers[0];
    expect(observer, '应创建至少一个 PerformanceObserver').toBeDefined();

    observer?.emit([entry({ entryType: 'paint', name: 'first-contentful-paint', startTime: 800 })]);
    observer?.emit([entry({ entryType: 'largest-contentful-paint', startTime: 1500 })]);
    harness.load();
    observer?.emit([entry({ entryType: 'event', name: 'click', startTime: 2000, duration: 120 })]);
    harness.interact();
    observer?.emit([entry({ entryType: 'layout-shift', startTime: 2100, value: 0.05 })]);
    harness.hide();

    const names = harness.vitals.map((event) => event.dimensions.metric_name);
    for (const metricName of METRIC_NAMES) {
      expect(names, `五类指标都要出现：缺 ${metricName}`).toContain(metricName);
    }
    // 每一类的值都来自注入条目，而不是自行计时
    const fcp = harness.vitals.find((event) => event.dimensions.metric_name === 'FCP');
    expect(fcp?.metrics.value).toBe(800);
    expect(fcp?.dimensions.rating).toBe('good');
    const ttfb = harness.vitals.find((event) => event.dimensions.metric_name === 'TTFB');
    expect(ttfb?.metrics.value).toBe(123.5);
  });

  it('CLS 只统计非「最近输入后」的偏移，delta 与 value 都必填', () => {
    const harness = setup();
    const observer = harness.observers[0];
    observer?.emit([entry({ entryType: 'layout-shift', startTime: 100, value: 0.04, hadRecentInput: false })]);
    observer?.emit([entry({ entryType: 'layout-shift', startTime: 200, value: 0.9, hadRecentInput: true })]);
    harness.hide();

    const cls = harness.vitals.find((event) => event.dimensions.metric_name === 'CLS');
    expect(cls, 'CLS 必须上报').toBeDefined();
    expect(cls?.metrics.value, '最近输入后的偏移不计入 CLS').toBeCloseTo(0.04, 5);
    expect(cls?.metrics.delta).toBeCloseTo(0.04, 5);
  });
});

describe('C05-AC-07 不支持的条目类型被跳过且不抛错', () => {
  it('某个条目类型的 observe 抛错时：不抛错、其余指标照常采集', () => {
    // setup() 内部即创建采集实例并注册观察者；用 throwing 记录“创建阶段是否抛错”
    let throwing = false;
    let harness: ReturnType<typeof setup> | undefined;
    try {
      harness = setup({ throwOn: 'layout-shift' });
    } catch {
      throwing = true;
    }
    expect(throwing, '不支持的条目类型不得让创建阶段抛错').toBe(false);
    if (harness === undefined) throw new Error('setup 未返回采集实例');

    const observer = harness.observers[0];
    expect(observer, '抛错的条目类型不得让整个插件放弃创建观察者').toBeDefined();
    expect(observer?.observedTypes).toContain('paint');
    expect(observer?.observedTypes).not.toContain('layout-shift');

    observer?.emit([entry({ entryType: 'paint', name: 'first-contentful-paint', startTime: 700 })]);
    harness.load();
    // FCP 照常上报；CLS 被跳过
    expect(harness.vitals.map((event) => event.dimensions.metric_name)).toContain('FCP');
    harness.hide();
    expect(harness.vitals.map((event) => event.dimensions.metric_name)).not.toContain('CLS');
  });
});
