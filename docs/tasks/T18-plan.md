# T18（C05 错误、性能、路由、HTTP 插件）实施计划

- 状态：**第二轮已定稿**（2026-10-13）。§1、§2、§4、§7 的待定项已按读到的 Schema/契约原文填实；§8 的 16 条 AC 映射完成，字段级待定基本消除。**仍需负责人裁定的事项集中在 §13 的六个冲突与 `docs/use-cases.md` 的 7 条问题**（其中请求体开关、面包屑归属、装配根归属、AC-08/09 自动路由、AC-12 追踪头名、AC-13 构建检查方式为硬阻塞）。
- 执行：A03；对接：前端负责人（隐私与同意相关另需安全负责人）
- 依赖：T11（内核）、T14（C04 上下文/脱敏/同意）——**均已合入 main**
- 所有权：`packages/plugins/src/{error,perf,route,http}`、框架集成包（如需要）、`docs/use-cases.md`、对应测试目录
- 验收用例：**C05-AC-01…AC-14、AC-19、AC-20（共 16 条）属本任务**；**AC-15…AC-18 属 T19**——依据 `tests/acceptance/C05.md` **第 3 行**原文：「对应任务：T18（AC-01 至 AC-14、AC-19、AC-20）、T19（AC-15 至 AC-18）」。
  - ⚠️ **任务卡需回退**：卡片此前被改成「C05-AC-01 至 C05-AC-20（共 20 条）」并注明「原文漏列 AC-15..18」，**那是错的**——原卡所列 01-14、19、20 与验收文件完全一致；AC-15..18 是 T19 的双写适配器用例（C05-F5）。
- 本计划在第二轮补读了五个内置事件 Schema、`event-standard.md`（第 6 节）、`reason-codes.md`、`ingest-protocol.md`（2.2）与各包 `exports`；**凡仍标「待定」的，都是需要负责人裁定或需读 Q7/remote-config 才能定的**（见 §13 与 `docs/use-cases.md`）。

## 1. C05-F1 JS 错误归一化

**已定**
- 采集源三类：`window.onerror`（含资源加载错误）、`unhandledrejection`、以及框架集成包（如需要）的显式上报。
- 归一化为 `web_js_error`，**必须含契约要求的 `source`、`fingerprint`、`metrics.count`**（缺任一项即契约违规——这是 T12 交付时踩过的同类坑）。
- **去重与计数**：以 `fingerprint`（消息 + 源 + 行列 + 错误类型的稳定哈希）为键，同一指纹在一次会话内只上报**首条**并累计 `metrics.count`；需要"重复也要看到"时由配置决定（默认只上报首条 + 计数）。
- 与 C04 的衔接：错误消息/堆栈进入 C04 的脱敏与字段约束**之前**不落地、不缓存；脱敏在 C04 完成，本任务不重复实现。

**已定（第二轮补读 Schema 后定稿）**
- **字段路径（照抄 `web_js_error.schema.json`）**：`dimensions` 必填 `error_type`、`message`、`source`、`fingerprint`；`metrics` 必填 `count`（`integer, minimum: 1`），可选 `line`、`column`；错误栈走 **`attachment`**（顶层字符串，非 dimensions）。
- **`source` 的取值来自验收用例原文**（Schema 未加枚举，是自由字符串——即契约不约束取值，但 AC 明确要求这两个值，实现必须照用）：
  - C05-AC-01 → `source` = **`window_error`**；
  - C05-AC-02 → `source` = **`unhandled_rejection`**。
- **`fingerprint` 的构成**：契约只要求它是 `dimensions` 里的**字符串**、且 AC-03 要求"按 `fingerprint` 去重"。因此构成本身是实现自由，但**必须满足两条可验证性质**：① 同一错误稳定同值（AC-03 去重的前提）；② 不随易变部分漂移。本任务取 `error_type + source + 归一化后的 message + line/column` 的稳定哈希，归一化包含"剥离数字与 URL 查询参数"。**在 README 写明该构成**（否则接入方无法预测去重行为）。
- **资源加载错误**：`error_type` 是自由字符串，**Schema 不排除**资源错误；本任务**算作 `web_js_error`**，用 `error_type` 区分（如 `resource_error`）。⚠️ **AC-01 只覆盖未捕获异常**，故本项属"计划内的合理扩展"，**请在用例确认时一并拍板**（不确认则默认只做 AC 覆盖的两类）。

