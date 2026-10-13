/**
 * C08-F1 / C08-F3 的 metrics 映射层用例：
 * - 固定计数 + 第 1 节 `drop_<原因码>` + 第 2 节 `count_<原因码>`；
 * - 值为 0 的计数不上报（Schema 里除耗时类外 `minimum: 1`）；
 * - 契约外的计数键一律不进入 metrics（Schema 是 `additionalProperties: false`）；
 * - CR-001 的 `exposure_window_ms` 仅在 `exposure_window_events >= 1` 时上报。
 */
import { describe, expect, test } from 'vitest';
import { buildHealthMetrics, clampWindowMs } from './metrics';
import { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';

describe('buildHealthMetrics（C08-F1）', () => {
  test('window_ms 必填且始终存在', () => {
    const metrics = buildHealthMetrics({ counters: {}, windowMs: 60_000 });
    expect(metrics.window_ms).toBe(60_000);
    expect(Object.keys(metrics)).toEqual(['window_ms']);
  });

  test('值为 0 的计数不上报', () => {
    const metrics = buildHealthMetrics({
      counters: { queue_evicted: 0, retry_5xx: 0, calls_total: 0 },
      windowMs: 1_000,
    });
    expect('drop_queue_evicted' in metrics).toBe(false);
    expect('count_retry_5xx' in metrics).toBe(false);
    expect(Object.keys(metrics)).toEqual(['window_ms']);
  });

  test('第 1 节原因码映射为 drop_，第 2 节映射为 count_', () => {
    const metrics = buildHealthMetrics({
      counters: { invalid_args: 3, prewrite_commit_lost: 2, processor_error: 5 },
      windowMs: 60_000,
    });
    expect(metrics.drop_invalid_args).toBe(3);
    expect(metrics.drop_prewrite_commit_lost).toBe(2);
    expect(metrics.count_processor_error).toBe(5);
  });

  test('契约外的计数键不进入 metrics（避免 additionalProperties: false 违规）', () => {
    const metrics = buildHealthMetrics({
      counters: { some_future_reason: 9, drops_total: 4 },
      windowMs: 1_000,
    });
    expect(Object.keys(metrics)).toEqual(['window_ms']);
  });

  test('非正整数计数被规整到 >=1 或剔除，固定计数与原因码计数共存', () => {
    const metrics = buildHealthMetrics({
      counters: { invalid_args: 1.4 },
      fixed: { calls_total: 100, events_sent: 0, queue_length_max: 2.5 },
      windowMs: 1_000,
    });
    expect(metrics.calls_total).toBe(100);
    expect('events_sent' in metrics).toBe(false);
    expect(metrics.queue_length_max).toBe(3);
    expect(metrics.drop_invalid_args).toBe(1);
  });

  test('CR-001 暴露窗口：events>=1 才上报 events，ms 仅在 events>=1 且非 null 时上报', () => {
    const gated = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      exposure: { events: 0, windowMs: 500 },
    });
    expect('exposure_window_events' in gated).toBe(false);
    expect('exposure_window_ms' in gated).toBe(false);

    const withWindow = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      exposure: { events: 4, windowMs: 12.6 },
    });
    expect(withWindow.exposure_window_events).toBe(4);
    expect(withWindow.exposure_window_ms).toBe(13);

    const withoutWindow = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      exposure: { events: 4, windowMs: null },
    });
    expect(withoutWindow.exposure_window_events).toBe(4);
    expect('exposure_window_ms' in withoutWindow).toBe(false);
  });

  test('耗时类指标只在采样命中且有样本时出现，允许 0', () => {
    const metrics = buildHealthMetrics({
      counters: {},
      windowMs: 1_000,
      latency: { track: 0, pipeline: 2.5 },
    });
    expect(metrics.track_p99_ms).toBe(0);
    expect(metrics.pipeline_p99_ms).toBe(2.5);
    expect('serialize_p99_ms' in metrics).toBe(false);
  });

  test('全部第 1/2 节原因码都能映射（AC-01 的全量口径）', () => {
    const counters: Record<string, number> = {};
    for (const code of DROP_REASON_CODES) counters[code] = 2;
    for (const code of COUNT_REASON_CODES) counters[code] = 3;
    const metrics = buildHealthMetrics({ counters, windowMs: 60_000 });
    for (const code of DROP_REASON_CODES) {
      expect(metrics[`drop_${code}`], code).toBe(2);
    }
    for (const code of COUNT_REASON_CODES) {
      expect(metrics[`count_${code}`], code).toBe(3);
    }
    expect(Object.keys(metrics).length).toBe(
      1 + DROP_REASON_CODES.length + COUNT_REASON_CODES.length,
    );
  });

  test('window_ms 规整到 >=1 的整数', () => {
    expect(clampWindowMs(60_000)).toBe(60_000);
    expect(clampWindowMs(0)).toBe(1);
    expect(clampWindowMs(-5)).toBe(1);
    expect(clampWindowMs(1.6)).toBe(2);
  });
});
