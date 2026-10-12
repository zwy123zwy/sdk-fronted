# 评审意见记录

维护者：A01（T01）。每条评审意见都要有处理结论。T01 验收时，本表不得有“待处理”。

| 编号 | 日期 | 来源 | 涉及文档 / 章节 | 意见 | 处理结论 | 状态 |
|---|---|---|---|---|---|---|
| R-001 | 2026-10-09 | 起草人 | `ingest-protocol.md` 2.2 | 信标通道令牌放在请求体中，需要安全负责人确认 | 采纳：令牌放在请求体 `auth` 字段，不进入 URL；接收方忽略常规通道中的 `auth`、不记录日志、持久化前删除（RR-03、RR-13）。确认：wenye.zhang（项目负责人）2026-10-09 对话中授权，代行安全负责人确认，2026-10-10 记录；安全负责人可以补签 | 已关闭 |
| R-002 | 2026-10-09 | 起草人 | `remote-config.md` 第 4 节 | 配置公钥由接入方在初始化参数中传入，会增加接入步骤 | 采纳原方案：公钥由初始化参数 `config_public_keys` 传入，SDK 不内置；ES256 + P1363 签名；轮换时新旧公钥并存至少 30 天。不打包进 SDK，否则轮换需要发布新版本。确认方式同 R-001 | 已关闭 |
| R-003 | 2026-10-09 | 起草人 | 总体方案 | 飞书线上版本尚未同步本地草稿中“服务端选型不写死”的修改 | 采纳，延后执行：仓库内契约与决策优先于飞书方案（指南第 1 节），飞书未同步不影响开发；同步时一并写入 D001 的范围变化。负责人 wenye.zhang，在 T34 前完成；看板阻塞记录跟踪 | 已关闭（延后项） |
| R-004 | 2026-10-12 | A01（T06）升级 | `reason-codes.md` 第 4 节 | `sdk_health.dimensions.config_version` 的编码方式未定义：`dimensions` 的值只能是字符串，而 `remote-config.schema.json` 的 `config_version` 是整数 | 采纳：以十进制字符串编码（批次 Schema 的 `dimensions` 值只能为字符串），取值范围与 `remote-config.schema.json` 的整数 `config_version` 一致（不小于 1），没有生效配置时不上报。口径写入 `reason-codes.md` 第 4 节，机器可读定义见 `schemas/builtin-events/sdk_health.schema.json`。确认：架构负责人（代行），2026-10-12 | 已关闭 |
| R-005 | 2026-10-12 | A01（T06）升级 | `reason-codes.md` 第 4 节、`schemas/builtin-events/sdk_health.schema.json` | `sdk_health.dimensions.state` 只写“生命周期状态”，没有契约字面量，SDK、接收方与看板无法对齐取值 | 采纳：冻结为 `initialized`、`running`、`paused`、`destroyed` 四值的 enum，依次对应 C02 生命周期状态的已初始化、运行中、暂停、已销毁。确认：架构负责人（代行），2026-10-12 | 已关闭 |
| R-006 | 2026-10-12 | A01（T06）升级 | `event-standard.md` 第 6 节、`schemas/builtin-events/web_long_task.schema.json` | `web_long_task.metrics.start_time_ms` 的时间基准未定义（epoch 毫秒还是相对 time origin） | 采纳：与 `PerformanceEntry.startTime` 同基准，即相对 time origin 的毫秒。在 `event-standard.md` 第 6 节表格下方以澄清句补充，不改动该节已有的表述与字段。确认：架构负责人（代行），2026-10-12 | 已关闭 |
| R-007 | 2026-10-12 | A01（T06）升级 | `schemas/builtin-events/web_vitals.schema.json`、`schemas/builtin-events/web_js_error.schema.json`、`schemas/builtin-events/web_http.schema.json`、`schemas/builtin-events/web_pageview.schema.json` | `rating`、`source`、`failure_reason`、`navigation_type` 是否收敛为 enum | 采纳：只把 `web_vitals` 的 `rating` 收敛为 `good`、`needs-improvement`、`poor`；`source`、`failure_reason`、`navigation_type` 保持开放字符串（收紧会卡住自动采集遇到的新取值，新增取值属于兼容变更）。确认：架构负责人（代行），2026-10-12 | 已关闭 |
| R-008 | 2026-10-12 | A01（T06）升级 | `contracts/README.md` 约定、`schemas/builtin-events/` 全部 Schema | 内置事件 Schema 的 `dimensions`/`metrics` 用封闭集合还是允许额外键 | 采纳：确认封闭集合（`additionalProperties: false`），只允许 `event-standard.md` 第 6 节列出的键（`sdk_health` 另见 `reason-codes.md` 第 4 节）；新增键必须走一次兼容追加。约定写入 `contracts/README.md` 的“约定”小节。确认：架构负责人（代行），2026-10-12 | 已关闭 |
| R-009 | 2026-10-12 | A01（T06）升级 | `contracts/README.md` 约定 | Schema `$id` 末段的版本（如 `urn:web-report-sdk:contracts:builtin-event:web_js_error:0.2`）与事件的 `schema_version` 容易混淆 | 采纳：明确 `$id` 末段是契约文档版本（0.2），`schema_version` 是事件定义版本（内置事件当前为 `1`），两者不是一回事。约定写入 `contracts/README.md` 的“约定”小节。确认：架构负责人（代行），2026-10-12 | 已关闭 |