## 2. C05-F2 性能条目与长任务

**已定**
- `PerformanceObserver` 采集条目并归一化；不自己实现计时。
- **自身不得产生 50 ms 以上长任务**：所有采集回调做最小工作，归一化与序列化延后到批次组装阶段（C06）。
- 与 C08 的分工：C08 负责"SDK 自己的耗时"（自监控），本任务只负责"宿主页面的性能条目"；两者不得互相计数。

**已定（第二轮补读 Schema 后定稿）**
- **五类核心指标共用一条事件 `web_vitals`**，不是各自独立字段：`dimensions.metric_name` 的枚举是 **`FCP` / `LCP` / `CLS` / `INP` / `TTFB`**（与 AC-05 的五类完全对应），`dimensions.rating` 是必填枚举 **`good` / `needs-improvement` / `poor`**，值本身走 `metrics.value`（必填）与 `metrics.delta`（必填）。
  → 因此 `entryType → metric_name` 的映射为：`paint`(first-contentful-paint) → `FCP`；`largest-contentful-paint` → `LCP`；`layout-shift` → `CLS`；`event`(interaction) → `INP`；`navigation`(responseStart) → `TTFB`。
- **长任务单列一条 `web_long_task`**：`metrics.duration_ms`（必填，integer）、`metrics.start_time_ms`（可选）；注意该 Schema 的 `dimensions` 是**空对象 schema**（`{}`，无 properties）→ **不要把任何东西塞进 `dimensions`**。
- **明确不采集**：`resource`、`navigation` 的明细条目等**没有 Schema 承载**的类型一律不采集（原本的"待定"是因为没读 Schema；现在结论是"契约没有承载它们的字段，所以不做"，而不是"以后再说"）。
- **`rating` 的算法**：契约只要求它是那三个枚举值之一，**不给阈值**。本任务按 Web Vitals 官方阈值判定并在 README 写明；真实浏览器差异归 T29。
- 长任务的观测方式（`longtask` 支持度有真实浏览器差异）→ **归 T29 复测**。

## 3. C05-F3 路由与页面浏览

**已定**
- 与 T14 已交付的 `packages/core/src/context/page.ts` 配合：本任务只负责**在路由变化时通知**，页面归属的计算与 `page_id`/`view_id` 的生命周期归 C04。
- **不主动打补丁 `history`/`popstate`**：由接入方在路由变化后调用 `setPage`/`configureView`（理由：打补丁会与宿主框架的路由实现冲突，且难以回退）。这一点请负责人在用例确认时一并拍板（见 `docs/use-cases.md` 问题 4）。

**待定：我打算这样定**
- 是否提供可选的"自动路由插件"（打补丁 + 可卸载）：**倾向不提供**，除非负责人要求；若要求，必须给出卸载/恢复原生方法的保证。

## 4. C05-F4 HTTP 采集（含注入契约与隐私硬约束）

**已定**
- **`captureNativeHttpRefs()` 由装配方在任何插件安装之前调用一次**（幂等、捕获后冻结）。**采集插件不得在自己的 `install()` 里捕获**（那会依赖安装顺序，太脆）。
- 插件只接收**已注入**的原生引用，包装后暴露恢复方法；宿主可随时卸载。
- **请求体默认不采集**（硬约束）：不注册任何读取 `body`/`FormData`/`Blob` 的逻辑；若将来要支持，必须走负责人批准 + 脱敏方案 + 用例，**本任务不做**。
- **追踪头只注入同源或白名单域**：不在白名单内一律不注入（不做"尽力而为"的降级注入）。
- 采集内容限定为元信息：方法、URL（经 C04 的 URL 白名单与脱敏处理）、状态码、耗时、以及是否失败。

**已定 / 待裁**
- 与 T19 双写适配器的包装归属：**采集插件负责包装并暴露注入点，适配器只消费事件、不重复包装**（避免双重包装导致宿主原生方法泄漏或双重上报）。**待负责人确认**（见 `docs/usecases.md` 问题 5 → 实为 `docs/use-cases.md`）。
- **`web_http` 的字段路径（照抄 `web_http.schema.json`）**：`dimensions` 必填 `method`、`url_template`，可选 `status_class`（枚举 **`1xx`/`2xx`/`3xx`/`4xx`/`5xx`**）、`failure_reason`（**自由字符串，Schema 无枚举**）；`metrics` 必填 `duration_ms`，可选 `status`（`integer, minimum: 100`）、`request_bytes`、`response_bytes`。
  → 注意：**URL 进的是 `dimensions.url_template`（模板，不是实参 URL）**，与 C04 的 `url` 顶层字段是两回事；令牌只可能出现在查询参数里，已由 C04 的白名单删除（AC-11 的注入点之一）。
