/**
 * C05-F2 核心指标（web_vitals）与长任务（web_long_task）的归一化。
 *
 * 映射（T18-plan §2 定稿）：
 * - `paint`（`first-contentful-paint`）→ `FCP`；`largest-contentful-paint` → `LCP`；
 *   `layout-shift` → `CLS`；`event`（interaction）→ `INP`；
 *   `navigation` 的 `responseStart` → `TTFB`（由装配根通过 `responseStartProvider` 提供——
 *   契约没有承载 `navigation` 明细条目的字段，所以只取这一个数）。
 *
 * 明确**不采集** `resource` 与 `navigation` 的明细条目。
 */
import type { LongTaskEvent, MetricName, PerfEntryLike, VitalsEvent, VitalsRating } from './types';

/** 需要观察的条目类型（`paint` 在前：AC-07 要求某类型不可用时"其余照常"）。 */
export const OBSERVED_ENTRY_TYPES: readonly string[] = [
  'paint',
  'largest-contentful-paint',
  'layout-shift',
  'event',
  'longtask',
];

/**
 * Web Vitals 官方阈值（README 同步写明；真实浏览器差异归 T29）。
 * 每项为 `[good 上限, poor 下限]`：`≤ good` 判 `good`，`> poor` 判 `poor`，其余 `needs-improvement`。
 */
const THRESHOLDS: Readonly<Record<MetricName, readonly [number, number]>> = {
  FCP: [1800, 3000],
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  TTFB: [800, 1800],
};

/** 按 Web Vitals 官方阈值判定 `rating`。 */
export function rate(metricName: MetricName, value: number): VitalsRating {
  const [good, poor] = THRESHOLDS[metricName];
  if (value <= good) return 'good';
  if (value > poor) return 'poor';
  return 'needs-improvement';
}

/** 创建核心指标累计器所需的注入端口。 */
export interface VitalsAccumulatorOptions {
  /** 当前时间源；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  /** TTFB 的来源（`navigation` 计时的 `responseStart`）；不提供即不采集 TTFB（AC-07）。 */
  readonly responseStartProvider?: (() => number | undefined) | undefined;
}

/** 核心指标累计器：**取走式**（`take`），保证每个指标只上报一次。 */
export interface VitalsAccumulator {
  /** 把 entryType（可带条目名）归一化为指标名；不属于五类核心指标时返回 `undefined`。 */
  classify(entryType: string, name?: string): MetricName | undefined;
  /** 记录一个条目（只更新累计值，不做序列化）。 */
  observe(entry: PerfEntryLike): void;
  /**
   * 组装并**取走**一条事件；该指标此前未观测到（或已被取走）时返回 `undefined`。
   * 取走语义保证「五类指标各自只上报一次」（AC-05）。
   */
  take(metricName: MetricName): VitalsEvent | undefined;
  /** 已观测到且尚未取走的指标名（按首次出现顺序）。 */
  seen(): readonly MetricName[];
}

/** 造一条 `web_vitals` 事件（`value` 与 `delta` 均必填）。 */
function buildVitalsEvent(metricName: MetricName, value: number, occurredAt: number): VitalsEvent {
  return {
    event_name: 'web_vitals',
    priority: 'normal',
    occurred_at: occurredAt,
    dimensions: { metric_name: metricName, rating: rate(metricName, value) },
    metrics: { value, delta: value },
  };
}

/** 创建核心指标累计器。 */
export function createVitalsAccumulator(options?: VitalsAccumulatorOptions): VitalsAccumulator {
  const now = options?.now ?? ((): number => Date.now());
  const responseStartProvider = options?.responseStartProvider;
  /** 已累计的值；键不存在表示尚未观测到。 */
  const values = new Map<MetricName, number>();
  /** 首次出现顺序（`seen()` 用）。 */
  const order: MetricName[] = [];

  const note = (metricName: MetricName, value: number, mode: 'max' | 'sum'): void => {
    if (!values.has(metricName)) order.push(metricName);
    const previous = values.get(metricName);
    values.set(metricName, previous === undefined ? value : mode === 'max' ? Math.max(previous, value) : previous + value);
  };

  const drop = (metricName: MetricName): void => {
    values.delete(metricName);
    const index = order.indexOf(metricName);
    if (index >= 0) order.splice(index, 1);
  };

  return {
    classify(entryType: string, name?: string): MetricName | undefined {
      if (entryType === 'paint') return name === 'first-contentful-paint' ? 'FCP' : undefined;
      if (entryType === 'largest-contentful-paint') return 'LCP';
      if (entryType === 'layout-shift') return 'CLS';
      if (entryType === 'event') return 'INP';
      return undefined;
    },
    observe(entry: PerfEntryLike): void {
      const metricName = this.classify(entry.entryType, entry.name);
      if (metricName === undefined) return;
      if (metricName === 'CLS') {
        // 「最近输入后」的偏移不计入 CLS（官方口径）。
        if (entry.hadRecentInput === true) return;
        note('CLS', entry.value ?? 0, 'sum');
        return;
      }
      if (metricName === 'INP') {
        // `event` 条目的 duration 即交互延迟。
        note('INP', entry.duration, 'max');
        return;
      }
      note(metricName, entry.startTime, 'max');
    },
    take(metricName: MetricName): VitalsEvent | undefined {
      if (metricName === 'TTFB') {
        // TTFB 不在条目里累计：只从 `responseStart` 取；取不到就跳过（AC-07）。
        const responseStart = responseStartProvider?.();
        if (responseStart === undefined) return undefined;
        drop('TTFB');
        return buildVitalsEvent('TTFB', responseStart, now());
      }
      const value = values.get(metricName);
      if (value === undefined) return undefined;
      drop(metricName);
      return buildVitalsEvent(metricName, value, now());
    },
    seen(): readonly MetricName[] {
      return [...order];
    },
  };
}

/**
 * 把一条 `longtask` 条目归一化为 `web_long_task`。
 *
 * `dimensions` 必须为空对象（该 Schema 的 `dimensions` 无 properties、`additionalProperties: false`）；
 * `start_time_ms` 与 `PerformanceEntry.startTime` 同基准（相对 time origin 的毫秒数）。
 */
export function normalizeLongTask(entry: PerfEntryLike, occurredAt: number): LongTaskEvent {
  return {
    event_name: 'web_long_task',
    priority: 'normal',
    occurred_at: occurredAt,
    dimensions: {},
    metrics: { duration_ms: entry.duration, start_time_ms: entry.startTime },
  };
}
