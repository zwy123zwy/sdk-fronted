# 契约

SDK 与接收方、SDK 与开发工具（K01、K02、M01）之间只通过本目录的契约协作（指南第 1 节）。接收方不在本项目内（D001），对它的要求见 `receiver-requirements.md`。契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准，并按“版本与兼容规则”递增版本。

文档版本号（0.2）与线上协议版本（URL `/v1/`、`protocol_version: 1`、`format_version: 1`）是两回事；前者记录文档修订，后者决定兼容性。

## 状态

| 文件 | 对应任务 | 版本 | 状态 |
|---|---|---|---|
| [ingest-protocol.md](ingest-protocol.md) | T05 | 0.2 | 已冻结 |
| [schemas/batch.schema.json](schemas/batch.schema.json) | T05、T06 | 0.2 | 已冻结 |
| [event-standard.md](event-standard.md) | T06 | 0.2 | 已冻结 |
| [schemas/event-definition.schema.json](schemas/event-definition.schema.json) | T06 | 0.2 | 已冻结 |
| [dictionary-compat.md](dictionary-compat.md) | T06、T22 | 0.2 | 已冻结 |
| [remote-config.md](remote-config.md) | T07 | 0.2 | 已冻结 |
| [schemas/remote-config.schema.json](schemas/remote-config.schema.json) | T07 | 0.2 | 已冻结 |
| [reason-codes.md](reason-codes.md) | T05、T17 | 0.2（兼容追加 2026-10-13，经 CR-001） | 已冻结 |
| [receiver-requirements.md](receiver-requirements.md) | T05、T17 | 0.2（兼容追加 2026-10-13，经 CR-002 补全附录 A） | 已冻结 |
| [examples/](examples/) | T05–T07 | 0.2 | 已冻结 |
| [schemas/builtin-events/](schemas/builtin-events/) | T06、T18 | 0.2（兼容追加） | 已提供（2026-10-12；2026-10-13 经 CR-001 追加 `prewrite_commit_lost` 与 `exposure_window_*`，不递增文档版本号） |
| [examples/builtin-events/](examples/builtin-events/) | T06、T10 | 0.2（兼容追加） | 已提供（2026-10-12） |
| [examples/compat-pairs/](examples/compat-pairs/) | T06、T10、T22 | 0.2（兼容追加） | 已提供（2026-10-12） |

**草案状态下不得作为实现依据。** 冻结后修改走契约变更请求。

## 冻结记录

| 日期 | 版本 | 范围 | 批准 |
|---|---|---|---|
| 2026-10-10 | 0.2 | 上表中所有标为“已冻结”的文件 | wenye.zhang（项目负责人）于 2026-10-09 在对话中授权，代行架构负责人批准；架构负责人可以补签 |

已知未完成项（不阻塞冻结，按兼容变更追加）：**无**（`receiver-requirements.md` 附录 A 已于 2026-10-13 经 CR-002 补全）。

2026-10-12 的兼容澄清（均不递增文档版本号，冻结记录不变；详见 `docs/review-log.md` R-010 至 R-012）：
- `schemas/builtin-events/` 由 T06 按兼容变更补齐（只细化 `event-standard.md` 第 6 节已列出的字段，不改变该节内容）。
- `batch.invalid.json`：补入信标通道 `auth` 的非法样例（原先在本文档里被指派给 T10，但 T10 无权写契约，实际未做）；并修正 case[4] 的 `_why` —— 原说明称「维度值超过 256 字符」，而该样例中该值仅 1 字符，真实失败原因是维度键含大写与顶层出现未声明字段。
- `remote-config.valid.json` 的 `_note`：写明 `envelope.payload` 是一份最小但完整合法的正文、与 `decoded_payload` 不是同一份。
- `compat-pairs/index.json`：写明 `verdict_zh` 只放短判定、判定表单元格的附加要求统一放在 `expected.additional_requirements`（对全部行统一，非缺失）。

## 约定

- Schema 使用 JSON Schema 2020-12。字段名统一为小写下划线。
- 时间为 UTC 毫秒时间戳；耗时字段后缀 `_ms`，字节数后缀 `_bytes`。
- 规则用“必须 / 不得 / 应该 / 可以”表述，含义同 RFC 2119。每条“必须”都对应 `tests/acceptance/` 中的至少一个用例。
- 每个 Schema 都要有至少一个合法样例（`examples/*.valid.json`）和一个非法样例（`examples/*.invalid.json`），契约测试（T10）用它们做双向校验。
- 内置事件 Schema（`schemas/builtin-events/`）的 `dimensions` 与 `metrics` 是**封闭集合**：只允许 `event-standard.md` 第 6 节列出的键（`sdk_health` 另见 `reason-codes.md` 第 4 节）。新增键必须走一次兼容追加（新增可选字段属于兼容变更），不能由实现方自行添加。
- Schema `$id` 的末段是**契约文档版本**（如 `urn:web-report-sdk:contracts:builtin-event:web_js_error:0.2` 中的 `0.2`）；事件的 `schema_version` 是**事件定义版本**（内置事件当前为 `1`）。两者不是一回事。
- 样例中只使用占位值，不得出现真实的个人信息、令牌或域名。

## 版本与兼容规则

| 对象 | 版本位置 | 兼容变更 | 破坏性变更 |
|---|---|---|---|
| 上报协议 | URL 路径 `/v1/` 与 `protocol_version` | 新增可选字段、新增响应头 | 删除或改名字段、改变响应码语义；新主版本发布后，SDK 至少保留一个兼容前一主版本的发布线，提前 6 个月通知已知接收方 |
| 事件 Schema | 每个事件的 `schema_version` | 新增可选字段 | 删除字段、改类型或语义，必须递增 `schema_version` |
| 远程配置 | `format_version` | 新增字段（SDK 必须忽略不认识的字段） | 删除或改语义；SDK 遇到不认识的主版本时使用本地缓存或保守默认 |
| 原因码 | `reason-codes.md` | 新增原因码 | 删除或改语义 |
