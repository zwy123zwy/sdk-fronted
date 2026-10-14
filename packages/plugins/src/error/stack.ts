/**
 * C05-F1 错误的归一化与指纹。
 *
 * 约束（T18-plan §1）：
 * - 归一化包含「剥离数字与 URL 查询参数」，使同一错误稳定同值（AC-03 去重的前提）；
 * - 指纹取 `error_type + source + 归一化后的 message + line/column` 的稳定哈希；
 * - 本模块**不实现脱敏**：脱敏与字段约束在 C04 完成，本任务只在其之前不落地、不缓存。
 *
 * 字段路径（照抄 `web_js_error.schema.json`）：`dimensions` 为**封闭四键**
 * （`error_type`/`message`/`source`/`fingerprint`），`metrics` 为 `count`（必填）
 * 与可选 `line`/`column`，错误栈走顶层 `attachment`。
 */
import { ERROR_TYPE_EXCEPTION, SOURCE_WINDOW_ERROR } from './types';
import type { NormalizedJsDimensions, NormalizedJsError } from './types';

/** 归一化的输入：来自任一采集源的原始错误信息。 */
export interface NormalizeInput {
  /** 未归一化的原始消息。 */
  readonly message: string;
  /** 该来源对应的 `source` 取值（`window_error` / `unhandled_rejection`）。 */
  readonly source: string;
  /** 该来源对应的 `error_type` 取值。 */
  readonly errorType: string;
  /** 有行号信息时写入 `metrics.line`。 */
  readonly line?: number | undefined;
  /** 有列号信息时写入 `metrics.column`。 */
  readonly column?: number | undefined;
  /** 脱敏前的错误栈；本模块原样透传（脱敏由 C04 负责）。 */
  readonly stack?: string | undefined;
}

/** URL 查询参数（`?` 起、到空白或 `#` 止）。 */
const QUERY_PATTERN = /\?[^\s#]*/g;
/** 连续数字串（计数器、ID、时间戳等易变部分）。 */
const DIGITS_PATTERN = /\d+/g;

/**
 * 归一化消息：剥离数字与 URL 查询参数，使易变部分不参与指纹。
 *
 * 例如 `request 12345 failed?id=999` → `request N failed`。
 * 这样「同一处代码、同一类错误」在不同请求/不同计数下得到同一指纹（AC-03 去重的前提）。
 */
export function normalizeMessage(message: string): string {
  return message.replace(QUERY_PATTERN, '').replace(DIGITS_PATTERN, 'N');
}

/** FNV-1a 32 位哈希（十六进制，8 字符）；纯函数、无依赖、跨环境一致。 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 计算稳定指纹。
 *
 * 性质要求（T18-plan §1）：① 同一错误稳定同值；② 不随易变部分漂移。
 * 构成（README 同步写明，接入方据此可预测去重行为）：
 * `error_type + source + 归一化后的 message + line + column` 的 FNV-1a 十六进制哈希。
 * 长度 8 ≤ Schema 的 `maxLength: 64` 且非空。
 */
export function computeFingerprint(input: Omit<NormalizeInput, 'stack'>): string {
  const parts: readonly string[] = [
    input.errorType,
    input.source,
    normalizeMessage(input.message),
    input.line === undefined ? '' : String(input.line),
    input.column === undefined ? '' : String(input.column),
  ];
  return fnv1a(parts.join('|'));
}

/**
 * 把任一采集源的原始错误归一化为 `web_js_error` 的字段。
 *
 * 产出的是**事件字段**（dimensions 四键 + metrics 骨架 + 顶层 attachment），
 * `metrics.count` 由去重器（`createDeduplicator`）写入——「首条上报 + 累计次数」
 * 是同一次会话内的状态机行为，不属于纯归一化。
 */
export function normalizeError(input: NormalizeInput): NormalizedJsError {
  const dimensions: NormalizedJsDimensions = {
    error_type: (input.errorType === '' ? ERROR_TYPE_EXCEPTION : input.errorType),
    message: normalizeMessage(input.message),
    source: (input.source === '' ? SOURCE_WINDOW_ERROR : input.source),
    fingerprint: computeFingerprint(input),
  };
  const metrics = {
    count: 1,
    ...(input.line === undefined ? {} : { line: input.line }),
    ...(input.column === undefined ? {} : { column: input.column }),
  };
  return input.stack === undefined
    ? { dimensions, metrics }
    : { dimensions, metrics, attachment: input.stack };
}
