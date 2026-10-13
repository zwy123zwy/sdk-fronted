/**
 * C08-AC-04 / C08-AC-06 的事件组装用例：
 * - 单条事件的字段与 `sdk_health.schema.json` 对齐（`priority` 固定 `normal`）；
 * - `maxProperties: 50`：窗口内非零指标超过 50 时拆成多条，每条带相同的
 *   `window_ms` 与 `dimensions`（含“恰好 50”“51 个”两个边界）；
 * - 只有 `window_ms` 时也产出一条事件。
 */
import { describe, expect, test } from 'vitest';
import { buildHealthEvents, MAX_METRICS_PER_EVENT } from './events';
import type { HealthDimensions } from './types';

const DIMENSIONS: HealthDimensions = { sdk_version: '1.2.3', state: 'running' };

let sequence = 0;
function createId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function metricsWith(count: number): Record<string, number> {
  const metrics: Record<string, number> = { window_ms: 60_000 };
  for (let index = 0; index < count; index += 1) {
    metrics[`drop_reason_${String(index)}`] = index + 1;
  }
  return metrics;
}

describe('buildHealthEvents（C08-F3）', () => {
  test('单条事件的固定字段与 Schema 对齐，priority 固定 normal', () => {
    const events = buildHealthEvents({
      metrics: { window_ms: 60_000, calls_total: 3 },
      dimensions: DIMENSIONS,
      occurredAt: 1_793_000_060_000,
      createId,
    });
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.event_name).toBe('sdk_health');
    expect(event?.event_type).toBe('sdk_internal');
    expect(event?.schema_version).toBe(1);
    expect(event?.priority).toBe('normal');
    expect(event?.occurred_at).toBe(1_793_000_060_000);
    expect(event?.dimensions).toEqual(DIMENSIONS);
    expect(event?.metrics.window_ms).toBe(60_000);
    expect(event?.metrics.calls_total).toBe(3);
  });

  test('恰好 50 个指标时不拆分（window_ms 计入 50）', () => {
    const metrics = metricsWith(49);
    expect(Object.keys(metrics)).toHaveLength(50);
    const events = buildHealthEvents({
      metrics,
      dimensions: DIMENSIONS,
      occurredAt: 1,
      createId,
    });
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]?.metrics ?? {})).toHaveLength(MAX_METRICS_PER_EVENT);
  });

  test('51 个指标时拆成两条，每条 <=50 且都带 window_ms 与相同 dimensions', () => {
    const metrics = metricsWith(50);
    expect(Object.keys(metrics)).toHaveLength(51);
    const events = buildHealthEvents({
      metrics,
      dimensions: DIMENSIONS,
      occurredAt: 1,
      createId,
    });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(Object.keys(event.metrics).length).toBeLessThanOrEqual(MAX_METRICS_PER_EVENT);
      expect(event.metrics.window_ms).toBe(60_000);
      expect(event.dimensions).toEqual(DIMENSIONS);
      expect(event.priority).toBe('normal');
    }
    const carried = events
      .flatMap((event) => Object.keys(event.metrics))
      .filter((key) => key !== 'window_ms');
    expect(carried).toHaveLength(50);
    expect(new Set(carried).size).toBe(50);
  });

  test('非零指标远超 50 时全部保留且不重复', () => {
    const metrics = metricsWith(120);
    const events = buildHealthEvents({
      metrics,
      dimensions: DIMENSIONS,
      occurredAt: 1,
      createId,
    });
    expect(events).toHaveLength(3);
    const carried = events
      .flatMap((event) => Object.keys(event.metrics))
      .filter((key) => key !== 'window_ms');
    expect(carried).toHaveLength(120);
    expect(new Set(carried).size).toBe(120);
    for (const event of events) {
      expect(Object.keys(event.metrics).length).toBeLessThanOrEqual(MAX_METRICS_PER_EVENT);
    }
  });

  test('只有 window_ms 时也产出一条事件', () => {
    const events = buildHealthEvents({
      metrics: { window_ms: 1_000 },
      dimensions: DIMENSIONS,
      occurredAt: 1,
      createId,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metrics).toEqual({ window_ms: 1_000 });
  });

  test('拆出的多条事件 event_id 唯一、occurred_at 相同', () => {
    const events = buildHealthEvents({
      metrics: metricsWith(120),
      dimensions: DIMENSIONS,
      occurredAt: 777,
      createId,
    });
    expect(new Set(events.map((event) => event.event_id)).size).toBe(events.length);
    for (const event of events) expect(event.occurred_at).toBe(777);
  });

  test('可配置单条事件指标上限（更保守的配置）', () => {
    const events = buildHealthEvents({
      metrics: metricsWith(10),
      dimensions: DIMENSIONS,
      occurredAt: 1,
      createId,
      maxMetricsPerEvent: 5,
    });
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(Object.keys(event.metrics).length).toBeLessThanOrEqual(5);
      expect(event.metrics.window_ms).toBe(60_000);
    }
  });
});
