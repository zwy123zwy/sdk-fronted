/**
 * 发布物/正文结构校验（T13）。
 *
 * 运行时**不得引入 Ajv**（零运行时依赖），因此结构校验是手写的；`contract.test.ts` 用真实
 * `remote-config.schema.json` 的 Ajv 校验器做同语料交叉验证，防止手写校验器与契约漂移。
 *
 * 失败原因码（CR-003 / 安全负责人 2026-10-13）：
 * - 发布物结构缺字段、`alg` 非 ES256、签名长度非法 → `config_signature_invalid`（安全项 7）；
 * - 合法 JSON 但不符合 Schema（正文，或发布物含额外字段） → `config_schema_invalid`；
 * - `format_version` 主版本不认识 → `config_format_unsupported`（只计一次，由调用方保证）；
 * - `privacy.consent_mode` 为 `full`/非法 → **只忽略该字段**（D002），其余部分照常校验。
 *
 * 手写校验器严格镜像冻结 Schema 的 `additionalProperties` / `required` / 取值范围，
 * 含 `remote-config.md` 5.1 的 semver 语法支持性（不支持即整份 `config_schema_invalid`）。
 */
import { CONFIG_REASON_CODES, SUPPORTED_FORMAT_VERSION } from './constants';
import { isSupportedSemverRange } from './kill-switch';
import type { ConfigReasonCode } from './constants';

/** 结构校验结果。 */
export interface ValidationResult {
  readonly ok: boolean;
  readonly reason: ConfigReasonCode | undefined;
}

const SCHEMA_INVALID: ValidationResult = { ok: false, reason: CONFIG_REASON_CODES.schemaInvalid };
const SIGNATURE_INVALID: ValidationResult = { ok: false, reason: CONFIG_REASON_CODES.signatureInvalid };
const FORMAT_UNSUPPORTED: ValidationResult = { ok: false, reason: CONFIG_REASON_CODES.formatUnsupported };
const VALID: ValidationResult = { ok: true, reason: undefined };

const APP_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const ENV = /^[a-z][a-z0-9_-]{0,31}$/u;
const FIELD_KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const URL_QUERY_KEY = /^[A-Za-z0-9_.-]{1,64}$/u;
const SENSITIVE_HEADER = /^[a-z0-9-]{1,64}$/u;
const MASK_NAME = /^[a-z][a-z0-9_]{0,31}$/u;
const MASK_FLAGS = /^[imsu]{0,4}$/u;
const INGEST = /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/u;
const ENVELOPE_KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

const PLUGIN_NAMES: readonly string[] = ['error', 'perf', 'route', 'http', 'apm_dual_write'];
const EVENT_TYPES: readonly string[] = ['custom', 'log', 'error', 'perf', 'pageview', 'http'];
const ENVELOPE_KEYS: readonly string[] = ['format_version', 'key_id', 'alg', 'payload', 'signature'];
const TRANSPORT_KEYS: readonly string[] = [
  'max_batch_events',
  'max_batch_bytes',
  'idle_flush_ms',
  'max_wait_ms',
  'replay_batches_per_second',
];
const PATCH_KEYS: readonly string[] = ['sampling', 'plugins', 'transport'];
const PUBLISHED_AT_MIN = 1_577_836_800_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function inRange(value: unknown, minimum: number, maximum: number): boolean {
  return isInteger(value) && value >= minimum && value <= maximum;
}

function isNumberRange(value: unknown, minimum: number, maximum: number, exclusiveMinimum: boolean): boolean {
  if (!isFiniteNumber(value)) return false;
  if (exclusiveMinimum ? value <= minimum : value < minimum) return false;
  return value <= maximum;
}

function isStringArray(value: unknown, maxItems: number, maxLength: number, pattern?: RegExp): boolean {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  for (const item of value) {
    if (!isString(item) || item.length === 0 || item.length > maxLength) return false;
    if (pattern !== undefined && !pattern.test(item)) return false;
  }
  return true;
}