- ⚠️ **【新发现的契约缺口】AC-12 要求注入"链路追踪头"，但契约里没有定义这个头的名字。**
  对 `docs/contracts/**`（不含 `changes/`）全库检索 `trace` / `traceparent` / `tracestate` / `追踪头` / `链路追踪` → **0 命中**；`ingest-protocol.md` 只定义了 `X-App-Id`、`X-Write-Token`、`X-Request-Id`（请求）与 `X-Server-Time`（响应）。
  → **AC-12 无法在不猜头名的前提下实现**。出路有三（**我不自行决定，请负责人择一**）：① 新增契约条款定义头名（走 CR，建议用 W3C 的 `traceparent`）；② 由远程配置提供"要注入的头名 + 白名单域名"（配置驱动，不动契约措辞，但需确认 `remote-config.schema.json` 是否有承载字段）；③ 明确 AC-12 的验证方式是"注入任一头名为实现自由"，并把头名写进 README（最省事，但接入方无从预测，会削弱该 AC 的意义）。
  **另需核**：`docs/decisions/Q7-apm-coexistence.md` 是否提到该头（本次只检索了 `docs/contracts/**`，未检索决策记录）。
- ⚠️ **【新发现】AC-10 的"失败原因正确"缺取值定义**：`dimensions.failure_reason` 在 Schema 里是**无枚举的自由字符串**，而 `tests/acceptance/C05.md` 只有一行表格、**没有列出任何取值**（该文件除标题外只有表格）。
  → 建议实现取一组可枚举值并在 README 写明（例如 `timeout` / `network_error` / `abort` / `http_error`），**但这等于由实现定义契约语义**，请负责人在用例确认时拍板；否则 AC-10 的"正确"无法被客观验证。

## 5. C05-F6 四入口、按需引入与体积预算

**已定**
- 四个独立入口（error / perf / route / http），各自可单独引入；`packages/plugins` 的全量入口另行聚合。
- 由配置启停：`plugins.*.enabled`（远程 `plugins` 段）；**运行期只能关，不能开**（与 C03 的运行时覆盖规则一致）。
- 体积：`plugins` 全量 **gzip 后不超过 20 KB**（门禁已有一条 20 KB 的 size-limit 条目，当前实测 642 B）；覆盖率 **行 ≥80%**。

**已定（第二轮读了各包 `exports` 后）**
- **仓库现有约定是「单入口」**：`core`/`transport`/`plugins` 三个包的 `exports` 都只有 `"."`（`{source, types, import}` 三键），只有 `browser` 额外多一个 `"./iife"`。
- **但 AC-13 要求「只引入错误插件构建 → 产物中不包含其他插件代码」，这必须按插件分别构建**，单入口做不到。两者冲突。
- **结论**：`packages/plugins` 需要新增**子路径导出**（形如 `"./error"`、`"./perf"`、`"./route"`、`"./http"`，沿用 `{source, types, import}` 三键）+ 相应的 per-entry 构建配置。这是该包**首次**引入子路径导出，且改动 `package.json` 的 `exports` 与构建配置。
- ⚠️ **需批准**：属公共导出面变更（api-extractor 的 `api:check` 会受影响，需跑 `pnpm api:update`）+ 构建配置变更。**已列入 §11 越界申请**（见 #5）。

## 6. Q7 与第三方 APM 共存

**已定**
- 与第三方 APM 的关系是"单向、可卸载、不抢占"：包装后保留原方法并转发，卸载时恢复。
- T19 的双写适配器已在本包内，**本任务不重新实现它**，只做接线与共存验证。

**待定：我打算这样定**
- 若宿主已包装过同一方法（第三方 APM 先包装），我们的包装应叠加在**最外层**还是**最内层**：需按 Q7 的正文定稿；倾向叠加在最外层并保证卸载后不影响内层。

## 7. 契约自证

**已定**
- 用**真实** `docs/contracts/schemas/builtin-events/*.json` + Ajv（2020-12）校验本任务产出的四类事件，含**正向与负向对照**、以及**非空转对照**（断言"校验器确实在校验"——本会话已有两次"自证空转"的教训）。
- 不复制 Schema 到测试目录（避免副本漂移）。

