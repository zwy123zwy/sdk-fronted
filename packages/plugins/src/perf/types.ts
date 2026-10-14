/**
 * C05-F2 性能插件的类型契约。
 *
 * 字段名照抄 `docs/contracts/schemas/builtin-events/`：
 * - `web_vitals.schema.json`：`dimensions.metric_name` 枚举为 **`FCP`/`LCP`/`CLS`/`INP`/`TTFB`**，
 *   `dimensions.rating` 必填枚举 **`good`/`needs-improvement`/`poor`**；
 *   值走 `metrics.value` 与 `metrics.delta`（均必填）。
 * - `web_long_task.schema.json`：`metrics.duration_ms` 必填（number），`metrics.start_time_ms` 可选；
 *   该 Schema 的 `dimensions` 是**空对象 schema**，因此**不得往里塞任何字段**。
 *
 * 采集方式：`PerformanceObserver` 只负责“收到条目”，计时/阈值判定不自己实现
 * （长任务的可观测性差异归 T29 复测）。
 */

/** 五类核心指标的事件名。 */
export const VITALS_EVENT_NAME = 'web_vitals';

/** 长任务的事件名。 */
export const LONG_TASK_EVENT_NAME = 'web_long_task';

/** `metric_name` 的五类取值（照抄 Schema 枚举）。 */
export type MetricName = 'FCP' | 'LCP' | 'CLS' | 'INP' | 'TTFB';

/** `metric_name` 的取值清单（保持 Schema 顺序）。 */
export const METRIC_NAMES: readonly MetricName[] = ['FCP', 'LCP', 'CLS', 'INP', 'TTFB'];

/** `rating` 的三档取值（照抄 Schema 枚举）。 */
export type VitalsRating = 'good' | 'needs-improvement' | 'poor';

/** `web_vitals` 的 `dimensions` 段。 */
export interface VitalsDimensions {
  readonly metric_name: MetricName;
  readonly rating: VitalsRating;
}

/** `web_vitals` 的 `metrics` 段（`value` 与 `delta` 均必填）。 */
export interface VitalsMetrics {
  readonly value: number;
  readonly delta: number;
}

/** 一条归一化后的核心指标事件。 */
export interface VitalsEvent {
  readonly event_name: typeof VITALS_EVENT_NAME;
  readonly priority: 'normal' | 'critical';
  readonly occurred_at: number;
  readonly dimensions: VitalsDimensions;
  readonly metrics: VitalsMetrics;
}

/** `web_long_task` 的 `metrics` 段。 */
export interface LongTaskMetrics {
  readonly duration_ms: number;
  readonly start_time_ms?: number | undefined;
}

/**
 * 一条归一化后的长任务事件。
 *
 * 注意：`dimensions` 是 `{}` 空对象 schema —— 只允许为空对象，**不得加任何字段**。
 */
export interface LongTaskEvent {
  readonly event_name: typeof LONG_TASK_EVENT_NAME;
  readonly priority: 'normal' | 'critical';
  readonly occurred_at: number;
  readonly dimensions: Readonly<Record<string, never>>;
  readonly metrics: LongTaskMetrics;
}

/**
 * `PerformanceObserver` 条目的结构子集（DOM 的 `PerformanceEntry` 子集）。
 * 用结构子集而非 DOM 具体类，便于测试注入伪造条目。
 */
export interface PerfEntryLike {
  readonly entryType: string;
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
  /** `layout-shift` 的偏移分数。 */
  readonly value?: number | undefined;
  /** `layout-shift` 是否为「最近输入后」的偏移；为 `true` 时不计入 CLS。 */
  readonly hadRecentInput?: boolean | undefined;
}

/** 观察者回调入参：能取到条目列表。 */
export interface PerfEntryListLike {
  getEntries(): readonly PerfEntryLike[];
}

/** 观察者回调。 */
export type PerfObserverCallback = (list: PerfEntryListLike) => void;

/** `PerformanceObserver` 的结构子集。 */
export interface PerfObserverLike {
  observe(options: { readonly type: string; readonly buffered?: boolean }): void;
  disconnect(): void;
}

/** 观察者工厂：真实实现传 `(callback) => new PerformanceObserver(callback)`；测试注入伪造观察者。 */
export type PerfObserverFactory = (callback: PerfObserverCallback) => PerfObserverLike;

/** 「页面隐藏」/「交互」等完成时机的订阅端口。 */
export interface PerfCompletionPorts {
  /** 页面隐藏时回调（CLS 在此时汇总并上报）；返回注销函数。 */
  readonly onHidden?: ((callback: () => void) => () => void) | undefined;
  /** 交互结束时回调（INP 在此时汇总并上报）；返回注销函数。 */
  readonly onInteraction?: ((callback: () => void) => () => void) | undefined;
  /** 页面加载完成时回调（FCP/LCP/TTFB 汇总）；返回注销函数。 */
  readonly onLoad?: ((callback: () => void) => () => void) | undefined;
}

/** 创建性能插件所需的注入端口（全部可注入，便于确定性测试）。 */
export interface PerfPorts {
  /** 观察者工厂；缺省用 `globalThis.PerformanceObserver`，不存在时降级（AC-07 不抛错）。 */
  readonly createObserver?: PerfObserverFactory | undefined;
  /** 当前时间源；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  /**
   * TTFB 的来源：`navigation` 计时的 `responseStart`。
   * `navigation` 明细条目本身**不采集**（契约没有承载字段），只取这一个数。
   * 返回 `undefined` 表示取不到（跳过 TTFB，AC-07）。
   */
  readonly responseStartProvider?: (() => number | undefined) | undefined;
  /** 完成时机订阅；缺省由装配根接真实 `document`/`window`。 */
  readonly completion?: PerfCompletionPorts | undefined;
}