/** `rate`：0–1 的有限数。 */
function isRate(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function hasOnlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

function checkKillSwitch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if ('all' in value && !isBoolean(value['all'])) return false;
  if ('sdk_versions' in value) {
    const ranges = value['sdk_versions'];
    if (!Array.isArray(ranges) || ranges.length > 20) return false;
    for (const range of ranges) {
      if (!isString(range) || range.length < 1 || range.length > 64) return false;
      if (!isSupportedSemverRange(range)) return false;
    }
  }
  if ('plugins' in value) {
    const plugins = value['plugins'];
    if (!Array.isArray(plugins)) return false;
    const seen = new Set<string>();
    for (const plugin of plugins) {
      if (!isString(plugin) || !PLUGIN_NAMES.includes(plugin)) return false;
      if (seen.has(plugin)) return false;
      seen.add(plugin);
    }
  }
  return true;
}

function checkRuleDimension(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['key', 'equals'])) return false;
  const key = value['key'];
  const equals = value['equals'];
  return isString(key) && FIELD_KEY.test(key) && isString(equals) && equals.length <= 256;
}

function checkRuleMatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length < 1) return false;
  if (!hasOnlyKeys(value, ['event_name', 'event_type', 'dimension'])) return false;
  if ('event_name' in value) {
    const name = value['event_name'];
    if (!isString(name) || name.length > 64) return false;
  }
  if ('event_type' in value) {
    const type = value['event_type'];
    if (!isString(type) || !EVENT_TYPES.includes(type)) return false;
  }
  if ('dimension' in value && !checkRuleDimension(value['dimension'])) return false;
  return true;
}

function checkRule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['match', 'rate'])) return false;
  if (!('match' in value) || !('rate' in value)) return false;
  return checkRuleMatch(value['match']) && isRate(value['rate']);
}

function checkSampling(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if ('session_rate' in value && !isRate(value['session_rate'])) return false;
  if ('allow_users' in value && !isStringArray(value['allow_users'], 200, 128)) return false;
  if ('rules' in value) {
    const rules = value['rules'];
    if (!Array.isArray(rules) || rules.length > 100) return false;
    for (const rule of rules) {
      if (!checkRule(rule)) return false;
    }
  }
  return true;
}

function checkPluginSetting(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!('enabled' in value) || !isBoolean(value['enabled'])) return false;
  if ('options' in value && !isRecord(value['options'])) return false;
  return true;
}

function checkPlugins(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const [name, setting] of Object.entries(value)) {
    if (!PLUGIN_NAMES.includes(name)) return false;
    if (!checkPluginSetting(setting)) return false;
  }
  return true;
}

function checkMaskRule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['name', 'pattern', 'flags', 'replacement'])) return false;
  const name = value['name'];
  const pattern = value['pattern'];
  if (!isString(name) || !MASK_NAME.test(name)) return false;
  if (!isString(pattern) || pattern.length < 1 || pattern.length > 200) return false;
  if ('flags' in value) {
    const flags = value['flags'];
    if (!isString(flags) || !MASK_FLAGS.test(flags)) return false;
  }
  if ('replacement' in value) {
    const replacement = value['replacement'];
    if (!isString(replacement) || replacement.length > 32) return false;
  }
  return true;
}

/** `privacy`：`consent_mode` 一律不在此校验（字段级例外，D002）。 */
function checkPrivacy(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if ('url_query_allowlist' in value && !isStringArray(value['url_query_allowlist'], 50, 64, URL_QUERY_KEY)) {
    return false;
  }
  if ('sensitive_headers' in value && !isStringArray(value['sensitive_headers'], 50, 64, SENSITIVE_HEADER)) {
    return false;
  }
  if ('extra_mask_rules' in value) {
    const rules = value['extra_mask_rules'];
    if (!Array.isArray(rules) || rules.length > 40) return false;
    for (const rule of rules) {
      if (!checkMaskRule(rule)) return false;
    }
  }
  return true;
}

function checkEndpoints(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if ('ingest' in value) {
    const ingest = value['ingest'];
    if (!isString(ingest) || ingest.length > 512 || !INGEST.test(ingest)) return false;
  }
  return true;
}

function checkTransport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, TRANSPORT_KEYS)) return false;
  if ('max_batch_events' in value && !inRange(value['max_batch_events'], 1, 100)) return false;
  if ('max_batch_bytes' in value && !inRange(value['max_batch_bytes'], 1024, 61_440)) return false;
  if ('idle_flush_ms' in value && !inRange(value['idle_flush_ms'], 200, 10_000)) return false;
  if ('max_wait_ms' in value && !inRange(value['max_wait_ms'], 1_000, 60_000)) return false;
  if ('replay_batches_per_second' in value && !isNumberRange(value['replay_batches_per_second'], 0, 2, true)) {
    return false;
  }
  return true;
}

