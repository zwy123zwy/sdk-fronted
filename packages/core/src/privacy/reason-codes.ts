/**
 * C04 的原因码常量（T14）。
 *
 * 取值逐字取自 `docs/contracts/reason-codes.md` 0.2（冻结），**不得自造新码**：
 * - 第 1 节（丢弃类）：`invalid_field_key`、`non_finite_metric`、`event_too_large`、`consent_denied`、`consent_buffer_cleared`
 * - 第 2 节（只计数类）：`truncated_dimension`、`truncated_dimension_keys`、`truncated_metric_keys`、`truncated_attachment`
 *
 * 本文件放在 `privacy/` 下（隐私与字段约束是这些原因码的主要归属），由 `context/` 与
 * `privacy/` 共用，避免两处字面量漂移。理由码的语义分工见 `docs/tasks/T14-plan.md` 第 6 点。
 */
export const PRIVACY_REASON_CODES = {
  /** 字段键名格式非法（非小写字母开头 / 含非法字符 / 超过 64 字符），该字段被丢弃。 */
  invalidFieldKey: 'invalid_field_key',
  /** 指标值为 NaN 或 Infinity，该字段被丢弃（JSON 无法表示）。 */
  nonFiniteMetric: 'non_finite_metric',
  /** 截断后仍超过 16 KB，整条事件被丢弃。 */
  eventTooLarge: 'event_too_large',
  /** 维度值（或 context 值）被截断到 256 字符。 */
  truncatedDimension: 'truncated_dimension',
  /** 维度键（或 context 键）数量被裁剪到 50。 */
  truncatedDimensionKeys: 'truncated_dimension_keys',
  /** 指标键数量被裁剪到 50。 */
  truncatedMetricKeys: 'truncated_metric_keys',
  /** 附件被截断到 8 KB。 */
  truncatedAttachment: 'truncated_attachment',
  /** 同意状态不允许采集或发送该事件。 */
  consentDenied: 'consent_denied',
  /** `buffer` 模式下设置 `denied`，缓存的事件被清空（计数单位：事件条数）。 */
  consentBufferCleared: 'consent_buffer_cleared',
} as const;

/** C04 原因码取值类型。 */
export type PrivacyReasonCode = (typeof PRIVACY_REASON_CODES)[keyof typeof PRIVACY_REASON_CODES];
