/**
 * C08 聚合 `sdk_health` 时使用的两个原因码清单（`docs/contracts/reason-codes.md` 0.2 +
 * CR-001 的兼容追加）。
 *
 * **这是契约数据的本地副本**：顺序、成员都必须与机器可读权威
 * `docs/contracts/schemas/builtin-events/sdk_health.schema.json` 的 `patternProperties`
 * 完全一致；`reason-codes.test.ts` 做双向比对，任何一侧漂移都会让门禁失败。
 *
 * 前缀规则（`reason-codes.md` 第 4 节）：第 1 节 → `drop_<原因码>`，第 2 节 → `count_<原因码>`。
 */

/** 第 1 节：客户端丢弃（事件或字段不会发出）。含 CR-001 的 `prewrite_commit_lost`。 */
export const DROP_REASON_CODES = [
  'invalid_args',
  'invalid_event_name',
  'invalid_field_key',
  'non_finite_metric',
  'event_too_large',
  'command_queue_overflow',
  'prestart_queue_overflow',
  'plugin_dependency_missing',
  'plugin_install_failed',
  'sampled_out_session',
  'sampled_out_rule',
  'disabled_by_rule',
  'killed',
  'consent_denied',
  'consent_buffer_cleared',
  'filtered_by_plugin',
  'queue_evicted',
  'offline_evicted',
  'offline_incompatible',
  'retry_exhausted',
  'prewrite_commit_lost',
  'rejected_400',
  'rejected_401',
  'rejected_403',
  'rejected_413',
  'destroyed',
] as const;

/** 第 2 节：只计数（事件仍发出或流程继续）。 */
export const COUNT_REASON_CODES = [
  'processor_error',
  'truncated_dimension',
  'truncated_dimension_keys',
  'truncated_metric_keys',
  'truncated_attachment',
  'retry_429',
  'retry_5xx',
  'retry_network',
  'split_413',
  'circuit_open',
  'replayed',
  'storage_unavailable',
  'config_fetch_failed',
  'config_signature_invalid',
  'config_version_stale',
  'config_scope_mismatch',
  'config_format_unsupported',
  'config_parse_failed',
  'config_schema_invalid',
  'config_cache_expired',
  'config_signature_unavailable',
  'config_consent_mode_rejected',
] as const;
