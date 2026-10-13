/**
 * C08 的契约自证：用 **Ajv 对真实的 `sdk_health.schema.json`** 校验本模块产出的
 * 每一条 `sdk_health` 事件（含 JSON 序列化后的形态），并附负向对照。
 *
 * 为什么必须这样自证：T12 曾出现「105 个单测全绿却违反 5 处契约」，根因是当时
 * 契约测试只校验样例、不校验 SDK 真实产出。本文件校验的是**真实产出**，
 * 并额外用 `batch.schema.json#/$defs/event` 校验同一对象（入队前的形状）。
 *
 * 负向对照特意包含 CR-001 补正后的 `dependentRequired`：
 * `exposure_window_ms` 单独出现必须被拒绝（该规则先由映射层保证，再由 Schema 兜底）。
 */
import { Ajv2020 } from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv';
import { describe, expect, test } from 'vitest';
import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import sdkHealthSchema from '../../../../docs/contracts/schemas/builtin-events/sdk_health.schema.json';
import { buildHealthEvents } from './events';
import { buildHealthMetrics } from './metrics';
import { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';
import type { HealthDimensions, SdkHealthEvent } from './types';

// strictRequired 关闭的理由与 tests/contract/lib/schemas.ts 一致：冻结的 batch Schema
// 用 `allOf[].if/then` 表达条件必填，`then` 子模式没有重复声明 properties（契约只读）。
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addSchema(batchSchema);
const validateHealth: ValidateFunction = ajv.compile(sdkHealthSchema);
const validateBatchEvent: ValidateFunction = ajv.compile({
  $ref: `${batchSchema.$id}#/$defs/event`,
});

const DIMENSIONS: HealthDimensions = { sdk_version: '1.2.3', state: 'running' };

let sequence = 0;
function createId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function expectValid(validate: ValidateFunction, value: unknown, label: string): void {
  const valid = validate(value);
  expect(valid, `${label}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

function expectInvalid(validate: ValidateFunction, value: unknown, label: string): void {
  const valid = validate(value);
  expect(valid, `${label}（本应被拒绝）`).toBe(false);
  expect(validate.errors ?? []).not.toEqual([]);
}

function buildEvents(metrics: Readonly<Record<string, number>>): readonly SdkHealthEvent[] {
  return buildHealthEvents({
    metrics,
    dimensions: DIMENSIONS,
    occurredAt: 1_793_000_060_000,
    createId,
  });
}

describe('Ajv 对真实 sdk_health.schema.json 校验真实产出', () => {
  test('最小窗口（只有 window_ms）通过校验', () => {
    const events = buildEvents(buildHealthMetrics({ counters: {}, windowMs: 60_000 }));
    expect(events).toHaveLength(1);
    for (const event of events) {
      expectValid(validateHealth, toJson(event), 'minimal');
      expectValid(validateBatchEvent, toJson(event), 'minimal/batch');
    }
  });

  test('全量窗口（固定计数 + 全部原因码 + 暴露窗口 + 三个 p99）通过校验', () => {
    const counters: Record<string, number> = {};
    for (const code of DROP_REASON_CODES) counters[code] = 2;
    for (const code of COUNT_REASON_CODES) counters[code] = 3;
    const metrics = buildHealthMetrics({
      counters,
      fixed: {
        calls_total: 1_000,
        events_enqueued: 900,
        events_sent: 880,
        batches_sent: 44,
        batches_failed: 2,
        queue_length_max: 120,
      },
      latency: { track: 1.5, pipeline: 2.5, serialize: 0.5 },
      exposure: { events: 3, windowMs: 42 },
      windowMs: 60_000,
    });
    const events = buildEvents(metrics);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expectValid(validateHealth, toJson(event), 'full');
      expectValid(validateBatchEvent, toJson(event), 'full/batch');
      expect(Object.keys(event.metrics).length).toBeLessThanOrEqual(50);
    }
  });

  test('CR-001 暴露窗口按规则上报时通过校验', () => {
    const metrics = buildHealthMetrics({
      counters: {},
      windowMs: 60_000,
      exposure: { events: 2, windowMs: 15.4 },
    });
    expectValid(validateHealth, toJson(buildEvents(metrics)[0]), 'exposure');
  });

  test('负向对照：计数为 0、契约外指标键、非法 state、超 50 指标、缺 window_ms 均被拒绝', () => {
    const base = buildEvents({ window_ms: 60_000, calls_total: 1 })[0];
    expect(base).toBeDefined();
    if (base === undefined) return;

    expectInvalid(
      validateHealth,
      { ...base, metrics: { ...base.metrics, calls_total: 0 } },
      'calls_total=0',
    );
    expectInvalid(
      validateHealth,
      { ...base, metrics: { ...base.metrics, bogus_metric: 1 } },
      '未知指标键',
    );
    expectInvalid(
      validateHealth,
      { ...base, dimensions: { ...base.dimensions, state: 'started' } },
      'state=started',
    );
    expectInvalid(validateHealth, { ...base, priority: 'critical' }, 'priority=critical');
    expectInvalid(validateHealth, { ...base, schema_version: 2 }, 'schema_version=2');

    const tooMany: Record<string, number> = { window_ms: 60_000 };
    for (let index = 0; index < 50; index += 1) tooMany[`drop_reason_${String(index)}`] = 1;
    expect(Object.keys(tooMany)).toHaveLength(51);
    expectInvalid(validateHealth, { ...base, metrics: tooMany }, 'metrics 超 50');

    expectInvalid(validateHealth, { ...base, metrics: { calls_total: 1 } }, '缺 window_ms');
  });

  test('负向对照：CR-001 的两个指标（四个方向）', () => {
    const base = buildEvents({ window_ms: 60_000 })[0];
    expect(base).toBeDefined();
    if (base === undefined) return;

    // 1) ms 单独出现 → 被 dependentRequired 拒绝
    expectInvalid(
      validateHealth,
      { ...base, metrics: { window_ms: 60_000, exposure_window_ms: 5 } },
      'exposure_window_ms 单独出现',
    );
    // 2) ms + events → 合法
    expectValid(
      validateHealth,
      toJson({
        ...base,
        metrics: { window_ms: 60_000, exposure_window_events: 2, exposure_window_ms: 5 },
      }),
      'exposure_window_ms + events',
    );
    // 3) 仅 events → 合法
    expectValid(
      validateHealth,
      toJson({ ...base, metrics: { window_ms: 60_000, exposure_window_events: 2 } }),
      '仅 exposure_window_events',
    );
    // 4) events=0 → 被 minimum: 1 拒绝
    expectInvalid(
      validateHealth,
      { ...base, metrics: { window_ms: 60_000, exposure_window_events: 0 } },
      'exposure_window_events=0',
    );
    expectInvalid(
      validateHealth,
      { ...base, metrics: { window_ms: 60_000, exposure_window_events: 1, exposure_window_ms: 0 } },
      'exposure_window_ms=0',
    );
  });

  test('负向对照证明校验器确实在生效（不是空转）', () => {
    expectInvalid(validateHealth, { event_name: 'sdk_health' }, '缺少全部必填字段');
    expectInvalid(validateHealth, null, 'null');
  });

  test('映射层规则与 Schema 规则一致：events=0 时映射层不产出 ms', () => {
    const metrics = buildHealthMetrics({
      counters: {},
      windowMs: 60_000,
      exposure: { events: 0, windowMs: 500 },
    });
    expect('exposure_window_ms' in metrics).toBe(false);
    expectValid(validateHealth, toJson(buildEvents(metrics)[0]), 'events=0 的映射结果');
  });
});