**已定（第二轮补读 Schema 后逐条列出）**
负向样本按 Schema 的 `required` 与枚举构造，每条对应一个"实现若写错就会被拒"的违约点：
1. `web_js_error`：缺 `dimensions.source`（required）→ 应被 Ajv 拒；
2. `web_js_error`：缺 `dimensions.fingerprint`（required）→ 拒；
3. `web_js_error`：`metrics.count` = 0（`minimum: 1`）→ 拒；
4. `web_js_error`：`metrics.count` 写成 `1.5`（非 integer）→ 拒；
5. `web_vitals`：`dimensions.metric_name` 写成 `'FID'`（不在 `FCP/LCP/CLS/INP/TTFB` 枚举内）→ 拒；
6. `web_vitals`：缺 `dimensions.rating` 或写成 `'ok'`（不在 `good/needs-improvement/poor` 内）→ 拒；
7. `web_vitals`：缺 `metrics.delta`（required）→ 拒；
8. `web_long_task`：缺 `metrics.duration_ms`（required）→ 拒；
9. `web_long_task`：往 `dimensions` 里塞字段（该 Schema 的 `dimensions` 是空对象 schema）→ 拒；
10. `web_http`：`dimensions.status_class` 写成 `'200'`（应为 `'2xx'`）→ 拒；
11. `web_http`：`metrics.status` = 99（`minimum: 100`）→ 拒；
12. `web_http`：缺 `dimensions.url_template`（required）→ 拒。
- **非空转对照**：另加一条"故意构造的合法样本必须被接受"，以防"校验器根本没在跑"（本会话已出现两次"自证空转"：正则抽到 0 个名字却报通过、`console.` 转义错误的 grep）。
- **不复制 Schema 到测试目录**：直接 import `docs/contracts/schemas/builtin-events/*.json`（T10/T13/T14 的既有做法），避免副本漂移。

## 8. 测试先行（16 条 AC 映射；AC-15..18 属 T19）

**已定**
- 映射表逐条列：AC 编号 → 测试文件 → 用例名 → **预写的断言形态**。
- **fail-first 必须是断言级失败**（不是 `Failed to resolve import`）；失败摘要原文留证。
- 必须先落接口桩再写用例，避免"文件不存在"型的假失败。

**已读原文**：`tests/acceptance/C05.md`（全文 20 条；其中 **16 条属本任务**，AC-15..18 属 T19）。下表按 **C05.md 原文**填写；事件名、`source` 取值、字段名一律照抄原文，**凡原文未给出确切字段路径的，在「待定」列写明缺什么**（本轮未读 Schema，不猜字段路径）。

