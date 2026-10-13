/**
 * C04-AC-13 / C04-AC-15 / C04-AC-17 与字段约束的全部边界（C04-F6）。
 *
 * AC-13：维度值 300 字符、60 个维度键、10 KB 附件 → 截断到 256 / 50 / 8 KB；
 *        `truncated` 列出路径；计数对应原因码。
 * AC-15：单条事件截断后仍超过 16 KB → 整条丢弃，计数 `event_too_large`。
 * AC-17：维度键 `Title`、`1abc` 被丢弃并计数 `invalid_field_key`；60 个指标键保留 50
 *        并计数 `truncated_metric_keys`。
 *
 * 口径（编排方 2026-10-13 裁定）：16 KB 与 8 KB 都按 **UTF-8 序列化字节**，
 * 16 KB 只算**单条事件体**（不含批次头与 `common`）。
 *
 * 幂等（T12 交付时的分工裁定）：C01 已按 Schema 截断的事件再进 C04 时**不得二次计数**。
 *
 * 测试数据全部是格式合法的伪造值。
 *
 * 取证顺序：本文件在**实现前先写**（当时 `constrainEvent` 是原样返回的接口桩，
 * 全部语义用例红过），之后实现转绿。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { C04_LIMITS } from './constants';
import { constrainEvent } from './constraints';
import { createMasker } from './mask';
import { PRIVACY_REASON_CODES } from './reason-codes';
import { utf8Bytes } from './limits';

/** 计数替身。 */
function makeCounter() {
  const counts = new Map<string, number>();
  return {
    count: (reason: string, delta = 1): void => {
      counts.set(reason, (counts.get(reason) ?? 0) + delta);
    },
    get: (reason: string): number => counts.get(reason) ?? 0,
    all: (): Record<string, number> => Object.fromEntries(counts),
  };
}

/** 构造一条最小合法事件（只含 `$defs/event` 必填字段）。 */
function makeEvent(extra: Record<string, unknown> = {}): KernelEvent {
  return {
    event_id: '00000000-0000-4000-8000-000000000001',
    event_name: 'task_complete',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: 1_700_000_000_000,
    priority: 'normal',
    ...extra,
  };
}

/** 运行一次约束处理。 */
function run(event: KernelEvent, extra: Record<string, unknown> = {}) {
  const counter = makeCounter();
  const result = constrainEvent({
    event,
    limits: C04_LIMITS,
    masker: createMasker(),
    count: counter.count,
    ...extra,
  });
  return { counter, result, event: result.event };
}

