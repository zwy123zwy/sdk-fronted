# CR-002 `receiver-requirements.md` 追加附录 A：SDK 自监控（`sdk_health`）字段清单

- 状态：**草案（待架构负责人批准）**
- 起草人：A01（编排方代行）；起草日期：2026-10-13
- 依据：T17（C08 自监控与调试）任务卡的交接产物——「`sdk_health` 事件的字段清单（写入 `receiver-requirements.md` 附录 A，供接收方建看板；给 T32、T33 对账）」。**任务卡把这份清单指派给 T17 书写，但同一张卡的「文件所有权」只允许 T17 写 `packages/transport/src/{monitor,debug}/`，而 `receiver-requirements.md` 是冻结契约** —— 该矛盾由编排方按契约变更流程处理，内容取自 T17 的交付报告。
- 流程依据：`docs/contracts/README.md`「契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准」

## 1. 变更摘要

向 `docs/contracts/receiver-requirements.md` **追加一个附录 A**，供接收方据此建设自监控看板、供 T32/T33 做可靠性对账。**不修改该文件已有正文的任何一条要求**。

## 2. 附录 A 的内容（拟）

### A.1 事件形态

`sdk_health` 是普通上报事件，走同一条批次通道、同一个 `app_id`+`event_id` 去重键。顶层必填 `event_id`、`event_name`（`sdk_health`）、`event_type`（`sdk_internal`）、`schema_version`、`occurred_at`、`priority`（固定 `normal`，Q3 结论第 4 条）、`dimensions`、`metrics`。

**字段的权威定义是机器可读的 [`schemas/builtin-events/sdk_health.schema.json`](schemas/builtin-events/sdk_health.schema.json)**；本附录**不复制字段表**，以免与 Schema 产生漂移。接收方建看板应直接以该 Schema 为准，并可用 `docs/contracts/examples/builtin-events/sdk_health.valid.json` 做实现自测。

### A.2 `dimensions`

`sdk_version`（semver，产生本窗口数据的 SDK 版本）、`state`（`initialized|running|paused|destroyed`；SDK 的「未初始化」态不上报）、`config_version`（十进制字符串；无生效配置时省略）。

### A.3 `metrics` 的读数口径（接收方最容易读错的地方）

1. **计数类指标值为 0 时不上报**——因此「某个 `drop_*`/`count_*` 键不出现」等价于「该窗口内为 0」，**不要当成缺数据**。
2. **`offline_written` / `offline_replayed` 的单位是「批次数」，不是事件数**（事件数另有本地观测量，不进契约指标）。此项经 T16 审计修正过一次，接收方按批次数建看板。
3. **`exposure_window_ms` 必须与 `exposure_window_events` 同现**（Schema 的 `dependentRequired`，机器可校验）；`exposure_window_events` 为 0 时两者都不上报。
4. **`batches_sent` 与 `batches_failed` 不互补**：前者只计常规通道成功提交，后者含熔断（未尝试发送）与终态 4xx 拒绝，两者都不含离开通道与补发批次（补发计 `offline_replayed`）。**不要用 `sent + failed` 反推提交总数。**
5. **`queue_length_max` 是窗口内的队列长度峰值**，在非自监控入队时刻采样。
6. 三个 `*_p99_ms` **只在 1% 会话上报**（`sample_rate`）。

### A.4 上报节奏与分片

窗口常规为 60 秒（`window_ms`）。**一个窗口内非零指标超过 50 个时，SDK 拆成多条 `sdk_health`**（Schema 的 `maxProperties: 50`），每条带**相同的 `window_ms` 与 `dimensions`**、各自的 `event_id`。**接收方看板聚合时必须把同 `window_ms` + 同 `dimensions` 的多条事件视为同一窗口**，否则会把一条窗口拆成多行。

### A.5 流量占比

自监控流量占业务流量的比例，实测口径与结果：1 条 `sdk_health`（12 个指标、约 480 B）对 1000 条业务事件（约 467,000 B）→ **计数比 0.100%、体积比 0.1028%**（均 ≤1%）。接收方按此估算容量。

### A.6 调试模式

调试模式是**纯本地输出**（接入方控制台/logger），**不产生任何额外的上报事件**，因此不影响接收方侧的数据形态。

## 3. 兼容性判定

| 判据 | 本次改动 | 结论 |
|---|---|---|
| 接收方要求：新增章节 | 只追加附录 A，不改已有正文 | 兼容 |
| 事件 Schema | 不变引用 | 兼容 |
| 文档版本 | 按既有先例标注「0.2（兼容追加）」、**不递增文档版本号** | — |

## 4. 影响面

- **接收方**：可据此建自监控看板（尤其 A.3 的六个读数口径与 A.4 的分片聚合规则）。
- **T32（可靠性对账）**、**T33（试点）**：对账时按 A.3 的口径，不得用 `sent + failed` 反推。
- **T34（文档）**：`wr_debug` 参数名由实现自定、可配置；若文档要用别的名字，改配置即可。

## 5. 若不予批准的退路

T17 的字段清单只留在其交付报告里；接收方需自行从机器可读 Schema 推导读数口径——**A.3 的六条口径无法从 Schema 单独推出**（例如「0 值不上报」的读法、`sent + failed` 不互补、分片需按窗口聚合），因此不建附录会让接收方看板有实质性的误读风险。

## 6. 批准记录

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 起草 | A01（编排方代行） | 提交草案（内容取自 T17 交付报告，字段定义指向机器可读 Schema 以避免漂移） | 2026-10-13 |
| 架构负责人 | （待签署） | — | — |
