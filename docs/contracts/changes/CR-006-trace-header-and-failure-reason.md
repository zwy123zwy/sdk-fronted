# CR-006 定义链路追踪头的名字与注入范围；定义 `web_http.failure_reason` 的取值集

- 状态：**已批准（2026-10-13）**，已应用到 `docs/contracts/remote-config.md` 第 5.4 节与 `docs/contracts/event-standard.md` 第 6 节
- 起草人：A01（编排方代行）；起草日期：2026-10-13
- 来源：T18（C05）在计划第二轮读原文时发现的两处缺口——**AC-12 要求注入「链路追踪头」，但契约里没有这个头的名字；AC-10 要求「失败原因正确」，但 `failure_reason` 没有任何取值定义**
- 流程依据：`docs/contracts/README.md`「契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准」

## 1. 问题

### 1.1 链路追踪头没有名字（阻塞 AC-12）

`tests/acceptance/C05.md` 的 C05-AC-12：「配置追踪白名单只含同源，分别请求同源与第三方 → **只有同源请求被注入链路追踪头**」。

但对 `docs/contracts/**`（不含 `changes/`）检索 `trace`/`traceparent`/`tracestate`/`追踪头`/`链路追踪` → **0 命中**；`ingest-protocol.md` 第 2 节只定义了 SDK **自己上报请求**的 `X-App-Id`/`X-Write-Token`/`X-Request-Id`/`X-Server-Time`，与本条无关（本条注入的对象是**接入方自己的出站请求**）。

**不定义头名就无法实现这条 AC；而由实现方自创私有头名会破坏 AC-12 的目的**——它存在的意义是与第三方 APM 对接（`docs/decisions/Q7-apm-coexistence.md`），私有头名需要双方另行约定，正好抵消这个价值。

### 1.2 `failure_reason` 没有取值定义（使 AC-10 无法客观验证）

C05-AC-10：「发出成功、404、超时三个请求（fetch 与 XHR 各一组）→ 上报 `web_http`，状态码与失败原因正确」。

而 `docs/contracts/event-standard.md` 第 6 节只列了 `failure_reason` 这个维度名，**没有取值**；`schemas/builtin-events/web_http.schema.json` 里它是**无枚举的自由字符串**；`tests/acceptance/C05.md` 除标题外只有一张表、未列任何取值。**「正确」因此无法被客观判定。**

## 2. 精确改动

### 2.1 `event-standard.md` 第 6 节：定义 `failure_reason` 的取值集

在 6 节的澄清段之后补一段，明确：

- `failure_reason` **只表达传输层失败**，可取值为：`network_error`（网络错误 / 请求未能完成）、`timeout`（超时）、`aborted`（被调用方中止）、`cors`（跨域被拒）；
- **HTTP 4xx/5xx 不由 `failure_reason` 表达**，由 `metrics.status` 表达——这样 AC-10 的「404」与「超时」两类就有了各自的落点（404 → `status=404`、无 `failure_reason`；超时 → `failure_reason='timeout'`），而「成功」两者皆无；
- **成功请求不上报 `failure_reason`**（该维度缺省省略，不是空字符串）。

**不改 Schema、不给该字段加枚举**：给一个已存在的自由字符串字段加枚举属于**收紧**，会让已按契约实现的接收方拒绝原本合法的载荷，不是兼容变更。取值集通过契约正文约束。

### 2.2 `remote-config.md` 第 5.4 节：定义追踪头的名字与注入范围

在 5.4 节补一段，明确：

- 追踪头的名字采用 **W3C Trace Context 标准：`traceparent`（必需）与 `tracestate`（可选）**，不引入私有头名；
- **注入范围**：只对**同源**请求，或**命中配置的追踪白名单**的请求注入；白名单之外一律不注入（对应 C05-AC-12 的"只有同源请求被注入"）；
- 内置敏感请求头清单（本节上文）与追踪头的关系：追踪头**不在**敏感头清单里（它需要被发送出去），而它的**值**仍受脱敏规则约束；
- 远程配置**只能收紧**注入范围（例如把白名单改窄），**不能放宽到"注入所有请求"**——与本节"远程只能追加、不能删除或关闭内置项"的方向一致（安全默认）。

**遗留一个设计点（不在本次契约变更范围）**：`traceparent` 的**值从哪来**（由接入方注入既有 trace context、还是 SDK 自行生成）属实现设计，需 T18 在实施计划里定并写进接入指南——本次只定**头名与注入范围**，不替实现决定值的来源。

## 3. 兼容性

**兼容追加，不升版本号**（契约版本仍为 0.2）。理由：

- 2.1 **只约束一个新维度的取值**，且**明确不加 Schema 枚举**，不改任何字段的存在性、类型或必填性；
- 2.2 **只定义新头的名字与注入范围**，不改任何已有报文的格式与字段；对不采集 HTTP 或不使用追踪的接入方零影响。

## 4. 影响面

| 对象 | 影响 |
|---|---|
| `docs/contracts/event-standard.md` 第 6 节 | 新增 `failure_reason` 取值集与"HTTP 状态码不走该维度"的口径（本次已应用） |
| `docs/contracts/remote-config.md` 第 5.4 节 | 新增追踪头名（W3C）与注入范围（同源/白名单、只紧不松）（本次已应用） |
| `packages/plugins`（T18） | 实现 C05-F4 时按此口径；追踪头的**值来源**需在其实施计划里定 |
| 接收方 | 可按契约正文校验 `failure_reason`；**Schema 不加枚举**，故不会因此拒绝既有载荷 |
| T29（E2E） | 真实浏览器下验证"同源注入、第三方不注入"归 T29 |

## 5. 未做的事

- **未改任何 Schema**（尤其没有给 `failure_reason` 加枚举——那是收紧，不是兼容变更）；
- **未定义 `traceparent` 值的来源**（属 T18 的实现设计，本次刻意不替它决定）；
- **未修改 `ingest-protocol.md`**：它第 2 节定义的是 SDK 自己上报请求的头，与本条注入对象（接入方自己的出站请求）无关，混入会制造歧义。
