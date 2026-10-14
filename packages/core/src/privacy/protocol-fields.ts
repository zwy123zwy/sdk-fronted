/**
 * 顶层字符串脱敏的**协议字段排除清单**（C04-F6）。
 *
 * ## 取法（从 Schema 推导，不是拍脑袋的清单）
 *
 * 权威是 `docs/contracts/schemas/batch.schema.json#/$defs/event`。把其中**Schema 已经关死取值**
 * 的**字符串**属性挑出来，即下面三条的并集：
 *
 *   ① `required`（**协议信封**）：Schema 强制存在，SDK/内核必须产出 —— 改写它等于让产出
 *      过不了 `$defs/event` 自证，并破坏依赖它的协议语义（`event_id` 是去重的唯一依据、
 *      `event_name` 参与「必要事件」判定）；
 *   ② `enum`（**闭集词汇表**）：取值集合被 Schema 关死 —— 改写必然离开契约取值集合
 *      （`event_type` / `priority` / `level`）；
 *   ③ **非 PII 形态**（`$defs/uuid`，等价写法 `format: uuid`）：Schema 把取值锁成**结构上
 *      不可能含个人信息**的形态 —— 改写它换不到任何隐私收益，只会让事件过不了自证
 *      （`view_id`；`event_id` 同时满足 ① 与 ③）。
 *
 * 再按「解析 `$ref` 后产出字符串」过滤：`schema_version`/`occurred_at`/`sample_rate`/
 * `retry_count`/`replayed` 是数值/布尔，本就不经过字符串脱敏通道；`app_id` 是批次头
 * （`properties.app_id`）的字段，不在事件体里。
 *
 *   ④ **`page_id`/`url`/`attachment` 为什么仍必须脱敏**：它们只受 `maxLength` 约束，取值是
 *      **自由文本**（`page_id` 可以是 `/user/13800138000`）→ 属载荷字段，③ 不覆盖它们。
 *      协议字段与载荷字段的判别力来自「必填 ∪ 枚举 ∪ 非 PII 形态」，而不是「长得像什么」。
 *
 * ## 为什么 `view_id` 在清单里（2026-10-14 修订）
 *
 * 旧口径只认「必填 ∪ 枚举」，于是**非必填**的 `view_id`（与 `event_id` 同为 `$ref uuid`）被送进
 * 脱敏通道。内置 `cn_mobile` 规则 `(?<!\d)1[3-9]\d{9}(?!\d)` **会偶然命中随机 uuid 末段的一串
 * 数字**，把它改写成 `1**********` 形态（实测：`…-13800138000a` → `…-1**********a`）→ 事件
 * 立刻违反 `$defs/uuid`。命中是**随机的**（每次运行都是新 uuid，单次命中概率约 0.06%），
 * 症状正是「单跑必过、全量多数通过、偶发红」—— 即 `api/schema-validation.test.ts`「多实例」
 * 用例那条长期未定位的间歇失败。而 `view_id` 本身是 uuid，**结构上不可能含 PII**。
 *
 * 遗留口径（**待裁定**，本条不擅自实现）：`context/page.ts` 的 `noteLocation(url, explicitViewId)`
 * 允许装配根传入**任意** `view_id`（接管场景）。本清单生效后这类**非 uuid** 的 `view_id` 不再被
 * 兜底脱敏——它本来就会让事件过不了 `$defs/uuid`，但"本地不再兜底"这一点需要装配根侧补格式
 * 校验才能彻底收口；记在 `docs/tasks/board.md` 待裁定。
 *
 * ## 漂移检测
 *
 * 源码不能 import `docs/**` 的 JSON（构建边界），因此清单是常量；但它的**取值来源与漂移**
 * 由 `protocol-fields.test.ts` 直接读**真实** Schema 按同一取法重算、并**两侧相等**锁定
 * （少了新增的必填/枚举/非 PII 形态字符串字段 → 红；多了 Schema 已删/改名的字段 → 也红）。
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
  'view_id',
]);
