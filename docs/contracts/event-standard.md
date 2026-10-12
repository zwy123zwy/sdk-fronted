# 事件数据标准

- 版本：0.2（已冻结，2026-10-10；批准见 `README.md`“冻结记录”）
- 对应任务：T06；需求：C04-F1、C04-F6、C06-F3、K01-F1、K01-F4；接收方要求 RR-06、RR-21
- 机器可读定义：`schemas/batch.schema.json`（上报格式）、`schemas/event-definition.schema.json`（事件注册表中的事件定义）

## 1. 批次公共头

| 字段 | 必填 | 说明 |
|---|---|---|
| `protocol_version` | 是 | 固定为 `1` |
| `app_id` | 是 | 应用标识，由接收方分配，通过初始化参数传入 |
| `env` | 是 | 环境，如 `production`、`staging`；小写字母开头，不超过 32 字符 |
| `release` | 是 | 接入方应用版本 |
| `sdk_name` / `sdk_version` | 是 | SDK 包名与 semver 版本 |
| `device_id` | 是 | 随机 UUID v4。未取得同意时为页面级临时值，并设置 `device_id_persistent: false` |
| `session_id` | 是 | 随机 UUID v4；30 分钟无活动后重新生成 |
| `user_id` | 否 | 业务用户标识；`user_id_hashed: true` 表示已是哈希值 |
| `consent` | 否 | 发送时的同意状态，见 Q5 |
| `batch_id` | 是 | 随机 UUID v4；重试时不变，拆分时重新生成 |
| `sent_at` | 是 | 本次发送时间（客户端时钟） |
| `clock_offset` | 是 | 接收方时间减客户端时间（毫秒），未校准时为 `0` 且 `clock_calibrated: false` |
| `common` | 否 | 批次内取值相同的事件字段，见第 3 节 |
| `auth` | 否 | 仅信标通道使用 |

## 2. 事件体

| 字段 | 必填 | 说明 |
|---|---|---|
| `event_id` | 是 | 客户端生成的 UUID v4，去重的唯一依据；补发和重试时不变 |
| `event_name` | 是 | 业务域前缀加小写下划线，至少两段，如 `video_load_complete`；应该在事件注册表（K01）中登记；未登记的事件 SDK 照常发送，由接收方决定如何处理，K01 可以出具未登记事件报告（K01-F6） |
| `event_type` | 是 | `custom`、`log`、`error`、`perf`、`pageview`、`http`、`sdk_internal` |
| `schema_version` | 是 | 事件定义的版本，取自 K01 生成的类型包；自动采集的事件由 SDK 内置 |
| `occurred_at` | 是 | 事件发生时间（客户端时钟，UTC 毫秒），补发时不变 |
| `priority` | 是 | `normal` 或 `critical`，以事件注册表声明为准（Q3）；未声明的按 normal |
| `sample_rate` | 是* | 生效采样率，取值 (0, 1] |
| `page_id` | 是* | 路由模板，如 `/task/:id` |
| `view_id` | 是* | 页面访问标识；路由变化时重新生成，入队时绑定（C04-F2） |
| `url` | 是* | 脱敏后的完整 URL |
| `level` | 条件 | `event_type` 为 `log` 时必填 |
| `dimensions` | 否 | 字符串维度，键不超过 50 个，值不超过 256 字符 |
| `metrics` | 否 | 有限数值，键不超过 50 个；不得为 `NaN` 或 `Infinity`（JSON 本身无法表示，SDK 序列化前必须剔除并计数） |
| `context` | 否 | 全局自定义上下文，与 `dimensions` 分开存放 |
| `attachment` | 否 | 附加文本（日志、错误栈），不超过 8 KB |
| `truncated` | 否 | 被截断的字段路径列表 |
| `retry_count` / `replayed` | 否 | 投递诊断信息 |

带 `*` 的字段必须出现在事件体或批次 `common` 中的至少一处。接收方还原批次时，事件体中的值优先于 `common`（RR-06）。

