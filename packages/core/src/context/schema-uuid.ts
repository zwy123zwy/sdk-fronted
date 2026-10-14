/**
 * `$defs/uuid` 的形态判据（SDK 内**唯一**副本）。
 *
 * 接收方按 `batch.schema.json` 的 `$defs/uuid` 校验，因此 SDK 内所有
 * 「接受一个来自外部的 uuid 形态值、否则丢弃」的判定都必须走这里 —— 目前是
 * `view_id`（C04-F2）、`device_id`（C04-F1）与 `event_id`（C01-F3 加载桩交接）。
 * **不**放宽成 RFC 4122 的宽松判据：任何"看着像 uuid"的值都得按会被拒处理。
 *
 * 这些字段都在协议字段排除清单里（UUID 结构上不可能含 PII → 不脱敏），所以非 uuid 的值
 * 不会被任何兜底改写，放行一个就等于产出一个注定被拒的批次/事件。
 *
 * 与 Schema 的漂移由测试直接读真实 Schema 的 `$defs/uuid.pattern` 逐样本比对锁定
 * （`page.test.ts` / `session.test.ts` / `stub-bridge-event-id.test.ts`）：
 * 形态改了这里就红。
 */
export const SCHEMA_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 该字符串是否满足 `$defs/uuid`（能安全作为协议里的 uuid 字段上报）。 */
export function isSchemaUuid(value: string): boolean {
  return SCHEMA_UUID_PATTERN.test(value);
}
