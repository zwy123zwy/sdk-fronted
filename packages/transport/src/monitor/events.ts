/**
 * `sdk_health` 事件组装（C08-F3）。
 *
 * Schema 的 `metrics.maxProperties` 是 50，因此一个窗口内非零指标超过 50 时要拆成
 * 多条事件：每条都带**相同的 `window_ms` 与 `dimensions`**，`event_id` 各自唯一，
 * `occurred_at` 相同。`window_ms` 计入每条事件的指标数，所以每条最多带 49 个其它指标。
 */
import { WINDOW_METRIC_KEY } from './metrics';
import type { HealthDimensions, SdkHealthEvent } from './types';

/** `metrics` 的硬上限（与 Schema 的 `maxProperties: 50` 一致）。 */
export const MAX_METRICS_PER_EVENT = 50;

export interface HealthEventInput {
  readonly metrics: Readonly<Record<string, number>>;
  readonly dimensions: HealthDimensions;
  readonly occurredAt: number;
  readonly createId: () => string;
  /** 单条事件的 metrics 上限；缺省 50（Schema 上限），仅用于测试或更保守的配置。 */
  readonly maxMetricsPerEvent?: number | undefined;
}

function clampMaxMetrics(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_METRICS_PER_EVENT;
  return Math.min(MAX_METRICS_PER_EVENT, Math.max(2, Math.floor(value)));
}

/** 把一组 metrics 组装为一条或多条 `sdk_health` 事件。 */
export function buildHealthEvents(input: HealthEventInput): readonly SdkHealthEvent[] {
  const maxMetrics = clampMaxMetrics(input.maxMetricsPerEvent);
  const windowMs = input.metrics[WINDOW_METRIC_KEY] ?? 1;
  const others = Object.entries(input.metrics).filter(([key]) => key !== WINDOW_METRIC_KEY);

  const createEvent = (metrics: Record<string, number>): SdkHealthEvent => ({
    event_id: input.createId(),
    event_name: 'sdk_health',
    event_type: 'sdk_internal',
    schema_version: 1,
    occurred_at: input.occurredAt,
    priority: 'normal',
    dimensions: input.dimensions,
    metrics,
  });

  if (others.length === 0) {
    return [createEvent({ [WINDOW_METRIC_KEY]: windowMs })];
  }

  const capacity = maxMetrics - 1;
  const events: SdkHealthEvent[] = [];
  for (let index = 0; index < others.length; index += capacity) {
    const chunk = others.slice(index, index + capacity);
    events.push(createEvent({ [WINDOW_METRIC_KEY]: windowMs, ...Object.fromEntries(chunk) }));
  }
  return events;
}