function checkOverrideWhen(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length < 1) return false;
  if ('sdk_versions' in value) {
    const ranges = value['sdk_versions'];
    if (!Array.isArray(ranges)) return false;
    for (const range of ranges) {
      if (!isString(range) || range.length < 1 || range.length > 64) return false;
      if (!isSupportedSemverRange(range)) return false;
    }
  }
  if ('session_bucket' in value) {
    const bucket = value['session_bucket'];
    if (!Array.isArray(bucket) || bucket.length !== 2) return false;
    if (!inRange(bucket[0], 0, 100) || !inRange(bucket[1], 0, 100)) return false;
  }
  return true;
}

function checkOverridePatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, PATCH_KEYS)) return false;
  if ('sampling' in value && !checkSampling(value['sampling'])) return false;
  if ('plugins' in value && !checkPlugins(value['plugins'])) return false;
  if ('transport' in value && !checkTransport(value['transport'])) return false;
  return true;
}

function checkOverrides(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  for (const item of value) {
    if (!isRecord(item)) return false;
    if (!('when' in item) || !('patch' in item)) return false;
    if (!checkOverrideWhen(item['when'])) return false;
    if (!checkOverridePatch(item['patch'])) return false;
  }
  return true;
}

/** 校验发布物外形（字段齐全、`alg`/签名格式）。 */
export function validateEnvelopeShape(envelope: Readonly<Record<string, unknown>>): ValidationResult {
  if (!isRecord(envelope)) return SCHEMA_INVALID;
  for (const key of ENVELOPE_KEYS) {
    if (!(key in envelope)) return SIGNATURE_INVALID;
  }
  if (!hasOnlyKeys(envelope, ENVELOPE_KEYS)) return SCHEMA_INVALID;
  if (envelope['format_version'] !== SUPPORTED_FORMAT_VERSION) return FORMAT_UNSUPPORTED;
  const keyId = envelope['key_id'];
  const alg = envelope['alg'];
  const payload = envelope['payload'];
  const signature = envelope['signature'];
  if (!isString(keyId) || !ENVELOPE_KEY_ID.test(keyId)) return SIGNATURE_INVALID;
  if (alg !== 'ES256') return SIGNATURE_INVALID;
  if (!isString(payload) || payload.length < 2 || payload.length > 65_536) return SIGNATURE_INVALID;
  if (!isString(signature) || !SIGNATURE.test(signature)) return SIGNATURE_INVALID;
  return VALID;
}

/**
 * 校验配置正文（镜像 `remote-config.schema.json`）。
 * `privacy.consent_mode` 为字段级例外：不参与校验（`full`/非法值只忽略该字段，D002）。
 */
export function validateRemoteBody(body: Readonly<Record<string, unknown>>): ValidationResult {
  if (!isRecord(body)) return SCHEMA_INVALID;
  if (body['format_version'] !== SUPPORTED_FORMAT_VERSION) return FORMAT_UNSUPPORTED;
  const appId = body['app_id'];
  const env = body['env'];
  const configVersion = body['config_version'];
  const publishedAt = body['published_at'];
  if (!isString(appId) || !APP_ID.test(appId)) return SCHEMA_INVALID;
  if (!isString(env) || !ENV.test(env)) return SCHEMA_INVALID;
  if (!isInteger(configVersion) || configVersion < 1) return SCHEMA_INVALID;
  if (!isInteger(publishedAt) || publishedAt < PUBLISHED_AT_MIN) return SCHEMA_INVALID;

  if ('kill_switch' in body && !checkKillSwitch(body['kill_switch'])) return SCHEMA_INVALID;
  if ('sampling' in body && !checkSampling(body['sampling'])) return SCHEMA_INVALID;
  if ('plugins' in body && !checkPlugins(body['plugins'])) return SCHEMA_INVALID;
  if ('privacy' in body && !checkPrivacy(body['privacy'])) return SCHEMA_INVALID;
  if ('endpoints' in body && !checkEndpoints(body['endpoints'])) return SCHEMA_INVALID;
  if ('transport' in body && !checkTransport(body['transport'])) return SCHEMA_INVALID;
  if ('overrides' in body && !checkOverrides(body['overrides'])) return SCHEMA_INVALID;
  return VALID;
}
