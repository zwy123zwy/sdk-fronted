/**
 * 请求体解码与批次结构校验（M01-F1、RR-01、RR-04）。
 *
 * 只用 Node 内置模块：`node:zlib` 流式解压，累计解压量达到 1 MB 立即中止（防 gzip 炸弹）。
 */

/** 解压后请求体上限（1 MB，ingest-protocol 2.3）。 */
export const MAX_DECOMPRESSED_BYTES = 1_048_576;
/** 压缩后请求体上限（256 KB，仅常规通道使用 gzip）。 */
export const MAX_COMPRESSED_BYTES = 256 * 1024;
/** 单批事件数上限（500）。 */
export const MAX_EVENTS_PER_BATCH = 500;
/** 单条事件序列化后上限（16 KB）。 */
export const MAX_EVENT_BYTES = 16 * 1024;
/** 信标通道请求体上限（60 KB，C07-F1）。 */
export const MAX_BEACON_BYTES = 60 * 1024;

/** 校验失败的原因码（与响应体的 `error` 一致）。 */
export type ValidationError =
  | 'invalid_json'
  | 'invalid_structure'
  | 'unsupported_protocol'
  | 'unsupported_encoding'
  | 'app_id_mismatch'
  | 'payload_too_large'
  | 'too_many_events';

export type ValidationResult =
  | { ok: true; batch: Record<string, unknown> }
  | { ok: false; error: ValidationError; message: string };

export type DecodeResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; error: 'payload_too_large' | 'invalid_json'; message: string };

const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const ENV = /^[a-z][a-z0-9_-]{0,31}$/;
const SDK_NAME = /^[a-z0-9@/._-]{1,64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const TIMESTAMP_MIN = 1_577_836_800_000;
const TIMESTAMP_MAX = 4_102_444_800_000;

const BATCH_KEYS = new Set([
  'protocol_version',
  'app_id',
  'env',
  'release',
  'sdk_name',
  'sdk_version',
  'device_id',
  'device_id_persistent',
  'session_id',
  'user_id',
  'user_id_hashed',
  'consent',
  'batch_id',
  'sent_at',
  'clock_offset',
  'clock_calibrated',
  'common',
  'auth',
  'events',
]);

const COMMON_KEYS = new Set(['page_id', 'view_id', 'url', 'sample_rate', 'context']);

const EVENT_KEYS = new Set([
  'event_id',
  'event_name',
  'event_type',
  'schema_version',
  'occurred_at',
  'priority',
  'sample_rate',
  'page_id',
  'view_id',
  'url',
  'level',
  'dimensions',
  'metrics',
  'context',
  'attachment',
  'truncated',
  'retry_count',
  'replayed',
  'auth',
]);

const EVENT_TYPES = new Set([
  'custom',
  'log',
  'error',
  'perf',
  'pageview',
  'http',
  'sdk_internal',
]);

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const CONSENT = new Set(['granted', 'denied', 'unknown']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isTimestamp(value: unknown): boolean {
  return isInteger(value) && value >= TIMESTAMP_MIN && value <= TIMESTAMP_MAX;
}

function isSampleRate(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

function checkExtraKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return `unexpected field: ${key}`;
  }
  return null;
}

function validateDimensions(value: unknown): string | null {
  if (!isPlainObject(value)) return 'dimensions must be an object';
  const keys = Object.keys(value);
  if (keys.length > 50) return 'dimensions maxProperties';
  for (const key of keys) {
    if (!FIELD_KEY.test(key)) return `invalid dimension key: ${key}`;
    const item = value[key];
    if (typeof item !== 'string' || item.length > 256) return `invalid dimension value: ${key}`;
  }
  return null;
}

function validateMetrics(value: unknown): string | null {
  if (!isPlainObject(value)) return 'metrics must be an object';
  const keys = Object.keys(value);
  if (keys.length > 50) return 'metrics maxProperties';
  for (const key of keys) {
    if (!FIELD_KEY.test(key)) return `invalid metric key: ${key}`;
    const item = value[key];
    if (typeof item !== 'number' || !Number.isFinite(item)) return `invalid metric value: ${key}`;
  }
  return null;
}

function validateCommon(value: unknown): string | null {
  if (!isPlainObject(value)) return 'common must be an object';
  const extra = checkExtraKeys(value, COMMON_KEYS);
  if (extra !== null) return extra;
  if (value['page_id'] !== undefined && (typeof value['page_id'] !== 'string' || value['page_id'].length > 256)) {
    return 'invalid common.page_id';
  }
  if (value['view_id'] !== undefined && !(typeof value['view_id'] === 'string' && UUID.test(value['view_id']))) {
    return 'invalid common.view_id';
  }
  if (value['url'] !== undefined && (typeof value['url'] !== 'string' || value['url'].length > 2048)) {
    return 'invalid common.url';
  }
  if (value['sample_rate'] !== undefined && !isSampleRate(value['sample_rate'])) {
    return 'invalid common.sample_rate';
  }
  if (value['context'] !== undefined) return validateDimensions(value['context']);
  return null;
}

function validateAuth(value: unknown): string | null {
  if (!isPlainObject(value)) return 'auth must be an object';
  const extra = checkExtraKeys(value, new Set(['app_id', 'write_token']));
  if (extra !== null) return extra;
  const appId = value['app_id'];
  if (typeof appId !== 'string' || !IDENTIFIER.test(appId)) return 'invalid auth.app_id';
  const token = value['write_token'];
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
    return 'invalid auth.write_token';
  }
  return null;
}