| AC | 原文要求（照抄要点） | 测试文件（拟） | 用例名（拟） | 预写断言形态（语义） | 待定 |
|---|---|---|---|---|---|
| C05-AC-01 | 未捕获异常 → `web_js_error`，`source` 为 `window_error`，附脱敏后错误栈 | `packages/plugins/src/error/capture.test.ts` | `AC-01 未捕获异常上报 web_js_error 且 source=window_error` | 事件名为 `web_js_error`；`source === 'window_error'`；注入伪造敏感值的 message/stack 在产出中**不再出现** | 事件字段路径（`fields`/`dimensions`？）以 `web_js_error.schema.json` 为准 |
| C05-AC-02 | 未处理拒绝（Error 对象 / 字符串两种拒绝值）都上报，`source` 为 `unhandled_rejection` | 同上 | `AC-02 unhandled_rejection 两种拒绝值都上报` | 两条用例各断言 `source === 'unhandled_rejection'`；字符串拒绝值也被归一化 | 字符串拒绝值的归一化字段 |
| C05-AC-03 | 同一错误 1 秒 100 次 → 按 `fingerprint` 去重、上报次数受控、`count` 记总次数、计 `filtered_by_plugin` | 同上 | `AC-03 同指纹去重且 count 记总次数` | 上报条数 ≪ 100（预期 1）；`count`（或 `metrics.count`）`=== 100`；原因码计数含 `filtered_by_plugin` | **已核（第二轮）**：`count` 在 `metrics.count`（`integer, minimum: 1`）；`filtered_by_plugin` **已登记**（`reason-codes.md` 第 27 行，归属 C02/C05，对应 C05-AC-03） |
| C05-AC-04 | 错误前 25 次点击与路由跳转 → 附**最近 20 条面包屑**；**面包屑中没有输入框内容** | 同上 | `AC-04 面包屑取最近 20 条且不含输入框内容` | 面包屑条数 `=== 20`（25 次操作后）；输入框的伪造值 `input.value` 在产出中**不再出现** | 面包屑字段名与承载方式；**公共 API 是否有配置入口**（见第 13 节冲突 ③） |
| C05-AC-05 | 正常加载 → 上报 FCP、LCP、TTFB；交互后 INP；隐藏时 CLS | `packages/plugins/src/perf/vitals.test.ts` | `AC-05 五类核心指标各自上报` | 五类指标名各出现一次；值来自注入的 `PerformanceObserver` 条目（不得自行计时） | **已核（第二轮）**：事件名 `web_vitals`；`dimensions.metric_name` 枚举 `FCP/LCP/CLS/INP/TTFB`、`dimensions.rating` 必填枚举 `good/needs-improvement/poor`；值在 `metrics.value`/`metrics.delta`（均必填） |
| C05-AC-06 | 制造 120 ms 长任务 → `web_long_task`，`duration_ms` 约 120 | `packages/plugins/src/perf/long-task.test.ts` | `AC-06 长任务上报 duration_ms` | 事件名 `web_long_task`；`duration_ms` 落在容差内（如 100–140） | **已部分定（第二轮）**：字段为 `metrics.duration_ms`（必填）；容差建议 **90–150 ms**（AC 原文只说「约为 120」）；`entryType` 清单见第 2 节定稿 |
| C05-AC-07 | 浏览器不支持某性能条目类型 → 不抛错、跳过该指标 | `packages/plugins/src/perf/degrade.test.ts` | `AC-07 不支持的条目类型被跳过且不抛错` | 注入会抛错的 `observe` 后：不抛错、该指标不上报、其余指标照常 | 覆盖哪些"不支持"形态（`observe` 抛错 / 回调不收 / 无 API） |
| C05-AC-08 | **History 模式**下 `pushState`、`replaceState`、后退 → **每次路由变化上报 `web_pageview`**，`page_id` 为**路由模板** | `packages/plugins/src/route/history.test.ts` | `AC-08 History 三种变化各上报一次且 page_id 为模板` | 三种操作各产出 1 条 `web_pageview`；`page_id === '/task/:id'`（模板而非实参） | **与第 3 节既有结论冲突，见第 13 节冲突 ①**；`page_id` 模板来源（`routePatterns`？） |
| C05-AC-09 | Hash 模式；另测手动模式 → Hash 变化上报；手动模式**只在业务调用时**上报 | `packages/plugins/src/route/hash.test.ts`、`.../manual.test.ts` | `AC-09 Hash 变化上报 + 手动模式不自动上报` | hash 变化产出 1 条；手动模式下不监听路由事件，仅 `setPage` 调用产出 | Hash 模式的 `page_id` 取值口径 |
| C05-AC-10 | 成功 / 404 / 超时三请求（fetch 与 XHR 各一组）→ `web_http`，状态码与失败原因正确；**SDK 自己的上报请求不被采集** | `packages/plugins/src/http/capture.test.ts` | `AC-10 六种组合的状态码与失败原因 + 不采集自身请求` | 六条事件；404 → 状态码 404；超时 → 对应失败原因；**上报请求自身的 URL 不出现在任何 `web_http` 事件里** | 失败原因枚举值（以 `web_http.schema.json` 为准）；"自身请求"的识别方式（标记注入？） |
| C05-AC-11 | 请求带 `Authorization` 头与含令牌的查询参数 → 上报中**不出现**这两项 | `packages/plugins/src/http/privacy.test.ts` | `AC-11 不采集 Authorization 头与查询参数中的令牌` | 伪造令牌值在产出中**不出现**（两个注入点各一条） | `Authorization`（采集侧不取）与追踪头（注入侧）的区别 |
| C05-AC-12 | 白名单只含同源 → 只有同源请求被注入链路追踪头 | `packages/plugins/src/http/trace-header.test.ts` | `AC-12 仅同源请求注入追踪头` | 同源请求的头存在；第三方请求的头**不存在**（不是空值，是未注入） | 追踪头名（以 `ingest-protocol.md` 为准） |
| C05-AC-13 | 只引入错误插件构建 → **产物中不包含其他插件代码** | 构建产物检查（**非单元测试**） | `AC-13 仅错误插件的构建产物不含其他插件` | 产物中不出现 perf/route/http 的可识别符号 | **验证方式待定，见第 13 节冲突 ②** |
| C05-AC-14 | 远程配置关闭性能插件 → **观察器断开**，之后不再上报性能事件 | `packages/plugins/src/perf/kill-switch.test.ts` | `AC-14 关闭后 observer 断开且不再上报` | 关闭后 `observer.disconnect` 被调用；再注入条目**不产出**事件 | 与 C03 运行时覆盖（只能关不能开）的一致性 |
| C05-AC-19 | 第三方 APM 先/后初始化，两边都 hook `fetch` 与 `onerror` → 两边都采到数据；**本 SDK 销毁后第三方 hook 仍生效** | `packages/plugins/src/coexist/order.test.ts` | `AC-19 两种初始化顺序都共存 + 销毁后第三方仍生效` | 两种顺序各一组：两边各收到事件；`destroy()` 后第三方 hook 仍被调用且收到数据 | 需要最小化的第三方 APM 桩（本任务自造、仅测试用） |
| C05-AC-20 | 共存模式默认配置 → **错误、性能、HTTP 插件默认关闭**；可由远程配置逐个开启 | `packages/plugins/src/coexist/defaults.test.ts` | `AC-20 共存模式下三类插件默认关闭且可远程开启` | 共存模式默认：三类插件均不产出事件；远程配置置启用后各自产出 | **与"运行期只能关不能开"存在张力，见第 13 节冲突 ④** |

