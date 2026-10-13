/**
 * C03 配置常量与原因码（T13）。
 *
 * 原因码取自 `docs/contracts/reason-codes.md` 0.2（冻结）。
 */

/** 配置拉取时间参数（`remote-config.md` 第 1 节）。 */
export const FETCH_INTERVAL_MS = 300_000;
export const MIN_FETCH_GAP_MS = 60_000;
export const CACHE_TTL_MS = 86_400_000;
export const FETCH_TIMEOUT_MS = 5_000;

/** 拉取路径前缀。 */
export const CONFIG_PATH_PREFIX = '/v1/config/';

/** 配置能力名（供 T18/C04–C07 通过内核的能力注册表读取）。 */
export const CONFIG_CAPABILITY = 'sdk.config';

/** 配置相关原因码。 */
export const CONFIG_REASON_CODES = {
  fetchFailed: 'config_fetch_failed',
  signatureInvalid: 'config_signature_invalid',
  versionStale: 'config_version_stale',
  scopeMismatch: 'config_scope_mismatch',
  formatUnsupported: 'config_format_unsupported',
  parseFailed: 'config_parse_failed',
  cacheExpired: 'config_cache_expired',
  signatureUnavailable: 'config_signature_unavailable',
  consentModeRejected: 'config_consent_mode_rejected',
  /**
   * CR-003（2026-10-13 已批准并落地）：合法 JSON 但不符合 `remote-config.schema.json`，
   * 含使用了 `remote-config.md` 5.1 节未列出的 semver 范围语法。与 `config_parse_failed`
   * （非合法 JSON）区分。见 `docs/contracts/reason-codes.md` 第 2 节。
   */
  schemaInvalid: 'config_schema_invalid',
} as const;

/** 支持的 `format_version` 主版本。 */
export const SUPPORTED_FORMAT_VERSION = 1;

/** 采集类插件（会话未命中时拆除监听的对象，C03-F6 / AC-15）。 */
export const COLLECTOR_PLUGIN_IDS: readonly string[] = ['error', 'perf', 'route', 'http', 'apm_dual_write'];

/** 配置原因码取值。 */
export type ConfigReasonCode = (typeof CONFIG_REASON_CODES)[keyof typeof CONFIG_REASON_CODES];