function validateEvent(value: unknown): string | null {
  if (!isPlainObject(value)) return 'event must be an object';
  for (const key of ['event_id', 'event_name', 'event_type', 'schema_version', 'occurred_at', 'priority']) {
    if (!(key in value)) return `event missing ${key}`;
  }
  const extra = checkExtraKeys(value, EVENT_KEYS);
  if (extra !== null) return extra;
  // 单条事件超过 16 KB 时，接收方只拒绝该条，不再追究字段级长度限制（ingest-protocol 2.3）。
  const oversized = Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVENT_BYTES;
  if (typeof value['event_id'] !== 'string' || !UUID.test(value['event_id'])) return 'invalid event_id';
  if (
    typeof value['event_name'] !== 'string' ||
    value['event_name'].length > 64 ||
    !EVENT_NAME.test(value['event_name'])
  ) {
    return 'invalid event_name';
  }
  if (typeof value['event_type'] !== 'string' || !EVENT_TYPES.has(value['event_type'])) {
    return 'invalid event_type';
  }
  if (!isInteger(value['schema_version']) || value['schema_version'] < 1) return 'invalid schema_version';
  if (!isTimestamp(value['occurred_at'])) return 'invalid occurred_at';
  if (value['priority'] !== 'normal' && value['priority'] !== 'critical') return 'invalid priority';
  if (value['event_type'] === 'log' && !LEVELS.has(typeof value['level'] === 'string' ? value['level'] : '')) {
    return 'log event requires level';
  }
  if (value['level'] !== undefined && !(typeof value['level'] === 'string' && LEVELS.has(value['level']))) {
    return 'invalid level';
  }
  if (value['sample_rate'] !== undefined && !isSampleRate(value['sample_rate'])) {
    return 'invalid sample_rate';
  }
  if (value['page_id'] !== undefined && (typeof value['page_id'] !== 'string' || value['page_id'].length > 256)) {
    return 'invalid page_id';
  }
  if (value['view_id'] !== undefined && !(typeof value['view_id'] === 'string' && UUID.test(value['view_id']))) {
    return 'invalid view_id';
  }
  if (value['url'] !== undefined && (typeof value['url'] !== 'string' || value['url'].length > 2048)) {
    return 'invalid url';
  }
  if (value['dimensions'] !== undefined) {
    const error = validateDimensions(value['dimensions']);
    if (error !== null) return error;
  }
  if (value['metrics'] !== undefined) {
    const error = validateMetrics(value['metrics']);
    if (error !== null) return error;
  }
  if (value['context'] !== undefined) {
    const error = validateDimensions(value['context']);
    if (error !== null) return error;
  }
  if (value['attachment'] !== undefined && (typeof value['attachment'] !== 'string' || (!oversized && value['attachment'].length > 8192))) {
    return 'invalid attachment';
  }
  if (value['truncated'] !== undefined) {
    const list = value['truncated'];
    if (!Array.isArray(list) || list.length > 60) return 'invalid truncated';
    const seen = new Set<string>();
    for (const item of list) {
      if (typeof item !== 'string' || item.length > 128) return 'invalid truncated item';
      if (seen.has(item)) return 'duplicate truncated item';
      seen.add(item);
    }
  }
  if (value['retry_count'] !== undefined && (!isInteger(value['retry_count']) || value['retry_count'] < 0 || value['retry_count'] > 100)) {
    return 'invalid retry_count';
  }
  if (value['replayed'] !== undefined && typeof value['replayed'] !== 'boolean') return 'invalid replayed';
  if (value['auth'] !== undefined && !isPlainObject(value['auth'])) {
    return 'invalid event auth';
  }
  return null;
}