**映射完成度**：16/16 逐条映射完成。**第二轮补读 Schema 后，字段级待定基本消除**——AC-03（`metrics.count` + `filtered_by_plugin` 已登记）、AC-05（`web_vitals` + `metric_name`/`rating` 枚举）、AC-06/07（`duration_ms` + 容差）、AC-10（`method`/`url_template`/`status_class` 枚举/`metrics.status`）、AC-11（令牌两个注入点）均已按原文定稿，负向样本见第 7 节。
**仍需负责人裁定的三项**：AC-08/09（自动路由与「不打补丁」冲突，见冲突 ①）、AC-12（**契约未定义追踪头名**，见第 4 节与冲突 ⑤）、AC-13（构建产物检查方式，见冲突 ②）。
**AC-15…AC-18 不在本表**——属 T19（见文件头）。

## 9. 判别力验证（变异验证）

**已定**：至少对以下四处做变异验证，格式为「改了哪一行 / 哪条用例红了 / 恢复后是否全绿」：
1. **错误去重**：临时关掉按 `fingerprint` 去重 → 去重与计数用例必须红；
2. **请求体不被采集**：临时加一行读取请求体 → 隐私用例必须红；
3. **追踪头白名单外不注入**：临时去掉白名单判断 → 用例必须红；
4. **面包屑不含输入框内容**：临时让面包屑记录 `input.value` → 用例必须红。

理由：本会话已证明"看起来测了、其实不设防"是真实风险（T14 的第一版 AC-09 哨兵在变异下**一条都没红**）。

## 10. 非功能怎么测

**已定**
- 任务卡的「采集回调单次不超过 0.1 ms」是**契约目标值**，**不作为单元门禁阈值**：单元门禁只保留**有文档化余量的中位数护栏**，并在注释与断言消息里写明实测值与余量；P99/吞吐的权威验证归 **T20**。
- **不得用"总耗时"当统计量**——vitest 并行跑测试文件时总耗时会因 GC/调度抖动整段失真（本会话已因此连红两次）。只用中位数/最小值这类对离群值稳健的统计量。
- 长任务：用确定性手段验证"采集回调不做重活"（例如断言回调内不触发序列化），真实长任务观测归 T29。
- 覆盖率 ≥80%（沿用门禁阈值）。

## 11. 越界申请

| # | 需要改的东西 | 理由 | 最小 diff |
|---|---|---|---|
| 1 | `packages/plugins/package.json`：加 `"@web-report-sdk/core": "workspace:*"` | 承自 T19 的挂账义务：C05-AC-15..17 目前只靠编译期结构赋值守护，需要真实内核驱动 | 一行依赖 |
| 2 | 根 `package.json`：注册 `measure:apm-adapter` 脚本 | 承自 T19 的挂账义务 | 一行脚本 |
| 3 | **（需确认）** `packages/browser/**` 的装配接线 | 装配根**归属空缺**（无任何任务卡认领）；若 T18 不含装配，则多数用例无法端到端验证 | 待负责人指定归属后再评估 |
| 4 | **（待确认）** `tests/acceptance/C05.md` 的 AC-15..18 归属 | 任务卡与验收文件不一致 | 不涉及文件改动，只需确认范围 |