## 3. 字段提升规则（C06-F3）

C06 组装批次时，如果批次内所有事件的 `page_id`、`view_id`、`url`、`sample_rate`、`context` 中某个字段取值完全相同，可以把它移到 `common` 中，并从事件体删除。这是可选的体积优化：

- 接收方必须同时支持提升和未提升两种写法（RR-06）；
- 契约测试必须覆盖“全部提升”“部分提升”“不提升”三种样例；
- 提升不得改变语义：还原后的每条事件，必须与未提升时完全一致。

## 4. 字段约束与截断（C04-F6）

| 约束 | 上限 | 超限处理 | 计数原因码 |
|---|---|---|---|
| 维度值长度 | 256 字符 | 截断到 256 字符，路径写入 `truncated` | `truncated_dimension` |
| 维度键数量 | 50 | 保留按键名字典序的前 50 个，其余丢弃，写入 `truncated` | `truncated_dimension_keys` |
| 指标键数量 | 50 | 同上 | `truncated_metric_keys` |
| 附件长度 | 8 KB | 截断，写入 `truncated` | `truncated_attachment` |
| 单条事件 | 16 KB | 依次截断 `attachment`、`dimensions` 中最长的值，仍超限则丢弃整条 | `event_too_large` |
| 键名格式 | 小写字母开头，小写字母、数字、下划线，最长 64 | 丢弃该字段 | `invalid_field_key` |

SDK 按 UTF-16 码元计算长度（与 JavaScript `String.length` 一致），截断时不得切断代理对。JSON Schema 的 `maxLength` 按 Unicode 码点计数，码点数总是不超过 UTF-16 码元数，所以 SDK 截断后的结果一定能通过 Schema 校验。

## 5. 命名与单位

- 字段名统一为小写下划线。
- 时间为 UTC 毫秒时间戳；耗时以毫秒为单位，字段后缀 `_ms`；字节数后缀 `_bytes`；比率取值 0–1，后缀 `_ratio`。
- 布尔值只能出现在 `metrics` 中时用 `0`/`1`；`dimensions` 中用字符串 `"true"`/`"false"`。

## 6. 自动采集事件的内置定义

自动采集的事件由 SDK 内置定义，事件名使用保留前缀 `sdk_`、`web_`，接入方不得在事件注册表中登记这两个前缀的事件（K01 校验时拒绝）。

| 事件名 | `event_type` | 主要字段 |
|---|---|---|
| `web_js_error` | `error` | dimensions：`error_type`、`message`、`source`、`fingerprint`；metrics：`line`、`column`、`count`；attachment：脱敏后的错误栈 |
| `web_vitals` | `perf` | dimensions：`metric_name`（`FCP`、`LCP`、`CLS`、`INP`、`TTFB`）、`rating`；metrics：`value`、`delta` |
| `web_long_task` | `perf` | metrics：`duration_ms`、`start_time_ms` |
| `web_pageview` | `pageview` | dimensions：`referrer_page_id`、`navigation_type`；metrics：`load_time_ms` |
| `web_http` | `http` | dimensions：`method`、`url_template`、`status_class`、`failure_reason`；metrics：`status`、`duration_ms`、`request_bytes`、`response_bytes` |
| `sdk_health` | `sdk_internal` | 计数与耗时，见 `reason-codes.md` 第 4 节 |

这些定义的完整 Schema 由 T06 补充到 `schemas/builtin-events/`，T18 实现时以其为准。补充时只能细化本表已列出的字段（新增可选字段属于兼容变更），不得改变本表内容；T18 开工前必须完成。

## 7. 示例

见 `examples/batch.valid.json`、`examples/batch-promoted.valid.json`、`examples/batch.invalid.json`。

## 8. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1 | 2026-10-09 | 草案 |
| 0.2 | 2026-10-10 | 按 D001 把字典、S03、S04、控制台、服务端改为 K01 与接收方；冻结。`schemas/builtin-events/` 仍待 T06 补充 |
