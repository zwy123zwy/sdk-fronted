# 契约

客户端与服务端、服务端各模块之间只通过本目录的契约协作（指南第 1 节）。契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准，并按“版本与兼容规则”递增版本。

## 状态

| 文件 | 对应任务 | 版本 | 状态 |
|---|---|---|---|
| [ingest-protocol.md](ingest-protocol.md) | T05 | 0.1 | 草案 |
| [schemas/batch.schema.json](schemas/batch.schema.json) | T05、T06 | 0.1 | 草案 |
| [event-standard.md](event-standard.md) | T06 | 0.1 | 草案 |
| [schemas/event-definition.schema.json](schemas/event-definition.schema.json) | T06 | 0.1 | 草案 |
| [remote-config.md](remote-config.md) | T07 | 0.1 | 草案 |
| [schemas/remote-config.schema.json](schemas/remote-config.schema.json) | T07 | 0.1 | 草案 |
| [reason-codes.md](reason-codes.md) | T05、T17 | 0.1 | 草案 |
| [examples/](examples/) | T05–T07 | 0.1 | 草案 |

**草案状态下不得作为实现依据。** 评审通过后，把状态改为“已冻结”并写上冻结日期和批准人。

## 约定

- Schema 使用 JSON Schema 2020-12。字段名统一为小写下划线。
- 时间为 UTC 毫秒时间戳；耗时字段后缀 `_ms`，字节数后缀 `_bytes`。
- 规则用“必须 / 不得 / 应该 / 可以”表述，含义同 RFC 2119。每条“必须”都对应 `tests/acceptance/` 中的至少一个用例。
- 每个 Schema 都要有至少一个合法样例（`examples/*.valid.json`）和一个非法样例（`examples/*.invalid.json`），契约测试（T10）用它们做双向校验。
- 样例中只使用占位值，不得出现真实的个人信息、令牌或域名。

## 版本与兼容规则

| 对象 | 版本位置 | 兼容变更 | 破坏性变更 |
|---|---|---|---|
| 上报协议 | URL 路径 `/v1/` 与 `protocol_version` | 新增可选字段、新增响应头 | 删除或改名字段、改变响应码语义；服务端至少同时兼容当前与前一个主版本，下线前提前 6 个月公告 |
| 事件 Schema | 每个事件的 `schema_version` | 新增可选字段 | 删除字段、改类型或语义，必须递增 `schema_version` |
| 远程配置 | `format_version` | 新增字段（SDK 必须忽略不认识的字段） | 删除或改语义；SDK 遇到不认识的主版本时使用本地缓存或保守默认 |
| 原因码 | `reason-codes.md` | 新增原因码 | 删除或改语义 |
