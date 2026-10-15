/**
 * AC-03 第 3 步②：信标切片估算器的**校准**依据（真机实测数字）。
 *
 * 真机（`docs/reports/e2e-real-browser.md` 追加节第 2 次）：探针单事件原文 **743 B**，
 * `queue/size.ts` 的 `estimateEventBytes` 给 **923 B**（高估 24%），于是 29→32 KiB 的
 * 阈值只产出 26391 B 的片、80 KB 变 4 片、4 次写挤在同一同步回合。
 * 校准后必须既**接近实际**（不再掏空片）又**不小于实际**（切片上限才安全）。
 */
import { describe, expect, test } from 'vitest';
import type { QueueEvent } from '../batch/types';
import { estimateEventBytes } from '../queue/size';
import { estimateBeaconEventBytes } from './beacon-size';

/** 与 `tests/e2e/probes/leave-slice-driver.js` 的 `buildEvents()` 逐字段一致。 */
function ac03Event(index: number): QueueEvent {
  const metrics: Record<string, number> = {};
  for (let slot = 0; slot < 8; slot += 1) metrics[`m${String(slot)}`] = 1;
  return {
    event_id: `ac03-${String(index).padStart(4, '0')}`,
    event_name: 'ac03_slice',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: 1_750_000_000_000 + index,
    priority: 'normal',
    attachment: 'A'.repeat(520),
    metrics,
  };
}

describe('AC-03 信标估算器校准', () => {
  test('真机载荷：单事件实际 743 B → 校准后 745 B（旧口径 923 B，高估 24%）', () => {
    const event = ac03Event(0);
    const actual = JSON.stringify(event).length;
    const calibrated = estimateBeaconEventBytes(event);
    const legacy = estimateEventBytes(event);

    expect(actual, '真机实测：单事件原文 743 B').toBe(743);
    expect(legacy, '旧口径：923 B（高估 24%）').toBe(923);
    expect(calibrated, '校准后：745 B（余量 2 B）').toBe(745);
    expect(calibrated, '估算不得小于实际（切片上限必须安全）').toBeGreaterThanOrEqual(actual);
    expect(
      calibrated - actual,
      '高估不得超过 1%（旧口径 24%；片必须能被装满）',
    ).toBeLessThan(actual * 0.01);
  });

  test('估算器不小于实际：数字、字符串、布尔、null、数组、嵌套对象逐个覆盖', () => {
    const samples: readonly QueueEvent[] = [
      ac03Event(1),
      {
        event_id: 'e-1',
        event_name: 'thin',
        event_type: 'custom',
        schema_version: 1,
        occurred_at: 1,
        priority: 'normal',
      },
      {
        event_id: 'e-2',
        event_name: 'fat',
        event_type: 'custom',
        schema_version: 1,
        occurred_at: 1_750_000_000_000,
        priority: 'critical',
        flag: true,
        missing: null,
        list: [1, 22, 333, 'x', null, false],
        nested: { deep: { value: 1.5 }, big: 1234567890123456 },
        text: 'A'.repeat(101),
      },
    ];
    for (const event of samples) {
      const actual = JSON.stringify(event).length;
      const estimated = estimateBeaconEventBytes(event);
      expect(
        estimated,
        `估算 ${String(estimated)} 必须 ≥ 实际 ${String(actual)}`,
      ).toBeGreaterThanOrEqual(actual);
      expect(estimated).toBeLessThanOrEqual(actual + 32);
    }
  });

  test('112 条真机载荷：校准估算合计 ≈ 实际合计（旧口径多算 20 KB）', () => {
    const events = Array.from({ length: 112 }, (_, index) => ac03Event(index));
    const actual = JSON.stringify(events).length;
    const calibrated = events.reduce((sum, event) => sum + estimateBeaconEventBytes(event) + 1, 1);
    const legacy = events.reduce((sum, event) => sum + estimateEventBytes(event) + 2, 0);
    expect(actual, '真机实测：原始事件数组 83329 B').toBe(83329);
    expect(legacy, '旧口径把 80 KB 估成 103 KB').toBeGreaterThan(100_000);
    expect(calibrated, '校准口径贴合实际').toBeGreaterThanOrEqual(actual);
    expect(calibrated - actual, '校准口径误差 < 1%').toBeLessThan(actual * 0.01);
  });
});
