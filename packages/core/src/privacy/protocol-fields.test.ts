/**
 * 协议字段排除清单的**漂移检测**（C04-F6 顶层字符串脱敏）。
 *
 * 口径（与 `packages/transport/src/monitor/reason-codes.test.ts` 对
 * `docs/contracts/schemas/builtin-events/sdk_health.schema.json` 的形态一致）：
 * **不复制、不手写**清单的推导结果，而是直接 `import` **真实** Schema，按与
 * `protocol-fields.ts` 注释里写明的同一取法重算，再与源码常量**两侧相等**比较 ——
 * 少了（Schema 新增了必填/枚举字符串字段而清单没登记）红，多了（Schema 已删除/改名）也红。
 *
 * 取法：`$defs/event.properties` 中「`required` ∪ 有 `enum` ∪ **非 PII 形态**（`$defs/uuid` /
 * `format: uuid`）」且「解析 `$ref` 后产出字符串」的属性名。
 *
 * 另用**需求钉子**表达「不能因为排除清单丢掉该脱敏的」：
 * - `page_id`/`url`/`attachment` 必须**不在**清单里（它们只受 `maxLength` 约束，是自由文本）；
 * - `view_id` 必须**在**清单里（2026-10-14 修订：`$ref uuid` → 结构上不可能含 PII，
 *   脱敏它只会产出违反 `$defs/uuid` 的事件，正是「多实例」用例偶发红的根因）；
 * - 非字符串的受控字段（`schema_version`/`occurred_at`）不进字符串清单。
 *
 * 末尾一组**判别性回归**用真实 `constrainEvent` 钉住行为：命中 uuid 的规则（含内置
 * `cn_mobile` 偶然命中随机 uuid 末段数字的那种）**不得**改写 `view_id`，但 `page_id`
 * 里的伪造手机号**必须**继续被脱敏。
 */
import { describe, expect, it } from 'vitest';

import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import type { KernelEvent } from '../kernel';
import { C04_LIMITS } from './constants';
import { constrainEvent } from './constraints';
import { createMasker } from './mask';
import { PROTOCOL_STRING_FIELDS } from './protocol-fields';
import type { MaskRule } from './types';

type JsonObject = Record<string, unknown>;

/** 只把「对象」当作 Schema 节点（数组与 null 都不是）。 */
function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

/** 解析 Schema 内的本地引用（本 Schema 只用 `#/$defs/<name>` 这一种形态）。 */
function resolveRef(schema: unknown, defs: JsonObject | undefined): unknown {
  const object = asObject(schema);
  const ref = object?.['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return schema;
  return defs?.[ref.slice('#/$defs/'.length)];
}

/** 该属性解析后是否可能产出字符串（数值/布尔/数组/对象字段不进字符串清单）。 */
function producesString(schema: unknown, defs: JsonObject | undefined, depth = 0): boolean {
  if (depth > 4) return false;
  const object = asObject(resolveRef(schema, defs));
  if (object === undefined) return false;
  if (object['type'] === 'string') return true;
  const values = object['enum'];
  return Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === 'string');
}

/** 「Schema 关死取值集合」的第二种形态：`enum`。 */
function hasEnum(schema: unknown, defs: JsonObject | undefined): boolean {
  const object = asObject(resolveRef(schema, defs));
  return Array.isArray(object?.['enum']);
}

/**
 * 「Schema 把它约束成**结构上不可能含 PII 的形态**」——本 Schema 用 `$defs/uuid` 表达
 * （`format: uuid` 是等价写法）。判据不写死 uuid 的字面 pattern：直接与 `$defs/uuid` 的
 * `pattern` 比对，Schema 改形态时这里会跟着变，不会"看起来还在锁、其实已经漂了"。
 */
function constrainsToNonPiiFormat(schema: unknown, defs: JsonObject | undefined): boolean {
  const object = asObject(schema);
  if (object?.['$ref'] === '#/$defs/uuid') return true;
  const resolved = asObject(resolveRef(schema, defs));
  if (resolved === undefined) return false;
  if (resolved['format'] === 'uuid') return true;
  const uuidPattern = asObject(defs?.['uuid'])?.['pattern'];
  return typeof uuidPattern === 'string' && resolved['pattern'] === uuidPattern;
}

