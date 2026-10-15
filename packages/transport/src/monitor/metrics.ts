/**
 * `sdk_health.metrics` 的映射层（C08-F1 / C08-F3）。
 *
 * 输入是各环节的**窗口增量**，输出严格对齐
 * `docs/contracts/schemas/builtin-events/sdk_health.schema.json`：
 * - `window_ms` 必填、整数、>=1；
 * - 值为 0 的计数不上报（Schema 里除耗时类外 `minimum: 1`）；
 * - 契约外的计数键一律不进入结果（Schema 是 `additionalProperties: false`）；
 * - CR-001：`exposure_window_ms` 只在 `exposure_window_events >= 1` 时上报
 *   （Schema 侧由 `dependentRequired` 兜底，映射层先行保证）；
 * - CR-008：夹逼端点 `exposure_window_lower_bound_ms` / `exposure_window_upper_bound_ms`
 *   成对上报（要有下界读数）；两个观测量 `flush_skipped_due_to_budget` / `leader_lost`
 *   不带 `drop_` / `count_` 前缀，值为 0 时不上报。
 */
import { METRIC_EXPOSURE_WINDOW_EVENTS, METRIC_EXPOSURE_WINDOW_MS } from '../offline/constants';
import {
  EXPOSURE_WINDOW_LOWER_BOUND_MS,
  EXPOSURE_WINDOW_UPPER_BOUND_MS,
  METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
  METRIC_LEADER_LOST,
} from './observables';
import { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';
import {
  FIXED_METRIC_NAMES,
  LATENCY_METRIC_NAMES,
  LATENCY_STAGES,
} from './types';
import type {
  ExposureWindowInput,
  FixedMetricDeltas,
  LatencyP99,
  ObservableMetricsInput,
} from './types';

/** `window_ms` 的键名（拆片时每个分片都要带上它）。 */
export const WINDOW_METRIC_KEY = 'window_ms';

/** 映射层输入。所有计数字段都应是**本窗口的增量**。 */
export interface HealthMetricsInput {
  readonly counters: Readonly<Record<string, number>>;
  readonly fixed?: FixedMetricDeltas | undefined;
  readonly latency?: LatencyP99 | undefined;
  readonly exposure?: ExposureWindowInput | null | undefined;
  /** CR-008：两个观测量的窗口增量（不是原因码）。 */
  readonly observables?: ObservableMetricsInput | null | undefined;
  readonly windowMs: number;
}

/** 把窗口长度规整为 Schema 要求的整数（>=1）。 */
export function clampWindowMs(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}

/**
 * 计数类指标的取值规整：非有限值、<1 的值一律不上报（值为 0 时 Schema 会拒绝），
 * 其余四舍五入到整数（Schema 要求 `integer`）。
 */
function toCountValue(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value) || value < 1) return null;
  const rounded = Math.round(value);
  return rounded >= 1 ? rounded : null;
}

/**
 * CR-008 **时长**类指标的取值规整：允许 0（夹逼下界可以是 0 ms，它不是计数），
 * 非有限值或负值不上报，其余四舍五入到整数（Schema 要求 `integer`）。
 */
function toDurationValue(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * 把窗口内的各环节计数映射为 `sdk_health.metrics`。
 * 输出顺序固定（`window_ms` → 固定计数 → 暴露窗口与夹逼端点 → CR-008 观测量 →
 * `drop_*` → `count_*` → 三个 p99），便于体积与断言稳定。
 */
export function buildHealthMetrics(input: HealthMetricsInput): Record<string, number> {
  const metrics: Record<string, number> = { [WINDOW_METRIC_KEY]: clampWindowMs(input.windowMs) };

  const fixed = input.fixed;
  if (fixed !== undefined) {
    for (const name of FIXED_METRIC_NAMES) {
      const value = toCountValue(fixed[name]);
      if (value !== null) metrics[name] = value;
    }
  }

  const exposure = input.exposure;
  if (exposure !== undefined && exposure !== null) {
    const events = toCountValue(exposure.events);
    if (events !== null) {
      metrics[METRIC_EXPOSURE_WINDOW_EVENTS] = events;
      // CR-001：ms 仅在事件数 >= 1 时上报；没有可用的窗口长度时也不上报。
      if (exposure.windowMs !== null) {
        const windowMs = toCountValue(exposure.windowMs);
        if (windowMs !== null) {
          metrics[METRIC_EXPOSURE_WINDOW_MS] = windowMs;
          // CR-008：捕获到窗口时成对上报夹逼端点（下界允许 0）。没有下界读数
          // （没捕获到窗口）时两个端点都不上报——单独一个端点不构成夹逼。
          const observedWindowMs = toDurationValue(exposure.observedWindowMs);
          if (observedWindowMs !== null) {
            metrics[EXPOSURE_WINDOW_LOWER_BOUND_MS] = observedWindowMs;
            metrics[EXPOSURE_WINDOW_UPPER_BOUND_MS] = windowMs;
          }
        }
      }
    }
  }

  // CR-008：两个**观测量**（CR-001 §5.2 第 3 条裁定不计原因码），键名照抄 CR-001 原文，
  // 因此不带 `drop_` / `count_` 前缀；与固定计数同口径，值为 0 时不上报。
  const observables = input.observables;
  if (observables !== undefined && observables !== null) {
    const budgetStops = toCountValue(observables.flushSkippedDueToBudget);
    if (budgetStops !== null) metrics[METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET] = budgetStops;
    const leaderLost = toCountValue(observables.leaderLost);
    if (leaderLost !== null) metrics[METRIC_LEADER_LOST] = leaderLost;
  }

  for (const code of DROP_REASON_CODES) {
    const value = toCountValue(input.counters[code]);
    if (value !== null) metrics[`drop_${code}`] = value;
  }
  for (const code of COUNT_REASON_CODES) {
    const value = toCountValue(input.counters[code]);
    if (value !== null) metrics[`count_${code}`] = value;
  }

  const latency = input.latency;
  if (latency !== undefined) {
    for (const stage of LATENCY_STAGES) {
      const value = latency[stage];
      if (value !== undefined && Number.isFinite(value) && value >= 0) {
        metrics[LATENCY_METRIC_NAMES[stage]] = value;
      }
    }
  }

  return metrics;
}