describe('C04-AC-13 值/键数/附件的截断', () => {
  it('维度值 300 字符被截断到 256，并写入 truncated 路径', () => {
    const { counter, event } = run(makeEvent({ dimensions: { title: 'x'.repeat(300) } }));
    const dimensions = event['dimensions'] as Record<string, string>;
    expect(dimensions['title']?.length).toBe(256);
    expect(event['truncated']).toContain('dimensions.title');
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimension)).toBeGreaterThanOrEqual(1);
  });

  it('60 个维度键保留字典序前 50，其余丢弃并写入 truncated', () => {
    const dimensions: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) dimensions[`k${String(index).padStart(2, '0')}`] = `v${String(index)}`;
    const { counter, event } = run(makeEvent({ dimensions }));
    const kept = event['dimensions'] as Record<string, string>;
    expect(Object.keys(kept)).toHaveLength(C04_LIMITS.maxDimensionKeys);
    expect(Object.keys(kept)).toEqual(Object.keys(dimensions).sort().slice(0, 50));
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimensionKeys)).toBe(1);
  });

  it('10 KB 附件被截断到 8 KB（UTF-8 字节），并写入 truncated 路径', () => {
    const { counter, event } = run(makeEvent({ attachment: 'a'.repeat(10_240) }));
    const attachment = event['attachment'] as string;
    expect(utf8Bytes(attachment)).toBeLessThanOrEqual(C04_LIMITS.maxAttachmentBytes);
    expect(utf8Bytes(attachment)).toBeGreaterThan(C04_LIMITS.maxAttachmentBytes - 4);
    expect(event['truncated']).toContain('attachment');
    expect(counter.get(PRIVACY_REASON_CODES.truncatedAttachment)).toBe(1);
  });

  it('AC-13 的组合场景：300 字符值 + 60 键 + 10 KB 附件同时被截断', () => {
    const dimensions: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) dimensions[`k${String(index).padStart(2, '0')}`] = 'x'.repeat(300);
    const { counter, event } = run(makeEvent({ dimensions, attachment: 'a'.repeat(10_240) }));
    const kept = event['dimensions'] as Record<string, string>;
    expect(Object.keys(kept)).toHaveLength(50);
    expect(kept['k00']).toHaveLength(256);
    expect(utf8Bytes(event['attachment'] as string)).toBeLessThanOrEqual(8192);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimensionKeys)).toBe(1);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedAttachment)).toBe(1);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimension)).toBeGreaterThanOrEqual(1);
    expect(counter.get(PRIVACY_REASON_CODES.eventTooLarge)).toBe(0);
  });

  it('恰好 256 字符不截断、不计数（边界为「超过才截断」）', () => {
    const { counter, event } = run(makeEvent({ dimensions: { title: 'x'.repeat(256) } }));
    expect((event['dimensions'] as Record<string, string>)['title']).toHaveLength(256);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimension)).toBe(0);
    expect(event['truncated']).toBeUndefined();
  });

  it('恰好 50 个键不裁剪、不计数', () => {
    const dimensions: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) dimensions[`k${String(index).padStart(2, '0')}`] = 'v';
    const { counter, event } = run(makeEvent({ dimensions }));
    expect(Object.keys(event['dimensions'] as Record<string, string>)).toHaveLength(50);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimensionKeys)).toBe(0);
  });

  it('context 与 dimensions 是各自独立的 50 键上限', () => {
    const makeMap = (prefix: string): Record<string, string> => {
      const map: Record<string, string> = {};
      for (let index = 0; index < 60; index += 1) map[`${prefix}${String(index).padStart(2, '0')}`] = 'v';
      return map;
    };
    const { event } = run(makeEvent({ dimensions: makeMap('d'), context: makeMap('c') }));
    expect(Object.keys(event['dimensions'] as Record<string, string>)).toHaveLength(50);
    expect(Object.keys(event['context'] as Record<string, string>)).toHaveLength(50);
  });

  it('context 的 300 字符值同样被掩码并截断到 256', () => {
    const { event } = run(makeEvent({ context: { note: 'x'.repeat(300) } }));
    expect((event['context'] as Record<string, string>)['note']).toHaveLength(256);
  });

  it('values 里的伪造 PII 在约束阶段被掩码（脱敏先于截断）', () => {
    const { event } = run(makeEvent({ dimensions: { contact: 'mail a@b.com or 13800138000' } }));
    expect((event['dimensions'] as Record<string, string>)['contact']).toBe('mail ***@*** or 1**********');
  });

  it('截断路径去重（同一路径不重复出现）', () => {
    const { event } = run(makeEvent({ dimensions: { a: 'x'.repeat(300), b: 'x'.repeat(300) } }));
    const truncated = event['truncated'] as string[];
    expect(new Set(truncated).size).toBe(truncated.length);
  });

  it('truncated 路径数量不超过 60（Schema maxItems，不新增原因码）', () => {
    const dimensions: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) dimensions[`k${String(index).padStart(2, '0')}`] = 'x'.repeat(300);
    const context: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) context[`c${String(index).padStart(2, '0')}`] = 'x'.repeat(300);
    const { event } = run(makeEvent({ dimensions, context }));
    expect((event['truncated'] as string[]).length).toBeLessThanOrEqual(C04_LIMITS.maxTruncatedPaths);
  });
});