| 5 | `packages/plugins/package.json` 的 `exports` 新增子路径（`./error` `./perf` `./route` `./http`）+ per-entry 构建配置 | **AC-13 要求按插件分别构建**，而仓库现有约定是单入口（见 §5） | 四个 `exports` 条目 + 构建入口配置；改后需 `pnpm api:update` |

**未申请的越界**（本轮明确不做）：kernel、transport/投递代码、`docs/contracts/**`、门禁配置、`packages/core/**`。

## 12. 风险与对策

| 风险 | 后果 | 对策 |
|---|---|---|
| **重复包装原生方法**（与第三方 APM、或与 T19 适配器重复） | 宿主方法泄漏、事件双重上报、无法卸载 | 单一包装方（采集插件）+ 显式注入点；提供恢复方法；共存用例（Q7）覆盖 |
| `PerformanceObserver`/监听器泄漏 | 内存增长、页面变慢 | 每个插件提供 `uninstall`，并在测试中验证卸载后监听器数归零 |
| **隐私泄漏**（请求体、追踪头、面包屑） | 合规事故 | 三条硬约束 + 四条变异验证（第 9 节）；任何削弱先升级 |
| 体积超 20 KB | 门禁红、接入方负担 | 按需引入 + 子路径导出；提交前实测 `pnpm exec size-limit` |
| 采集回调变成长任务 | 拖慢宿主业务 | 回调只做最小工作；序列化延后到批次组装；确定性验证（第 10 节） |
| **装配根缺失导致无法端到端验证** | "交付了但发不出数据" | 在计划与报告中显式标注；请负责人指定装配归属（第 11 节 #3） |
| 测试后补（先实现后写测试） | fail-first 证据失真、哨兵形同虚设 | 先落接口桩 → 写用例跑出**断言级**失败 → 再实现；关键行为做变异验证（第 9 节） |
| 未读文件导致的口径偏差 | 实现与契约不符 | 本计划中所有标「待定」的条款，下一轮**先读对应文件再定稿**，不凭印象实现 |

## 13. 读原文后发现的冲突与契约疑问（**优先级高于填完整计划**）

以下**六条**都是**读 `tests/acceptance/C05.md` 原文与相关 Schema/契约后发现、与计划既有结论或既有契约/配置不一致**的地方。它们不是"待定项"，而是**必须先解决否则会做错**的问题。

### ① 【最严重】AC-08/AC-09 要求自动路由检测，与第 3 节「不主动打补丁 history」直接冲突

- **第 3 节现有结论**：不主动打补丁 `history`/`popstate`，由接入方在路由变化后调用 `setPage`/`configureView`。
- **但 AC-08 原文**要求：「History 模式下 `pushState`、`replaceState`、后退 → **每次路由变化上报 `web_pageview`**，`page_id` 为路由模板」；**AC-09** 还要求「Hash 变化上报」。
- **冲突实质**：若 SDK 不打补丁、完全依赖业务调用，则 **AC-08/AC-09 描述的"三种 History 变化各自自动上报"无法成立**（业务不调用就没有事件）。
- **三条出路**（需负责人择一，我**不自行决定**）：
  1. **提供可选的自动路由插件**（打补丁 `pushState`/`replaceState` + 监听 `popstate`/`hashchange`），可卸载、可恢复原生方法——能满足 AC-08/09，代价是第 3 节与第 12 节的两条判断（"避免破坏宿主框架""难以回退"）被推翻，需要给出卸载保证；
  2. **改写 AC-08/09 的口径**为"接入方调用 `setPage` 后上报，`page_id` 按其声明的模板取"——但**改验收用例不在本任务权限内**（且"验收用例不得修改"是仓库硬规矩），故这条路需负责人先改契约/用例；
  3. **两者都提供**：默认不打补丁（安全默认），可选开启自动路由（打补丁、可卸载）——AC-08/09 在"开启自动路由"的用例下验证。

### ② AC-13 是**构建产物检查**，不是单元测试——验证方式未定

