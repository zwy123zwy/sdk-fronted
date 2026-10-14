/**
 * 协议字段排除清单的**漂移检测**（C04-F6 顶层字符串脱敏）。
 *
 * 口径（与 `packages/transport/src/monitor/reason-codes.test.ts` 对
 * `docs/contracts/schemas/builtin-events/sdk_health.schema.json` 的形态一致）：
 * **不复制、不手写**清单的推导结果，而是直接 `import` **真实** Schema，按与
 * `protocol-fields.ts` 注释里写明的同一取法重算，再与源码常量**两侧相等**比较 ——
 * 少了（Schema 新增了必填/枚举字符串字段而清单没登记）红，多了（Schema 已删除/改名）也红。
 *
 * 取法：`$defs/event.properties` 中「`required` ∪ 有 `enum`」且「解析 `$ref` 后产出字符串」
 * 的属性名。
 *
 * 另用两条**需求钉子**表达「不能因为排除清单丢掉该脱敏的」：
 * - `page_id`/`view_id`/`url`/`attachment` 必须**不在**清单里（否则本次修复的初衷被抵消）；
 * - 非字符串的受控字段（`schema_version`/`occurred_at`）不进字符串清单。
 */
import { describe, expect, it } from 'vitest';

import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import { PROTOCOL_STRING_FIELDS } from './protocol-fields';

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
    if (!requiredNames.has(name) && !hasEnum(property, defs)) continue;
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

  it('必须继续脱敏的载荷字段不在清单里（page_id/view_id/url/attachment）', () => {
    for (const name of ['page_id', 'view_id', 'url', 'attachment']) {
      expect(DERIVED.has(name), `${name} 不应被推导为协议字段`).toBe(false);
      expect(PROTOCOL_STRING_FIELDS.has(name), `${name} 不应出现在源码清单里`).toBe(false);
    }
  });

  it('非字符串的受控字段不进字符串清单（数值/布尔不经过字符串脱敏通道）', () => {
    for (const name of ['schema_version', 'occurred_at', 'sample_rate', 'retry_count', 'replayed']) {
      expect(DERIVED.has(name), `${name} 不是字符串字段`).toBe(false);
    }
  });
});
