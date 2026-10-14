# 原因码

- 版本：0.2（已冻结，2026-10-10；批准见 `README.md`“冻结记录”）
- 对应任务：T05、T17；需求：C01-F6、C02-F2、C03-F2、C08-F1

每个丢弃、截断、重试路径都必须有原因码（指南第 11 节），由 C08 计数。新增原因码是兼容变更；删除或修改语义是破坏性变更。每个原因码都至少有一条验收用例，C08-AC-01 逐个触发第 1 节的丢弃原因码。

## 1. 客户端丢弃（事件或字段不会发出）

| 原因码 | 环节 | 说明 | 验收用例 |
|---|---|---|---|
| `invalid_args` | C01 | 公共方法参数非法 | C01-AC-11 |
| `invalid_event_name` | C01 | 事件名不符合命名规则或使用保留前缀 | C01-AC-11 |
| `invalid_field_key` | C04 | 字段键名格式非法，该字段被丢弃 | C04-AC-17 |
| `non_finite_metric` | C04 | 指标值为 `NaN` 或 `Infinity`，该字段被丢弃 | C01-AC-11 |
| `event_too_large` | C04 | 截断后仍超过 16 KB | C04-AC-15 |
| `command_queue_overflow` | C01 | 命令队列超过 200 条 | C01-AC-05 |
| `prestart_queue_overflow` | C02 | 预启动队列超过 500 条 | C02-AC-10 |
| `plugin_dependency_missing` | C02 | 插件依赖的插件不存在，该插件不安装 | C02-AC-07 |
| `plugin_install_failed` | C02 | 插件安装函数抛错，该插件不安装 | C02-AC-08 |
| `sampled_out_session` | C03 | 会话未命中采样 | C03-AC-15 |
| `sampled_out_rule` | C03 | 事件级规则未命中 | C03-AC-13 |
| `disabled_by_rule` | C03 | 事件级规则 `rate: 0` | C03-AC-13 |
| `killed` | C03 | kill switch 生效 | C03-AC-14 |
| `consent_denied` | C04 | 同意状态不允许采集或发送该事件 | C04-AC-10、C04-AC-12 |
| `consent_buffer_cleared` | C04 | `buffer` 模式下设置 `denied`，缓存的事件被清空 | C04-AC-18 |
| `filtered_by_plugin` | C02 / C05 | 插件过滤规则（如去重的重复错误） | C02-AC-05、C05-AC-03 |
| `queue_evicted` | C06 | 内存队列溢出，淘汰最早的 normal 事件 | C06-AC-01、C06-AC-02 |
| `offline_evicted` | C07 | 离线存储超过 5 MB 或 2,000 批，或超过 7 天 | C07-AC-16 |
| `offline_incompatible` | C07 | 离线数据格式版本与当前 SDK 不兼容，被清理 | C07-AC-22 |
| `retry_exhausted` | C07 | 重试次数用完且离线存储不可用 | C07-AC-23 |
| `prewrite_commit_lost` | C07 | critical 事件已发起离线预写，但 IndexedDB 事务在 `oncomplete` 之前被中断（页面或进程被强杀），该事件未落盘且无法补发；按 D004 单独计数，**不得与优雅路径的丢失混算** | C07-AC-28 |
| `rejected_400` / `rejected_401` / `rejected_403` / `rejected_413` | C07 | 接收方拒绝，见 `ingest-protocol.md` 3.1；`rejected_413` 只在单条事件仍超限时计数 | C07-AC-05、AC-06、AC-24、AC-07 |
| `destroyed` | C02 | SDK 销毁后仍有调用 | C01-AC-03、C02-AC-14 |

## 2. 只计数（事件仍发出或流程继续）