AC-13 原文「只引入错误插件构建 → **产物中不包含其他插件代码**」。这需要**构建 + 产物扫描**，而：
- 仓库现有测试 project（`unit`/`contract`/`security`）都不做构建产物检查；
- `packages/plugins` 目前只有全量入口，**没有"仅错误插件"的构建配置**；
- `pnpm gates` 的顺序是 build 在 test 之前，理论上可在测试里读产物，但需要先有"仅错误插件"的构建产物。
**需负责人定**：是新增一个子路径构建（属构建配置变更），还是把 AC-13 的验证交给 T30/T31 一类的工作。

### ③ AC-04 要求**面包屑**，但公共 API 与用例里都没有它的位置

AC-04 原文：「错误前用户做了 25 次点击和路由跳转 → 附**最近 20 条面包屑**；面包屑中没有输入框内容」。
- 说明面包屑**确实是 C05-F1 的一部分**（作为错误事件的自动上下文），这**倾向于回答** `docs/use-cases.md` 里那条疑问（"是错误事件的自动上下文，还是独立能力"）→ **倾向自动上下文**；
- 但仍有开放点：**面包屑缓存容量是否有公共配置入口**（20 条是硬编码还是可配）、**"点击"如何采集**（`click` 监听？会不会与宿主冲突）、以及**哪些信息进面包屑**（元素选择器？文本？——**文本就可能含输入框内容，正是这条约束要防的**）。
- 建议：本任务按"最近 20 条、只记元素标识与动作类型、**绝不记录输入框的 `value`**"实现，容量硬编码 20；是否给配置入口请示负责人。

### ④ AC-20 的"共存模式默认关闭"与 C03 的"运行期只能关不能开"存在张力

- AC-20 原文：「共存模式下的默认配置 → **错误、性能、HTTP 插件默认关闭**；可由**远程配置逐个开启**」。
- 而第 5 节现有结论是「运行期只能关，不能开」（与 C03 的运行时覆盖规则一致）。
- **张力点**：若"默认关闭"发生在**初始化**（builtin 缺省），远程配置在**拉取后**把它们打开——那不是"运行期覆盖打开"，而是"远程配置的缺省值与内置缺省不同"，**并不违反 C03**。但前提是**"共存模式"必须在初始化时就能确定**（例如由初始化参数 `apm_coexistence: true` 决定），否则 SDK 无法知道该用哪套缺省。
- **需负责人定**：共存模式如何声明（初始化参数？远程配置的某个标志？）、以及**非共存模式**下 error/perf 的缺省是开还是关（T13 的内建默认表记的是 error/perf/route 开、http 关，与 AC-20 的共存模式缺省不同）。

### ⑤ 【新】AC-12 的「链路追踪头」在契约里没有名字

见第 4 节的详细说明：`docs/contracts/**`（不含 `changes/`）全库检索 `trace`/`traceparent`/`tracestate`/`追踪头`/`链路追踪` **0 命中**，`ingest-protocol.md` 只定义了 `X-App-Id`/`X-Write-Token`/`X-Request-Id`/`X-Server-Time`。**AC-12 无法在不猜头名的前提下实现**，三条出路见第 4 节。另需核 `docs/decisions/Q7-apm-coexistence.md` 是否提到该头。

### ⑥ 【新】AC-10 的「失败原因正确」没有取值定义

`web_http.dimensions.failure_reason` 在 Schema 里是**无枚举的自由字符串**，而 `tests/acceptance/C05.md` 除标题外只有一张表、未列任何取值。**「正确」目前无法被客观验证**，需负责人拍板一组可枚举值（或确认由实现定义并写进 README）。

### 附：本轮未读、需下一轮补的

~~- 五个内置事件 Schema~~ → **第二轮已读**（required/properties/枚举已落到 §1/§2/§4/§7/§8）；
~~- `event-standard.md` 第 6 节 与 `reason-codes.md`~~ → **第二轮已读**（`event-standard.md:83` 与 Schema 一致；`filtered_by_plugin` 已登记）；
- `docs/contracts/ingest-protocol.md` 2.2 → **已读，结论是缺口**（未定义追踪头，见冲突 ⑤）；
- `docs/decisions/Q7-apm-coexistence.md`（核追踪头名与包装层级）；`remote-config.schema.json` 的 `plugins` 段（核 AC-20 共存模式的声明方式）。
