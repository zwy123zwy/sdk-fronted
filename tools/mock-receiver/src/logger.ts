/**
 * 集中日志与脱敏（RR-13、M01-AC-11）。
 *
 * 日志只允许经过 `log()` 进入环形缓冲：令牌、`auth` 字段与 IP 末段在写入前被替换。
 * 环形缓冲同时供 `GET /__mock/logs` 与单元测试断言使用，避免测试去解析 stdout。
 */

/** 契约样例使用的固定占位令牌；日志与入库数据中都不得出现。 */
export const TOKEN_PLACEHOLDER = 'placeholder-write-token-0000';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 结构化日志字段：只放低基数、非敏感的值。 */
export interface LogFields {
  level: LogLevel;
  /** 事件名，如 `batch_accepted`、`request_rejected`。 */
  event: string;
  request_id?: string;
  /** 已脱敏的请求方地址。 */
  ip?: string;
  status?: number;
  error?: string;
  mode?: string;
  /** 兼容字段：调用方不要放令牌。 */
  [key: string]: unknown;
}

export interface LogEntry {
  ts: number;
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
}

export interface Logger {
  log: (fields: LogFields, message?: string) => LogEntry;
  entries: () => LogEntry[];
  text: () => string;
  clear: () => void;
}

export interface LoggerOptions {
  /** 环形缓冲容量，默认 500。 */
  capacity?: number;
  /** 固定的敏感字符串列表（除内置占位令牌外）。 */
  sensitive?: string[];
}

const DEFAULT_CAPACITY = 500;

const PHONE = /\b1[3-9]\d{9}\b/g;
const TOKEN_LIKE = /\b(?:wt|sk|pk)_[A-Za-z0-9_-]{8,}\b/g;
const AUTH_JSON_VALUE = /"(auth|write_token|token)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|\{[^{}]*\})/g;

/** IPv4 去掉末段；IPv6 只保留前 48 位（RFC 4291 文本形式的前 6 组）。 */
export function maskIp(input: string | undefined): string {
  if (input === undefined || input.length === 0) return 'unknown';
  const value = input.trim();
  if (value.length === 0) return 'unknown';

  const lastColon = value.lastIndexOf(':');
  const lastDot = value.lastIndexOf('.');
  const isIpv6 = lastColon > lastDot;
  if (isIpv6) {
    return value.split(':').slice(0, 6).join(':');
  }
  if (lastDot >= 0) {
    return value.slice(0, lastDot + 1);
  }
  return 'unknown';
}

/** 去掉字符串中的令牌类内容、`auth` 字段值与手机号。 */
export function redactText(input: string, sensitive: readonly string[] = []): string {
  let output = input;
  for (const secret of [TOKEN_PLACEHOLDER, ...sensitive]) {
    if (secret.length > 0) output = output.split(secret).join('[redacted]');
  }
  output = output.replace(AUTH_JSON_VALUE, '"$1":"[redacted]"');
  output = output.replace(TOKEN_LIKE, '[redacted-token]');
  output = output.replace(PHONE, '[redacted-phone]');
  return output;
}

/** 去掉对象中令牌相关键（入库前调用，RR-13）。 */
export function stripSecrets<T extends Record<string, unknown>>(value: T): T {
  const secretKeys = new Set(['auth', 'write_token', 'writeToken']);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretKeys.has(key)) continue;
    output[key] = item;
  }
  return output as T;
}

/** 创建日志器。逻辑集中在这里，模块其他部分不得直接写 console。 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const capacity = (options as { capacity?: number }).capacity ?? DEFAULT_CAPACITY;
  const sensitive = options.sensitive ?? [];
  const buffer: LogEntry[] = [];

  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value, sensitive);
    return value;
  };

  const log = (fields: LogFields, message?: string): LogEntry => {
    const { level, event, ...rest } = fields;
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key === 'ip' && typeof value === 'string') {
        sanitized['ip'] = maskIp(value);
        continue;
      }
      sanitized[key] = sanitize(value);
    }
    if (message !== undefined && message.length > 0) {
      sanitized['message'] = redactText(message, sensitive);
    }
    const entry: LogEntry = { ts: Date.now(), level, event, fields: sanitized };
    buffer.push(entry);
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    return entry;
  };

  return {
    log,
    entries: () => buffer.slice(),
    text: () => buffer.map((entry) => JSON.stringify(entry)).join('\n'),
    clear: () => {
      buffer.length = 0;
    },
  };
}