| 原因码 | 环节 | 说明 | 验收用例 |
|---|---|---|---|
| `processor_error` | C02 | 处理器抛错，跳过该处理器，事件继续 | C02-AC-06、C01-AC-02 |
| `truncated_dimension` | C04 | 维度值被截断 | C04-AC-13 |
| `truncated_dimension_keys` | C04 | 维度键数量被截断 | C04-AC-13 |
| `truncated_metric_keys` | C04 | 指标键数量被截断 | C04-AC-17 |
| `truncated_attachment` | C04 | 附件被截断 | C04-AC-13 |
| `retry_429` | C07 | 收到 429 后重试 | C07-AC-08 |
| `retry_5xx` | C07 | 收到 5xx 后重试 | C07-AC-09 |
| `retry_network` | C07 | 网络错误或超时后重试 | C07-AC-25 |
| `split_413` | C07 | 收到 413 后拆分重发 | C07-AC-07 |
| `circuit_open` | C07 | 熔断期间暂停发送的批次 | C07-AC-10 |
| `replayed` | C07 | 离线补发的批次 | C07-AC-14 |
| `storage_unavailable` | C07 | IndexedDB 和 localStorage 都不可用，critical 事件降级为仅内存 | C07-AC-23 |
| `config_fetch_failed` | C03 | 配置拉取失败 | C03-AC-05、C03-AC-06 |
| `config_signature_invalid` | C03 | 签名校验失败或 `key_id` 未知 | C03-AC-07、C03-AC-16 |
| `config_version_stale` | C03 | `config_version` 不大于当前生效版本 | C03-AC-08 |
| `config_scope_mismatch` | C03 | `app_id`、`env` 与请求路径不一致 | C03-AC-17 |
| `config_format_unsupported` | C03 | `format_version` 主版本不认识 | C03-AC-09 |
| `config_parse_failed` | C03 | 发布物或正文不是合法 JSON | C03-AC-18 |
| `config_schema_invalid` | C03 | 发布物或正文是合法 JSON 但不符合 `schemas/remote-config.schema.json`（含使用了 `remote-config.md` 5.1 节未列出的 semver 范围语法） | C03-AC-24 |
| `config_cache_expired` | C03 | 本地缓存超过 24 小时 | C03-AC-19 |
| `config_signature_unavailable` | C03 | 运行环境不支持 WebCrypto | C03-AC-20 |
| `config_consent_mode_rejected` | C03 | 远程配置中的 `consent_mode` 为 `full` 或非法值，被忽略（D002） | C03-AC-21 |

## 3. 接收方响应体 `error` 的建议取值

接收方不在本项目内（D001）。以下取值是建议，SDK 不依赖它们（`ingest-protocol.md` 3.3），M01 按此实现，便于调试模式显示。

| 取值 | 响应码 |
|---|---|
| `invalid_json`、`unsupported_protocol`、`unsupported_encoding`、`app_id_mismatch`、`invalid_structure` | 400 |
| `invalid_token`、`token_revoked` | 401 |
| `origin_not_allowed`、`app_disabled` | 403 |
| `payload_too_large`、`too_many_events` | 413 |
| `rate_limited` | 429 |
| `storage_unavailable`、`internal_error` | 503 / 500 |

接收方内部的校验、死信、去重指标如何命名由接收方决定，不在本契约范围内。

## 4. sdk_health 事件

C08 每 60 秒聚合一次，作为 `sdk_health` 事件上报（C08-F3），且本身不再进入计数。

| 位置 | 内容 |
|---|---|
| `metrics` | `calls_total`、`events_enqueued`、`events_sent`、`batches_sent`、`batches_failed`、`offline_written`、`offline_replayed`、`queue_length_max`、`window_ms`、`exposure_window_events`、`exposure_window_ms`，以及第 1 节每个原因码一个 `drop_<原因码>`、第 2 节每个原因码一个 `count_<原因码>` |
| `metrics`（1% 会话） | `track_p99_ms`、`pipeline_p99_ms`、`serialize_p99_ms`（C08-F2） |
| `dimensions` | `sdk_version`、`state`（生命周期状态）、`config_version` |