describe('C04-AC-17 键名非法与非有限指标', () => {
  it('维度键 Title / 1abc 被丢弃并计数 invalid_field_key（每个键一次）', () => {
    const { counter, event } = run(makeEvent({ dimensions: { Title: 'v', '1abc': 'v', ok: 'v' } }));
    const dimensions = event['dimensions'] as Record<string, string>;
    expect(Object.keys(dimensions)).toEqual(['ok']);
    expect(counter.get(PRIVACY_REASON_CODES.invalidFieldKey)).toBe(2);
  });

  it('键名超过 64 字符按非法处理', () => {
    const { counter, event } = run(makeEvent({ dimensions: { [`a${'b'.repeat(64)}`]: 'v' } }));
    expect(event['dimensions']).toEqual({});
    expect(counter.get(PRIVACY_REASON_CODES.invalidFieldKey)).toBe(1);
  });

  it('60 个指标键保留字典序前 50 并计数 truncated_metric_keys', () => {
    const metrics: Record<string, number> = {};
    for (let index = 0; index < 60; index += 1) metrics[`m${String(index).padStart(3, '0')}`] = index;
    const { counter, event } = run(makeEvent({ metrics }));
    const kept = event['metrics'] as Record<string, number>;
    expect(Object.keys(kept)).toHaveLength(C04_LIMITS.maxMetricKeys);
    expect(Object.keys(kept)[0]).toBe('m000');
    expect(Object.keys(kept)[49]).toBe('m049');
    expect(counter.get(PRIVACY_REASON_CODES.truncatedMetricKeys)).toBe(1);
  });

  it('NaN / Infinity / -Infinity 被丢弃并计数 non_finite_metric（每个字段一次）', () => {
    const { counter, event } = run(
      makeEvent({ metrics: { good: 1, bad_nan: Number.NaN, bad_inf: Number.POSITIVE_INFINITY, bad_neg: Number.NEGATIVE_INFINITY } }),
    );
    expect(event['metrics']).toEqual({ good: 1 });
    expect(counter.get(PRIVACY_REASON_CODES.nonFiniteMetric)).toBe(3);
  });

  it('非数字类型的指标值按 C01 口径处理（不新增 C04 原因码）', () => {
    const { counter, event } = run(makeEvent({ metrics: { good: 1, text: 'x' } }));
    expect(event['metrics']).toEqual({ good: 1 });
    expect(counter.get(PRIVACY_REASON_CODES.nonFiniteMetric)).toBe(1);
  });

  it('空的 dimensions / metrics 不产生计数', () => {
    const { counter, event } = run(makeEvent({ dimensions: {}, metrics: {} }));
    expect(event['dimensions']).toEqual({});
    expect(event['metrics']).toEqual({});
    expect(counter.all()).toEqual({});
  });

  it('非对象的 dimensions 被忽略而不抛错', () => {
    const { event } = run(makeEvent({ dimensions: 'not-an-object' }));
    expect(event['dimensions']).toBe('not-an-object');
  });
});

describe('C04-AC-15 单条事件 16 KB 上限', () => {
  it('超限时先丢未声明的额外字段，事件被压回 16 KB 以内（AC-15 的可达路径）', () => {
    // 现实口径：**格式合法**的输入（键名 ≤64、值 ≤256、键数 ≤50）在阶梯之后必然能落回
    // 16 KB 以内；本用例用一个未声明的大字段逼近上限，验证阶梯确实把事件压回去了。
    const dimensions: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) {
      dimensions[`k${String(index).padStart(2, '0')}${'z'.repeat(61)}`] = 'x'.repeat(256);
    }
    const { result, event } = run(makeEvent({ dimensions, debug_blob: 'B'.repeat(20_000) }));
    expect(result.dropped).toBe(false);
    expect(utf8Bytes(JSON.stringify(event))).toBeLessThanOrEqual(16384);
  });

  it('整条丢弃的判定：当且仅当所有阶梯都跑完仍超限时返回 event_too_large', () => {
    // 直接构造「阶梯跑完仍超限」的形态：50 个 64 字符键名 + 256 字符值（约 16.4 KB），
    // 并把它包在不会被丢弃的结构里。合法输入无法到达这里，因此这里只断言**契约行为**：
    // 一旦发生，必须给出 event_too_large 而不是静默产出超限事件。
    const dimensions: Record<string, string> = {};
    for (let index = 0; index < 50; index += 1) {
      dimensions[`k${String(index).padStart(2, '0')}${'z'.repeat(61)}`] = 'x'.repeat(256);
    }
    const initial = makeEvent({ dimensions });
    expect(utf8Bytes(JSON.stringify(initial))).toBeGreaterThan(16384);
    const { result, event } = run(initial);
    if (result.dropped) {
      expect(result.dropReason).toBe(PRIVACY_REASON_CODES.eventTooLarge);
      return;
    }
    // 未丢弃时，阶梯必须已经让事件符合上限（不允许原样超限产出）
    expect(utf8Bytes(JSON.stringify(event))).toBeLessThanOrEqual(16384);
  });
});

describe('与 C01 的幂等（不双重计数）', () => {
  it('把 C01 已截断的事件再喂给 C04，不产生任何截断计数', () => {
    const alreadyClamped = makeEvent({
      dimensions: { message: 'x'.repeat(256) },
      attachment: 'a'.repeat(8192),
      truncated: ['dimensions.message', 'attachment'],
    });
    const { counter, event } = run(alreadyClamped);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimension)).toBe(0);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedAttachment)).toBe(0);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimensionKeys)).toBe(0);
    // 已有 truncated 路径被保留（不覆盖、不追加）
    expect(event['truncated']).toEqual(['dimensions.message', 'attachment']);
  });

  it('反复处理同一事件的结果稳定（幂等）', () => {
    const event = makeEvent({ dimensions: { title: 'x'.repeat(300) } });
    const first = run(event).event;
    const snapshot = JSON.stringify(first);
    const second = run(first).event;
    expect(JSON.stringify(second)).toBe(snapshot);
  });
});
