# 原因码

- 版本：0.1（草案，未冻结）
- 对应任务：T05、T17、T23；需求：C01-F6、C02-F2、C08-F1、S04-F1

每个丢弃、截断、重试路径都必须有原因码（指南第 11 节），客户端由 C08 计数，服务端写入死信或处理指标。新增原因码是兼容变更；删除或修改语义是破坏性变更。

## 1. 客户端丢弃（事件不会发出）

| 原因码 | 环节 | 说明 |
|---|---|---|
| `invalid_args` | C01 | 公共方法参数非法 |
| `invalid_event_name` | C01 / C02 校验 | 事件名不符合命名规则或使用保留前缀 |
| `invalid_field_key` | C04 | 字段键名格式非法，该字段被丢弃 |
| `non_finite_metric` | C04 | 指标值为 `NaN` 或 `Infinity`，该字段被丢弃 |
| `event_too_large` | C04 | 截断后仍超过 16 KB |
| `command_queue_overflow` | C01 | 命令队列超过 200 条 |
| `prestart_queue_overflow` | C02 | 预启动队列超过 500 条 |
| `processor_error` | C02 | 处理器抛错，跳过该处理器（事件继续，不算丢弃，只计数） |
| `sampled_out_session` | C03 | 会话未命中采样 |
| `sampled_out_rule` | C03 | 事件级规则未命中 |
| `disabled_by_rule` | C03 | 事件级规则 `rate: 0` |
| `killed` | C03 | kill switch 生效 |
| `consent_denied` | C04 | 同意状态不允许采集或发送该事件 |
| `filtered_by_plugin` | C05 | 插件过滤规则（如去重的重复错误） |
| `queue_evicted` | C06 | 内存队列溢出，淘汰最早的 normal 事件 |
| `offline_evicted` | C07 | 离线存储超过 5 MB 或 2,000 批，或超过 7 天 |
| `retry_exhausted` | C07 | 重试次数用完且离线存储不可用 |
| `rejected_400` / `rejected_401` / `rejected_403` / `rejected_413` | C07 | 服务端拒绝，见 `ingest-protocol.md` 3.1 |
| `destroyed` | C02 | SDK 销毁后仍有调用 |
| `storage_unavailable` | C07 | IndexedDB 和 localStorage 都不可用，critical 事件降级为仅内存 |

## 2. 客户端截断与重试（只计数，事件仍发出）

`truncated_dimension`、`truncated_dimension_keys`、`truncated_metric_keys`、`truncated_attachment`、`retry_429`、`retry_5xx`、`retry_network`、`split_413`、`circuit_open`、`replayed`、`config_fetch_failed`、`config_signature_invalid`、`config_format_unsupported`、`config_cache_expired`、`config_signature_unavailable`。

## 3. 服务端原因码

网关响应体 `error`：

| 取值 | 响应码 |
|---|---|
| `invalid_json`、`unsupported_protocol`、`app_id_mismatch`、`invalid_structure` | 400 |
| `invalid_token`、`token_revoked` | 401 |
| `origin_not_allowed`、`app_disabled` | 403 |
| `payload_too_large`、`too_many_events` | 413 |
| `rate_limited` | 429 |
| `queue_unavailable`、`internal_error` | 503 / 500 |

S04 死信与处理指标：`schema_missing_required`、`schema_type_mismatch`、`schema_enum_mismatch`、`schema_retired`、`unknown_field`（只计数）、`unregistered`（打标签后入库）、`duplicate`（只计数）、`event_too_large`。

## 4. sdk_health 事件

C08 每 60 秒聚合一次，作为 `sdk_health` 事件上报（C08-F3），且本身不再进入计数。

| 位置 | 内容 |
|---|---|
| `metrics` | `calls_total`、`events_enqueued`、`events_sent`、`batches_sent`、`batches_failed`、`offline_written`、`offline_replayed`、`queue_length_max`、`window_ms`，以及每个原因码一个 `drop_<原因码>` 或 `count_<原因码>` |
| `metrics`（1% 会话） | `track_p99_ms`、`pipeline_p99_ms`、`serialize_p99_ms`（C08-F2） |
| `dimensions` | `sdk_version`、`state`（生命周期状态）、`config_version` |

值为 0 的计数不上报，以控制体积。字段键必须满足 `fieldKey` 格式（不超过 64 字符）。一个窗口内非零指标超过 50 个时，拆成多条 `sdk_health` 事件，每条带相同的 `window_ms` 和 `dimensions`。