值为 0 的计数不上报，以控制体积。字段键必须满足 `fieldKey` 格式（不超过 64 字符；最长的 `count_config_signature_unavailable` 为 34 字符）。一个窗口内非零指标超过 50 个时，拆成多条 `sdk_health` 事件，每条带相同的 `window_ms` 和 `dimensions`。

**`exposure_window_ms` 是暴露窗口时长的上界，不是真实窗口**（2026-10-13 经 CR-007 写入，兼容澄清，字段名与类型不变）：

- **起点**是事件产生（`first_pending_at`）；**结束点是重启后的对账时刻**——会话死亡时刻在客户端不可观测，窗口只能在下次打开时闭合。
- 因此该值**包含「强杀 + 重启 + 打开探测页」的固定开销**：T29/T32 实测 **923–1712 ms**，而 D004 的真实窗口由批写提交延迟决定（实测 **0–11 ms**；D004 引用的 p50 1–4.1 ms / p95 3–17 ms），**两者相差 2–3 个数量级**。
- 该字段的数值随**重启速度**漂移：重启越快，上报的窗口越小。**不得把它读作真实窗口，也不得用于 SLA / 容量判定**。
- 真实窗口的本地可观测读数见 `packages/transport` 的 `stats().exposure.commitLostObservedWindowMs`（**内部观测量，不是契约指标，不进 `sdk_health`**）。

`dimensions` 取值的口径（2026-10-12 经架构负责人确认；本节其余内容不变）：

- `config_version` 以**十进制字符串**编码（批次 Schema 的 `dimensions` 值类型只能是字符串），取值范围与 `remote-config.schema.json` 的整数 `config_version` 一致（不小于 1）；没有生效配置时不上报。
- `state` 取 `initialized`、`running`、`paused`、`destroyed`，依次对应 C02 生命周期状态的已初始化、运行中、暂停、已销毁。
- 以上取值的机器可读定义见 `schemas/builtin-events/sdk_health.schema.json`。

## 5. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1 | 2026-10-09 | 草案 |
| 0.2 | 2026-10-10 | 删除 S04 死信原因码，网关 `error` 改为接收方建议取值；每个原因码对应验收用例；新增 `plugin_dependency_missing`、`plugin_install_failed`、`consent_buffer_cleared`、`offline_incompatible`、`config_version_stale`、`config_scope_mismatch`、`config_parse_failed`、`config_consent_mode_rejected`；`processor_error`、`storage_unavailable` 移到只计数；冻结 |
| 0.2（兼容追加） | 2026-10-13 | 经 CR-001 与架构负责人批准（2026-10-13）：第 1 节新增 `prewrite_commit_lost`（C07，硬杀导致的预写未落盘）；第 4 节 `metrics` 新增 `exposure_window_events`、`exposure_window_ms`。属兼容变更，**不递增文档版本号**（沿用 2026-10-12 对内置事件 Schema 与样例的先例）；`offline_evicted`、`storage_unavailable` 的既有语义不变 |
| 0.2（兼容追加） | 2026-10-13 | 经 **CR-003** 与架构负责人批准：第 2 节新增 `config_schema_invalid`（C03，「合法 JSON 但不符合 `remote-config.schema.json`」，与 `config_parse_failed`＝非合法 JSON 区分；含使用了 `remote-config.md` 5.1 节未列出的 semver 范围语法）。属兼容变更，**不递增文档版本号**；`config_parse_failed` 的既有语义不变 |
| 0.2（兼容追加） | 2026-10-13 | 经 **CR-007** 与编排方批准：第 4 节澄清 `exposure_window_ms` 是暴露窗口时长的**上界**（结束点是重启后的对账时刻，含强杀+重启开销，实测 923–1712 ms），**不是** D004 的真实窗口（0–11 ms），不得用于 SLA/容量判定；真实窗口的本地可读量见 `stats().exposure.commitLostObservedWindowMs`（内部观测量，非契约指标）。**未改字段名、类型、取值口径与 Schema**，属兼容澄清，**不递增文档版本号** |