/** 从**真实** Schema 推导协议字段清单（取法见 `protocol-fields.ts` 的注释）。 */
function deriveProtocolStringFields(schema: unknown): Set<string> {
  const root = asObject(schema);
  const defs = asObject(root?.['$defs']);
  const event = asObject(defs?.['event']);
  const properties = asObject(event?.['properties']) ?? {};
  const required = event?.['required'];
  const requiredNames = new Set(
    (Array.isArray(required) ? required : []).filter((name): name is string => typeof name === 'string'),
  );
  const derived = new Set<string>();
  for (const [name, property] of Object.entries(properties)) {
    const pinned = requiredNames.has(name) || hasEnum(property, defs) || constrainsToNonPiiFormat(property, defs);
    if (!pinned) continue;
    if (producesString(property, defs)) derived.add(name);
  }
  return derived;
}

const DERIVED = deriveProtocolStringFields(batchSchema);

describe('C04 协议字段排除清单：从真实 Schema 推导并两侧锁定（漂移即红）', () => {
  it('推导结果与源码常量 PROTOCOL_STRING_FIELDS 两侧相等', () => {
    expect([...DERIVED].sort()).toEqual([...PROTOCOL_STRING_FIELDS].sort());
  });

  it('反空转：推导本身非空（取法失效/键名写错都会红，而不是「推导出 0 个所以通过」）', () => {
    expect(DERIVED.size).toBeGreaterThanOrEqual(3);
  });

  it('必须继续脱敏的载荷字段不在清单里（page_id/url/attachment）', () => {
    for (const name of ['page_id', 'url', 'attachment']) {
      expect(DERIVED.has(name), `${name} 不应被推导为协议字段`).toBe(false);
      expect(PROTOCOL_STRING_FIELDS.has(name), `${name} 不应出现在源码清单里`).toBe(false);
    }
  });

  it('view_id 是 $ref uuid（非 PII 形态）→ 必须在清单里（2026-10-14 修订）', () => {
    // 旧口径（只认「必填 ∪ 枚举」）把它当载荷脱敏，结果是一条随机命中的规则就能把 uuid
    // 改成非 uuid 形态 → 事件违反 $defs/uuid（"多实例"用例偶发红）。
    expect(DERIVED.has('view_id'), 'view_id 应被推导为协议字段').toBe(true);
    expect(PROTOCOL_STRING_FIELDS.has('view_id'), 'view_id 应出现在源码清单里').toBe(true);
  });

  it('非字符串的受控字段不进字符串清单（数值/布尔不经过字符串脱敏通道）', () => {
    for (const name of ['schema_version', 'occurred_at', 'sample_rate', 'retry_count', 'replayed']) {
      expect(DERIVED.has(name), `${name} 不是字符串字段`).toBe(false);
    }
  });
});

describe('判别性回归：命中 uuid 的规则改不动 view_id，但改得动 page_id', () => {
  const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const FAKE_PHONE = '13800138000';

  /** 会命中**任何** uuid 的追加规则：若 `view_id` 仍走脱敏通道，它必然被改写。 */
  const HOSTILE_UUID_RULE: MaskRule = {
    name: 'hostile_uuid_probe',
    pattern: '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
    replacement: '***',
    builtin: false,
  };

  /** 最小合法事件 + 本次 flaky 的真实触发形态（uuid 末段是一串"手机号"数字）。 */
  function makeEvent(extra: Record<string, unknown>): KernelEvent {
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

  function run(event: KernelEvent, rules: readonly MaskRule[]) {
    return constrainEvent({
      event,
      limits: C04_LIMITS,
      masker: createMasker(rules),
      count: () => undefined,
    }).event;
  }

  it('追加规则命中 uuid：view_id 原样保留（仍是合法 uuid），page_id 的手机号仍被脱敏', () => {
    const viewId = '00000000-0000-4000-8000-13800138000a';
    const event = run(makeEvent({ view_id: viewId, page_id: `/user/${FAKE_PHONE}` }), [HOSTILE_UUID_RULE]);

    expect(event['view_id']).toBe(viewId);
    expect(String(event['view_id'])).toMatch(UUID_V4_PATTERN);
    // 载荷字段必须继续脱敏：排除清单没有放过该脱敏的。
    expect(String(event['page_id'])).not.toContain(FAKE_PHONE);
    expect(String(event['page_id'])).toContain('1**********');
  });

  it('内置 cn_mobile 偶然命中 uuid 末段数字时也改不动 view_id（flaky 的确定性复现）', () => {
    // 修复前：内置 `(?<!\d)1[3-9]\d{9}(?!\d)` 命中 `…-13800138000a` → `…-1**********a`
    // → Ajv 报 `/events/0/view_id` 违反 `#/$defs/uuid/pattern`。
    const viewId = '00000000-0000-4000-8000-13800138000a';
    const event = run(makeEvent({ view_id: viewId }), []);
    expect(event['view_id']).toBe(viewId);
    expect(String(event['view_id'])).toMatch(UUID_V4_PATTERN);
  });
});
