/**
 * C04 的长度/数量上限与时间参数（T14）。
 *
 * 数值来源逐条标注，**不得随手改动**：
 * - `maxDimensionValueLength` / `maxDimensionKeys` / `maxMetricKeys` / `maxAttachmentBytes` /
 *   `maxEventBodyBytes` / `maxUrlLength` / `maxPageIdLength` / `maxUserIdLength` /
 *   `maxTruncatedPaths`：`docs/contracts/event-standard.md` 第 4 节与
 *   `docs/contracts/schemas/batch.schema.json`（`$defs/dimensions`、`$defs/metrics`、
 *   `properties.attachment`、`properties.url`、`properties.page_id`、`properties.truncated`）。
 * - `maxEventBodyBytes` 的口径已由编排方 2026-10-13 裁定：**单条事件体的 UTF-8 序列化字节数**，
 *   不含批次头与 `common`。`truncated` 超 `maxTruncatedPaths` 时只保留前 N 条，**不新增原因码**。
 * - `maxContextKeys` = 50：`context` 与 `dimensions` 同为 `$defs/dimensions`。
 * - `clockOffsetLimitMs`：批次 Schema 的 `clock_offset` `minimum/maximum`（±86,400,000）。
 * - `maxClockRoundTripMs` / `sessionIdleMs` / `bufferMaxEvents` / `bufferMaxBytes` /
 *   `maxExtraMaskRules`：契约未定义，属 C04 内部实现，取值理由见 `docs/tasks/T14-plan.md`
 *   （裁定记录与第 5、7 点）。
 */
import type { FieldLimits } from './types';

/** C04 全部长度/数量上限（不可由远程配置放宽）。 */
export const C04_LIMITS: FieldLimits = {
  maxDimensionValueLength: 256,
  maxDimensionKeys: 50,
  maxContextKeys: 50,
  maxMetricKeys: 50,
  maxAttachmentBytes: 8192,
  maxEventBodyBytes: 16384,
  maxTruncatedPaths: 60,
};

/** URL 上限（批次 Schema `properties.url.maxLength`）。 */
export const MAX_URL_LENGTH = 2048;

/** `page_id` 上限（批次 Schema `properties.page_id.maxLength`，也是 `$defs/commonFields.properties.page_id.maxLength`）。 */
export const MAX_PAGE_ID_LENGTH = 256;

/** `user_id` 上限（批次 Schema `properties.user_id.maxLength`）。超限丢弃整个字段，不截断。 */
export const MAX_USER_ID_LENGTH = 128;

/** 内置脱敏规则条数（`remote-config.md` 5.4）。 */
export const BUILTIN_MASK_RULE_COUNT = 7;

/** 远程追加规则上限（`remote-config.md` 5.4 与 `remote-config.schema.json` 的 `maxItems: 40`）。 */
export const MAX_EXTRA_MASK_RULES = 40;

/**
 * 追加规则的实际保留上限。
 *
 * 算术前提（已在测试里用断言固定）：`BUILTIN_MASK_RULE_COUNT + MAX_EXTRA_MASK_RULES = 47 ≤ 50`，
 * 因此**正常远程配置永远不会触发裁剪**；这个值只用于「运行时注入的规则表」这一非契约路径。
 */
export const MAX_MASK_RULES_TOTAL = 50;

/** 会话空闲上限：30 分钟无活动后重新生成 `session_id`（`event-standard.md` 第 1 节）。 */
export const SESSION_IDLE_MS = 1_800_000;

/** `buffer` 模式的内存缓冲上限（条数与字节，先到者为准；对齐 T16 离线存储）。 */
export const CONSENT_BUFFER_MAX_EVENTS = 2000;
export const CONSENT_BUFFER_MAX_BYTES = 5_242_880;

/** 时钟偏移的钳制范围（批次 Schema `clock_offset` 的 `minimum/maximum`）。 */
export const CLOCK_OFFSET_LIMIT_MS = 86_400_000;

/** 时钟校准的漂移上限：往返超过该值放弃本次校准（契约未定义，C04 内部实现）。 */
export const MAX_CLOCK_ROUND_TRIP_MS = 2000;

/** 字段键名格式（与 C01 的 `hasValidFieldKey` 同一规则；`event-standard.md` 第 4 节）。 */
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** 合法的事件优先级。 */
export const EVENT_PRIORITIES = ['normal', 'critical'] as const;
