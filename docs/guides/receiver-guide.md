# 接收方指南

- 对应交付：T34（A14）；读者：接收 SDK 上报数据的服务的负责人与工程师
- 事实来源：`docs/contracts/receiver-requirements.md`（0.2，含 2026-10-13 经 CR-002 补全的附录 A）、`docs/contracts/ingest-protocol.md`、`docs/contracts/event-standard.md`、`reason-codes.md`、`tests/contract/sample-pack/manifest.json`（T10 的接收方样例包）

## 0. 适用对象与前提

本文适用于**生产环境**接收本 SDK 上报数据的服务（由接入方或其他团队提供）。SDK 只负责客户端一侧；`docs/contracts/receiver-requirements.md` 开头明确：

> critical 事件"丢失率不超过 0.1%"和"不重复入库"的端到端目标，只有在接收方满足本文"必须"条目时才成立。接收方按本文自查；**本项目不验证接收方的实现**。

因此：

- 本文与契约里所有"必须"条目都要由接收方自己实现并自证；本仓库只提供协议样例、样例清单与本地 mock（M01）作为**行为参照**，不提供生产参考实现。
- M01 覆盖全部"必须"条目的行为，但**不覆盖 RR-11（HTTPS）、RR-14（来源白名单）、RR-15（限流）**，且 M01 本身不得用于生产（[工具指南 · M01](tools.md#m01-本地联调)）。
- 本项目侧的可靠性与对账（T29/T32/T33）尚未执行；接收方的实现正确性不能由本项目保证。

## 1. 逐条解释

### 协议（1 节）

#### RR-01 实现 `ingest-protocol.md` 第 1–3 节的端点、请求格式、上限与响应码 —— **必须**

- **SDK 侧的依赖**：C07 按响应码决定重试、拆分、丢弃；协议不一致会直接导致 SDK 侧行为错误。
- **要点**：`POST /v1/batch`（主版本号在路径里）；必须 HTTPS（TLS 1.2+）；端点由接入方通过初始化参数 `endpoint` 或远程配置 `endpoints.ingest` 提供，**SDK 不内置默认域名**；常规通道请求头 `Content-Type: application/json`、`X-App-Id`（与请求体 `app_id` 一致）、`X-Write-Token`、可选 `X-Request-Id`（= 批次 `batch_id`）；请求体结构见 `schemas/batch.schema.json`。
- **上限**：请求体解压后 1 MB → 413；压缩后 256 KB → 413；单批事件数 500 → 413；单条事件序列化后 16 KB（SDK 侧保证，接收方可以只拒绝该条，其余正常处理）。
- **响应码**（`ingest-protocol.md` 3.1，SDK 只按响应码决定行为，不依赖 `error`/`message`）：`202` 持久化成功、`400` 结构/版本/app_id 不一致（丢弃不重试）、`401` 令牌无效或吊销（丢弃 + 暂停发送，直到下一次配置拉取成功且令牌或端点变化）、`403` 来源不在白名单/应用停用（同 401）、`413` 超限（SDK 拆半重发，单条仍超限则丢弃）、`429` 限流（按 `Retry-After` 退避）、`5xx` 暂时不可用（指数退避）、网络错误/超时（同 5xx）。**其他未列出的 2xx 按 202 处理，其他 4xx 按 400 处理。**
- **自查**：把 `docs/contracts/examples/batch.valid.json` 原文 POST，期望 **202**；把 `batch.invalid.json` 的每个 case POST，期望 **400** 且返回原因码；核对三个上限。对应 M01-AC-01、M01-AC-02、M01-AC-04。

#### RR-02 只在批次已持久化（写入队列或存储）之后返回 202；任何失败都不得返回 2xx —— **必须**

- **SDK 侧的依赖**：SDK 收到 202 后删除 critical 离线副本；提前返回会造成丢失（C07-F5）。
- **要点**：把"持久化"放在返回 202 之前；持久化失败（关闭存储、写入抛错、超时）必须返回 5xx。
- **自查**：行为自查（无可复用 JSON 样例）。在持久化步骤注入失败，确认响应是 5xx 而不是 2xx；恢复后用同一批次重发，入库事件数与源批次一致。对应 M01-AC-05。
- **注意**：本仓库的 M01 没有持久层，其"持久化后才返回 202"按"存储层接受后即 202"追认（看板 2026-10-12），这是 mock 的解释，**不适用于生产接收方**。

#### RR-03 同时支持常规通道（令牌在 `X-Write-Token` 请求头）和信标通道（`text/plain`，令牌在请求体 `auth` 字段）；常规通道请求体中的 `auth` 必须忽略 —— **必须**

- **SDK 侧的依赖**：页面离开时只能用 `sendBeacon`——它不能设置自定义请求头，也不能设置 `Content-Encoding`；所以信标通道的令牌在请求体。
- **要点**：信标通道 `Content-Type: text/plain;charset=UTF-8`（避免触发跨域预检），请求体是批次 JSON，令牌在 `auth.write_token`，`auth.app_id` 与批次 `app_id` 一致；**令牌不得放在 URL 中**；信标请求体不得超过 60 KB（C07 预先切片的上限），超过时由 SDK 分成多个信标请求；接收方通过 `Content-Type` 识别信标通道，**常规通道的请求体里出现 `auth` 时只认请求头、忽略它**。
- **自查**：把 `batch-beacon.valid.json` 作为 `text/plain` 信标请求体发送，按 `auth.write_token` 比对；再用常规通道发送同一份含 `auth` 的请求体，确认忽略请求体里的 `auth`。对应 M01-AC-03。
- **注意**：信标通道**无法读取响应**——`sendBeacon` 返回 `true` 只表示浏览器接受了请求。SDK 对 critical 批次不因此删除离线副本，等下一次常规通道的补发确认（C07-F5）。接收方应把它当作普通上报处理。

#### RR-04 支持 `Content-Encoding: gzip`；流式解压，解压量达到 1 MB 立即中止并返回 413（防 gzip 炸弹）；压缩后超过 256 KB 直接返回 413；其他编码返回 400 —— **必须**

- **SDK 侧的依赖**：C07-F8 只在批次序列化后超过 4 KB、且浏览器支持 `CompressionStream` 时才压缩；SDK 只发送 `gzip`，不发送其他编码。
- **要点**：流式解压并**在解压量达到 1 MB 时立即中止**（不要先解压完再判断）；压缩后上限用 `Content-Length` 之外的方式也要能拦住；`identity` 之外的编码（如 `br`）返回 400 + `unsupported_encoding`。
- **自查**：压缩 `batch.valid.json` 后发送确认正常入库；构造 gzip 炸弹确认达到 1 MB 时立即中止并 413；构造压缩后 >256 KB 的请求确认 413；用 `br`/`deflate` 确认 400。对应 M01-AC-04。

#### RR-05 按 `app_id` + `event_id` 在至少 7 天窗口内去重 —— **必须**

- **SDK 侧的依赖**：SDK 为保证不丢失会重复送达（重试、补发、多标签页）；**去重由接收方完成**。D003/D004 明确去重与限流是方案成立的前提。
- **要点**：去重键是 `app_id` + `event_id`（`event_id` 是客户端生成的 UUID v4，补发与重试不变；拆分重发时 `batch_id` 重新生成而 `event_id` 不变）；窗口至少 7 天（`ingest-protocol.md` 第 4 节）；同一事件重复送达**不应重复入库**，但要计入去重指标以备对账。
- **自查**：把 `batch.valid.json` 连续发送两次（第二次可换 `batch_id`），确认两次都返回 202 而**入库只增加一次**；再用 `batch-promoted.valid.json` 验证提升还原后仍按 `event_id` 去重。对应 M01-AC-06。
- **口径**：M01 的去重键在**进程生命周期内**有效，不做 7 天窗口与持久化——生产接收方必须真正落实窗口。

#### RR-06 按 `event-standard.md` 的提升规则还原批次 `common` 字段；事件体中的值优先 —— **必须**

- **SDK 侧的依赖**：C06 组装批次时，如果批次内所有事件的 `page_id`、`view_id`、`url`、`sample_rate`、`context` 中某个字段取值完全相同，**可以**把它移到 `common` 并从事件体删除（可选体积优化）。
- **要点**：接收方必须**同时支持提升与未提升两种写法**；还原时**事件体中的值优先于 `common`**；对象字段（如 `context`）按字段合并，标量字段由事件体覆盖；提升不得改变语义——还原后每条事件必须与未提升时完全一致。
- **自查**：按 `event-standard.md` 第 3 节还原 `batch-promoted.valid.json`：还原后的每条事件与未提升版本完全一致，事件体中的同名字段（如第 2 条的 `url`）优先。对应 M01-AC-07。

#### RR-07 429、503 返回 `Retry-After`；所有响应返回 `X-Server-Time` —— **应该**

- **SDK 侧的依赖**：退避与时钟校准（C04-F7）。客户端取 `Retry-After` 与本地退避时间中的较大值，上限 60 秒；两者缺失或格式非法时按"没有该响应头"处理，不得报错。
- **要点**：`Retry-After` 是**整数秒**；`X-Server-Time` 是接收方当前 UTC 毫秒时间戳；`X-Request-Id` 回显请求的 `X-Request-Id`，请求中没有时由接收方生成。
- **自查**：触发限流与 503，核对 `Retry-After` 与所有响应上的 `X-Server-Time`。

#### RR-08 支持 CORS：允许 SDK 所在页面的来源、`POST`、`Content-Type`、`Content-Encoding`、`X-App-Id`、`X-Write-Token`、`X-Request-Id`；暴露 `Retry-After`、`X-Server-Time` —— **必须**

- **SDK 侧的依赖**：跨域上报；`Access-Control-Expose-Headers` 缺了，浏览器侧就读不到 `Retry-After` / `X-Server-Time`。
- **要点**：处理 `OPTIONS` 预检；允许的方法至少有 `POST`；允许的请求头覆盖契约列出的 5 个（`Content-Type`、`Content-Encoding`、`X-App-Id`、`X-Write-Token`、`X-Request-Id`）；暴露 `Retry-After`、`X-Server-Time`（M01 还暴露 `X-Request-Id`）。
- **自查**：发预检 `OPTIONS`，核对 `Access-Control-Allow-Origin`、`Allow-Methods: POST`、`Allow-Headers` 与 `Access-Control-Expose-Headers`。对应 M01-AC-08。

### 安全（2 节）

#### RR-11 只接受 HTTPS（TLS 1.2 及以上） —— **必须**

- **自查**：对明文 HTTP 端点发起上报必须被拒绝（不监听或返回 403/301），并用 TLS 1.1 客户端连接确认握手失败。**M01 只监听 `127.0.0.1`，不适用于本项**，由接收方自查。

#### RR-12 令牌只写不读，按应用签发，可吊销；吊销后返回 401 —— **必须**

- **要点**：令牌与 `app_id` 绑定、按应用签发；**任何接口与响应体都不读回令牌**；吊销后该令牌的上报返回 `401 token_revoked`；令牌无效返回 `401 invalid_token`。
- **自查**：用合法占位令牌返回 202；错误令牌与吊销后的令牌返回 401；确认任何响应体或接口都不读回令牌。对应 M01-AC-02。

#### RR-13 访问日志与错误日志不记录令牌、信标请求体中的 `auth` 字段、完整 IP；`auth` 字段在持久化前删除；如需保存 IP，IPv4 去掉末段、IPv6 只保留前 48 位 —— **必须**

- **要点**：`auth` 在**持久化前**删除，不只是不入库；日志与入库文档都不含令牌；IP 截断规则：IPv4 去末段（`127.0.0.1` → `127.0.`），IPv6 只保留前 48 位（前 6 组）。这条同时覆盖"日志"与"存储"两条路径。
- **自查**：用 `batch-beacon.valid.json` 发送后检查访问日志、错误日志与入库记录：不出现 `auth.write_token`、不出现完整 IP；入库文档中不含 `auth`。对应 M01-AC-11。

#### RR-14 校验来源域名白名单，不匹配时返回 403 —— **应该**

- **自查**：用不在白名单的 `Origin` 发请求，期望 403（`error` 建议 `origin_not_allowed`）。**不在 M01 范围内**，接收方自查。

#### RR-15 对外接口限流，超限返回 429 而不是丢弃 —— **应该**

- **要点**：限流是方案成立的前提之一（D003/D004 第 4 条：每个 critical 会被补发一次，重复 ≈1 倍 critical 流量，必须计入容量与限流评估）。超限返回 `429` + `Retry-After`（整数秒），**不要静默丢弃**。
- **自查**：压到限流阈值以上，确认返回 429 且带 `Retry-After`。**不在 M01 范围内**，接收方自查。

### 数据（3 节）

#### RR-21 按 `event-standard.md` 校验公共字段；不合规的事件进入死信或单独计数，不静默丢弃 —— **应该**

- **要点**：校验不合规时"死信或单独计数"，关键是**可查**、**不静默丢**；未登记事件照常入库（由接收方决定处理方式，`event-standard.md` 第 2 节）。
- **自查**：用非法批次构造公共字段不合规的输入，确认事件进入死信或单独计数，且计数可查。

#### RR-22 可以使用 K01 导出的校验规则做运行期校验 —— **可以**

- **要点**：K01 的 `export-rules` 输出运行期校验规则 JSON（`schema_id = urn:web-report-sdk:k01:runtime-validation-rules:1`），默认每个事件保留最近 3 个 `schema_version`，保证未升级的客户端仍能入库（`dictionary-compat.md` 运行期校验）。建议：按 `event_name` + `schema_version` 查找定义，查不到时**标记未登记后入库而不是丢弃**；必填缺失、类型不符、枚举越界的事件单独存放或计数；定义中没有的字段丢弃该字段并计数。
- **注意**：规则文件格式**未进契约**（工具自带 Schema 并自校验），属"可以"级且尚无接收方消费（`docs/reports/wave1-lanes.md` 第 6 节）。接入前请与 SDK 侧确认版本。
- **自查**：用 `event-definition.schema.json` 校验事件定义；按 `event_name` + `schema_version` 查找，覆盖"查不到"的路径。

#### RR-23 保留 `sdk_health` 事件，供 SDK 一侧计数与入库计数对账 —— **必须**

- **要点**：`sdk_health` 是普通上报事件：走同一条批次通道、同一个 `app_id` + `event_id` 去重键（**RR-04、RR-05 同样适用**）；`event_type` 是 `sdk_internal`，`priority` 固定 `normal`（Q3 结论第 4 条）。接收方**与业务事件一样入库并计数**，不要特殊丢弃。它的字段与读数口径见第 2 节。
- **自查**：把 `sdk_health.valid.json` 包进批次上报，确认与业务事件一样入库并计数，可与 SDK 侧计数对账；对非法样例确认按字段约束拒绝或计数。对应 M01-AC-06。

## 2. `sdk_health` 的读数口径（CR-002 附录 A）

字段的**权威定义**是机器可读的 `docs/contracts/schemas/builtin-events/sdk_health.schema.json`（附录 A 明确不复制字段表，以免与 Schema 漂移）。可用 `docs/contracts/examples/builtin-events/sdk_health.valid.json` 做实现自测。

接收方建看板时最容易读错的六条（附录 A.3 原文口径）：

1. **计数类指标值为 0 时不上报。** 因此"某个 `drop_*` / `count_*` 键不出现"等价于"该窗口内为 0"，**不要当成缺数据或上报失败**。
2. **`offline_written` / `offline_replayed` 的单位是"批次数"，不是事件数**（事件数另有本地观测量，不进契约指标）。按批次数建看板。
3. **`exposure_window_ms` 必须与 `exposure_window_events` 同时出现**（Schema 的 `dependentRequired`，机器可校验）；`exposure_window_events` 为 0 时两者都不上报。
4. **`batches_sent` 与 `batches_failed` 不互补。** 前者只计常规通道成功提交的批次；后者含熔断（`circuit_open`，未尝试发送）与终态 4xx 拒绝；两者都**不含**离开通道与补发批次（补发计 `offline_replayed`）。**不要用 `sent + failed` 反推提交总数。**
5. **`queue_length_max` 是窗口内的队列长度峰值**，在非自监控事件的入队时刻采样。
6. 三个 `*_p99_ms`（`track_p99_ms` / `pipeline_p99_ms` / `serialize_p99_ms`）**只在 1% 会话上报**。

另两条同样容易出错的（附录 A.1/A.2/A.4）：

- **`dimensions`**：`sdk_version`（semver）、`state`（`initialized`｜`running`｜`paused`｜`destroyed`；"未初始化"态不上报）、`config_version`（**十进制字符串**；无生效配置时省略）。`dimensions` 是封闭集合（`additionalProperties: false`）。
- **分片**：一个窗口内非零指标超过 50 个时，SDK 会拆成多条 `sdk_health`（Schema 的 `maxProperties: 50`），每条带**相同的 `window_ms` 与 `dimensions`**、各自的 `event_id`。**接收方聚合时必须把"同 `window_ms` + 同 `dimensions`"的多条视为同一窗口**，否则会把一个窗口拆成多行、把计数当成多份。
- **调试模式不改变数据形态**：调试模式是纯本地输出（接入方控制台或 logger），**不产生额外的上报事件**（附录 A.6）。

流量占比（附录 A.5，T17 确定性计数，供容量估算）：1 条 `sdk_health`（12 个指标、约 480 B）对 1000 条业务事件（约 467,000 B）→ **计数比 0.100%、体积比 0.1028%**（均 ≤1%）。

对账恒等式（M01 侧的实现，可作参考）：`received_events - stored_events === duplicate_events`（M01-AC-06）。

## 3. 自查清单

### 3.1 "必须"条目（全部通过才使端到端目标成立）

- [ ] **RR-01** 实现端点、请求格式、三个上限与全部响应码；`batch.valid.json` → 202，`batch.invalid.json` 每个 case → 400（M01-AC-01/02/04）
- [ ] **RR-02** 只在持久化后返回 202；注入持久化失败时返回 5xx，恢复后重发入库数一致（M01-AC-05）
- [ ] **RR-03** 常规通道与信标通道都支持；常规通道忽略请求体里的 `auth`；令牌不进 URL（M01-AC-03）
- [ ] **RR-04** gzip 流式解压，1 MB 中止、压缩后 256 KB 上限、其他编码 400（M01-AC-04）
- [ ] **RR-05** 按 `app_id` + `event_id` 在 ≥7 天内去重；重复投递不重复入库（M01-AC-06）
- [ ] **RR-06** 支持 `common` 提升与未提升两种写法，事件体优先（M01-AC-07）
- [ ] **RR-08** CORS 覆盖来源、POST、5 个请求头（`Content-Type`、`Content-Encoding`、`X-App-Id`、`X-Write-Token`、`X-Request-Id`），暴露 `Retry-After`、`X-Server-Time`（M01-AC-08）
- [ ] **RR-11** 只接受 HTTPS（TLS 1.2+）；明文被拒；TLS 1.1 握手失败（**M01 不适用**，自查）
- [ ] **RR-12** 令牌只写不读、按应用签发、可吊销；吊销/无效返回 401（M01-AC-02）
- [ ] **RR-13** 日志与持久化都不含令牌、`auth`、完整 IP；`auth` 持久化前删除；IP 按规则截断（M01-AC-11）
- [ ] **RR-23** `sdk_health` 与业务事件一样入库计数，可用于对账（M01-AC-06）

### 3.2 "应该 / 可以"条目（不属于 100% 通过范围，建议逐条确认）

- [ ] **RR-07** 429/503 带整数 `Retry-After`；所有响应带 `X-Server-Time`（建议级）
- [ ] **RR-14** 来源域名白名单，不匹配返回 403（建议级，**M01 不适用**）
- [ ] **RR-15** 限流返回 429 + `Retry-After`，不静默丢弃；容量评估计入"重复 ≈1 倍 critical 流量"（建议级，**M01 不适用**）
- [ ] **RR-21** 不合规事件进死信或单独计数，不静默丢弃（建议级）
- [ ] **RR-22** 用 K01 导出的规则做运行期校验；未登记事件标记后入库而非丢弃（可选级；规则文件格式未进契约）

### 3.3 自查工具

```bash
# 用仓库的契约样例复现全部校验结论（11 条"必须"映射到样例与 Schema）
pnpm test:contract

# 样例清单（机器可读）：每条给出 samples[]（路径 + Schema + 期望结论）与 self_check 步骤
# tests/contract/sample-pack/manifest.json
```

样例包**只引用、不复制**契约样例（`docs/contracts/` 只读）；用任意 JSON Schema 2020-12 校验器按 `samples[].schema` 校验 `samples[].path`，`expect: "pass"` 必须通过，`expect: "each_case_must_fail"` 的每个 case 必须失败。`check_kind: "behavior"` 的条目（RR-02、RR-08、RR-11）没有可复用样例，按 `self_check` 做故障注入或协议行为验证。

## 4. 容量建议（不作为本项目验收标准）

契约给出的参考值（Q1）：首年日活设备 **50 万**，日均 **5,000 万条事件**，峰值 **2 万条/秒**，平均每批 15 条（约 **1,500 个请求/秒**），建议按 **3 倍余量**规划；SDK 单页面峰值约每秒 30 条事件。

**必须额外计入的一项**（D003 第 4 条、D004 第 4 条）：因离开时刻拿不到 202，**每个 critical 会被补发一次（重复 ≈ 1 倍 critical 流量）**——这是方案的确定性成本，必须写入容量估算与限流评估。

> **契约状态说明（2026-10-13 更新）**：`receiver-requirements.md` 第 4 节**已补入**"必须计入重复流量（≈ 1 倍 critical 流量）"，并新增 4.1 节容量估算示例——变更记录见 `docs/contracts/changes/CR-005-duplicate-critical-traffic-capacity.md`（标为 0.2 兼容追加、不升版本号）。该条的决策出处是 `docs/decisions/D003-critical-reliability-tiered-target.md` 第 4 条。
>
> 本指南此前只能标注"已批准决策要求但契约正文尚未更新"，现以契约为准：**RR-05（去重）与 RR-15（限流）是方案成立的前提**，不是可选配合项；容量按"业务 + critical + 重复"合计的 3 倍规划，且**不得把重复量与真实事件量合并成一个数**。

## 5. 本项目不做的验证（如实声明）

- 本项目**不验证接收方的实现**（`receiver-requirements.md` 开头）。本文的清单是自查指引，不是本项目出具的合格证明。
- M01 虽覆盖全部"必须"条目的行为，但它是**内存 mock**：无 TLS、只监听回环、令牌是固定占位值、无真实鉴权与限流、不实现 7 天去重窗口与持久化，**不得用于生产**，也不得作为生产接收方的参考实现对外提供（指南第 11 节）。
- 接收方看板的同步（CR-001 的 `prewrite_commit_lost` 与 `exposure_window_*` 指标、CR-003 的 `config_schema_invalid`）**不在本项目内**，属遗留交接项（看板 2026-10-13 与 `docs/reports/wave3-lanes.md` 的遗留义务）。
- 端到端可靠性对账（T32）与试点迁移对账（T33）**均未就绪**；`critical ≤0.1%` 只在**有优雅退出路径**的场景下成立（D003 第 1 条），硬杀场景按 D004 的暴露窗口口径分列计量。
