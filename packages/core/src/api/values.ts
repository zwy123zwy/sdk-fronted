/**
 * C01 公共 API 的常量、参数校验与位置解析（T12）。
 *
 * 所有校验函数返回一个「安全值」，非法输入返回 `undefined` 并计数原因码；
 * 本模块不访问 `window`，位置来源由 `LocationSource` 注入。
 */
import { REASON_CODES } from '../kernel';
import type { Counters } from '../kernel';
import type { ConsentState, DiagnosticsRecord, LocationSource, LogLevel } from './types';

/** 命令队列上限（指南第 11 节：命令队列 200 条）。 */
export const COMMAND_QUEUE_CAPACITY = 200;

/** 协议保留事件名前缀（`event-standard.md` 第 6 节）。 */
export const RESERVED_EVENT_PREFIXES = ['sdk_', 'web_'] as const;

/** 字段键格式：小写字母开头，小写字母/数字/下划线，最长 64（`event-standard.md` 第 4 节）。 */
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const CONSENT_STATES: readonly ConsentState[] = ['granted', 'denied', 'buffer'];

/** 非空字符串。 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 可枚举的普通对象（排除 null、数组与类实例不在此列，这里只要求是对象）。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 有限数值。 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 事件名是否符合命名规则：至少两段小写下划线，且未使用保留前缀。 */
export function hasValidEventName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return false;
  return !RESERVED_EVENT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 字段键名是否合法。 */
export function hasValidFieldKey(key: unknown): key is string {
  return typeof key === 'string' && FIELD_KEY_PATTERN.test(key);
}

/** 日志级别是否合法。 */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** 同意状态是否合法。 */
export function isConsentState(value: unknown): value is ConsentState {
  return typeof value === 'string' && (CONSENT_STATES as readonly string[]).includes(value);
}

/**
 * 公共 API 层负责的原因码（取值见 `docs/contracts/reason-codes.md` 0.2）。
 * 内核负责的 `processor_error` / `destroyed` 等从 `REASON_CODES` 复用，避免两处字面量漂移。
 */
export const API_REASON_CODES = {
  invalidArgs: 'invalid_args',
  invalidEventName: 'invalid_event_name',
  nonFiniteMetric: 'non_finite_metric',
  commandQueueOverflow: 'command_queue_overflow',
  /** 维度值被截断（契约归 C04；C01 的 web_js_error/sdk_log 为了产出合法事件先按 Schema 截断）。 */
  truncatedDimension: 'truncated_dimension',
  destroyed: REASON_CODES.destroyed,
  processorError: REASON_CODES.processorError,
  sinkError: REASON_CODES.processorError,
} as const;

/** 维度值长度上限（`event-standard.md` 第 4 节）。 */
export const MAX_DIMENSION_VALUE_LENGTH = 256;

/** `web_js_error.schema.json` 对各字段的长度上限。 */
export const WEB_JS_ERROR_LIMITS = {
  errorType: 128,
  message: 256,
  source: 32,
  fingerprint: 64,
  attachment: 8192,
} as const;

/** 记录一条调试输出；sink 抛错被吞掉并计数 `processor_error`（业务不受影响）。 */
export function reportDiagnostics(
  counters: Counters,
  sink: (record: DiagnosticsRecord) => void,
  record: DiagnosticsRecord,
): void {
  try {
    sink(record);
  } catch {
    counters.count(REASON_CODES.processorError);
  }
}

/** 从 `globalThis.window` 解析位置；SSR 或非浏览器环境返回全 `undefined`。 */
export function readLocation(): LocationSource {
  const scope: unknown = globalThis.window;
  if (typeof scope !== 'object' || scope === null) return { href: undefined, pageId: undefined };
  const href: unknown = (scope as { location?: { href?: unknown } }).location?.href;
  return { href: typeof href === 'string' ? href : undefined, pageId: undefined };
}

/**
 * 生成 UUID v4：优先用 `crypto.randomUUID`，不可用时用 `Math.random` 兜底。
 * 模块顶层不访问 `crypto`，只在调用时解析；格式满足 `batch.schema.json` 的 `$defs/uuid`。
 */
export function createUuid(): string {
  const scope: { crypto?: { randomUUID?: () => string } | undefined } = globalThis;
  const generated = scope.crypto?.randomUUID?.();
  if (typeof generated === 'string' && generated.length > 0) return generated;
  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  let result = '';
  for (const character of template) {
    if (character === 'x') result += Math.floor(Math.random() * 16).toString(16);
    else if (character === 'y') result += (Math.floor(Math.random() * 4) + 8).toString(16);
    else result += character;
  }
  return result;
}

/**
 * 按 UTF-16 码元截断，且不切断代理对（`event-standard.md` 第 4 节）。
 */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let cut = maxLength;
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return value.slice(0, cut);
}

/** 创建一个静态位置来源（测试与 SSR 用）。 */
export function createLocationSource(href: string | undefined, pageId: string | undefined): LocationSource {
  return { href, pageId };
}