/** 校验批次结构。`protocol_version` 不认识时返回 `unsupported_protocol`（响应仍是 400）。 */
export function validateBatch(input: unknown): ValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'invalid_structure', message: 'batch must be a JSON object' };
  }
  if (input['protocol_version'] !== undefined && input['protocol_version'] !== 1) {
    return { ok: false, error: 'unsupported_protocol', message: 'unsupported protocol_version' };
  }
  for (const key of ['protocol_version', 'app_id', 'env', 'release', 'sdk_name', 'sdk_version', 'device_id', 'session_id', 'batch_id', 'sent_at', 'clock_offset', 'events']) {
    if (!(key in input)) {
      return { ok: false, error: 'invalid_structure', message: `batch missing ${key}` };
    }
  }
  const extra = checkExtraKeys(input, BATCH_KEYS);
  if (extra !== null) return { ok: false, error: 'invalid_structure', message: extra };

  if (typeof input['app_id'] !== 'string' || !IDENTIFIER.test(input['app_id'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid app_id' };
  }
  if (typeof input['env'] !== 'string' || !ENV.test(input['env'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid env' };
  }
  if (typeof input['release'] !== 'string' || input['release'].length < 1 || input['release'].length > 64) {
    return { ok: false, error: 'invalid_structure', message: 'invalid release' };
  }
  if (typeof input['sdk_name'] !== 'string' || !SDK_NAME.test(input['sdk_name'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid sdk_name' };
  }
  if (typeof input['sdk_version'] !== 'string' || !SEMVER.test(input['sdk_version'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid sdk_version' };
  }
  if (typeof input['device_id'] !== 'string' || !UUID.test(input['device_id'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid device_id' };
  }
  if (typeof input['session_id'] !== 'string' || !UUID.test(input['session_id'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid session_id' };
  }
  if (typeof input['batch_id'] !== 'string' || !UUID.test(input['batch_id'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid batch_id' };
  }
  if (!isTimestamp(input['sent_at'])) {
    return { ok: false, error: 'invalid_structure', message: 'invalid sent_at' };
  }
  if (!isInteger(input['clock_offset']) || Math.abs(input['clock_offset']) > 86_400_000) {
    return { ok: false, error: 'invalid_structure', message: 'invalid clock_offset' };
  }
  if (input['device_id_persistent'] !== undefined && typeof input['device_id_persistent'] !== 'boolean') {
    return { ok: false, error: 'invalid_structure', message: 'invalid device_id_persistent' };
  }
  if (input['user_id'] !== undefined && (typeof input['user_id'] !== 'string' || input['user_id'].length < 1 || input['user_id'].length > 128)) {
    return { ok: false, error: 'invalid_structure', message: 'invalid user_id' };
  }
  if (input['user_id_hashed'] !== undefined && typeof input['user_id_hashed'] !== 'boolean') {
    return { ok: false, error: 'invalid_structure', message: 'invalid user_id_hashed' };
  }
  if (input['consent'] !== undefined && !(typeof input['consent'] === 'string' && CONSENT.has(input['consent']))) {
    return { ok: false, error: 'invalid_structure', message: 'invalid consent' };
  }
  if (input['clock_calibrated'] !== undefined && typeof input['clock_calibrated'] !== 'boolean') {
    return { ok: false, error: 'invalid_structure', message: 'invalid clock_calibrated' };
  }
  if (input['common'] !== undefined) {
    const error = validateCommon(input['common']);
    if (error !== null) return { ok: false, error: 'invalid_structure', message: error };
  }
  if (input['auth'] !== undefined) {
    const error = validateAuth(input['auth']);
    if (error !== null) return { ok: false, error: 'invalid_structure', message: error };
  }
  const events = input['events'];
  if (!Array.isArray(events) || events.length < 1) {
    return { ok: false, error: 'invalid_structure', message: 'events must be a non-empty array' };
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return {
      ok: false,
      error: 'too_many_events',
      message: `batch exceeds ${String(MAX_EVENTS_PER_BATCH)} events`,
    };
  }
  for (const event of events) {
    const error = validateEvent(event);
    if (error !== null) return { ok: false, error: 'invalid_structure', message: error };
  }
  return { ok: true, batch: input };
}

/** 只统计事件数，用于在完整校验前先做 413 判定。 */
export function countEvents(value: unknown): number {
  if (!isPlainObject(value)) return 0;
  const events = value['events'];
  return Array.isArray(events) ? events.length : 0;
}
