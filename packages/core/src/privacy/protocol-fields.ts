/**
 * 顶层字符串脱敏的**协议字段排除清单**（C04-F6）。
 *
 * ## 取法（从 Schema 推导，不是拍脑袋的清单）
 *
 * 权威是 `docs/contracts/schemas/batch.schema.json#/$defs/event`。把其中**Schema 已经关死取值**
 * 的**字符串**属性挑出来，即下面两条的并集：
 *
 *   ① `required`（**协议信封**）：Schema 强制存在，SDK/内核必须产出 —— 改写它等于让产出
 *      过不了 `$defs/event` 自证，并破坏依赖它的协议语义（`event_id` 是去重的唯一依据、
 *      `event_name` 参与「必要事件」判定）；
 *   ② `enum`（**闭集词汇表**）：取值集合被 Schema 关死 —— 改写必然离开契约取值集合
 *      （`event_type` / `priority` / `level`）。
 *
 * 再按「解析 `$ref` 后产出字符串」过滤：`schema_version`/`occurred_at`/`sample_rate`/
 * `retry_count`/`replayed` 是数值/布尔，本就不经过字符串脱敏通道；`app_id` 是批次头
 * （`properties.app_id`）的字段，不在事件体里。
 *
 * **为什么不是「凡有 `pattern`/`format` 的都算」**：`view_id` 与 `event_id` 同为 `$ref uuid`，
 * 但 `view_id` 属**路由/上下文载荷**且非必填 → 必须继续脱敏（`page_id`/`url`/`attachment`
 * 同理，它们只受 `maxLength` 约束）。协议字段与载荷字段的判别力就在「必填 ∪ 枚举」这一条：
 * 同一 uuid 形态，`event_id` 排除、`view_id` 脱敏。
 *
 * ## 漂移检测
 *
 * 源码不能 import `docs/**` 的 JSON（构建边界），因此清单是常量；但它的**取值来源与漂移**
 * 由 `protocol-fields.test.ts` 直接读**真实** Schema 按同一取法重算、并**两侧相等**锁定
 * （少了新增的必填/枚举字符串字段 → 红；多了 Schema 已删/改名的字段 → 也红）。
 * 与 `packages/transport/src/monitor/reason-codes.test.ts` 对 `sdk_health.schema.json`
 * 的形态一致。
 *
 * 本清单是内部实现细节，**不在** `packages/core/src/privacy/index.ts` 的导出面里。
 */
export const PROTOCOL_STRING_FIELDS: ReadonlySet<string> = new Set([
  'event_id',
  'event_name',
  'event_type',
  'priority',
  'level',
]);
