# T33 接入阻塞点与文档缺陷清单

- 产出任务：T33（试点）中不依赖 Q2 的部分
- 日期：2026-10-15
- 读者：负责人（A00）、T34（文档）、T18/T16（装配根与传输）、后续接手者
- 口径：**凡本文件声称"实测"的，都给出了可复跑的脚本与命令**；未跑的写"未测"。
- 相关脚本：`tests/pilot/00-connectivity.mjs`、`tests/pilot/10-three-leg-reconcile.mjs`、
  `tests/pilot/20-receiver-selfcheck.mjs`

> 本清单是 T33 交接产物「接入问题清单（给 T34 修订文档）」的落地。
> **按派工口径，本任务只报告、不改 `docs/guides/**`**（指南属 T34 交付物）。

---

## 汇总

| 编号 | 级别 | 一句话 | 归属 |
|---|---|---|---|
| **D-01** | **阻断级** | 不设置 `pageId` 时 SDK 产出 `common.page_id: null`，**违反冻结契约**，接收方按结构非法拒收 → 事件全部丢失 | SDK（C04/C01） |
| **D-02** | **阻断级** | 在装配根上调用公共 API `client.onEvent()` 会让**全部投递静默失效** | SDK（C01 装配根契约） |
| **D-03** | **阻断级（文档）** | 指南把 M01 的上报端点写成 `/ingest`，真实路径是 `/v1/batch` → 照做必 404 | T34（文档）· **已修 2026-10-15** |
| **D-04** | 高（文档） | 指南第 8.3 节的自检片段**不是可运行代码**（`Assembly` 没有 `track`） | T34（文档）· **已修 2026-10-15** |
| **D-05** | 中（文档） | 指南称"webpack 与开发服务器未在本仓库验证"，**已过期**（T30 已实测通过） | T34（文档）· **已修 2026-10-15** |
| **D-06** | 中（方法论） | 既有"端到端验证"用的是**不校验结构的自定义接收端**，让 D-01 逃过多轮验收 | T30/T29 的口径 · **已固化为守卫 + 证据 2026-10-15** |
| **D-07** | 低（文档） | 指南的 flush 后立刻查计数会读到 0（异步投递未说明） | T34（文档）· **已修 2026-10-15** |
| **D-09** | 高（SDK） | `createClient({ consent })` 被**静默忽略**（D-08 现象的 API 层根因）→ 非必要事件全被同意门丢掉 | SDK（C01/C04）· **已修 2026-10-15** |

---

## D-01（阻断级）：`common.page_id: null` 违反冻结契约，导致接收方整批拒收

### 现象

接入方按指南装配后**什么都不上报**（接收方入库恒为 0），因为接收方以 400 拒收整批。

### 实测证据

`packages/browser/dist/index.js` 的 `createAssembly({...})`，在**未调 `setPage`** 时产出的批次：

```jsonc
// node tests/pilot/* 的探针实测（tests/pilot/00-connectivity.mjs 的成因）
"common": { "page_id": null, "view_id": "…", "url": "…" }
```

对**冻结契约**做 Ajv 校验（`docs/contracts/schemas/batch.schema.json`）：

```
[未调 setPage（pageId 缺省 null）] common.page_id = null
  完整批次 Ajv 校验: FAIL
  错误: [{"instancePath":"/common/page_id","schemaPath":"#/properties/page_id/type",
          "keyword":"type","params":{"type":"string"},"message":"must be string"}]
[显式 pageId] common.page_id = "/home"
  完整批次 Ajv 校验: PASS
```

M01（严格按契约校验的接收方）的判决与后果：

```
M01 validateBatch => {"ok":false,"error":"invalid_structure","message":"invalid common.page_id"}
→ 400，counters: received_batches=1, stored_events=0, rejected_invalid_structure=1
→ SDK 侧 delivery.metrics(): eventsSent=0, batchesFailed=1
```

### 契约依据（SDK 这边是错的一方）

`docs/contracts/schemas/batch.schema.json` 的 `$defs.commonFields`：

- `page_id`：`{"type": "string", "maxLength": 256}` —— **是字符串**
- `required`：**无**（即 `page_id` 是**可选**的）

所以正确行为是二选一：**给出字符串**，或**整个键不出现**。**绝不能是 `null`。**

### 为什么它危险

1. **默认路径就中**：只要接入方没有在 init 前调 `setPage()`，第一条事件就丢。
   这是**最常见的接入形态**（先跑通，再补页面归属）。
2. **静默**：SDK 不抛错、不告警；接入方看到的是"接收方没数据"，容易先去怀疑接收方。
3. **多接收方都会拒**：任何按契约实现 RR-01/RR-06 的接收方都会拒；M01 只是其中一个。

### 建议（不在本任务可写范围）

- 修在事件/上下文产出侧：`page_id` 为 `undefined` 时**不写该键**（现在的 `enrich` 路径本来就只
  在 `!== undefined` 时写，但 `common` 提升路径上出现了 `null`），并在**装配根/批次组装前**
  加一条与契约同源的兜底：`null` 一律按"键不存在"处理。
- **同时补一条契约自证用例**：用 Ajv 对**真实产出批次**校验（见 D-06），否则同类缺陷还会漏。
- 单元级哨兵建议：`common.page_id` 必须是 `string` 或 `undefined`，**不得为 null**。

### 已修（2026-10-14，执行方；修复 + 复现证据）

**根因比本条目原描述更精确**：`null` **不是**"未调 `setPage`"的默认值 —— 完全不注入位置来源时
`page_id` 键本来就不出现（本就合法）。`null` 只在**注入的 `LocationSource` 在运行期给出非字符串
`pageId`**（JS 接入方 / SSR 适配层 / 反序列化快照）时产生：`submit()` 的
`context.page_id ?? location.pageId` 拦不住 `null`，`makeEvent` 的 `!== undefined` 判定又放行，
C06 `promoteCommonFields` 再把它提升到 `common`。**契约违反是真实的，触发条件是外部输入的运行期形态**
（与 `view_id`/`device_id`/stub `event_id` 三处同族，都是"边界不校验外部值"）。

**修法**：在 `LocationSource` / `init({ location })` / 加载桩命令这些**外部输入边界**做与契约同源的
归一化，唯一实现是 `context/page.ts#normalizePageId`（`typeof value !== 'string'` → 按"未设置"，
并顺带让 `init({ pageId: null })` 不再抛 `TypeError`）。选"**键不出现**"而不是"给兜底字符串"：
`page_id` 是路由模板/手动页面标识，C04 明确**不从 URL 推导**（裁定 8），编造值会污染语义。

**证据**：
- `packages/browser/src/assembly-contract.test.ts`：对**真实产出的完整批次**用 Ajv 2020-12 校验
  `batch.schema.json`，并断言事件体与 `common` 两处的 `page_id` **要么是 string、要么键不存在**。
  修复前原文：`[{"instancePath":"/common/page_id","schemaPath":"#/properties/page_id/type","keyword":"type","params":{"type":"string"},"message":"must be string"}]`
- `packages/core/src/api/location-boundary.test.ts`：边界单测（null / 数字 / `href` 非字符串 /
  `init({ pageId: null })` 不抛错）。
- M01 端到端（修复后，`location.pageId: null`）：`stored_events=1`、`rejected_invalid_structure=0`。
- 变异验证：把归一化临时改回 → 2 条批次用例 + 4 条边界用例转红（同一 Ajv 原文）。

**同族问题（一并修）**：同一注入点上的 `href` 非字符串会让 `track()` 抛
`TypeError: Cannot read properties of null (reading 'indexOf')`（`sanitizeUrl` 直吞外部输入），
`init({ location: null })` 会在 `initOptions.location.href` 上抛同类异常 —— 二者已在同一边界归一化掉。

---

## D-02（阻断级）：公共 API `client.onEvent()` 会让装配根的投递**静默失效**

### 现象

在 `createAssembly(...)` 返回的装配根上调用**文档化的公共方法** `client.onEvent(sink)` 之后，
队列再也拿不到事件：`flush` 恒返回 `{status:"empty"}`，**零投递、零入库**。

### 实测证据（含顺序对照，排除"只是调用时机问题"）

只改一个变量（是否调 `onEvent`），同一个脚本：

```
assembly onEvent before-init -> flush=empty stored=0
assembly onEvent after-init  -> flush=empty stored=0
assembly onEvent never       -> flush=submitted stored=1
```

再做一个 A/B（同一次运行里跑两轮，只差一行 `onEvent`）：

```
[no-onEvent]   r0 flush=submitted batchEvents=1
[no-onEvent]   sent=3 batches=3 failed=0 stored=3 rejStruct=0
[with-onEvent] r0 flush=empty batchEvents=undefined
[with-onEvent] sent=0 batches=0 failed=0 stored=0 rejStruct=0
```

### 机制（读代码可知）

`packages/browser/src/assembly.ts` 内部用 `client.onEvent(...)` 把管线接到队列：

```ts
const enqueueFromPipeline = delivery.wireEnqueue(queue);
client.onEvent((event: KernelEvent): void => {
  enqueueFromPipeline(event);
});
```

而 `onEvent` 的语义是**替换**事件出口（不是"追加一个观察者"），所以接入方再调一次，
就把装配根自己的接线**顶掉了**。C01 的公共契约里 `onEvent` 是"注册事件出口"，
在**纯 `createClient`** 场景下这是合理且有用的（我实测它是好的：`seen` 能拿到事件）；
但在**装配根**场景下，它同时是内部接线点，于是变成**静默数据杀手**。

### 为什么它危险

- **无声**：不抛错、不计数、`destroy` 也正常。接入方只会看到"SDK 不上报"。
- **触发动机非常自然**：接入方想"先不上报，只看 SDK 产出了什么"时，
  照 API 参考调 `onEvent` 是最直觉的做法 —— 结果把上报**彻底关掉**。
- 与 D-01 叠加时更难排查：两个都表现为"接收方没有数据"。

### 建议（不在本任务可写范围）

- 让 `onEvent` 在装配根场景下**组合而非替换**（保留既有 sink，追加观察者）；
  或让装配根**不再依赖公共 `onEvent`**，改用内部能力注册出口。
- 无论哪种，**都必须有一条守卫**：装配后调用 `onEvent`，投递仍应成立。

### 已修（2026-10-14，执行方；选 (a)）

**选 (a)**：装配根**不再借用替换语义的公共 API**。不选 (b)：`onEvent` 的公共契约是"**替换**事件出口"
（等价于 `init({ onEvent })`），`packages/core/src/api/edge-cases.test.ts` 有"init 的 `onEvent` 覆盖
`createClient` 注入点"的锁定用例 —— 改成追加就是破坏既有公共语义。

**修法**：core 新增内核能力 `EVENT_OBSERVER_CAPABILITY`（`'sdk.event_observer'`，**追加**语义：
值是 `(observer) => Dispose`），`emit()` 在调用公共 `eventSink` 之后再依次调用全部观察者；
`assembly.ts` 改用它接线投递。接入方在装配根上调 `onEvent` 只替换"自己的观察出口"，投递不再被顶掉；
`onEvent` 的公共契约与其返回的注销函数**语义未改**（`assembly.ts` 模块头有明文声明）。
装配根拿不到该能力时**抛错**，而不是退回静默不投递。

**证据**：`packages/browser/src/assembly-contract.test.ts` 的 D-02 组 —— `init` 前/后各一条：
投递成立（批次到达接收替身、`eventsSent ≥ 1`）**且**接入方观察者仍收到同一条事件；外加不调 `onEvent`
的基线。变异验证：把接线改回 `client.onEvent(...)` → 两条 onEvent 用例转红（`waitFor 超时`），
D-01 组保持绿（两组互不耦合）。

**公共导出面**：新增 `EVENT_OBSERVER_CAPABILITY`（additive；`etc/core.api.md` 需 `pnpm api:update`，由负责人执行）。

---

## D-03（阻断级·文档）：指南给 M01 的端点 `/ingest` 是错的，真实路径是 `/v1/batch`

### 现象

`docs/guides/integration.md` 第 8.3 节：

- 第 2 步：「把 SDK 的端点指向 M01（`endpoint` / 远程配置 `endpoints.ingest`），`app_id` 与令牌用占位值。」；
- 该节片段与本仓库 T30 的脚本用的是 `/ingest`（`tests/compat/scripts/browser-core-path.mjs:88`）。

实测：**M01 对 `/ingest` 返回 404**，真实路径是 `/v1/batch`。

### 实测证据

```
$ curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8899/ingest
404
$ curl -s http://127.0.0.1:8899/v1/batch
405        # 路径存在，只是 GET 不允许（POST 才是正确方法）

# 不用 curl 也能看到权威答案 —— M01 的 CLI 自己打印：
$ node tools/mock-receiver/dist/cli.js --port 8899
M01 mock 接收服务已启动：http://127.0.0.1:8899
  上报端点：POST /v1/batch
```

用 `/ingest` 时 SDK 侧的真实后果（`tests/pilot` 的探针）：

```
GET/POST /ingest -> 404 body={"error":"not_found","message":"unknown path: /ingest"}
delivery.metrics(): batchesFailed=1, eventsSent=0
counters: received_batches=0, stored_events=0
```

契约本身是对的：`docs/contracts/ingest-protocol.md:13` 写「路径 `/v1/batch`；主版本号体现在路径中」。

### 为什么它危险

接入方自检的第一条命令就 404，会直接得出"这个 SDK 不上报"的结论 —— 而**指南是唯一的操作依据**。

### 建议（归 T34）

把 `integration.md` 第 8.3 节第 2 步的端点写成 **`/v1/batch`**，并在该节给出
`node tools/mock-receiver/dist/cli.js` 的**完整输出**（它自带正确端点，接入方一眼可见）。

### 已修（2026-10-15，T34 执行；**先实测后改**）

**实测脚本**：`temp/t34-d03-endpoint-probe.mjs`（裸 HTTP 探测）、`temp/t34-e2e-probe.mjs`（SDK 真实投递）。
M01 起在 `127.0.0.1:8899`。原始响应：

```
[1-GET]  GET  /ingest   -> 404  body: {"error":"not_found","message":"unknown path: /ingest"}
[2-POST] POST /ingest   -> 404  body: {"error":"not_found","message":"unknown path: /ingest"}
[3-GET]  GET  /v1/batch -> 405  body: {"error":"method_not_allowed","message":"only POST is supported on /v1/batch"}
[4-POST] POST /v1/batch -> 401  body: {"error":"invalid_token","message":"invalid write token"}   # 占位令牌写错，见下
```

用**合法占位令牌** `placeholder-write-token-0000`（`tools/mock-receiver/README.md` 第 2 节）跑 SDK 真实投递：

```
endpoint=/ingest   → M01: received_batches=0, stored_events=0；SDK delivery.metrics(): eventsSent=0, batchesFailed=1
endpoint=/v1/batch → M01: received_batches=1, received_events=1, stored_events=1, rejected_invalid_structure=0；
                         SDK delivery.metrics(): eventsSent=1, batchesSent=1, batchesFailed=0
```

**改法**（`docs/guides/integration.md` 第 8.3 节）：端点写成 `endpoint: 'http://127.0.0.1:8787/v1/batch'`，
并注明 `/ingest` 会 404、`endpoints.ingest` 只是**配置键名**而非 URL 路径、M01 CLI 启动时会打印正确端点。

**回归**：`temp/t34-guide-snippet-regression.mjs` 逐字执行修订后的片段 → `exit 0`，
`received_batches=1 / received_events=1 / stored_events=1 / rejected_invalid_structure=0`，恒等式成立。

> **诚实记录（探针自身错误）**：本轮第一次实测我用了自造的 `placeholder-token`，得到 `/v1/batch → 401`
> 与 `stored_events=0`，**一度又要把它读成"端点也不通"**。真实原因是占位令牌写错（M01 是固定值比对）。
> 换回合法占位值后同一路径立刻 `202 / stored_events=1`。与本文末"探针三错"同一条教训。

---

## D-04（高·文档）：指南第 8.3 节的自检片段不是可运行代码

`integration.md` 第 8.3 节说：

> 装配根用法：`createAssembly({ appId, endpoint, token, env, release, consent: 'granted' })`
> 后调用 `assembly.init()`（或直接用返回的 `client`），`track` 产出的事件会经 …发到 `endpoint`。

但 `Assembly` 接口（`packages/browser/dist/index.d.ts`、`packages/browser/etc/browser.api.md:84`）
**没有** `track` / `log` / `setUser` 等方法，只有：

```
client, kernel, config, clock, erasePort, queue, delivery, reporter,
nativeHttpRefs, collectors, init(), flush(), destroy()
```

实测按直觉写会直接崩：

```
TypeError: assembly.track is not a function
    at tests/pilot/00-connectivity.mjs
```

（"(或直接用返回的 `client`)" 这半句是对的，但**没有给出任何示例**，
而第 3 步紧接着写 `client.track('self_check_event')` —— 这里的 `client` 从未被定义过。）

### 建议（归 T34）

第 8.3 节给一段**能整段复制运行**的代码，明确写出 `assembly.client.track(...)`。

### 已修（2026-10-15，T34 执行）

**逐字复现**（`temp/t34-e2e-probe.mjs`，真实装配根）：

```
=== D-04: 旧 8.3 片段逐字执行 ===
  ✅ 复现失败：TypeError: assembly.track is not a function
  Assembly 自身方法: client, clock, collectors, config, delivery, destroy, erasePort, flush,
                     init, kernel, nativeHttpRefs, queue, reporter
  Assembly 是函数: track=undefined, log=undefined, setUser=undefined, init=function, flush=function
  Assembly.client 上 track=function, flush=function
```

与 `packages/browser/dist/index.d.ts` 的 `interface Assembly`（第 82–103 行）一致：装配根只有
`init()` / `flush()` / `destroy()` 三个方法，其余全是句柄。

**改法**：`integration.md` 第 8.3 节改为**一段整段可复制的 `self-check.mjs`**，其中显式写
`assembly.client.track(...)`，并用醒目提示写明"`Assembly` 上没有 `track`，业务方法在 `assembly.client` 上"。

**回归**：`temp/t34-guide-snippet-regression.mjs` **逐字**执行修订后的片段 → `exit 0`
（不是"读代码判断"，是真跑）。

---

## D-05（中·文档）：指南的"webpack 与开发服务器未验证"已过期

`docs/guides/integration.md:12`（引的是修订前的原文；该行现已按本节末「已修」改写）：

> …本仓库 `examples/` 覆盖 Vite、IIFE、Vitest、Jest，**webpack 与开发服务器未在本仓库验证**。

事实（T30 已于 2026-10-14 补测，`docs/reports/compat-matrix.md` 第 2.1 节第 10/11 格）：
webpack 生产构建与 webpack dev server **两格均 `pass`**，证据
`tests/compat/results/webpack-{production,dev-server}.json`，且 `examples/webpack/` 已入库。

本任务复跑确认（见 `t33-readiness.md` 第 3 节）：`pnpm examples:build`、`pnpm examples:test` 均 **exit 0**。

> 这属于 `handover.md` 第 2 节 T34 小节列出的"随其他任务落地而变成错的事实"的第 3 类。
> **归 T34。**

### 已修（2026-10-15，T34 执行；用 `compat-matrix.md` 的结论改写）

**核对**（不是转述）：`docs/reports/compat-matrix.md` 第 2.1 节第 10/11 格，环境
`webpack 5.104.1 + Chromium`（dev server 为 `webpack-dev-server 5.2.2`），**两格结论均为 `pass`**；
证据文件 `tests/compat/results/webpack-production.json` 与 `webpack-dev-server.json` 的
`status` 字段实测均为 `"pass"`（`generatedAt: 2026-10-14`），且 `examples/webpack/` 已入库
（`package.json` 的 `build: node scripts/build-production.mjs`、`test: node scripts/dev-server.mjs`）。

**改法**（`docs/guides/integration.md` 第 1 节）：把"**webpack 与开发服务器未在本仓库验证**"
改为"**以及 webpack 5 生产构建与 webpack 开发服务器**"；并在第 3.3 节"已验证的导入环境"表里
补上 `examples/webpack` 一行，指向 `docs/reports/compat-matrix.md` 第 2.1 节第 10/11 格与两份结果 JSON。

**未动**：第 3.3 节的命令仍只用 `pnpm examples:build` / `pnpm examples:test`（`examples/webpack`
的 npm script 正是这两个父命令会调到的），本任务实跑两者均 **exit 0**。

---

## D-06（中·方法论）：既有"端到端验证"的接收端不校验结构，导致 D-01 逃过多轮验收

T30 的真实 Chromium 核心路径脚本，其接收端是脚本内自建的 node http 端点
（`tests/compat/scripts/browser-core-path.mjs:139`），它只做"收到请求 → 解析 → 断言收到批次"，
**不按 `batch.schema.json` 校验结构**。同一脚本提供的 `pageId` 也走的是页面真实 `location`。

后果：**D-01（`common.page_id: null` 违反契约）在 T30 的 45 格矩阵里、在 T29 的多个 spec 里、
在 `examples/` 的全部接入验证里，一次都没有被触发。** 它只在"接到一个**真的按契约校验**的
接收方（M01）"时才暴露 —— 而这恰好是 T33 试点要做的第一件事。

### 建议

**任何声称"端到端送达"的验证，接收端必须至少做一次契约 Schema 校验**（用 Ajv 校验
`docs/contracts/schemas/batch.schema.json`，与 `tests/contract/` 已有的校验口径一致）。
"收到字节"不等于"收到合法批次"。

### 已固化（2026-10-15，执行方；唯一校验门 + 判别性证据 + 机器守卫）

**口径**：**"端到端通过" ≠ "端到端按契约通过"。** 三处落地：

1. **唯一校验门** `tests/compat/lib/batch-contract.mjs`：Ajv 2020-12（+ `ajv-formats`）直接编译
   `docs/contracts/schemas/batch.schema.json`（`strictRequired: false`，与 `tests/contract/lib/schemas.ts`
   同一口径；**不在代码里复制字段清单**）。`inspectBatchText` 区分 `invalid_json`（传输层噪声）与
   `invalid_structure`（契约违反）。
2. **盘点与处置**（逐个决定"加校验"或"如实降级为传输探针"）：

   | 接收端 | 处置 |
   |---|---|
   | `tests/compat/lib/ingest-receiver.mjs`（**T30 核心路径 `/ingest` 的实现**，从 `browser-core-path.mjs` 内联端点抽出） | **加校验**：违约 400 + 记录 Ajv 错误；`browser-core-path.mjs` 新增 `batchSchemaValid` 检查 |
   | `examples/webpack/scripts/lib/verify-bundle.mjs`（webpack 沙箱上传桩） | **加校验**：新增 `batchPassesContractSchema` 检查（任一批被拒 → `status=fail`） |
   | `tests/compat/apm-coexistence.test.ts`（上传替身） | **加校验**：违约 400 + `afterEach` 断言无拒收 |
   | `tests/compat/degradation.test.ts`（上传替身） | **加校验**：同上 |
   | `tests/e2e/lib/receiver.mjs` | **传输探针**：只收探针**手写信封**（`device_id`/`session_id`/`batch_id` 刻意不是契约 uuid）与 `sendBeacon` 随机字节哨兵，服务字节上限/真超时/401；拿不到 SDK 装配根产出的完整批次 |
   | `tests/e2e/leave-slice.spec.mjs`（C07-AC-03 信标端点，并发任务新增） | **传输探针**：手写信封（`event_id=ac03-0000`、`batch_id=ac03-batch`），判定片大小/Content-Type/令牌位置/顺序 |

   **不为过守卫加空校验**：后两类如实降级，理由写在守卫清单里。
3. **判别性证据** `tests/compat/receiver-contract-gate.test.ts`（先红后绿）：真实 SDK 产出批次
   （基线通过）→ 注入 D-01 形态（`common.page_id = null`）→ **HTTP 接收端 400**、**examples 上传桩 400**；
   注入"删掉 required 字段（`batch_id`）"→ 400；恢复合法批次 → 202/200。
   变异验证：把 Ajv 去掉 → 判别性用例 **4 条转红**（`expected 202 to be 400`），恢复后绿。
4. **机器守卫（防复发）** `tests/security/guard-e2e-receivers-validate-contract.test.ts` +
   `tests/security/lib/e2e-receiver-inventory.ts`：扫描 `tests/compat/**`、`tests/e2e/**`、`examples/**`
   里所有"会接收批次"的实现面（`createServer(` + 读**请求**正文；或自实现 `send(request)` 碰
   `request.body`），要求逐个出现在**带理由的两侧清单**里：扫到未登记 → 红；登记了扫不到 → 也红。
   **反空转**：断言扫到的接收端 ≥ 5、http 接收端 ≥ 2、传输替身 ≥ 3，三棵目录各自至少有一个，
   且点名文件（T30 `/ingest` 实现、T29 接收端、examples 上传桩）必须在列——正则写错时立刻红，
   不会"扫了 0 个所以通过"。变异验证：删一条清单项 → 红（未登记）；加一个幽灵登记项 → 红（清单失真）；
   把数量阈值改高 → 红（`expected 7 to be ≥ 50`）。
5. **回归**：`--project unit` 136 文件/1256 用例全绿；compat 5 文件/28 用例全绿；security 5 文件/32 用例全绿；
   `pnpm examples:build`、`pnpm examples:test` 均 pass 且沙箱 `batchPassesContractSchema=true`；
   `eslint tests/compat tests/security` 干净；根 `tsc -p tsconfig.json` 干净。

### 同族残留：一批"验证声称比结论弱"的守卫（2026-10-15 核实 → 已修）

D-06 的盘点暴露的不止一个接收端，而是**同一个模式**：**声称验证了某件事、实际没有**。
下面 5 处在当前 HEAD（`c931a73`）上**逐条核实**（先核实后动手；核实方式只有 `grep` 与读文件）：

| # | 位置 | 核实结果 | 核实依据 |
|---|---|---|---|
| 1 | `examples/vite/package.json` 的 `test` | **成立**：就是 `node -e "process.exit(0)"`；而 `examples:test` 是 `pnpm gates` 的一步 | 读文件 + 根 `package.json` 的 `gates` 脚本 |
| 2 | `examples/node-import`（`vitest.test.ts` / `jest.test.mjs`）、`examples/script-tag/check.mjs` | **成立，但三处强弱不同**：node-import 两个用例都只断言 `typeof SDK_VERSION === 'string'`；`script-tag` 确实**求值了 IIFE 产物**（比 node-import 强），但同样只断言 `typeof sdk.SDK_VERSION === 'string'`，不跑装配、不跑投递 | 逐个读文件 |
| 3 | `examples/webpack/scripts/lib/verify-bundle.mjs` 的 `checks.bundleEvaluated` | **成立**：仍是字面量 `true`。**但同一函数里的 `checks.batchPassesContractSchema`（D-06 加的）是真的**——由 `inspectBatchText` 的 Ajv 校验驱动、且要求"至少收到一次请求且零拒收"，能因注入违约批次转红。所以 `status` 不是恒绿，问题只是"多了一个恒真的检查项" | 读文件 + 读 `tests/compat/receiver-contract-gate.test.ts:185-188` 的既有判别性断言 |
| 4 | `tests/e2e/probes/*.js` 手写信封 | **成立，但探针侧 4/5 口径已经是对的**：`beacon-quota-driver.js` **完全不加载 SDK**（头注释写明"与 SDK 实现无关"）；`beacon-quota.spec.mjs` 写明"断言只覆盖浏览器特性本身"；`durability-driver.js` 写明被测对象是 `packages/transport/dist`；`real-browser-driver.js::leaveBeaconProbe` 用 `envelope(...)` 手写信封走 transport 的 `submit`。**唯一过声称**的是 `leave-slice-driver.js` 的内联注释把返回值叫"**SDK 侧观测量**"（实际是 transport 侧） | 逐个读探针 + spec 头注释 |
| 5 | `tests/e2e/lib/receiver.mjs` 把不可解析批次计成 202 | **成立**：`parseBatchBody` 失败 → `onUnparsableBatch` 只加计数，随后对 `LEDGER_PATHS` 的 POST **统一写 202**；且 `unparsable_batches` 在 `tests/e2e/**` 的任何 spec 里**都没有被读过**（`grep -rn unparsable tests/` 只命中 receiver.mjs 自身） | `grep` 全仓 + 读文件 |

**补充核实（防"改错地方"）**：`#5` 的正确处置**不是**"让 receiver 拒收"——`tools/mock-receiver` 的验收
用例 `tools/mock-receiver/src/e2e-receiver-reconciliation.acceptance.test.ts:348-359` **明确要求**
"无法解析的正文不使服务失败，只计入 `unparsable_batches`"。所以要么加断言让它不静默，要么如实降级口径，
不允许把 202 语义偷偷改掉。

### 处置（2026-10-15，执行方；逐处"加断言"或"如实降级" + 判别性证据）

**原则**：让**声称与验证对齐**，不是"把断言加严到过不去"。**最小投递路径只实现一次**：
`examples/webpack/scripts/lib/verify-bundle.mjs` 的 `runAssemblyMinimalPath`（`SDK_VERSION` 必须与包版本一致 →
`createAssembly` 是函数 → `init/track/flush` → 接收方真收到**通过 `batch.schema.json` Ajv 校验**的批次），
四个例子共用，不各写一套。

| # | 处置 | 具体改法 |
|---|---|---|
| 1 | **加真实验证（换掉空测试）** | `examples/vite/package.json` 的 `test` 改为 `node scripts/verify-build.mjs`（新增）：真跑 `vite build` → 从 `dist/index.html` 解析带 hash 的入口脚本 → 交给共用的 `runBundleInSandbox(..., { exposedKey: '__VITE_EXAMPLE__' })`。`examples/vite/src/main.ts` 相应暴露 `__VITE_EXAMPLE__ = { SDK_VERSION, createAssembly }`（与 webpack 入口同一形态） |
| 2 | **加真实验证** | `examples/node-import` 的 Vitest 与 Jest 用例、`examples/script-tag/check.mjs` 都改为调用**同一个** `runAssemblyMinimalPath`。node-import 用 `installBrowserGlobals()`（同一份最小浏览器面装到宿主 `globalThis`，`try/finally` 还原）跑**真实 `import` 来的**产物；script-tag 用 `createBrowserSandbox()` 求值 IIFE 后再跑最小路径 |
| 3 | **改成真实检查（不删、不留恒真）** | `checks.bundleEvaluated` 由字面量 `true` 改为 **`vm.runInContext` 是否成功求值**：失败时该检查转 `false`、`status=fail`，并把 `evaluationError` 记进结果（此前是恒真常量；求值抛错则整条逃逸为无结构的异常） |
| 4 | **如实降级口径（不改断言）** | 探针**故意**手写信封，且 4/5 本来口径就对（`beacon-quota-driver.js` 连信封都不写、`durability-driver.js` 明写被测对象是 `packages/transport/dist`）。只在**过声称处**补口径：`leave-slice-driver.js` 文件头 + `sliceSend` 注释（"SDK 侧观测量" → **transport 侧**，并写明"没有 `createAssembly` 参与"）、`real-browser-driver.js::leaveBeaconProbe`、`durability-driver.js`、`beacon-quota-driver.js` 各加一段"证明的是传输层、不是 SDK 组批"。**没有**为了好看去改 202 语义或加空校验 |
| 5 | **加断言** | `tests/e2e/lib/receiver.mjs`：新增 `assertNoUnparsableBatches`（导出）+ `close()` **默认**调用它；`BATCH_ONLY_PATHS = ['/ingest','/gzip']` 上 `unparsable === 0`，`/beacon` 按 `RAW_SENTINEL_PATHS` 豁免（理由写在文件头：`real-browser.spec.mjs:120-131` 故意发二进制哨兵）。同时新增 `unparsableByPath()` / `unparsableSamples()` 与 `counters.unparsable_by_path`，失败信息带前 120 字符正文 |

**为什么 #5 不是"全局 `unparsable === 0`"**：全局断言会在 `/beacon` 的**故意**二进制哨兵上造出与 SDK 无关的假失败。
豁免是**按路径**给的、且计数照样逐条可查——这是如实降级，不是放水。

**判别性证明（每处都人为制造它应当捕获的失败 → 该验证必须红 → 已恢复）**：

| 针对 | 注入的失败 | 结果 |
|---|---|---|
| #1 | 临时从 `examples/vite/src/main.ts` 的 `__VITE_EXAMPLE__` 里**去掉 `createAssembly`**（"产物缺必需符号"） | `createAssemblyIsFunction=false`、`minimalPathError="TypeError: createAssembly is not a function"`、`status=fail`、**exit 1**；恢复后 exit 0 |
| #2（node-import） | 临时给 `packages/browser/dist/index.js`（**构建产物**，非 `src`）追加模块级 `throw` | vitest **exit 1**、jest **exit 1**；按 sha256 恢复并校验 `OK` |
| #2（script-tag） | 临时给 `packages/browser/dist/web-report-sdk.iife.js` 追加模块级 `throw` | `check.mjs` **exit 1**；按 sha256 恢复并校验 `OK` |
| #1/#2 共用最小路径 | (a) 装配的 `track` 是空操作（不投递）；(b) 真实批次后把 `common.page_id` 改成 `null`（D-01 形态）再喂接收替身 | (a) `uploadStubReceivedRequest=false`、`minimalPathRan=false`；(b) 合法批次 200、违约批次 **400** + `rejections=[invalid_structure]`、`allAccepted=false` —— 证明 D-06 的 Ajv 门在复用路径里是活的 |
| #3 | 给真实产物代码追加模块级 `throw` 再喂 `runBundleInSandbox` | `bundleEvaluated` true→**false**、`status` pass→**fail**、`evaluationError="Error: injected-eval-failure"` |
| #5 | 往 `/ingest` POST 不可解析正文 | 仍回 **202**（语义未变），但 `close()` 抛"接收端在'只应承载批次'的路径上收到不可解析正文：`/ingest×1`；样本=[…]"；同一正文发到豁免的 `/beacon` **不误报**；合法批次保持绿 |
| #4 | ——（只改口径、不加断言，故无"应当捕获的失败"可造） | 注释改动不改变任何判定；`eslint tests/e2e` exit 0 |

**回归（2026-10-15）**：`pnpm examples:build` **exit 0**、`pnpm examples:test` **exit 0**
（script-tag/vite 的 `status=pass`；node-import vitest `1 passed`、jest `1 passed`；
webpack 沙箱 `bundleEvaluated` / `batchPassesContractSchema` / `minimalPathRan` 全 true）；
`--project security` **32/32 绿**（D-06 的接收端清单守卫没有被新增的
`examples/vite/scripts/verify-build.mjs` 打破）；`eslint tests/e2e` exit 0
（`examples/**` 与 `docs/**` 在 `eslint.config.js` 里是**既有** ignore，不在 lint 面）；
根 `tsc -p tsconfig.json` exit 0、`example-vite` 的 `typecheck` exit 0。

**已知偏差（必须记住，不是"已通过"）**：
1. `pnpm exec vitest run --coverage.enabled=false --project unit` **最终 139 文件 / 1277 用例全绿、exit 0**。
   但**第一次**运行时曾有 2 文件/3 用例红（`packages/transport/src/sender/page-leave.test.ts` 与一个
   运行中**被删掉**的 `packages/core/src/api/zz-probe-options.test.ts`），随后同一命令复跑即全绿——
   即那是一批**在本 lane 之外并发修改** `packages/transport` / `packages/core` 的在途改动造成的瞬态，
   不是本批改动：本批只动 `examples/**`、`tests/e2e/lib/receiver.mjs`、`tests/e2e/probes/*.js` 的注释与
   本文档，而 `packages/*/src` 里**没有任何 import 指向这些路径**（已 `grep` 验证）。
   **记录第 1 次的红**，是因为"第一次红、第二次绿"本身值得下一个人知道。
2. `tests/compat/results/webpack-*.json` 被 `pnpm examples:*` 覆写，已按 `git show HEAD:<path>` 恢复
   （内容回到 HEAD 版本；因此这两份证据文件里的 `checks` **不含** `evaluationError` 字段，
   与新代码的产出形状有一个字段的差异，下次正常跑门禁时会自然刷新）。
3. 复核提示：`runAssemblyMinimalPath` 的 `probeEventName` 必须满足 `hasValidEventName`
   （≥2 段小写下划线），否则 SDK 按 `invalid_event_name` **正确丢弃**该事件、批次为空——那是预期行为，不是缺陷。

### 同类候选（**只报告，未扩大改动范围**）

1. `examples/node-import` 与 `examples/script-tag` 的 `build` 仍是 `node -e "process.exit(0)"`——
   与 #1 的 `test` 是**同一个空脚本模式**。`pnpm examples:build` 是门禁步骤，但它对这两个例子
   实际上什么都不构建（"examples 全部构建通过"这句话对它们仍然是弱的）。
2. `examples/webpack/scripts/build-production.mjs` / `dev-server.mjs` 的 `browserCheck`：解析不到
   Chromium 时返回 `status:'skipped'`，而 `checks.browserStatusPass = browser.status !== 'fail'`
   → **skipped 也算 pass**。于是"真实浏览器复核过"在缺浏览器的机器上是**没跑**而不是**失败**。
3. `package.json` 的 `test:contract` / `test:e2e` 带 `--passWithNoTests` / `--pass-with-no-tests`：
   收集到 0 个用例时 **exit 0**。若 include 写错或环境缺失，门禁会"绿着什么都没测"。
4. `tests/e2e/leave-slice.spec.mjs` / `real-browser.spec.mjs` 的**头注释**仍写着"全量送达"、
   "经真实 `createBeaconSender` 送到本地接收端"，没有"手写信封、只证传输层"的限定语。
   本批只在**探针**与本文档里补了口径（spec 属 e2e lane 的文件，未越界改）。
5. `tests/e2e/lib/receiver.mjs` 对 `/beacon` 的不可解析正文仍回 202——本批按 #5 只让它在
   `BATCH_ONLY_PATHS` 上不静默；`/beacon` 混装真批次与二进制哨兵的语义，建议由 e2e lane
   决定是否拆分端点。
6. `tools/mock-receiver` 的 `unparsable_batches` 只在**它自己的**验收用例里被断言为 1；
   任何经它跑的集成路径仍可能把不可解析正文静默计成 202——同类问题在 M01 侧的处置值得单独确认。

---

### 派工复核（2026-10-15，第二轮 lane）：上表 6 条候选**逐条核实**后处置

派工复述了上表 6 条，并明确要求"先核实是否仍成立，**不要照抄**"。核实方式只有读文件 + 跑判别命令
（`git` 只读；不跑 e2e/浏览器，不 `pnpm install`）。**核实结果 5 条成立、1 条（⑥）我说错了位置**：

| # | 核实结果 | 核实依据（命令/文件） |
|---|---|---|
| ① | **成立** | `examples/node-import/package.json:7`、`examples/script-tag/package.json:7` 都仍是 `node -e "process.exit(0)"`；根 `package.json` 的 `gates` 与 `.github/workflows/ci.yml` 的 gates job 都跑 `examples:build` |
| ② | **成立，且不止一处** | `examples/webpack/scripts/build-production.mjs` 与 `…/dev-server.mjs:94` 各有一份 `browser.status !== 'fail'`；`skipped`（缺 Chromium）与**任何未知状态**都算 pass |
| ③ | **成立** | 根 `package.json:19-20`：`--passWithNoTests` / `--pass-with-no-tests`；两者都是 CI 步骤（`ci.yml` 的 `test:contract`、e2e job 的 `test:e2e`）。**但派工给的判别方式（"不存在的 project 名"）无效**：vitest 5 对无效 project 名本身直接 **exit 1**，与 flag 无关。真实形态是"**收集到 0 个用例**"（用不存在的文件名过滤复现） |
| ④ | **成立** | `tests/e2e/leave-slice.spec.mjs` 头注释仍写"全量送达（无丢失、保序、无重复…）"、`real-browser.spec.mjs` 仍写"经真实 `createBeaconSender` 送到本地接收端"，均无"**手写信封、只证传输层**"限定；上一轮只补了**探针**（`probes/*.js`）与本文档。属 e2e lane 文件 → **只报告** |
| ⑤ | **成立（建议维持只报告）** | `tests/e2e/lib/receiver.mjs` 的 `/beacon` 既收手写信封批次（`real-browser-driver.js::leaveBeaconProbe`）又收二进制哨兵（`…::sendBeaconProbe`：`i % 251` 的 `Uint8Array` + `Blob{text/plain}`）→ 一条路径两种语义。**风险**：`/beacon` 上的"不可解析"永远无法判死（现按 `RAW_SENTINEL_PATHS` 豁免），且将来把真批次发到 `/beacon` 的用例也拿不到结构校验 |
| ⑥ | **我说错了位置 / 基本已不成立** | `unparsable_batches` **不是** `tools/mock-receiver` 的字段，而是 `tests/e2e/lib/receiver.mjs` 的 `counters.snapshot()` 字段；断言它的用例在 `tools/mock-receiver/src/e2e-receiver-reconciliation.acceptance.test.ts:348-359`（该文件测的是 e2e 侧 receiver，不是 mock-receiver）。而且上一轮（`ccb8855`）已给 receiver 加了 `assertNoUnparsableBatches`，`startReceiver` 默认 `strictUnparsableBatches = true`、`close()` 里调用 → **e2e 侧已经在断言**（按路径）。另：`tools/mock-receiver` 在 `tests/` 里**零消费者**（`grep -rn mock-receiver tests/ tools/ examples/ scripts/` 只命中它自己）→ "在 e2e 侧也断言它"这件事**没有对象**，故不改 |

#### 改法（原则：让检查**真的能失败**；能复用就不重造）

| # | 改法 |
|---|---|
| ① | 新增 `examples/node-import/scripts/verify-build.mjs` 与 `examples/script-tag/scripts/verify-build.mjs`，两个 `build` 脚本改为 `node scripts/verify-build.mjs`。**复用** `examples/webpack/scripts/lib/verify-bundle.mjs` 的 `expectedSdkVersion()` / `createBrowserSandbox()`（不另造验证库）。两种产物形态各自贴合：**node-import（包导入）**用 `import.meta.resolve('@web-report-sdk/browser')` 按真实条件解析 → 断言入口在 `dist/` 下、存在且非空 → 用**裸包名** `import` 真加载 → 断言 `SDK_VERSION` 与包清单一致、`createAssembly` 是函数；**script-tag（IIFE）**从 `index.html` 解析出接入方唯一会加载的 `<script src>` → 断言该文件存在/非空/与包 `exports` 的 `./iife` **是同一个 realpath**（HTML 与包出口防漂移）→ 用 `node:vm` + 同一份最小浏览器面**真解析** IIFE → 断言 `WebReportSDK.SDK_VERSION` 与包清单一致、`createAssembly` 是函数。**行为级**验证（最小投递路径 + Ajv 契约校验）仍只由各自的 `test` 负责，本节不重造。**不**在这里重跑 `packages/browser` 的构建：`gates`/CI 都先跑 `pnpm build`，重跑会把"产物缺失"变成"我刚建出来"，检查失去判别力（产物缺失时脚本 exit 1 并提示先跑 `pnpm build`） |
| ② | 在 `verify-bundle.mjs` 新增**唯一实现** `classifyBrowserEvidence()`（白名单判据）：`pass` / **带非空 reason** 的 `skipped` 才算"已交代"（`accounted: true`），`fail`、未知状态、无理由的 skipped 一律 `accounted: false`。两个 webpack 脚本改为：`checks.browserEvidenceAccounted = evidence.accounted`（dev-server）/ `evidence.accounted`（build-production 的整体 status），并把跳过项**显式记账**到结果 `skipped: ['browser']` + `browser.accounted/reason`，同时在 stdout 打一行 `⚠ 浏览器复核已跳过…`。同步更新 `verify-bundle.d.mts` 声明与两处头注释 |
| ③ | 根 `package.json`：`test:contract` 去掉 `--passWithNoTests`、`test:e2e` 去掉 `--pass-with-no-tests`（**仅此两处脚本改动**）。**判断依据**：两者的用例都来自 **committed 固定路径**（`tests/contract/**` 9 文件 / `tests/e2e` 4 spec，`playwright test --list` 实测 **45 用例**），且**都不存在"本环境合法为空"的情形**——e2e 缺浏览器时 `lib/browsers.mjs::resolveBrowser` 是**显式抛错**（不是跳过），contract 的 include 是写死的目录。所以"收集到 0 个用例"只可能是 include/project/testDir 被改坏 → **对契约测试与端到端测试，0 用例都应当是失败**。（本仓没有"按平台条件生成用例"的 project，因此 `--passWithNoTests` 在这里没有任何合法用途；它唯一的实际作用是掩盖配置损坏） |
| ④ | **只报告**（`tests/e2e/**` 不在本轮可写范围）。建议 e2e lane 在两个 spec 的头注释补一句"探针**手写信封**（固定 `batch_id`/`device_id`/`session_id`）、**只证 transport 层**" |
| ⑤ | **只报告 + 写清风险**（不扩大改动）：若要拆分，建议给浏览器层哨兵单独端点（如 `/beacon-raw`），让 `/beacon` 回到"只承载批次"并从 `RAW_SENTINEL_PATHS` 里摘掉 |
| ⑥ | **不改**（核实结论：位置说错 + e2e 侧已有断言 + mock-receiver 无 e2e 消费者） |

#### 判别性证明（每处都人为制造它应当捕获的失败 → **必须红** → 已恢复）

| 针对 | 注入的失败 | 结果 |
|---|---|---|
| ①（node-import） | 移走 `packages/browser/dist/index.js`（构建产物） | `entryExists=false`、`entryNonEmpty=false`、`status=fail`、**exit 1**；`sha256` 恢复并校验 `OK`；恢复后 exit 0 |
| ①（script-tag） | 移走 `packages/browser/dist/web-report-sdk.iife.js` | `packageIifeExportResolves=false`、`htmlScriptExists=false`、**exit 1**；`sha256` 恢复 `OK`；恢复后 exit 0 |
| ①（script-tag 防漂移） | 把 `index.html` 的 `<script src>` 指向 IIFE 的**副本**（内容相同、路径不同） | `htmlScriptMatchesPackageExport=false`、`htmlScriptIsDistArtifact=false`、**exit 1**（内容相同也拦住"HTML 与包出口漂移"）；`index.html` 按 `sha256` 恢复 `OK`、副本已删 |
| ②（判据白名单） | 用**真实导出**的 `classifyBrowserEvidence` 跑 `pass / skipped+reason / skipped 无 reason / error / skiped（拼写错） / undefined / fail` 七种输入，与旧判据 `status !== 'fail'` 对照 | 旧判据 6/7 判过（只有 `fail` 拦得住）；新判据只放行 `pass` 与带理由的 `skipped`，其余 4 种全部 `accounted:false` |
| ②（集成·无理由的豁免） | 临时把 `build-production.mjs` 的 skipped 返回值去掉 `reason`，用不含 Chromium 的 `HOME` 跑 | `accounted=false`、`skipped=[]`、`status=fail`、**exit 1**；按 `sha256` 恢复 `OK`；恢复后同一 `HOME` exit 0 |
| ②（集成·运行且失败） | 在 `HOME` 下放一个**坏掉的** Chromium 可执行文件（`exit 1`），让 `browserCheck` 真的跑到 launch | `browser.status=fail`、`accounted=false`、`status=fail`、**exit 1**（证明这条检查不是"没跑也不会红"） |
| ②（集成·skipped 显式记账） | 用不含 Chromium 的 `HOME` 跑两个脚本 | exit 0，但结果里 `browser.status=skipped` / `browser.accounted=true` / `reason` 有值 / `skipped=["browser"]`，且 dev-server 的 `checks` 里**不再有** `browserStatusPass: true`（该字段已不存在） |
| ③（contract） | `vitest run --project contract no-such-file.test.ts`（0 用例） | 带 flag 时 **exit 0**（改前，实测）→ 去掉 flag 后 **exit 1**；正常 `pnpm test:contract` = 9 文件 / 191 用例 / **exit 0** |
| ③（e2e） | `playwright test --grep "no-such-title-xyz"`（0 用例） | 带 flag 时 **exit 0**（改前，实测）→ 去掉 flag 后 `Error: No tests found`、**exit 1**；正常用例数用 `playwright test --list` 实测 **45 tests in 4 files**（未跑浏览器） |

#### 回归与报备

- `pnpm examples:build` → **exit 0**；`pnpm examples:test` → **exit 0**（详见下方"本轮回归实测"）。
- `eslint examples` **不是有效信号**：`examples/**` 在 `eslint.config.js:13` 里是**既有** ignore，`eslint examples` 会以
  "all of the files matching the glob pattern are ignored" **exit 2**——这与本次改动无关，也不是失败。
  本轮改动的 `.mjs` 全在 ignore 面内；`docs/**` 同样是既有 ignore。
- 根 `tsc -p tsconfig.json` → **exit 0**（覆盖 `verify-bundle.d.mts` 的新增声明；`tests/**` 在根程序 include 内）。
- 根 `package.json` **只改了两行脚本**：`test:contract` 去掉 `--passWithNoTests`、`test:e2e` 去掉 `--pass-with-no-tests`；其余未动。
- `tests/compat/results/webpack-production.json` / `webpack-dev-server.json` 被 `pnpm examples:*` 覆写。
  **本轮没有用 `git show HEAD:<path>` 恢复**：这两份文件在本轮**开始前就已是修改态**（上一批 lane 的 `pnpm examples:*` 留下的，
  与 HEAD 的差异是 `generatedAt`/端口/`bundleBytes` 等易变字段）。为**不覆盖别人未提交的工作**，改成"运行前快照 → 运行后按 `sha256` 还原回**运行前**内容"，
  效果等价于"本轮不留易变字段痕迹"。**注意**：因此这两份文件相对 HEAD 仍是修改态（那是继承来的状态，不是本轮产生的）。

#### 本轮**额外**发现的"永远不会失败的检查点"（**只报告，未扩大改动范围**）

1. **`tests/compat/**/*.test.ts` 5 个文件从未被执行**——这是本轮最大的一处。`vitest.config.ts` 只定义
   `unit` / `contract` / `security` 三个 project，`vitest list` 实测收集结果：unit **1205** / contract **61** / security **30**，
   `tests/compat` **0 条**；`grep tests/compat /tmp/vitest-list.txt` 零命中。CI 也没有任何步骤跑它们
   （`pnpm test` 只跑那三个 project，`test:contract` 只跑 contract）。**后果**：兼容矩阵的登记守卫
   （`webpack-matrix.test.ts` 断言 `production.status === 'pass'`、`receiver-contract-gate.test.ts` 的 D-06 接收端清单守卫、
   `import-matrix.test.ts`、`apm-coexistence.test.ts`、`degradation.test.ts`）**全部不在门禁里**——
   "证据文件缺失 = 不得下结论"这条守卫今天不会红。（修复需要动 `vitest.config.ts`，属门禁配置变更，未越界改）
2. `scripts/gate-selftest.mjs`（`pnpm gates:selftest`，T08 验收）只覆盖 `lint` / `typecheck` / `size` / `api:check`
   四个门禁；`examples:build` / `examples:test` / `test:contract` / `test:e2e` **没有自检**——本轮修的 3 处恰好都藏在这四个里。
3. 两个 webpack 脚本的 `browserCheck` 探测的是**写死的 macOS 路径**（`$HOME/Library/Caches/ms-playwright/chromium-1223/...`），
   而 CI 的 gates job **不装浏览器** → 兼容矩阵里"Chromium 复核"这一栏在 CI 上**永远是 skipped**。
   本轮只做到"如实记账"；若要真在 CI 上有浏览器证据，需要改成按平台解析（或让 gates job 也装浏览器）——建议单独派工。
4. `examples/event-registry` **没有 `package.json`**，因此 `pnpm -r --filter "./examples/**" run build|test` 对它没有任何覆盖
   （它是纯样例/数据目录）。不是"假检查"，而是"**没有检查**"，登记在此以免被 `examples:*` 的全绿误读为"所有 example 都被验过"。
5. `tests/e2e/leave-slice.spec.mjs:76` 的 `test.skip(({ browserName }) => browserName !== 'chromium' && browserName !== 'webkit', '本机只支持 Chromium / WebKit')`
   是**按浏览器名写死**的跳过，而不是"本机跑不起来就跳过"：在 CI（`playwright install --with-deps`，Firefox 可用）上它**照样跳过**，
   于是 C07-AC-03 的 8 个用例在 Firefox 上**到处都不执行**，而整轮仍然绿。建议改成环境判定（或 `playwright.config.ts` 的
   `testIgnore`/project 级别），别把"本机沙箱限制"固化成"永久豁免"——属 e2e lane，只报告。
6. `eslint.config.js:72` 的"不得跳过测试"规则只覆盖 `**/*.test.ts` / `**/*.spec.ts` / `tests/**/*.ts`，
   **不覆盖 `.mjs` 的 e2e 用例**（`tests/e2e/*.spec.mjs`）——所以上面第 5 条的 `test.skip(...)` 不会被 lint 拦住。
   若认同"也禁止在 `.mjs` 用例里写死跳过"，需要改 `eslint.config.js`（门禁配置，未越界改）。

#### 第 5、6 条 —— **已修**（2026-10-15/16，跳过可见性 lane；依据见 `docs/reports/e2e-real-browser.md` 末尾追加节）

- **先复核实际状态（不照抄本条转述）**：HEAD 上第 5 条描述的那行**已经不在了** —— 另一条 lane 已把它换成
  **运行时真启动探测**（起得来就跑）。但复核发现该探测有 2 处会把"能跑"误判成"起不来"（`context.close()`
  被放在 `try` 里；失败原因未保留），已修；并补上探测结果记账（否则汇总里只会看到 `probeReady=unknown`）。
  **"能跑就跑"这一条成立**：`--project=chromium/--project=webkit` 上探测 `ready=true`，6 条全执行、0 跳过。
- **"跳过不可静默"**：新增 `tests/e2e/lib/skip-audit.mjs`（唯一跳过入口 + `afterEach` 抓旁路跳过判红 +
  每次 `afterAll` 汇总/落 JSON）、`tests/e2e/lib/skip-audit-summary.mjs`（run 级汇总与判定）、
  `tests/e2e/lib/skip-audit-selftest.mjs`（判据的确定性自检，14/14）。
  **某 spec 在某浏览器上全部跳过 = 判红**（理由：整轮仍绿正是本条要消灭的形态；措辞上区分"环境阻塞"与"用例失败"）。
- **第 6 条**：`eslint.config.js` 的"不得跳过测试"规则**已扩到 `.mjs`**
  （`**/*.test.mjs` / `**/*.spec.mjs` / `tests/**/*.mjs`，并保留原先被该块替换掉的 ClassDeclaration 禁令）。
  **误伤处理**：扩规则后 `test.skip(...)` 这一处合法运行时跳过会被拦；没有用"整文件豁免"糊过去，而是把它挪进
  唯一一个受审计的文件 `tests/e2e/lib/skip-audit.mjs`，并在该文件的块里换成**更窄**的形状判据 ——
  只放行 `test.skip(<非字面量表达式>, 原因)`；`test.skip()`、`test.skip(true, …)`、`test.skip(browserName !== …)`
  在**该文件里也报错**（实测，见追加节证明 ②）。
- **同源残留（本轮只报告、未改，需授权）**：`tests/e2e/beacon-quota.spec.mjs:56` 的
  `for (const browserName of ['chromium', 'webkit'])` 也是**写死的引擎名单** —— 它在 Firefox 可用时
  仍然只测 Chromium/WebKit（在 `--project=firefox` 下会重复测这两个引擎），所以
  `docs/reports/e2e-real-browser.md` 里"`--grep C07-AC-03` = 8 个用例"中的另外 2 个
  （`beacon-quota` 的两条）在 Gecko 上依然**取不到数**。它不是 `skip`，本轮的"跳过不可静默"机制覆盖不到它。

---

## D-07（低·文档）：`flush()` 后立刻查计数会读到 0

`integration.md` 第 8.3 节把「`track` 后 `flush`」与「查 M01 计数」写成相邻两步（第 3、4 步），
但 `flush()` 是**异步投递**：实测立刻查 `received_batches` 恒为 0，等一次网络往返后才是 1。
指南未说明这一点，接入方易误判为"上报失败"。

### 建议（归 T34）

在该节加一句：`flush()` 只是**发起**投递，查计数前需等待投递完成
（或轮询计数直到非 0，并设超时）。

### 已修（2026-10-15，T34 执行；附实测数字）

**实测**（`temp/t34-e2e-probe.mjs`，真实装配根 + 真实 HTTP 打 M01）：

```
track() 之后、flush() 之前:   M01 received_batches=0
flush() 返回类型:             undefined, 非 Promise（同步返回 undefined）
调 flush() 后立刻读（无等待）: M01 received_batches=0
等一次网络往返后再读:          M01 received_batches=1
⇒ 立刻=0 / 等待后=1，相差 1
```

**比原条目更精确的一点（原条目的措辞会把下一个人带偏）**：`flush()` **不返回 Promise**，
它同步返回 `undefined`，因此**没有"`await` flush 的 promise"这回事**（写了 `await assembly.flush()`
等于什么都没等）。正确做法是**轮询接收方计数直到非 0（并设超时）**，或等待投递指标
`assembly.delivery.metrics()`（`eventsSent` / `batchesSent` / `batchesFailed`）。

**改法**（`docs/guides/integration.md` 第 8.3 节）：把"`track` 后 `flush`"与"查计数"两步之间
插入明确说明，并在可运行片段里给出**带超时的轮询**（`deadline = Date.now() + 3000`），
使片段在"投递尚未完成"时不会误判失败。

**回归**：修订后的片段实跑 → `exit 0`，`stored_events=1`、`rejected_invalid_structure=0`，
片段在 50 ms 轮询内等到 `received_batches=1`。

---

## D-09（高·SDK）：`createClient({ consent })` 被静默忽略

> 与 D-08 同源：D-08 是**指南片段**少了 `consent: 'granted'`；D-09 是**公共 API 读不到**这个参数。
> 被本缺陷影响的调用方即使按类型提示写了 `createClient({ consent: 'granted' })`，也仍然 `seen = 0`。

### 现象（实测）

- `createClient({ consent: 'granted' }) + init({ appId })` → 未登记（`priority: 'normal'`）事件
  全部被同意门 `deny(consent_denied)` 丢掉，**不报错、不告警**，`seen = 0`；
- 改传 `init({ consent: 'granted' })` → `seen = 2`；
- 对照：同一处的 `createClient({ consent_mode: 'full' })` **是生效的** → 典型的"看起来设了、实际没设"。

### 根因

`packages/core/src/api/client.ts` 把初始同意态**硬编码**为 `'unknown'`、**从不读 `options.consent`**；
而 `ClientOptions extends ClientInitOptions`，`consent` 在该接口里声明为「初始同意状态，缺省 `unknown`」。

### 契约依据（SDK 是错的一方，不需要改契约）

- Q5（`docs/decisions/Q5-consent.md` 第 2 条）：「接入方可以在**初始化参数**中传入已知状态」；
- `ClientInitOptions.consent`（`packages/core/src/api/types.ts:214`）同口径；
- `consent_mode` 的独立来源见 `docs/contracts/remote-config.md` 2.1（与 `consent` 不冲突）。

### 修法（2026-10-15）

```ts
let consent: ConsentState = isConsentState(options.consent) ? options.consent : 'unknown';
```

与 `performInit` 同一套外部输入归一化：非法值按「未传」处理，不把契约外的值写进状态；
`consentMode` 一行未动。

### `consent` 与 `consent_mode` 的关系（回答派工里的问题；未新定口径）

- **两者是两条独立的轴**（同意状态 × 采集/发送策略），不是覆盖关系。判定在
  `packages/core/src/privacy/consent-policy.ts:51`：`state === 'granted' || mode === 'full'` → 放行；
  即"任一满足放行条件即放行"，**两者都传时没有谁优先**，`granted` 与 `full` 效果同为放行。
  `full` **不重写**状态快照（`state().consent` 仍是传入的 `denied`）。
- **同属初始化参数时的先后**：`init({ consent })` **覆盖** `createClient({ consent })`
  （`performInit` 读 `initOptions.consent` 覆盖闭包变量）；`init` 未传时保留 `createClient` 的值。
  这一条**契约没有明文**——本轮**只固化既有实现事实**，未新增口径、未改行为，正反两个方向各有一条用例锁定。
  若负责人认为应当反过来（`createClient` 为准），那是另一个决策，需要改 `performInit`，本轮未动。

### 证据

**用例**（新增，照 `packages/core` 既有测试形态）：`packages/core/src/api/client-consent-option.test.ts`（7 条）
——"granted → 两条 normal 事件都上报"、"denied → `consent_denied` 判定路径与必要事件放行不变"、
`consent` × `consent_mode` 组合、`init` 覆盖 `createClient` 的正反两向。

**fail-first 原文**（修实现之前实跑，`pnpm exec vitest run --coverage.enabled=false --project unit packages/core/src/api/client-consent-option.test.ts`）：

```
× 复现实测形态：createClient({ consent:'granted' }) + init({ appId }) → 两条 normal 事件都上报
    AssertionError: expected [] to have a length of 2 but got +0
× consent 与 consent_mode 是两条独立的轴：consent='granted' + essential_only 仍放行
    AssertionError: expected [] to have a length of 1 but got +0
× consent='denied' + consent_mode='full'：full 是放行条件（OR），但不重写状态快照
    AssertionError: expected 'unknown' to be 'denied'
× init 未传 consent 时不覆盖 options.consent（granted 保留）
    AssertionError: expected 'unknown' to be 'granted'
Tests  4 failed | 3 passed (7)
```

**变异验证**：把 `options.consent` 的读取删回 `let consent = 'unknown'` →
`Tests 4 failed | 3 passed (7)`（上表 4 条全红）；恢复后 `7 passed`。
三要素：**变异**＝`client.ts` 的 `options.consent` 读取点；**用例**＝`client-consent-option.test.ts`；
**判别性断言**＝`expected [] to have a length of 2`（不是"计数变化"这类弱断言）。

**回归**（2026-10-15）：
- `pnpm exec vitest run --coverage.enabled=false --project unit packages/core packages/browser packages/plugins packages/transport`
  → `Tests 1 failed | 1048 passed`；`packages/core` 单独跑 `61 files / 603 tests` **全绿**。唯一红是
  `packages/transport/src/sender/page-leave.test.ts`（"预算不足的尾部仍要计数: expected 2 to be 4"），
  该测试与 `page-leave.ts` 在本轮**开始前就已是工作区里的他人改动**（`git status` 可见），与本缺陷无关，单跑同样红。
- `pnpm exec tsc -p packages/core` → `exit 0`；`pnpm exec eslint packages/core/src` → `exit 0`。
- 未动公共导出面（只读 `options.consent`，无新导出），故未跑 `scripts/api-check.mjs`。

### 顺带核实（只报告、未改）：`options` 里还有哪些"声明了但没读"的字段

静态核对 `grep -n "options\." packages/core/src/api/client.ts` + `performInit` 的读取清单 +
两个**跑完即删**的临时探针（`zz-probe-options` / `zz-probe-init-options`）：

| 字段 | `createClient({…})` | `init({…})` | 证据 |
|---|---|---|---|
| `appId` | **未读** | 读（必填） | 探针：`createClient({ appId:'app-a' }).init({})` → `invalid_args=1`、`initialized=false`、`app_id=undefined` |
| `endpoint` / `token` | **未读**（core `client.ts` 内零读取点） | **未读** | 消费点在装配根 `AssemblyOptions.endpoint/token`（`packages/browser/src/assembly.ts:380`），`createAssembly()` 时求值；`init({ endpoint })` 不会生效 |
| `env` / `release` | 读（批次头） | **未读** | 探针：`init({ env:'prod-x', release:'9.9.9' })` → 批次头仍是 `production`/`0.0.0`；`createClient({env:'prod-x'})` → `prod-x` |
| `extra_mask_rules` | 读（探针：`SECRETVALUE` → `***`） | **未读** | 探针：`init({ extra_mask_rules:[…] })` → 维度仍是 `SECRETVALUE` |
| `consent` | **修前未读 → 已修** | 读 | 本条 D-09 |
| 其余：`consent_mode`、`context`、`url_query_allowlist`、`pageId`、`location`、`debug`、`dictionary`、`onEvent`、`target`、`registry`、`storage`、`erase` | 读 | 读（后四项只属 `ClientOptions`，`init` 不接受） | `grep` 逐字段读取点 |

**结论**：同类（"声明了但没读"）还剩 **`appId` / `endpoint` / `token`（`createClient` 侧）** 与
**`env` / `release` / `extra_mask_rules` / `endpoint` / `token`（`init` 侧）**。性质与 D-09 完全相同
（看起来设了、实际没设、不报错），建议单独立项；本轮**只报告、未改**。

**→ 2026-10-15 后续（发布阻塞点 ⑧ lane）已逐条处置，见文末「十、阻塞点 ⑧ 处置结果」。**

### 文档跟进（`docs/guides/**` 不在本轮可写范围，归 T34）

`docs/guides/integration.md` 第 8.2 节的新注记仍写着「`createClient({ consent: 'granted' })` 目前被**静默忽略**
（只有 `init(...)` 里的 `consent` 生效…）」——**修复后这句已过期**：两种写法现在都生效，
`init({ consent })` 覆盖 `createClient({ consent })`。该句应由 T34 更新。

---

## 附：本任务**自己犯过、并已修正**的探针错误（如实记录）

排查 D-01/D-02 的过程中，我的探针本身写错过三次，**差点把"我写错了"报成"SDK 缺陷"**。
记在这里，因为它们与上面几条缺陷是同一类风险：

1. **端点**：我先照指南写了 `/ingest`，得到"零投递"，一度以为是装配根缺陷 —— 实际是
   D-03（端点写错）。**先怀疑文档/自己的输入，再怀疑实现。**
2. **`device_id` / `session_id`**：我用了 `placeholder-device-0000` 这类"看起来像占位"的字符串，
   而契约里它们是 `$defs/uuid`（M01 按 v4 正则校验）→ 我的自查探针自己得到 400。
   占位值也**必须形状合法**（已改为 `00000000-0000-4000-8000-…`）。
3. **信标令牌形状**：我写成 `auth: { token }`，契约/M01 要的是 `auth: { write_token, app_id }`
   → 401，我一度把 RR-03 报成"接收方不支持信标通道"。同理，**跨 app 探针必须同时改
   `x-app-id` 头与 `body.app_id`**，否则得到 `app_id_mismatch` 400。

这三处的共同教训与 `docs/reports/handover.md` 第 4 节的既有流程口径一致：
**"实测失败"不等于"实现有缺陷"，先证明探针自己是合法输入。**

---

## 十、阻塞点 ⑧ 处置结果（2026-10-15，发布阻塞点 lane；逐条核定 + 修复）

出处：T35 发布检查表列出的发布阻塞点 ⑧；口径裁定由编排方给出（2026-10-15）。
本节记录**已修/已核定 + 依据**，修订上文「顺带核实」表的"本轮只报告、未改"。

**逐条处置**（探针均先复现旧行为，再改）：

| 参数 | 处置 | 依据 |
|---|---|---|
| `createClient({ appId })` | **(a) 生效**：构造面播种 `appId`，`init({ appId })` 覆盖（与 `consent` 同序）；两处都没有才计 `invalid_args` | 与 D-09 同一先例；`ClientInitOptions.appId` 注释即「必填且非空」 |
| `init({ env })` / `init({ release })` | **(a) 生效**：init 覆盖构造值；未传保留构造值，都缺省仍是 `production` / `0.0.0` | 同上；批头 provider 改为读可变来源（映射类型去 `readonly`，不改公共类型） |
| `init({ extra_mask_rules })` | **(a) 生效且只能追加**：追加到构造面规则集，不覆盖、不关闭内置 7 条；重建 masker 后由字段约束处理器与 `clampAndTrack` 共用 | 脱敏取保守方向（只能加掩码）；与契约「内置规则不可整体关闭」一致 |
| `createClient({ endpoint })` / `init({ endpoint })` | **(b) 显式拒绝**：计 `invalid_args` + 发 `dropped:'field'` / `field:'endpoint'` 诊断（`ASSEMBLY_ONLY_FIELDS`）；`endpoint` 唯一生效入口是 `AssemblyOptions.endpoint` | core 没有网络，不可能消费；真正消费点是装配根凭据端口 → C07 发送器 |
| `createClient({ token })` / `init({ token })` | **(b) 显式拒绝**（编排方 2026-10-15 裁决 A，与 `endpoint` 一致）：计 `invalid_args` + 发 `dropped:'field'` / `field:'token'` 诊断（**只带字段名，不带令牌值**）；唯一的生效入口是 `AssemblyOptions.token` | 同 `endpoint`；「token 绝不进入诊断/日志」的既有意图原样保留，只更新「token 会被拒绝」带来的计数与序列期望 |

**判别性证明（三要素，2026-10-15 实跑）**：变异点均为 `packages/core/src/api/client.ts` 的读取点，
用例为 `api/client-declared-options.test.ts`（15 条）与 `browser/src/assembly-init-options.test.ts`（2 条）：

| 变异 | 判别性断言（红） |
|---|---|
| 去掉构造面 `appId` 播种 | `expected 1 to be +0`（invalid_args） |
| 去掉 `init` 读 `env` | `expected 'production' to be 'prod-x'`；`expected 'ctor-env' to be 'init-env'` |
| 去掉 `init` 读 `release` | `expected '0.0.0' to be '9.9.9'` |
| 去掉 `init` 追加 `extra_mask_rules` | `expected 'value=SECRETVALUE' to be 'value=***'`；二次施加用例 `expected 'x' to be 'xx'` |
| 清空 `ASSEMBLY_ONLY_FIELDS` | `expected +0 to be 1`（invalid_args）；装配路径同断言 |
| 把 `token` 移出拒绝清单 | `client-declared-options`：`expected +0 to be 2`；`public-api.test.ts`：`expected [ 'invalid_event_name', …(2) ] to deeply equal [ Array(5) ]`、`expected [ …(2) ] to have a length of 3 but got 2` |
| 让诊断记录带上令牌值 | `expected '[{"reason_code":"invalid_args",…' not to contain 'placeholder-write-token-0002'` 与 `expected 'token=top-secret-token' to be 'token'` —— 证明「不泄漏」断言**仍可失败**（没有被改宽成空转） |

恢复后 `sha256` 逐字一致；回归：`vitest --project unit packages/{core,browser,transport,plugins}` =
124 files / 1082 tests 全绿；`tsc -p packages/core`、`tsc -p packages/browser`、`eslint packages/core/src packages/browser/src`、
`node scripts/api-check.mjs`（4 包 ok，未动导出面）全部 exit 0。

**被授权修改的既有断言（裁决 A；逐条说明"事实变了"而非"标准松了"）**——
`api/public-api.test.ts` 的两条 C01-AC-12 用例（`token` 现在会被拒绝，故诊断流多出 `invalid_args`）：

| 位置 | 改前期望 | 改后期望 | 为什么是事实变了 |
|---|---|---|---|
| `:492` 记录序列 | `['invalid_event_name','non_finite_metric','invalid_args']`，且 `records[0/1]` 指后两条 | `['invalid_args','invalid_args','invalid_event_name','non_finite_metric','invalid_args']`，`records[0/1]` 为两条 `field:'token'`、`records[2/3]` 为原来的两条 | 新增两条记录是**新事实**（`createClient({token})` 与 `init({token})` 各拒绝一次），不是把旧期望改宽 |
| `:516` console 行数 | `toHaveLength(2)` | `toHaveLength(3)`，并**新钉** `lines[0]` 含 `invalid_args` / `field=token`，`lines[1/2]` 仍是原来的两条 | 多出的一行是 `init({token})` 的字段级拒绝告警 |
| 两者共同的"不泄漏"断言 | `not.toContain('top-secret-token')` | **原样保留**（未放宽、未删除），并由上表最后一行变异证明仍可失败 | 意图（token 值不得进入诊断/日志）不变 |

**顺带核查（⑥，只报告；`packages/plugins/src/**` 不在本 lane 可写范围）**——按接口归属包限定作用域
静态核对 `ClientInitOptions`（15）/`ClientOptions`（19）/`AssemblyOptions`（25）的每个字段，另加探针实测：

- `ClientInitOptions` 只剩 `endpoint` / `token` 在 core 无读取点 → **两者均已按上表显式拒绝**（不再是静默忽略）；
- `AssemblyOptions` 25 个字段**全部**有读取点；
- **新增发现（C05 配置面，建议单独立项）**：
  1. `ErrorPluginOptions.reportRepeats`（`plugins/src/error/plugin.ts:41`）零读取点，探针 true/false 结果逐字相同；
     且 `error/edge-cases.test.ts:156`「reportRepeats 开启时窗口内每条都上报」是**空转用例**——断言
     `events.length===1 && count===3`，正是 `reportRepeats=false` 的默认分支（用例名与断言相反）。
  2. `ErrorPluginOptions.sources`（`:43`）全仓零读取点；探针 `sources: []` 仍照常采集 `window_error`。
  3. `RoutePluginOptions.match`（`route/types.ts:44`）零读取点；route 插件只读 `mode` / `templates`。
  4. 装配根安装 error 插件时未接 `sources` / `reportRepeats`（`browser/src/assembly.ts:465`）→ 生产路径不可达。

**→ 2026-10-15 后续（C05 采集插件 lane）已逐条核定 + 处置 + **补判别性证明**，见文末「十一、C05『声明了但没读』处置结果与判别性证明」。**

**文档跟进（不在本 lane 可写范围）**：`endpoint` / `token` 的「属装配根、core 面会被拒绝」已写进
`packages/core/src/api/types.ts` 与 `packages/browser/src/assembly.ts` 的字段注释；接入指南的对应说明归 T34。

---

## 十一、C05「声明了但没读」处置结果与判别性证明（2026-10-15 补做 lane）

出处：`b6e8dea`（按上文「十」末尾的登记：该批**改了代码但没留报告**，两件遗留未产出——
① 三条关键用例的**判别性证明**；② `packages/plugins/src` 的**同类核查结论**）。本节补上这两件。

**本节所有行号以工作区当前文件为准**（与 `b6e8dea` 提交时一致；本 lane 未改任何实现文件）。

### 11.1 三条关键用例的变异三要素（实跑）

命令模板（`<file>` 为被变异文件）：
`pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins/src/error/edge-cases.test.ts`

| # | 变异点（临时回退） | 被执行命令 | 具体红断言原文 |
|---|---|---|---|
| M1 | `error/plugin.ts:165` `const reportRepeats = options?.reportRepeats === true;` → `const reportRepeats = false;`（即**不再读**该字段，回到 D-09/C05 的"声明了但没读"原状） | 同模板 | `:156`「reportRepeats 开启时窗口内每条都上报」红：`AssertionError: expected [ 3 ] to deeply equal [ 1, 2, 3 ]`（`edge-cases.test.ts:165:56`）；`Tests 1 failed | 15 passed (16)` |
| M2 | 同 `:165` → `const reportRepeats = true;`（恒开，用于打**对照条**） | 同模板 | `:170`「对照：reportRepeats 关闭（缺省）时同一输入只上报一条」红：`AssertionError: expected [ 1, 2, 3 ] to deeply equal [ 3 ]`（`edge-cases.test.ts:178:56`）；`Tests 1 failed | 15 passed (16)` |
| M3 | `error/plugin.ts:229` `isSourceEnabled` 恒 `true`（白名单永不生效） | 同模板 | `:182`「sources 白名单」红：`AssertionError: expected [ { …(6) }, { …(6) } ] to have a length of 1 but got 2`（`edge-cases.test.ts:192:20`）；**同时** `:196`「sources 为空数组时不采集任何源」红：`…to have a length of +0 but got 2`（`:206:20`）；`Tests 2 failed | 14 passed (16)` |

**判别力要点（回应"它存在的意义就是曾经空转"）**：M1 是**唯一**能让 `:156` 变红的变异，
且 `:156` 在 M1 下**确实红**（见上）；反过来 `:170` 在 M1 下**保持绿**、在 M2 下才红——
**两侧各自可被独立打死**，说明这一对**不是**"同一断言的两次重复"，而是真正的开/关对照。
`:182` 在 M3 下与 `:196` 一起红，说明白名单的"排除侧"与"空数组侧"都被钉住。

### 11.2 同批其余改动的变异三要素（实跑）

| # | 变异点 | 被执行命令 | 红断言原文 |
|---|---|---|---|
| M4 | `route/plugin.ts:94` `options?.match ?? createMatcher(options?.templates ?? [])` → `createMatcher(options?.templates ?? [])`（`match` 回到零读取点） | `…--project unit packages/plugins/src/route/edge-cases.test.ts` | 「options.match 自定义匹配器优先于 templates，且确实被调用」红：`AssertionError: expected [] to deeply equal [ '/task/99' ]`（`route/edge-cases.test.ts:69:18`）；`Tests 1 failed | 9 passed (10)`。同文件 `:73` 对照条保持绿 |
| M5 | `browser/src/assembly.ts:483` 删掉 `...(errorOptions ?? {})`（装配根对 `errorPlugin` 回到零读取点） | `…--project unit packages/browser/src/assembly-error-plugin-options.test.ts` | ①「reportRepeats: true 时…count 累计（1/2/3）」红：`AssertionError: expected [ 3 ] to deeply equal [ 1, 2, 3 ]`；②「sources 白名单在装配路径上生效」红：`expected [ { …(9) }, { …(9) } ] to have a length of 1 but got 2`；`Tests 2 failed | 2 passed (4)` |
| M6 | `browser/src/assembly.ts:478` 改成让 C04 端口优先（把接入方 `globalContext` 顶掉） | 同上 | 「接入方显式提供的 globalContext 不被装配根的 C04 端口静默顶掉」红：`AssertionError: expected undefined to be 'acme' // Object.is equality`；`Tests 1 failed | 3 passed (4)` |

### 11.3 恢复后 `sha256` 一致性（硬要求）

变异用**先备份再 `cp` 恢复**（备份在 `/tmp`，不落仓库）。恢复后逐文件 `sha256sum -c`：

```
packages/plugins/src/error/plugin.ts                OK   0a0687bbf55845027cbc45225a534a7e86c4fe0c2d4eef0e95a84c4544b02fb9
packages/plugins/src/error/edge-cases.test.ts       OK   036d4a64d25e0d044caf16027526df18b0360bb4276c00f98e680cfda0347f58
packages/plugins/src/route/plugin.ts                OK   0a50e3babb22a66ec65bcb166761fafc363eead062a12ca1bf7c527f7c3f0f5d
packages/plugins/src/route/types.ts                 OK   ada988a169435add74ae6b9444137f84cf7f0eef841e1131dd01be7eca8ea4a7
packages/plugins/src/route/edge-cases.test.ts       OK   c01c97368754df8631dbaf4dc041445d1889a7fdda2cb95cfc494d910ad4b556
packages/browser/src/assembly.ts                    OK   a18cd8e784e60472260080bb61ca340848137c30777bd704b7991c3a2b1ab961
```

`git diff --stat -- packages/plugins packages/browser` 为空（除探针/变异外**零残留改动**）。
探针另动过 `http/plugin.ts`、`apm-dual-write/create-plugin.ts`、`perf/vitals.ts`，恢复后 sha256：
`b4f58368…` / `c753a9c5…` / `792d828e…`（三文件均无 `git diff`）。

### 11.4 行为**真的生效**（不只是"读了字段"）——开/关可观测差异

| 行为 | 关闭（缺省） | 开启 | 观测点 |
|---|---|---|---|
| `reportRepeats` | 同一输入 3 次 → **1 条**事件，`metrics.count = 3`、`collapsed = 2` | 同一输入 3 次 → **3 条**事件，`count = [1,2,3]`、`collapsed = 0` | 插件面：`edge-cases.test.ts:156` vs `:170`；**装配面**：`assembly-error-plugin-options.test.ts:111` vs `:121`（`expected [1,2,3]` vs `[3]`） |
| `sources` | 全部源参与：`window_error` 与 `unhandled_rejection` **各 1 条** | `sources:['window_error']` → 只 1 条且 `source=window_error`（拒绝值**不归一化、不上报**）；`sources:[]` → **0 条**（含自动监听路径） | 插件面 `:208`/`:222`/`:235`；装配面 `:131` |

差异不是"计数多了一个"这类弱证据，而是**事件条数与每条 `count` 序列同时改变**（`[3]` ↔ `[1,2,3]`），
且 M1/M2/M5 证明这两侧**各自可失败**。

### 11.5 同类核查结论：`packages/plugins/src` 还有没有"声明了但没读"/空转用例？

**方法**（三类证据叠加，不只靠 grep）：
1. **静态逐字段核对**：对每个 `*Options` 接口用 `awk` 抽出**全部** `readonly` 字段，再在 `packages/*/src` 内找
   `options?.<field>` / `ports?.<field>` 形式的**读取点**（并排除接口声明自身的匹配）；
2. **探针实测**（新方法，用来抓"读了但没人证明"）：把字段**钉成常量**（`??` 两侧各一次），
   跑该插件的全部单测——**全绿 = 该字段没有任何用例证明它生效**；
3. **"名字声称某行为"的用例抽查**：重点看判据里应同时存在"开启/关闭"两侧的用例名。

#### (a) 字段表：读取点与判别性覆盖

| 接口（文件） | 字段 | 实现读取点 | 有判别性用例？ |
|---|---|---|---|
| `ErrorPluginOptions`（`error/plugin.ts`） | `captureResourceErrors` | `:309`（`attach`） | ✅ 探针：恒 true → 3 红；恒 false → 1 红（`:103`/`:119` 双侧） |
| | `reportRepeats` | `:165`（`settle`/`observe` 消费于 `:209`/`:248`） | ✅ M1/M2 + `:156`/`:170` |
| | `sources` | `:166`（`isSourceEnabled` `:228`） | ✅ M3 + `:208`/`:222`/`:235` |
| | `now` | `:163`（`emit` 的 `occurred_at`、`dedup` 计时） | ✅ 探针 R：恒 `Date.now()` → 1 红（`capture.test.ts:282`；本 lane 在 `:238` 前置入新用例后，由原 `:238` 下移） |
| | `windowMs` | `:164` → `createDeduplicator({windowMs})` | ✅ **已补**（本 lane 归位）：`error/capture.test.ts:238`（配 10ms，见 §11.6；M7 可杀） |
| | `globalContext` | `:185`（`emit` 合并进 `context`） | ✅ `assembly-error-plugin-options.test.ts:141` + M6 |
| | `onLeave` | `:371`（注入端口优先） | ✅ 探针 C：跳过注入 → 1 红（`capture.test.ts:315`/`:335` 双侧；同上行号下移） |
| `RoutePluginOptions`（`route/{plugin,types}.ts`） | `mode` | `:92`（`readPath` `:106`、`attach` `:177`/`:181`） | ✅ 探针 J：恒 `manual` → 6 红；探针 P：hash 分支失效 → 3 红 |
| | `templates` | `:94` | ✅ 探针 K：恒 `[]` → 4 红 |
| | `match` | `:94` | ✅ M4 + `edge-cases.test.ts:63` |
| `HttpPluginOptions`（`http/plugin.ts`） | `traceScope` | `:206` | ✅ 探针 F：恒 `undefined` → 1 红；恒 `{}` → 5 红 |
| | `traceContextProvider` | `:208` | ✅ 探针 G：恒 `undefined` → 1 红 |
| | `urlTemplate` | `:195` → `:222` `url_template` | ✅ **已补**（本 lane 归位）：`http/privacy.test.ts:51`（注入值断言，见 §11.6；M8 可杀） |
| `ApmDualWriteOptions`（`apm-dual-write/create-plugin.ts`） | `forward` | `:137`（`:152` 消费） | ✅（`apm-dual-write.test.ts` 直接注入并断言转发） |
| | `resolve` | `:138`（`:152` 惰性解析） | ✅（含"未加载时记 `processor_error`"用例） |
| | `fieldMap` | `:134` | ✅ 探针 L：恒 `{}` → 2 红 |
| | `constants` | `:135` | ✅ 探针 N：恒 `{}` → 1 红 |
| | `eventTypes` | `:136` | ✅ 探针 M：恒 `[]` → 7 红 |
| `VitalsAccumulatorOptions`（`perf/vitals.ts`） | `now` | `:79`（`:128`/`:133` 组事件时的 `occurred_at`） | ✅ **已补覆盖 + 已做实跑变异（2026-10-16，见 §11.8）**：新增 `perf/vitals.test.ts:203`–`:290`（3 条用例，注入 `now` 后断言 `take()` 出的事件 `occurred_at` 等于注入值）。本轮先复核"无判别性覆盖"**仍成立**：`:79` 钉成 `Date.now` → 124/124 全绿；补齐后同一次钉常量复核 → **3 红** |
| | `responseStartProvider` | `:80`（`:125` 消费） | ✅ 探针 O：恒 `undefined` → 2 红 |
| `CoexistenceInitOptions`（`coexist/index.ts`） | `apmCoexistence` | `:56`/`:58` | ✅ `coexist/defaults.test.ts` 两份缺省表对照 |

**结论 (a)**：`packages/plugins/src` 的 `*Options` **没有任何字段是"零读取点"**——
上文「十」登记的四条（`reportRepeats` / `sources` / `match` / 装配根接线）均已由 `b6e8dea` 修实，
本 lane 逐字段复核确认**读取点真实存在且被消费**。
`AssemblyOptions.errorPlugin`（`browser/src/assembly.ts:475`/`:478`/`:483`）也已接线并有 4 条装配面用例（M5/M6 可杀）。

#### (b) 有问题的用例清单（**当时只报告；现已按裁定补齐，见 §11.6**）

1. **`ErrorPluginOptions.windowMs` —— 读取点在，但没有任何用例证明它生效（"名字声称的配置行为"未被测）。**
   **→ 2026-10-15 裁定"两条都补"，已补（本 lane 归位）：`error/capture.test.ts:238`，见 §11.6。**
   - 判定依据：探针 Q（`error/plugin.ts:164` 钉成 `DEFAULT_DEDUP_WINDOW_MS`）→ `Tests 35 passed (35)`，
     **全绿**；即把该字段改成"忽略配置"没有任何用例会红。
   - 原因（读代码可知）：唯一涉及它的用例 `capture.test.ts:282`「窗口到期自动结算（1 秒后上报）」
     **传的就是 `windowMs: 1000`**（现 `capture.test.ts:298`；原 `:238`/`:254`，被本 lane 在 `:238` 前置入新用例后下移），与缺省 `DEFAULT_DEDUP_WINDOW_MS`（1000）
     **同值**，且时钟只推进 `1000`——传与不传无法区分。该用例实际证明的是**缺省 1 秒语义**，不是**配置项语义**。
   - 判定：**不是空转用例**（它自身断言有效、且真能失败），但**该配置项缺判别性用例**。

2. **`HttpPluginOptions.urlTemplate` —— 读取点在，但没有任何用例注入过它。**
   **→ 已补（本 lane 归位）：`http/privacy.test.ts:51`，见 §11.6。**
   - 判定依据：① `grep -rn urlTemplate`（全仓 `src`/`tests`/`docs`）只有两处读取点（`http/plugin.ts:195`/`:222`）
     与接口声明，**无任何测试引用**；② 探针 E（`:195` 钉成 `defaultUrlTemplate`）→ `Tests 29 passed (29)`，
     **全绿**；而探针 I（钉成 `() => 'CONST'`）→ 1 红，说明变红的是**缺省去参数**行为，不是**注入**行为。
   - 判定：读取点真实（`options?.urlTemplate ?? defaultUrlTemplate`），**但"注入自定义模板会生效"未被任何用例证明**。

3. **"名字声称某行为"的抽查：未发现新的空转用例。** 逐条看了判据里应含"开启/关闭"两侧的用例名：
   `error/edge-cases.test.ts:103/:119`（`captureResourceErrors` 双侧 ✅）、`:156/:170`（`reportRepeats` 双侧 ✅）、
   `:208/:222/:235`（`sources` 三侧 ✅）、`route/edge-cases.test.ts:63/:73`（`match`/`templates` 双侧 ✅）、
   `coexist/defaults.test.ts`（共存/非共存两表，且 `:39` 有"非空转对照" ✅）、
   `http/trace-header.test.ts:118`（"未配置追踪范围时不注入"——单侧命名，但同文件已有配置侧注入断言 ✅）。
   **均无"名字与断言相反"的遗留**；上一轮那条（原 `:156`）已由 `b6e8dea` 修成真用例。

4. **`VitalsAccumulatorOptions.now` —— 本 lane 2026-10-16 复核时**新发现**：读取点在（`perf/vitals.ts:79`），
   但 §11.5(a) 表里"✅（探针口径同 error `now`）"是**未经实跑的推断，且复核为假**。**
   判定依据（钉常量法）：`:79` → `const now = ((): number => Date.now());` → `packages/plugins` **121/121 全绿**、
   `packages/plugins/src/perf` **11/11 全绿**；且 `perf/*.test.ts` 无任何 `occurred_at` 断言。
   即把该字段改成"忽略配置"没有任何用例会红 ⇒ **该字段没有判别性用例**。
   影响面：`perf/plugin.ts:79` 会把 `ports.now` 传进该字段，所以插件面注入的时钟同样不被任何断言钉住。
   **处置：只报告，未动手**（`packages/plugins/src/perf/**` 不在本 lane 可写范围）。
   **补记（2026-10-16，后续 lane）：已按下方修法建议补齐，并做实跑变异（3 红），见 §11.8。**
   修法建议（交给有 `perf/` 所有权的人）：照 `error` 的 `now` 探针 R，加一条"注入 `now` → 断言 `take()` 出的事件
   `occurred_at` 等于注入时钟"的用例，再对 `vitals.ts:79` 做一次钉常量确认变红。

#### (c) 判定依据与处置建议汇总

| 项 | 性质 | 依据 | 处置 |
|---|---|---|---|
| `reportRepeats` / `sources` / `match` / `assembly.errorPlugin` | 已修实 | §11.1/§11.2 变异三要素 + §11.4 开/关差异 | **无需处置**（本 lane 已补证明） |
| `ErrorPluginOptions.windowMs` | 读取点在，原本**配置语义无判别性用例** | 探针 Q 全绿；`capture.test.ts:298` 传同值 1000 | **已按裁定补用例**（`error/capture.test.ts:238`，§11.6，M7 可杀） |
| `HttpPluginOptions.urlTemplate` | 读取点在，原本**注入语义无用例** | 全仓零测试引用；探针 E 全绿 | **已按裁定补用例**（`http/privacy.test.ts:51`，§11.6，M8 可杀） |
| `VitalsAccumulatorOptions.now` | 读取点在，**原表漏判为 ✅，实为无判别性用例** | 2026-10-16 钉常量复核：`:79` 钉成 `Date.now` → 121/121 全绿 | **已补覆盖 + 已做实跑变异**（`perf/vitals.test.ts:203`–`:290`，见 §11.8；补齐前后两次钉常量结果见 §11.8） |
| 其余 `*Options` 字段 | 读取点 + 判别性用例均齐 | §11.5(a) 表；2026-10-16 本 lane 对**除上两条外的其余 19 个读取点**逐点钉常量复核，**18 红 / 1 绿**（绿者即上行的 `vitals.now`） | 无需处置 |

> 注：§11.5 的 **实现文件零改动**（`git diff` 对 `error/plugin.ts`/`http/plugin.ts`/`assembly.ts`/`route/plugin.ts`/
> `perf/vitals.ts`/`coexist/index.ts`/`apm-dual-write/create-plugin.ts` 全部为空），
> 只**新增两条测试**（最终落位：`error/capture.test.ts`、`http/privacy.test.ts`）并补写本节与 §11.6/§11.7。
> 2026-10-16 归位说明：两条用例最初被落在 `error/edge-cases.test.ts` 与 `http/trace-header.test.ts`；
> 本 lane 判定 ① `edge-cases.test.ts` 的 `createContext()` 返回 `Record<string, unknown>`，要装上去**必须**
> `as unknown as` 强转（本仓禁用），② `trace-header.test.ts` 的 describe 归属 AC-12，把 `url_template` 断言放在那里
> 属**挂错 AC**，故两处改动**已全部回退到 HEAD**（该两文件 `git diff` 为空），只保留本 lane 重新落位的两条。
> 另：`http/trace-header.test.ts:118` 的既有用例未被改动。

### 11.6 两条补做的判别性用例（2026-10-15 裁定"两条都补"后实做）

裁定口径：**"一个公共选项没有判别性用例"与"一个检查不会失败"是同一类事**——选项可以被改坏而没有任何测试会察觉；
故"每个 `*Options` 字段都必须有判别性用例"为硬口径。

**最终落位（2026-10-16 本 lane）**：两条用例分别补在 `error/capture.test.ts:238` 与 `http/privacy.test.ts:51`。
为什么不在最初落盘的位置：`error/edge-cases.test.ts` 的 `createContext()` 返回 `Record<string, unknown>`，
不改既有 helper 就只能靠 `as unknown as` 强转（本仓禁用）；`http/trace-header.test.ts` 的 describe 归属 AC-12，
把 `url_template` 断言放那儿属**挂错 AC**。**两处最初落盘已整体回退到 HEAD**（两文件 `git diff` 为空）⇒ 不存在重复用例。

| # | 新用例 | 被测字段的读取点 | 变异三要素（临时回退 → 必须红 → 恢复） |
|---|---|---|---|
| M7 | `error/capture.test.ts:238`「判别力：windowMs 生效——传 10 ms 时窗口内合并、到 10 ms 结算、窗口外另起一条」 | `error/plugin.ts:164` → `createDeduplicator({windowMs})` | 变异：`:164` → `const windowMs = DEFAULT_DEDUP_WINDOW_MS;`（即不再读该字段）；命令：`pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins/src/error/capture.test.ts -t "判别力：windowMs 生效"`；**红断言原文**：`AssertionError: 到 windowMs=10 必须结算（缺省 1000 ms 在此刻不会结算）: expected [] to have a length of 1 but got +0`（`capture.test.ts:269:62`），`Tests 1 failed | 12 skipped (13)` |
| M8 | `http/privacy.test.ts:51`「注入自定义 urlTemplate 后 dimensions.url_template 用注入值（判别：与缺省「去查询参数」的结果不同串）」 | `http/plugin.ts:195` → `:222` `url_template` | 变异：`:195` → `const urlTemplate = defaultUrlTemplate;`（即不再读该字段）；命令：`pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins/src/http/privacy.test.ts -t "注入自定义 urlTemplate"`；**红断言原文**：`AssertionError: 必须使用注入的 urlTemplate: expected '/api/task/42' to be '/x/:id' // Object.is equality`（`privacy.test.ts:69:71`），`Tests 1 failed | 2 skipped (3)` |

**为什么这两条真的能区分"传了"与"缺省"**（不是把同值再写一遍）：
- M7 传 `windowMs: 10`（与缺省 1000 **不同值**，这正是原用例 `capture.test.ts:282` 传 `1000` 的病）。
  假时钟 t=0 首条、t=5 重复（窗口内必须合并）、t=10 触发内核定时器：配置生效 → `due(10)` 成立 → 结算 1 条且 `count=2`；
  配置被忽略（仍按 1000 判定）→ **0 条**，M7 的红断言正是后者。结算后 t=10 再报一条、t=20 结算 → 第 2 条 `count=1`，
  钉住"窗口外另起一条"，顺带排除"永不结算"式的假通过。
- M8 注入 `() => '/x/:id'`，实参 URL 为 `/api/task/42?token=…#frag`：注入生效 → `/x/:id`；
  被忽略 → 缺省实现去 `?`/`#` 得 `/api/task/42`（**逐字不同**）。M8 的红断言原文正是这两串的对比。

**恢复与 sha256 一致性（硬要求）**：变异一律"先 `cp` 备份到 `/tmp` 再 `cp` 恢复"，恢复后与基线逐文件比对，**逐字节一致**：
`error/plugin.ts 0a0687bbf55845027cbc45225a534a7e86c4fe0c2d4eef0e95a84c4544b02fb9`、
`http/plugin.ts b4f583680cfdefd2e5104e57500b53a56a9cfa0f9711ae9619e228e7176c7551`；
本节 §11.7 复核动过的另四个实现文件恢复后为
`route/plugin.ts 0a50e3babb22a66ec65bcb166761fafc363eead062a12ca1bf7c527f7c3f0f5d`、
`perf/vitals.ts 792d828eaf5b61e772c74e2ecdae70df4ff4fde2f9ddd0750cb2c5e9654ddd93`、
`coexist/index.ts 49175f52b5311fa76a5f42e327ca32c022f777a5b26484ed897b9db586087af0`、
`apm-dual-write/create-plugin.ts c753a9c5d1df5a7614cfffe1b9ebf2e4333771d3728f32db32cc6615797d7d19`；
六个文件 `git diff` 全为空。

**回归**（最终状态实跑）：`pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins`
= **20 files / 121 tests 全绿**（补前 119，**+2** 即这两条）；`tsc -p packages/plugins` exit 0；`eslint packages/plugins/src` exit 0。

### 11.7 同批钉常量复核新发现：`VitalsAccumulatorOptions.now` 无判别性用例（只报告）

同一次复核把 §11.5(a) 表里**除 M7/M8 字段外的 19 个读取点**逐点钉成常量，只有一处全绿：

```
GREEN | V1_vitals.now  ← packages/plugins 121/121 全绿；packages/plugins/src/perf 11/11 全绿
RED   | E1_error.now / E3_reportRepeats / E4_sources / E5_globalContext / E6_captureResourceErrors / E7_onLeave
RED   | H2_traceScope / H3_traceContextProvider
RED   | R1_mode / R2_templates / R3_match
RED   | V2_responseStartProvider
RED   | A1_forward / A2_resolve / A3_fieldMap / A4_constants / A5_eventTypes
RED   | C1_apmCoexistence
```

判定：`VitalsAccumulatorOptions.now`（`perf/vitals.ts:44`，经 `perf/index.ts:25` → 包入口 `src/index.ts:18` 可达）
**读是读了**（`:79` → `:128`/`:133` 组事件时的 `occurred_at`），但把它钉成 `((): number => Date.now())` 后**没有一条用例会红**
⇒ 与改动前的 `windowMs`/`urlTemplate` 同类：**该选项可以被改坏而测试察觉不到**。
故 §11.5(a) 原表该行的"✅（探针口径同 error `now`）"是**未实跑的推断，已复核为假**，本轮已在表中改标 ❌。
`perf/plugin.ts:79` 会把 `ports.now` 传进该字段，所以插件面注入的时钟同样不被任何断言钉住。

**处置：只报告，未动手**——`packages/plugins/src/perf/**` 不在本 lane 可写范围，且修法是**新增断言**（不是纯探针）。
建议交给有 `perf/` 所有权的人：照 error 侧探针 R，加一条"注入 `now` → 断言 `take()` 出的事件 `occurred_at` 等于注入时钟"，
再对 `vitals.ts:79` 做一次钉常量确认变红。

**回归口径注明**：本节 121/121 是**当前工作区**的结果，它**包含**其他 lane 已落盘的内容——
`tests/compat/results/*.json`、`vitest.config.ts`（新增 `compat` project；与本 lane 的 `--project unit` 无关）、
`tests/e2e/*` 及其两个新文件（**本 lane 未触碰、也未运行 e2e**，按纪律禁止）。本 lane 自身改动只有三处：
`packages/plugins/src/error/capture.test.ts`（+1 用例）、`packages/plugins/src/http/privacy.test.ts`（+1 用例）、本报告；
另外**回退了另一条 lane 最初落盘的两处测试改动**（`error/edge-cases.test.ts`、`http/trace-header.test.ts` 现为 HEAD 原样）。
本 lane **未做任何 git 写操作**；未改任何实现文件、契约、决策、验收用例、门禁配置。

### 11.8 `VitalsAccumulatorOptions.now` 已补覆盖（2026-10-16，后续 lane 收口）

§11.7 是**只报告**的发现。本节把它补成"有判别性用例 + 实跑变异"，并给出"除本处外其余读取点 18/19 已红"
这句话在**补测后**的复核结果。**本轮实现文件零改动**（`perf/vitals.ts` 恢复后 sha256 逐字节等于基线
`792d828eaf5b61e772c74e2ecdae70df4ff4fde2f9ddd0750cb2c5e9654ddd93`，`git diff` 为空）。

**新增用例（只加不改）**：`packages/plugins/src/perf/vitals.test.ts:203`–`:291`，3 条，全部走
`createVitalsAccumulator({ now })` 并断言**事件级**的 `occurred_at`：

| # | 用例（行） | 断言 | 为什么有区分力 |
|---|---|---|---|
| N1 | `:218`「take() 产出的 FCP 事件 occurred_at 等于注入 now 的返回值（非 Date.now）」 | `expect(nowCalls).toBeGreaterThan(0)`；`expect(event.occurred_at).toBe(4_102_444_800_000)`；`expect(event.occurred_at).not.toBe(Date.now())` | 注入值 `4_102_444_800_000`（2100-01-01）**不可能自然出现**；且 `now` 被做成"相邻两次返回不同值"的序列，证明实现是**真的调用**了它，而不是两次都恰好等于某个常量 |
| N2 | `:238`「take() 产出的 TTFB 事件 occurred_at 也走注入 now」 | 同上，注入 `4_102_444_800_010`，配 `responseStartProvider: () => 123.5` | TTFB 的 `occurred_at` 走的是 `vitals.ts:128` **另一条** `now()` 调用点（不读累计值），N1 打死 `:133` 不代表打死 `:128` |
| N3 | `:258`「多次 take 各自使用当次注入的 now 值（CLS 与 INP）」 | `expect(produced).toEqual([{CLS, …+100}, {INP, …+200}])` + 每条 `not.toBe(Date.now())` | 每个指标注入**互不相同**的固定值，排除"把某一个常量写死"式的假通过；`toEqual` 是双侧结构断言，不是"事件存在" |

**关键点**：3 条都在断言 `occurred_at` 的**值**（且是别处不可能出现的值），不是"事件存在"。这正是本缺口此前
被漏掉的原因——旧用例只断言"FCP/LCP/… 出现了"、以及 `metrics.value` 来自条目，**从没有一条读 `occurred_at`**。

**变异三要素（实跑原文）**：变异 `perf/vitals.ts:79` → `const now = (): number => Date.now();`（即不再读
`options.now`）；命令 `pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins/src/perf/vitals.test.ts`；
**红断言原文**（3 条全红，`Tests 3 failed | 3 passed (6)`）：

```
FAIL … > take() 产出的 FCP 事件 occurred_at 等于注入 now 的返回值（非 Date.now）
AssertionError: 实现必须调用注入的 now（实际调用 0 次）: expected 0 to be greater than 0
 ❯ packages/plugins/src/perf/vitals.test.ts:232:59
FAIL … > take() 产出的 TTFB 事件 occurred_at 也走注入 now（TTFB 单独取自 responseStart）
AssertionError: 实现必须调用注入的 now（实际调用 0 次）: expected 0 to be greater than 0
 ❯ packages/plugins/src/perf/vitals.test.ts:250:59
FAIL … > 多次 take 各自使用当次注入的 now 值（第五条指标亦然：CLS 与 INP）
AssertionError: CLS 必须调用注入 now: expected 0 to be greater than 0
 ❯ packages/plugins/src/perf/vitals.test.ts:279:52
```

（"0 次调用"是钉常量法最直接的证据：注入的 `now` **一次都没被调用**。若担心实现改为"调用但不使用返回值"，
`:233` 的 `occurred_at === 4_102_444_800_000` 与 `:234` 的 `not.toBe(Date.now())` 仍会红。）

**变异第二种口径（"调了但不用返回值"）也实跑过**：`:79` → `const now = (): number => { void (options?.now?.() ?? 0); return Date.now(); };`
（注入的 `now` 被调用，但 `occurred_at` 取 `Date.now()`）⇒ **3 红**，此时红的是**值断言本身**，原文：

```
FAIL … > take() 产出的 FCP 事件 occurred_at 等于注入 now 的返回值（非 Date.now）
AssertionError: occurred_at 必须是注入 now 的返回值 4102444800000: expected 1792135132393 to be 4102444800000 // Object.is equality
 ❯ packages/plugins/src/perf/vitals.test.ts:233:87
FAIL … > take() 产出的 TTFB 事件 occurred_at 也走注入 now（TTFB 单独取自 responseStart）
AssertionError: TTFB 的 occurred_at 必须是注入 now 的返回值 4102444800010: expected 1792135132395 to be 4102444800010 // Object.is equality
```

该口径恢复后 sha256 同样为基线 `792d828e…dd93`（`git diff` 为空）。

**补齐前后两次钉常量（同一套方法，背靠背）**：
```
补测前  GREEN | V1_vitals.now（§11.7 结论复现，本轮 124/124 全绿）
补测后  RED   | V1_vitals.now（124 中 3 红，即新增的 N1/N2/N3）
```

**回归（最终状态实跑）**：`pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins`
= **20 files / 124 tests 全绿**（基线 121，**+3** 即 N1/N2/N3）；`packages/plugins/src/perf` = 5 files / 14 tests 全绿
（基线 11，+3）；`pnpm exec tsc -p packages/plugins` exit 0；`pnpm exec eslint packages/plugins/src` exit 0。

**§11.5(a) 的"除本处外 18/19 已红"补测后复核**：把 §11.7 点名的 19 个读取点逐点重钉一次（`packages/plugins`
124 全量用例为判据；§11.7 原文只**逐个点名了 18 个**探针名，但声称的 19 点里含 V1 本身 = 18 + 1，故按下表 19 点重钉），
结果 **19/19 红、零绿点**。逐点红计数（红用例数）：
`V1_vitals.now（本轮补测后）3` / `E1_error.now 2` / `E3_reportRepeats 1` / `E4_sources 2` / `E5_globalContext 1` /
`E6_captureResourceErrors 4` / `E7_onLeave 1` / `H2_traceScope 1` / `H3_traceContextProvider 1` / `R1_mode 5` /
`R2_templates 4` / `R3_match 1` / `V2_responseStartProvider 2` / `A1_forward 4` / `A2_resolve 2` / `A3_fieldMap 2` /
`A4_constants 1` / `A5_eventTypes 8` / `C1_apmCoexistence 2`。
（注：`C1` 第一次钉法无效——把 `:56` 原样重写等于没变异、24/24 全绿是假信号；改成 `const base = COEXISTENCE_DEFAULTS;`
后 **2 红**。记此一笔以免后人再把"无效钉法"当绿点。）

**顺带抽查新发现的读取点：仍有无覆盖的，只报告，本轮未处置。** 钉法同上（注入端口 `now` 钉成常量 `9_999` /
`Date.now`），当前 `packages/plugins` 124 用例**全绿**：

| 字段 | 读取点 | 证据（钉常量 → 结果） | 为什么没有判别性用例 |
|---|---|---|---|
| `RoutePorts.now`（`route/plugin.ts`） | `:95` → `:113` `RouteChange.at` | `:95` → `(): number => 9_999` ⇒ **124/124 全绿** | `route/*.test.ts` 多处注入 `now`（`history.test.ts:90`、`manual.test.ts:36/56`、`hash.test.ts:23`、`edge-cases.test.ts:54/76/95/128/149/165`）却**只断言 `via`/`path`/`template`**，全仓没有任何 `change.at` 断言。**❌ → ✅ 已补覆盖 + 实跑变异（2026-10-16），证据见 §11.9** |
| `HttpPorts.now`（`http/plugin.ts`） | `:196` → `:235`（事件 `occurred_at`）、`:271`/`:276`/`:283`/`:305`/`:310`/`:316`（耗时 `now()-startedAt`） | `:196` → `(): number => 9_999` ⇒ **124/124 全绿** | `http/*.test.ts` 注入 `now`（`edge-cases.test.ts:32` 等），但只断言 `metrics.duration_ms`（`capture.test.ts:44`、`edge-cases.test.ts:74`）——那是**同一个假时钟做差**，钉成常量后差值仍为期望值；**没有任何 `occurred_at` 断言**。**❌ → ✅ 已补覆盖 + 实跑变异（2026-10-16），证据见 §11.9** |
| `PerfPorts.now`（`perf/plugin.ts`） | `:78` → `:106` `web_long_task.occurred_at`（另经 `:80` 传入 §11.8 已补的 `VitalsAccumulatorOptions.now`） | `:78` → `(): number => 9_999` ⇒ **124/124 全绿** | `perf/long-task.test.ts:47` 只断言"上报 1 条 + `duration_ms` 落在 90–150 + `dimensions` 为空"，**不断言 `occurred_at`**；`perf/*.test.ts` 其余 `now` 注入同理。**❌ → ✅ 已补覆盖（vitals 侧接线一并补齐）+ 实跑变异（2026-10-16），证据见 §11.9** |

这三处与 `vitals.now` **同类**（读取点真实、注入无断言），但**字段归属不同**：前两者是 `route`/`http` 的注入端口
（`RoutePorts`/`HttpPorts`），后者是 `perf` 插件装配层的端口（`vitals.now` 的补测只覆盖 `VitalsAccumulator` 内部，
**插件面 `ports.now` → `occurred_at` 的接线仍未被断言**）。补法照 §11.8 即可（注入不可能出现的 `now` → 断言
`at`/`occurred_at` 等于注入值）。**2026-10-16 后续 lane 已按此补齐（三处 + vitals 插件面接线，共 4 条用例），
实跑变异与全量钉常量复核见 §11.9。**

### 11.9 上表三处 `now` 读取点已补覆盖（2026-10-16，后续 lane 收口）

§11.8 末尾"只报告，未动手"的三处缺口（外加其点名的 **vitals 插件面接线**）本轮补齐。**实现文件零改动**：
三处 `plugin.ts` 探针变异后逐字节恢复，sha256 与基线一致（见下"恢复后一致性"）。
**未改任何既有断言**（只加），未新增依赖，未动 `docs/contracts/**`、`docs/decisions/**`、`tests/acceptance/**`、门禁配置与实现。

**新增用例（只加不改，4 条）**：

| # | 用例（文件:行） | 断言（值断言，非"事件存在"） | 为什么有区分力 |
|---|---|---|---|
| G1 | `route/history.test.ts:166`「RouteChange.at 必须来自注入的 now」 | 注入 `now: () => 4_102_444_800_000`，驱动 `pushState` / `replaceState` / `popstate` 三种变化后 `expect(changes.map(c => c.at)).toEqual([4_102_444_800_000, …×3])`，并逐条 `expect(c.at).not.toBe(Date.now())` | `4_102_444_800_000`（2100-01-01）**不可能自然出现**；断言的是 `at` 的**值**。旧用例在同文件 `:90` 等多处注入了 `now`，却**只断 `via`/`path`/`template`**，故"不调用注入值"与"调用了但丢弃返回值"都打不死 |
| G2 | `http/capture.test.ts:302`「web_http.occurred_at 必须来自注入的 now」 | 注入 `now: () => 4_102_444_800_000`，`capture.record({GET,'/api/task/1'},{status:200},42)` 后 `expect(event.occurred_at).toBe(4_102_444_800_000)` | 旧用例只断 `metrics.duration_ms`（`capture.test.ts:44`、`edge-cases.test.ts:74`）——那是**同一个假时钟做差**，钉成常量后差值仍等于期望值；本用例断的是 `occurred_at` 的**值** |
| G3 | `perf/long-task.test.ts:63`「web_long_task.occurred_at 必须来自注入的 now」 | 注入 `now: () => 4_102_444_800_000`，投递 1 条 `longtask` 后 `expect(longTasks[0].occurred_at).toBe(4_102_444_800_000)` | 旧用例（`:47`）只断"上报 1 条 + `duration_ms` 落在 90–150 + `dimensions` 为空"，**`occurred_at` 从未被读** |
| G4 | `perf/vitals.test.ts:298`「插件面 now 接线（vitals 路径）必须被真实读取」 | 同注入，`FCP` 条目 + `onLoad` 后 `expect(fcp.occurred_at).toBe(4_102_444_800_000)` | §11.8 只补了 `VitalsAccumulator` **内部**；本用例钉的是**插件 `perf/plugin.ts:78` → 累加器** 这条接线。**"累加器已覆盖"不等于"插件接线已覆盖"** |

**变异三要素（实跑原文）**：每处两个口径，命令 `pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins`。

| 读取点 | 口径A：不调用注入值（改用 `Date.now`） | 口径B：调用了但丢弃返回值 |
|---|---|---|
| `route/plugin.ts:95` | 红（1 failed） | 红（1 failed） |
| `http/plugin.ts:196` | 红（1 failed） | 红（1 failed） |
| `perf/plugin.ts:78` | 红（2 failed：G3+G4） | 红（2 failed：G3+G4） |

口径A 变异原文：`const now = ports?.now ?? ((): number => Date.now());` → `const now = (): number => Date.now();`
口径B 变异原文：→ `const now = (): number => { void ports?.now?.(); return Date.now(); };`（`route`/`http` 用
`void ports?.now?.();`，`perf` 同步；口径B 红在**值断言**上）。

红断言原文（各取一条代表，均为**值断言**）：

```
FAIL  route  > RouteChange.at 必须来自注入的 now > push / replace / pop 三种变化的 change.at 都等于注入值 4102444800000
AssertionError: change.at 必须是注入 now 的返回值 4102444800000（Date.now 或丢弃返回值都会在此变红）:
  expected [ 1792136107122, 1792136107122, …(1) ] to deeply equal [ 4102444800000, 4102444800000, …(1) ]
  （口径A）
AssertionError: change.at 必须是注入 now 的返回值 4102444800000: expected [ 1792136112276, … ] to deeply equal [ 4102444800000, … ]  （口径B）

FAIL  http  > web_http.occurred_at 必须来自注入的 now > record 产出事件的 occurred_at 等于注入值 4102444800000
AssertionError: occurred_at 必须是注入 now 的返回值 4102444800000（Date.now 或丢弃返回值都会在此变红）:
  expected 1792136118602 to be 4102444800000 // Object.is equality  （口径A）
AssertionError: … expected 1792136123507 to be 4102444800000 // Object.is equality  （口径B）
  ❯ packages/plugins/src/http/capture.test.ts:320:7

FAIL  perf/long-task  > C05-AC-06 web_long_task.occurred_at 必须来自注入的 now > 长任务事件的 occurred_at 等于注入值 4102444800000
AssertionError: occurred_at 必须是注入 now 的返回值 4102444800000（Date.now 或丢弃返回值都会在此变红）:
  expected 1792136129326 to be 4102444800000 // Object.is equality  （口径A）
FAIL  perf/vitals  > C05-F2 插件面 now 接线（vitals 路径）必须被真实读取 > 加载完成上报的 FCP 事件 occurred_at 等于注入值 4102444800000
AssertionError: occurred_at 必须是注入 now 的返回值 4102444800000: expected 1792136129326 to be 4102444800000 // Object.is equality
  （口径A；口径B 同形，实收 1792136134053 / 1792136134054）
```

**恢复后 sha256 与基线一致（硬要求）**：

```
0a50e3babb22a66ec65bcb166761fafc363eead062a12ca1bf7c527f7c3f0f5d  packages/plugins/src/route/plugin.ts
b4f583680cfdefd2e5104e57500b53a56a9cfa0f9711ae9619e228e7176c7551  packages/plugins/src/http/plugin.ts
966df988884bc8055ab5a83fc7c269118ae619314f01c9bbe2c74ab64664d482  packages/plugins/src/perf/plugin.ts
```

**回归（最终状态实跑）**：`packages/plugins` = **20 files / 128 tests 全绿**（基线 124，**+4** 即 G1–G4）；
`pnpm exec tsc -p packages/plugins` exit 0；`pnpm exec eslint packages/plugins/src` exit 0。

**补完后全量钉常量法复核（34 个读取点，方法与 §11.7/§11.8 相同）**：**32 红 / 2 绿**（该 2 绿 = 下表 `RoutePorts.hooker` / `HttpPorts.hooker`，**已由后续 lane 在 §11.10 补覆盖清零；最新一次同法全量复核为 34 红 / 0 绿**），逐点红计数：

```
R1_mode 7 / R2_templates 4 / R3_match 1 / R4_now 1 / R5_currentUrl 4 / R6_history 4 / R8_listen 5 /
H1_urlTemplate 1 / H2_traceScope 1 / H3_traceCtxProv 1 / H4_now 1 / H5_refs 7 /
V1_vitals_now 4 / V2_respStartProv 3 / V3_perf_now 2 / V4_portsRespStart 2 / V5_createObserver 11 / V6_completion 5 /
E1_error_now 4 / E2_error_windowMs 1 / E3_reportRepeats 1 / E4_sources 2 / E5_globalContext 1 /
E6_captureResErr 1 / E7_onLeave 1 / E8_dedup_windowMs 2 /
A1_forward 4 / A2_resolve 2 / A3_fieldMap 1 / A4_constants 1 / A5_eventTypes 1 / C1_apmCoexist 2
```

**（历史记录）当时尚未达到"零绿点"**：仍有 **2 个绿点**，是**本轮新发现**的同类缺口，**只报告、不扩大改动**。
**→ 后续 lane 已按下面的修法建议补齐并做实跑双口径变异（见 §11.10），这 2 个绿点已清零。**

| 字段 | 读取点 | 钉常量证据 | 为什么没有判别性用例 |
|---|---|---|---|
| `RoutePorts.hooker` | `route/plugin.ts:194` `const hooker = ports?.hooker ?? createInlineHooker();` | 钉法 `→ createInlineHooker()`（丢弃注入分支；确认文件确有变化，非无效钉法）⇒ **128/128 全绿** | `history.test.ts:79/120/142/175` 注入的是**手工复刻 `createInlineHooker` 语义**的 `createHooker()`（同文件 `:49`），`edge-cases.test.ts:94` 直接注入 `createInlineHooker()`；断言只覆盖"转发到原层 + 恢复原引用"，这两点在注入实现与降级实现下**完全同形**，故"注入的 hooker 是否被使用"无人能判。**⇒ 已补覆盖 + 实跑口径A/B（2026-10-16，见 §11.10）**：新增 `route/hooker-port.test.ts` |
| `HttpPorts.hooker` | `http/plugin.ts:262` `const hooker = ports?.hooker ?? createInlineHooker();` | 同上，仅在 `http/plugin.ts` 上钉 `→ createInlineHooker()` ⇒ **128/128 全绿** | `capture.test.ts:168/193/224/253/286`、`trace-header.test.ts:96/126` 同样只注入语义等价的 `createHooker()`/`createInlineHooker()`，无"内核注册表确实被调用"的判别性断言（例如注入一个 `hook` 抛错/计数的桩）。**⇒ 已补覆盖 + 实跑口径A/B（2026-10-16，见 §11.10）**：新增 `http/hooker-port.test.ts` |

修法建议（留给有所有权的人）：给 `ports.hooker` 注入一个**可观测的桩**（如 `hook` 被调用次数计数，或
"只有注入 hooker 才记录的标记"），断言包装确实经过它；两处同法即可把剩下 2 个绿点清零。
**（已由后续 lane 按此落地：可观测桩 = 调用记录 + 装上层身份 + 注销簿记，两处各 1 条用例，见 §11.10。）**

**本轮改动文件**：`packages/plugins/src/{route/history,http/capture,perf/long-task,perf/vitals}.test.ts`（各 +1 用例）
与本报告。**未做任何 git 写操作**；实现文件、契约、决策、验收用例、门禁配置均未改。
**注意**：复核期间工作区另有 lane 在写 `CHANGELOG.md` 与 `tests/compat/results/*.json`（mtime 15:36–15:39），
与本 lane 无关，本 lane 未触碰。全量钉常量探针的临时改动在 `/tmp/pinsweep.*` 备份下逐点恢复并已 `cmp` 复核。

### 11.10 最后 2 个绿点（`RoutePorts.hooker` / `HttpPorts.hooker`）已补覆盖（2026-10-16，后续 lane 收口）

§11.9 末尾点名的 2 个绿点本轮清零。**实现文件零改动**（两处 `plugin.ts` 探针变异后逐字节恢复，
sha256 与基线一致）；**未改任何既有断言**（只新增测试文件），未新增依赖，未动
`docs/contracts/**`、`docs/decisions/**`、`tests/acceptance/**`、门禁配置。

**桩的可观测方式与理由**（这是本轮的关键）：注入一个**自带簿记**的 hooker 桩
（`route/hooker-port.test.ts:50` 起、`http/hooker-port.test.ts:50` 起，两文件各自独立一份）。
它**语义仍与 `createInlineHooker()` 完全一致**（成对安装、条件恢复），但多留三样**只有"被真正调用过"才会存在**的记录：

1. **调用记录**：每次 `hook(target, key, wrapper)` 记录 `target` 身份与 `key`（`calls()` / `keys()`），并在安装前记录 `saved`（`originalValue(key)`）；
2. **装上层身份**：记录自己实际写进 `target[key]` 的那一层（`installedValue(key)`）；
3. **注销簿记**：记录每个返回的注销函数被调用的 key，并维护未注销层数 `liveCount()`。

**为什么这能与降级实现区分**：降级实现 `createInlineHooker()` 不产生任何簿记；因此
"实现没读注入 hooker、改用降级实现"会让 `keys()` 为空、`installedValue()` 为 `undefined`；
"读了但丢弃它返回的注销函数"会让卸载后 `liveCount()` 仍为 2、`disposedKeys()` 为空、
`refs`/`history` 上不是原引用。这两类接线错误下，**断言红的是桩自己的簿记**，
而不是"包装行为"（后者在两种实现下同形，正是旧用例打不死的原因）。
断言对象都是**值/行为级**：调用参数身份、装上层身份、`web_pageview` 模板 / `web_http` 的
`status`+`method`+`url_template` 实际值、注销前后的状态，没有一条是"事件存在"。

**新增用例（只加不改，2 条，各 1 个 `it`）**：

| # | 用例（文件:行） | 值/行为级断言 | 为什么与降级实现可区分 |
|---|---|---|---|
| G5 | `route/hooker-port.test.ts:114`「RoutePorts.hooker 必须真的被使用（注入桩的可观测簿记）」 | `expect(stub.keys()).toEqual(['pushState','replaceState'])`（`:130`）；`stub.calls().map(c=>c.target)` 等于伪造 `history`（`:135`）；`originalValue('pushState'/'replaceState')` 等于原生两个函数（`:136`–`:137`）；`history.pushState === installedValue('pushState')`、`replaceState` 同理（`:139`–`:142`）；`pushState(...)` 后 `changes === ['/task/:id']`（`:146`–`:147`）；`uninstall()` 后 `liveCount()===0`、`disposedKeys()===['pushState','replaceState']`、两个方法仍是原生引用（`:153`–`:156`） | 旧用例注入的 `createHooker()`/`createInlineHooker()` **没有这些记录**，所以两种实现下输出同形；本用例断的是**注入桩留下的簿记**，只有实现真的调用了它才会出现 |
| G6 | `http/hooker-port.test.ts:105`「HttpPorts.hooker 必须真的被使用（注入桩的可观测簿记）」 | `expect(stub.keys()).toEqual(['fetch','XMLHttpRequest'])`（`:130`）；`calls()` 的 target 都是同一个 `refs` 容器（`:135`）；`originalValue('fetch') === originalFetch`、`originalValue('XMLHttpRequest') === FakeXhr`（`:136`–`:137`）；`holder.fetch === installedValue('fetch')`、`holder.XMLHttpRequest === installedValue('XMLHttpRequest')`（`:139`–`:141`）；驱动 fetch 与 XHR 后 `events.map(e=>e.metrics.status)===[200,201]`、`method===['GET','POST']`、`url_template` 去查询参数（`:146`–`:155`）；`uninstall()` 后 `liveCount()===0`、`disposedKeys()===['fetch','XMLHttpRequest']`、容器上两个引用恢复（`:163`–`:166`） | 同 G5；且**分别覆盖 http 插件的两条包装路径**（`fetch` 与 `XMLHttpRequest`），不是只覆盖其中一条 |

**变异三要素（实跑原文）**：每处两个口径，命令 `pnpm exec vitest run --coverage.enabled=false --project unit packages/plugins`。
每处先确认钉法确实改动了文件（非无效钉法），跑完 `cp` 回基线备份并 `shasum -a 256 -c` 复核。

| 读取点 | 口径A：不读注入 hooker（改用 `createInlineHooker()`） | 口径B：调用了但丢弃它返回的注销函数 |
|---|---|---|
| `route/plugin.ts:194` | 红（1 failed / 129 passed） | 红（5 failed / 125 passed） |
| `http/plugin.ts:262` | 红（1 failed / 129 passed） | 红（3 failed / 127 passed） |

口径A 变异原文：`const hooker = ports?.hooker ?? createInlineHooker();` → `const hooker = createInlineHooker();`（两处各一次）。
口径B 变异原文：把 `disposers.push(hooker.hook(...))` 的结果丢弃——
`disposers.push(` → `void ((value: () => void): void => { void value; })(`，
于是 `hooker.hook(...)` 的返回值（注销函数）被立刻丢弃（`route` 1 处、`http` 2 处：`fetch` 与 `XMLHttpRequest`）。
**口径B 适用**：`Hooker.hook()` **有返回值**（`() => void` 注销函数，`internal/hooker.ts:13`–`:17`），
且实现确实把该返回值交给 `uninstall()` 使用，因此 B 口径成立并已实跑为红。

红断言原文（均为**值断言**，非"事件存在"）：

```
FAIL  route  > RoutePorts.hooker 必须真的被使用（注入桩的可观测簿记） > pushState/replaceState 各经过注入 hooker 一次；装的是桩那一层；卸载后桩的层全部注销
AssertionError: 注入 hooker 必须被调用两次（pushState/replaceState）: expected [] to deeply equal [ 'pushState', 'replaceState' ]
  ❯ packages/plugins/src/route/hooker-port.test.ts:130:70        （口径A）

AssertionError: 卸载后注入 hooker 装上的层必须全部注销: expected 2 to be +0 // Object.is equality
  ❯ packages/plugins/src/route/hooker-port.test.ts:153:57        （口径B）

FAIL  http  > HttpPorts.hooker 必须真的被使用（注入桩的可观测簿记） > fetch 与 XMLHttpRequest 两条路径都经过注入 hooker；装的是桩那一层；卸载后桩的层全部注销
AssertionError: 注入 hooker 必须覆盖 fetch 与 XMLHttpRequest 两条路径: expected [] to deeply equal [ 'fetch', 'XMLHttpRequest' ]
  ❯ packages/plugins/src/http/hooker-port.test.ts:130:71         （口径A）

AssertionError: 卸载后注入 hooker 装上的层必须全部注销: expected 2 to be +0 // Object.is equality
  ❯ packages/plugins/src/http/hooker-port.test.ts:163:57         （口径B）
```

口径B 下另有既有用例一起变红（route：`route/history.test.ts`、`route/edge-cases.test.ts`×2、`coexist/order.test.ts`；
http：`http/edge-cases.test.ts`、`coexist/order.test.ts`），说明 B 口径同时被"恢复原引用"类断言与
本轮的注销簿记断言抓住；**口径A 下唯一变红的就是本轮新增的 2 条用例**（既有 128 条全绿）。

**恢复后 sha256 与基线一致（硬要求）**：

```
0a50e3babb22a66ec65bcb166761fafc363eead062a12ca1bf7c527f7c3f0f5d  packages/plugins/src/route/plugin.ts
b4f583680cfdefd2e5104e57500b53a56a9cfa0f9711ae9619e228e7176c7551  packages/plugins/src/http/plugin.ts
```

**回归（最终状态实跑）**：`packages/plugins` = **22 files / 130 tests 全绿**（§11.9 基线 128，**+2** 即 G5+G6）；
`pnpm exec tsc -p packages/plugins` exit 0；`pnpm exec eslint packages/plugins/src` exit 0。

**补完后全量钉常量法复核（同一 34 个读取点与同一脚本，方法和 §11.7/§11.8/§11.9 相同）**：**34 红 / 0 绿**。
逐点红计数（本轮，数字 = 该探针下失败的测试数）：

```
R1_mode 8 / R2_templates 5 / R3_match 1 / R4_now 1 / R5_currentUrl 5 / R6_history 5 / R7_hooker 1 / R8_listen 5 /
H1_urlTemplate 1 / H2_traceScope 1 / H3_traceCtxProv 1 / H4_now 1 / H5_refs 8 / H6_hooker 1 /
V1_vitals_now 4 / V2_respStartProv 3 / V3_perf_now 2 / V4_portsRespStart 2 / V5_createObserver 11 / V6_completion 5 /
E1_error_now 4 / E2_error_windowMs 1 / E3_reportRepeats 1 / E4_sources 2 / E5_globalContext 1 /
E6_captureResErr 1 / E7_onLeave 1 / E8_dedup_windowMs 2 /
A1_forward 4 / A2_resolve 2 / A3_fieldMap 1 / A4_constants 1 / A5_eventTypes 1 / C1_apmCoexist 2
```

与 §11.9 相比：`R7_hooker`、`H6_hooker` 由"128/128 全绿"转为**各 1 红**（正是本轮清零的两处）；
`R1_mode` 7→8、`R2_templates` 4→5、`R5_currentUrl` 4→5、`R6_history` 4→5、`H5_refs` 7→8
（本轮两条新用例在这些读取点被钉死时也一并变红，因为它们同样经由 mode/templates/currentUrl/history/refs 接线）；
**其余 27 个读取点的红计数与 §11.9 完全一致**。脚本末尾 `restore` + `trap` 逐点恢复，结束时三个 `plugin.ts`
的 sha256 与基线一致（见上），`git status` 只剩本 lane 新增的两个测试文件与工作区里**其它 lane** 的既有改动
（`tests/compat/results/*.json`、`vitest.config.ts`）。**未再发现新的绿点。**

**"零绿点"的边界（给后来人，必须连同结论一起读）**：
"零绿点"只表示**在当前用例集下，这 34 个读取点每一个都至少有一条能被"钉成常量"打死的断言**，
即"该读取点的注入值/返回值确实有人在守"。它**不等于"实现正确"**：钉常量法只能发现
"读取点无判别性覆盖"，**不能**发现契约语义错误、边界取值错误、时序/竞态错误、
契约与实现的一致性错误，也不能覆盖**不在探针清单里**的读取点（清单本身是人工枚举的）。
因此本节的正确读法是"**已清零的覆盖缺口清单**"，而不是"实现已被证明正确"。

**本轮改动文件**：新增 `packages/plugins/src/route/hooker-port.test.ts`、
`packages/plugins/src/http/hooker-port.test.ts`（各 1 条用例）与本报告（§11.9 两行状态 + §11.10）。
**未做任何 git 写操作**；实现文件、契约、决策、验收用例、既有测试断言、门禁配置均未改；
临时变异在 `/tmp/hooker_route_plugin.baseline.ts`、`/tmp/hooker_http_plugin.baseline.ts` 备份下逐处恢复并
`shasum -a 256 -c` 复核。

---

## 十二、三条「重负载敏感」用例的真因与修复（2026-10-16，T33 lane）

**派工背景**：看板记 `C05-AC-18 gzip` 负载下 3/6 红、`mask-adversarial` perf 护栏 1/6 红、
`tools/config-signer/.../leak-scan.test.ts` 的「K02 全部子命令的输出中不含本次使用的任何密钥材料」曾 1 次在全量门禁中红
（单跑 4/4 绿、随后全量重跑全绿）。
**结论：三条没有一条是"抖动"**——两条是**共享固定路径 / 仓库级共享状态**，一条是**统计量选错（墙钟 vs CPU 时间）**。
三条的修法都不是 retry / sleep / 放宽断言 / `.skip` / 调超时；**实现文件一行未改**。

### 12.1 机器状态（如实记录：空闲基线只在开工时拿到过）
- 开工第一步：`loadavg = [4.02, 4.87, 4.58]`、`pgrep -lf 'vitest|tsc|gates'` 只剩编辑器自带的 `tsserver`
  （路径里含 `tsc` 的误匹配），**无任何 vitest/tsc/gates 进程** ⇒ **拿到了空闲基线**，
  三条在空闲下全绿（与看板一致，复现不出）。
- 之后全程**拿不到空闲基线**：另有 3 条 lane 并行，`loadavg` 长期 12–65（最高实测 **65.5**）。
  因此所有"负载敏感"结论都建立在**受控负载**上（两个并发 vitest 进程；两个并发全量 `unit` 套件）；
  最终的空闲侧复核只在一个 `loadavg1≈5.0` 的窗口里补到（12.5）。

### 12.2 `C05-AC-18`：**固定产物目录的跨进程竞态**（不是负载，也不是 gzip 预算）

**复现与报错形态**（"同文件并发"各 2 个进程，共 6 轮）：
- **同文件并发 4/6 红**，报错原文（**资源/IO 错，不是超时、也不是体积断言**）：
  `Error: 期望 1 个 .js 产物，实际 0 个：`（`measure-apm-adapter.mjs:74` 的 `buildBundle`）。
- **纯 CPU 并发负载**（另一个进程跑**别的**测试文件，6 轮）：**0/6 红**。⇒ 与 CPU 竞争无关。
- 空闲单跑：1307 ms，gzip 705 B（限 1536 B，余量 2.18×）。**体积断言与负载无关**（gzip 是确定性函数）。

**真因**：`packages/plugins/scripts/measure-apm-adapter.mjs` 把产物固定写到
`packages/plugins/dist-apm-adapter`，并在 `finally` 里 `rmSync` 它。两个进程同时跑时，
一方的 `tsup --clean` 与 `finally` 会删掉另一方的产物，后者 `readdirSync` 到 0 个 `.js` 而抛错。
（`git check-ignore` 证实该目录**不在** `.gitignore` 里——`dist/` 匹配不到 `dist-apm-adapter`。）

**为什么它此前表现为"负载敏感"**：受控负载的构造方式就是"两个并发 vitest 进程"；只有当**同一份用例**
被两个进程同时收集时才会撞。真实门禁里这发生的条件正是"`pnpm gates` 与另一条 lane 的
`pnpm exec vitest run`（宽过滤器）并行"——与 CPU 忙不忙无关，所以空跑到底也不会红。

**修法（方向①"消除共享状态/固定路径"）**：在**测试侧**给每次运行一个**独占的临时根目录**
（`mkdtempSync(<packageRoot>/.measure-apm-adapter-)`）——`packageRoot` 由脚本自身位置推出，
于是 `outDir` 变成 `<临时根>/dist-apm-adapter`。要点：
`scripts/measure-apm-adapter.mjs` 必须是**拷贝**（`import.meta.url` 解析真实路径，符号链接会让 `packageRoot` 指回原处）；
`package.json` 与 `src` 用**符号链接**指回真实文件（`package.json` 的 `"type": "module"` 决定产物是 `index.js` 还是 `index.mjs`，
不能复制一份会走样的元数据）；临时根放在 `packages/plugins` **内部**（tsup 向上找到的 `tsup.config.ts`/`tsconfig.json` 与真实构建一致），
点号开头（`tsc` include 只有 `src`、`vitest` include 只覆盖各包 `src`、`coverage` 不含、ESLint 默认不遍历点目录），`finally` 删除。
**等价性**：临时根跑出 `raw 1199 B / gzip 705 B / brotli 585 B`，与原地跑**逐字节一致**。
**不用锁、不等待、不 retry**。

**证据**：受控负载 **10 轮 × 2 并发（=20 个进程-run）全绿**；两个并发全量 `unit` 套件 **8 轮 × 2（=16 个进程-run）全绿**；
变异 M1（退回共享路径 `execFileSync('node', [script])`）→ **2/4 红**，恢复后 3/3 绿（sha256 复核一致）。

### 12.3 `mask-adversarial`：**用墙钟度量"计算量"**（外加一个 5 s 默认超时面）

**复现与报错形态**（修复前，2 并发 `packages/core/src/privacy` 套件 10 轮）：**3/10 红**，
全是 `AssertionError`（不是超时）：
`输入「email 的域标签重复」的单次中位耗时 20.744084 ms 超出加固预算 20 ms`、
`50 条规则下输入「email 的域标签重复」的中位耗时 37.265312 ms`、
`50 条规则下输入「cn_mobile 的 lookahead 失败路径」的中位耗时 22.53 ms`。

**真因（同一份输入的两种度量，实测）**：

| 度量 | 空闲 | 单套件并行 | 双套件并行 |
| --- | --- | --- | --- |
| 墙钟中位数 | 3.1 ms | 10–23 ms | **23–32 ms（4/4 红）** |
| CPU 时间（`process.cpuUsage`） | 3.1 ms | 7.5–8.3 ms | **7.5–8.3 ms（不动）** |

`unit` project 共 145 个文件，10 核机上 `pnpm test` 跑到约 6× 超订（user 58 s / wall 9.5 s）。
**此时墙钟度量的不是代码，而是"被抢占多久"**；"无灾难性回溯"是关于**计算量**的命题，CPU 时间才是它的正确度量。
**为什么此前表现为"负载敏感"**：并行抢占只抬高墙钟、不抬高 CPU 时间，于是同一份代码在负载下"变慢"。

**修法（方向③：换成有依据的度量，不动阈值）**：新增 `cpuMsPerCall`，
用 `process.cpuUsage()` 的**块内求和再平均**（CPU 时间可加，整块求和把 µs 级分辨率误差摊平；中位数会被并行抢占整体抬高）。
`PRODUCTION_BUDGET_MS=0.2`、`HARDENING_BUDGET_MS=20` **原值保留**（实测余量：0.2 ms 对 0.006–0.020 ms；20 ms 对最贵的 8.3 ms ⇒ 2.4×）。
`packages/core/tsconfig.json` 的 `types` 为空，因此按本仓既有写法用**文件内** `declare const process: { cpuUsage(...) }`
（**没有**用 `/// <reference types="node" />`——那会把 node 类型泄漏进整个程序并打坏 `global-registry.ts` 的 `setTimeout` 返回类型）。

**同时查清并处置了第二个失败面（超时）**：`loadavg 65` 时另见
`Error: Test timed out in 5000ms`（vitest 默认 5 s；两个加固用例自身约 350 ms CPU，放大成 7.6 s 墙钟）。
**没有调超时**：把两个加固用例的迭代数 50 → **15**（整块 CPU 约 105 ms，仍远高于计数器分辨率），
用例自身 CPU 由约 0.74 s 降到约 0.29 s；生产上界用例 200 → 2000 次迭代（整块约 12 ms，只为保证分辨率）。
**阈值未动、判据未放宽**。

**证据**：受控负载 10 轮 × 2 并发 privacy 套件 **20/20 绿**；两个并发全量 `unit` 套件 **8 轮 × 2 = 16/16 绿，
0 次超时**（含 `loadavg 59.6` 的两轮）；`loadavg1≈5.0` 窗口 3/3 绿。
变异：M2（把统计量退回墙钟中位数）→ 双套件下 **3/3 轮、每轮 2/2 进程全红**（值 22.7–33.8 ms）；
M3（把最贵输入人为变慢 8 倍）→ `24.943467 ms > 20 ms` **判红**（证明阈值仍承重、不是空转）。

### 12.4 `leak-scan.test.ts`「K02 全部子命令…」：**观测窗口内的仓库级共享状态**

**真因**：该用例在窗口开始/结束各取一次 `git ls-files -o --exclude-standard` 快照，
并断言"窗口内新增的未跟踪文件**全部**位于 `tools/config-signer/` 下"。
这是**仓库级共享可变状态**：窗口内**任何别的进程**（并发套件、其它 lane 的途文件、构建产物）
新增一个未跟踪文件都会落进差集 ⇒ 断言实际在判"**别人**有没有写文件"，与 K02 是否泄漏密钥无关。

**确定性证据（同一份代码，只挪时序）**：
- 在窗口内（`delay≈0.65 s`）落下 `packages/plugins/dist-apm-adapter/pollute.js` ⇒ **必红**，
  原文 `AssertionError: expected false to be true`；
- 不在窗口内落 ⇒ **必绿**；
- 本会话还**实时看到**别的 lane 的未跟踪文件在集合里进出（`tests/e2e/lib/*.mjs`、`tests/compat/lib/*.mjs`、
  `docs/reports/gate-selftest-coverage.md`）。
- 叠加放大项：`C05-AC-18` 的度量脚本会在 `packages/plugins/dist-apm-adapter/` 短暂生成未跟踪文件
  （该目录**不在** `.gitignore`），而它与本用例同属 `unit` project、在**同一次** `vitest run` 里**并行**跑
  ⇒ 产物存活期与该用例窗口是否重合**只取决于调度**。这正是"全量偶发红、单跑 4/4 绿、重跑全绿"。

**修法（方向①+②：收回判定范围，并把内容判定加强）**：
① 仓库任意位置都不得新增 `.pem` / `.key` 形态文件（与原判据一致）；
② `tools/config-signer/` 内不得新增未跟踪文件（保留原判据里属于"本任务自身"的那一半）；
③ **任何**新增的未跟踪文件（任意目录、任意扩展名）的**内容**里都不得出现本次运行的任何密钥材料或私钥 PEM 头
——**比原来更强**（原来只看扩展名），且与别的进程写不写文件无关。
（`tools/config-signer/` 的兄弟用例仍然是**有意**仓库级的：「工作树里不应存在密钥形态文件」本身是全局性质，
别的进程落一个 `.pem` 就应该红——所以下面变异 B 里它同时变红是正确的，不是误伤。）

**证据**：在**持续**制造良性未跟踪文件的污染进程下 **10/10 绿**（修复前同一条件可稳定复现红）；
两个并发全量套件 16/16 绿。变异（均在窗口内注入，逐条确认文件确实变了、事后 sha256 还原）：
- A：在 `tools/config-signer/` 内落一个良性 JSON → **本用例第 183 行判红**，兄弟用例绿（精确隔离"本任务自身"那一半）；
- B：落一个 `.pem` → 本用例第 182 行（形态）判红，兄弟用例第 214 行同时判红；
- C：落一个**扩展名良性**（`.txt`）、内容含**私钥 PEM 头**的文件 → 本用例第 193 行
  内容扫描判红（`expected 1 to be +0`；该 PEM 头行本就是本次运行登记的指纹之一），兄弟用例同时判红。
  ⇒ 加强后的内容判定确实承重。
  （该 PEM 头的**完整字面量本文档故意不写出**——它与 `test-support.ts` 里拼接出的 `PRIVATE_KEY_MARKER` 同值，
  写出来会让兄弟用例的"工作树里不得有 PEM 头文本"扫描把本文档本身判为违规。这一坑本会话**真实踩过一次**：
  报告里写了该字面量 ⇒ `leak-scan.test.ts:215` 立刻把 `docs/reports/t33-access-blockers.md` 报成
  `expected [ Array(1) ] to deeply equal []`。**文档若要引用它，请用拼接写法或只写符号名。**）

### 12.5 汇总：实测结果（全部为最终版本，sha256 见下）
| 用例 | 受控负载 | 结果 |
| --- | --- | --- |
| `C05-AC-18` | 同文件 2 并发 × 10 轮（20 进程-run） | **20/20 绿**（修前同条件 4/6 红） |
| `mask-adversarial` | privacy 套件 2 并发 × 10 轮（20 进程-run） | **20/20 绿**（修前同条件 3/10 红） |
| `leak-scan`（K02） | 持续良性污染进程 × 10 轮 | **10/10 绿**（修前同条件可稳定复现红） |
| 三者同时 | 全量 `unit` 2 并发 × 9 轮（18 进程-run） | **18/18 绿、0 超时**（`loadavg` 最高 59.6；末轮两个进程各 `145/145 files、1330/1330 tests`） |
| 三者同时 | 单进程、`loadavg1≈5.0` × 3 轮 | **3/3 绿**（21 tests/轮） |

**最终 sha256（变异逐处恢复后复核）**：
- `packages/core/src/privacy/mask-adversarial.test.ts` `e2ba99c9558ab2aeddc2c9af78b0d6526a5617a54cb79dc51e03ffa65d50e71b`
- `tools/config-signer/src/__tests__/leak-scan.test.ts` `abf34c8f100ad3bb3bd11fd6932b80da90e7bba5a38ff135744d96a7b2129f7d`
- `packages/plugins/src/apm-dual-write/apm-dual-write.test.ts` `a2a788d0bf0233a5992ac049a096dba5464cf08d0096dc6b8cfa8e2bb884c350`

### 12.6 只报告、未改（交负责人裁决）
1. **第四条同类用例**：`tools/config-signer/src/__tests__/performance.test.ts`
   「K02-AC-09 进程内签名 100 次：中位数与 p95 均低于 100 ms」——**墙钟 p95** 判据，在全量双套件下
   实测 1/10 进程-run 红：`AssertionError: expected 104.88087499999983 to be less than 100`（第 62 行）。
   与 `mask-adversarial` 同一病根（墙钟统计量）。**它不在本次派工的三条里，我未改动**；
   建议同一修法（换成 CPU 时间统计量），请裁决。
   ⇒ **已修**：2026-10-16 收口 lane 按建议的修法收口，复现/修法/变异/回归证据见 §12.7。
2. **超时面**：`mask-adversarial` 在极端超订（实测 `loadavg 65`）下仍可能撞 vitest 默认 5 s——
   我已把用例自身 CPU 工作量降了约 2.5×（见 12.3），但**没有**调超时预算。若仍要更大余量，
   杠杆是"给这两个用例加 timeout"（我不自行调）或把 2 万字符加固检查移交 T20 的 `tests/bench/`。
3. **编排侧事故（非本 lane 造成，需登记）**：本 lane 的
   `packages/core/src/privacy/mask-adversarial.test.ts` 在 **16:58:38** 被编排方用
   `git checkout -- <该文件>` **整体回退**（理由：想让树在 `typecheck` 上变绿），已由我重新落盘；
   另两个文件当时未被触碰。**若有人在 16:58 前后读到过该文件的中间态/红，那不是最终版本**——
   请以本节的 sha256 与单跑结果为准（受影响窗口内的观测一律作废）。

### 12.7 第四条同类用例已修：`performance.test.ts` 的 K02-AC-09 也是墙钟（2026-10-16，收口 lane）

**背景**：12.6 第 1 条登记的第四条同类用例——`tools/config-signer/src/__tests__/performance.test.ts`
「K02-AC-09 进程内签名/验签 100 次：中位数与 p95 均低于 100 ms」。本轮按 12.3 的同一修法收口。
**实现文件（`tools/config-signer/src/**` 除该测试外）一行未改**；可写范围只有该测试文件与本文档。
本轮**只有这一条 lane**，收工时 `git status --porcelain` 只有本测试文件与本文档两个 ` M`、无未跟踪文件。

**复现（如实记录：2 并发复现不出，加重到 4 并发才复现）**
- **2 个并发全量 `unit` 套件 × 10 轮（= 20 进程-run，`loadavg` 11→63）**：**0/20 红**（复现不出）。
- **4 个并发全量 `unit` 套件 × 6 轮（= 24 进程-run，`loadavg` 52→114）**：**4/24 红**，四处**全是**
  「进程内签名 100 次」的 p95 那一行（**修前文件的第 62 行**，即 12.6 登记的那一行），报错原文（复制）：
  `AssertionError: expected 144.3507499999996 to be less than 100`、
  `AssertionError: expected 165.89016699999956 to be less than 100`、
  `AssertionError: expected 103.03383399999984 to be less than 100`、
  `AssertionError: expected 103.00837499999943 to be less than 100`。
  同批 40 个「跑完并打印了数值」的进程-run 里，**墙钟中位数只有 1.22–3.89 ms**，
  而同一份计算的 **p95 跨度 5.64–98.12 ms**（再叠加上述 4 次 >100）——**30 倍跨度全来自抢占**。
- 复现手段仅"并发跑**同一个** `unit` project"：没有改输入、没有制造 IO 竞争；
  2 并发不够就把并发数加到 4（仍是 vitest 进程并发，不是人为 sleep/网络抖动）。

**真因**：与 12.3 完全同因——`unit` project 145 个文件，10 核机上实测 `user 57.6 s / wall 11.5 s`
（约 6× 超订），并行只抬高墙钟、不抬高计算量；「100 ms 内完成」是关于**计算量**的命题，
所以在超订下用墙钟判它，判的其实是「被抢占多久」。⇒ 换统计量，**阈值不动**。

**修法**：`measure()`（`performance.now()`）→ `measureCpuMs()`（`process.cpuUsage()` 逐次差值，µs→ms）：
每次取样取一对 `process.cpuUsage()` 的差，中位数 / p95 仍由**逐次样本**算出（判据形状、条数、用例名全不变）。
`tools/config-signer/tsconfig.json` 有 `types: ["node"]`，因此直接用全局 `process`：
**没有**文件内 `declare`、更**没有** `/// <reference types="node" />`（10.6③ 的坑）。
**阈值 100 ms、迭代数 100 次全部原值保留**；无 retry / sleep / 放宽 / `.skip` / 调超时。

**修后实测（CPU 时间口径，单次操作，ms）**

| 场景 | sign 中位数 | sign p95 | verify 中位数 | verify p95 |
| --- | --- | --- | --- | --- |
| 单进程、空闲 | 0.389 | 1.270 | 0.166 | 0.260 |
| 2 并发全量套件（20 进程-run 观测区间） | 1.058–1.682 | 1.698–3.349 | 0.544–1.020 | 0.893–1.950 |
| 4 并发全量套件（**复现红的那一档**） | 1.233–2.007 | 2.101–3.990 | 0.649–1.231 | 0.912–1.729 |

⇒ 同一档负载下墙钟 p95 可以到 100–166 ms，CPU 时间 p95 始终 ≤ 3.99 ms：**度量与负载已解耦**
（对最贵的一次 sign p95 3.99 ms 余量仍有 25×；对 verify p95 1.73 ms 余量 58×）。

**证据（受控负载全绿）**
- **包级 2 并发 × 10 轮 = 20/20 进程-run 全绿**（`loadavg` 46–61；每轮 `7 passed (7)`、100 tests 全绿，
  含本用例；AC-09 的 CPU p95：sign 1.84–2.27 ms、verify 0.91–1.19 ms）。
- **全量 `unit` 2 并发 × 10 轮 = 20 进程-run：K02-AC-09 0 红**（文件最终字节，见下 sha256）。
  ⚠️ 这 20 个 run 里有 **7 个**因**别的既有墙钟判据/超时面**而红（与本用例无关、与本轮改动无关，见下"只报告"）。
- 更早一轮同形状的 2 并发全量套件 × 10 轮（= 20 进程-run，`loadavg` 26–61）里，
  **整个 `unit` 套件 20/20 全绿、0 次超时**（当时文件差一个注释行，行为等价；最终字节的复核以上两条为准）。
- 单进程聚焦跑 `vitest run --project unit tools/config-signer`：`7 passed (7)`、`100 passed`；未改动的第三条
  「对照记录」用例读数 sign/verify 中位数 0.28/0.16 ms（墙钟，空闲时与 CPU 时间同量级，符合预期）。

**变异三要素（10.9：先确认文件确实变了，再解释红/绿）**
- **M1（把统计量退回墙钟）**：把文件还原成基线字节，`sha256=cd63ade50eef5d84e3f464503425f9232601d3a8a391db426089e050ebb55c47`
  = **修前基线**（`git diff` 也非空）⇒ 文件确实变了。在**复现红的那一档（4 并发）**× 5 轮 = 20 进程-run：
  **5/20 红**，原文 `expected 130.14670800000022 to be less than 100`、`114.47937499999989`、
  `104.14883299999929`、`116.72975000000042`、`125.28462500000023`
  （另有一轮 p95 = 99.72 ms 擦线绿）。⇒ **墙钟口径在受控负载下确实红**，与病根一致。
- **M2（把单次成本人为放慢）**：`sha256=4f82d26651a27f8c178e141e22b23db2d2dab2f8a91076de1718d6b55eec050a`
  ≠ 修后字节 ⇒ 文件确实变了。**做法与"为什么不是统一 8×"（如实交代）**：本用例单次 CPU 只有
  0.2–3.2 ms，100 ms 预算有 25–500× 余量，**统一放慢 8× 远不足以打到 100 ms**；而"每次 > 100 ms"的
  统一放慢会让 100 次迭代总墙钟 > 10 s，**先撞 vitest 的 5 s 默认用例超时**——那是另一个失败面、
  证明力不足（我也拒绝用"调超时"来制造证据）。因此把自旋注入到 **p95 真正读到的那 6 个样本**
  （100 个样本的 p95 索引 = `ceil(100×0.95)-1 = 94`，即第 6 大样本），每条注入约 120 ms 纯 CPU 自旋
  （总自旋约 0.72 s，仍在超时之内）：**判红**，原文
  `AssertionError: sign 单次 CPU 耗时 p95 311.162 ms 应低于 100 ms: expected 311.162 to be less than 100`、
  `AssertionError: verify 单次 CPU 耗时 p95 317.495 ms 应低于 100 ms: expected 317.495 to be less than 100`。
  （**为什么是 311 ms 而不是 120 ms**：自旋用 `process.cpuUsage()` 轮询计时，实测 91.4 万次 `cpuUsage()`
  调用自身计入 **system** 时间 192.9 ms，样本 = 120.0 user + 192.9 sys ≈ 311 ms；同一次探针 60 ms 自旋 → 168 ms 墙钟 / 60.0 ms user。）
  ⇒ **阈值仍承重，且 p95 确实读的是尾部样本**（中位数不受影响，仍是 ~0.4 ms）。
- **恢复**：`cp` 回修后字节，`sha256=c076ccf7694c7273f74d0eaed7d30301f114ab9954c33cdd24e4580f6f305133`
  （与恢复前记录的修后字节逐字节一致；最终回归跑完后复核仍为该值）。**修前基线 sha256 见 M1，两者不同。**

**回归**（均在最终字节上跑）：`pnpm exec vitest run --coverage.enabled=false --project unit tools/config-signer`
→ `7 passed (7) / 100 passed`；`pnpm exec tsc -p tools/config-signer/tsconfig.json` → 退出码 0；
`pnpm exec eslint tools/config-signer/src --max-warnings 0` → 退出码 0。

**只报告、未扩大改动**
1. **本包（`tools/config-signer/src`）其余墙钟用法只有一处，且不是判据**：
   `performance.test.ts` 第 3 个用例「仅签名与仅验签的核心操作远低于预算（对照记录）」在第 118/130/134/142 行
   用 `performance.now()` 取 20+20 个样本，但**只 `console.log`、没有任何断言**（不会红）。
   按"只报告、不扩大改动"保留原样；将来若把它也变成判据，应一并换成 CPU 时间。
   全包静态扫描（`Date.now()` / `performance.now()` / `hrtime`）只命中这些行与新增的 `process.cpuUsage()`（45/55/57）。
2. **新发现·第五条同类（不在本 lane 可写范围，交负责人裁决）**：`tools/event-registry/src/__tests__/cli.test.ts`
   的 K01-AC-12「500 个事件定义的 check + generate + export-rules 总耗时不超过 5 秒」也是**墙钟度量计算量**：
   484 行 `const startedAt = Date.now()`、500 行 `const elapsed = Date.now() - startedAt`，
   随后 `expect(elapsed).toBeLessThanOrEqual(5_000)` 与 `expect(elapsed, ...).toBeLessThan(5_000)`
   （该用例自身给了 `120_000` 的用例超时，所以红的是**断言**、不是超时）。
   实测：**4 并发全量套件下 12/12 进程-run 全红**（原文形如
   `expected 5242 / 5337 / 5363 / 5522 / 5542 / 5600 / 5647 / 5803 / 6064 / 6212 / 6486 to be less than or equal to 5000`；
   同批 2 并发下也有 6 个 run 红，值到 10640 / 11657），
   且**修前**（基线文件）的 4 并发复现里 **24/24 日志同样红** ⇒ 与本轮改动无关、是本轮之前就存在的第五条。
   它与本用例同构（`run()` 走**进程内** `runCli`，第 31 行），因此 12.3/12.7 的 CPU 时间修法很可能同样适用；
   但 `tools/event-registry/**` 不在本 lane 可写范围，**我未改动任何一行**。
3. **另一处同族现象·超时面（只报告）**：同一份全量 2 并发负载（`loadavg`≈60）下，
   `tools/config-signer/src/__tests__/leak-scan.test.ts:94`「K02 全部子命令的输出中不含本次使用的任何密钥材料」
   出现过 **1 次** `Error: Test timed out in 5000ms`（vitest 默认用例超时；该用例要跑完全部子命令 + `git ls-files` 快照）。
   **这是 §12.3/10.6b 记过的"第二个失败面（超时也是墙钟量）"**，与 AC-09 的统计量病根同族；
   该文件也不在本 lane 可写范围，我**没有**调超时、**没有**改动它。
   同批另有 `tools/mock-receiver/src/injection.acceptance.test.ts` 的 M01-AC-09 在 1 个 run 里红
   （`expected 202 to be 429`），看起来是另一类竞态、与本轮无关，一并登记。


---

## 十三、两处基建缺陷：`browserCheck` 写死 macOS 路径 / `beacon-quota` 写死引擎名单（2026-10-16，基建缺陷 lane）

出处：`docs/reports/handover.md` 交接表第 3 行（"`examples/webpack` 的 `browserCheck` **写死 macOS 路径**
→ CI 上'Chromium 复核'永远 skipped"）+ 本文件「额外发现」第 3 条、第十一节第 5 条与
`docs/reports/e2e-real-browser.md` 跳过可见性 lane §6 的"同源残留"。**已修**，逐条给依据。

### 13.1 `examples/webpack` 的 `browserCheck`：写死 macOS 路径（handover 第 3 行）

**先复核实际状态（不照抄）**：两个脚本各有一份，写死**同一串**三合一常量：

```
examples/webpack/scripts/build-production.mjs:74-78   （修前）
examples/webpack/scripts/dev-server.mjs:148-152       （修前）
  join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
       'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
```

它把「本机装的是 `chromium-1223`」「平台目录 `chrome-mac-arm64`」「操作系统 `Library/Caches` + `.app` 包」
三件事同时钉死；`existsSync` 不成立就 `return { status: 'skipped' }`。**skipped 怎么产生的**：
不是浏览器起不来，而是**这条路径字符串在非 macOS 上必然不存在**——Linux CI 是
`~/.cache/ms-playwright/<build>/chrome-linux/chrome`，Windows 是
`%LOCALAPPDATA%\ms-playwright\<build>\chrome-win\chrome.exe`。所以 CI 上这一栏**从来没跑过**。

**与「#2（skipped 算 pass）」的关系**：是**同一处的两个不同缺陷**，不要混。`ccb8855` 修的是**判据**
（`classifyBrowserEvidence()`：`pass` 与**带理由**的 `skipped` 才 `accounted`，其余判红）——修完
"skipped 不再算 pass"，但"在 Linux 上必然 skipped"这条**没有变**，本轮的 `browserCheck` 依然走到那个 `return`。
本轮修的是**定位**：让它跨平台真的找到浏览器。

**改法**：新增 `examples/webpack/scripts/lib/chromium-locate.mjs`（唯一实现），定位顺序
① `PW_CHROMIUM_EXE` → ② `chromium.executablePath()`（Playwright 官方按 平台/架构/`PLAYWRIGHT_BROWSERS_PATH`
算出的期望路径，**不复制任何平台清单**）→ ③ 从①②的路径反推缓存根 + 各平台默认缓存根，枚举本机已装的
`chromium-*` 构建（按 revision 从新到旧）。关键：候选**存在**不算数，**真的 `launch()` 成功**才算数
（存在但起不来/缺依赖/架构不符不会被误判成可用）。定位不到时，把**试过的每一条路径与真实报错**
写进 `browser.attempts` / `browser.reason`（可审计），状态仍是 `skipped`（**不计入 pass**，由 #2 的白名单判据
显式记账）——**没有假装有浏览器**。

**判别性证明（三要素，2026-10-16 实跑）**：

| 场景 | 命令 | 观察到 |
|---|---|---|
| ① 正常（本机有 1223） | `node examples/webpack/scripts/build-production.mjs` | `browser.status=pass`、`chromeSource=ms-playwright chromium-1223`、`attempts=[{chromium.executablePath() … "文件不存在"}, {ms-playwright chromium-1223 … null}]`；**`status=pass`、exit 0`** —— 注意第一条候选（`executablePath()` 期望的 chromium-1248）在本机**不存在**：这正是旧代码"路径不存在就 skipped"的那一条，新代码会继续往下找到能启动的构建 |
| ② 没有任何可用浏览器（关掉全部候选） | `HOME=/tmp/proof-home PLAYWRIGHT_BROWSERS_PATH=/tmp/proof-browsers PW_CHROMIUM_EXE=/tmp/broken-chromium node examples/webpack/scripts/build-production.mjs` | `⚠ 浏览器复核已跳过…`、`browser.status=skipped`、`skipped=["browser"]`、`accounted=true`，`reason` 逐条列出：`env PW_CHROMIUM_EXE=/tmp/broken-chromium（browserType.launch: Target page, context or browser has been closed）；chromium.executablePath()=/tmp/proof-browsers/chromium-1248/…（文件不存在）`；exit 0（**不是 pass**，是显式记账） |
| ③ 通过 `PW_CHROMIUM_EXE` 指向**坏掉的**可执行文件 | 同上第一条候选 | 真的去 `launch()` → 真实报错被记录下来（**不是**"文件不存在"就跳过） |

**回归**：`pnpm examples:build` → **exit 0**；`pnpm examples:test` → **exit 0**（两个脚本各自
`browser.status=pass`、`skipped=[]`、整体 `status=pass`）。`tests/compat/results/webpack-{production,dev-server}.json`
是 `pnpm examples:*` 的产物，本轮**运行前快照 → 运行后按 sha256 还原回运行前内容**（`da8a858e…` / `fce14065…`
逐字一致），不把易变字段（`generatedAt`/随机端口）留给下一个人。

**没有做到的、需要负责人裁决的一点**：CI 的 **gates job 不装浏览器**（`.github/workflows/ci.yml` 只有 e2e job
跑 `playwright install`），而 `pnpm examples:build` / `examples:test` 正是 gates job 的步骤；e2e job 又
**不跑** examples。所以**今天没有任何一个 CI job 会执行 webpack 的浏览器复核**——本轮把"定位"修成跨平台后，
在装了浏览器的机器上这一栏会真的跑（本机实测 pass），但在 CI 上它仍然是 `skipped`（显式记账、带逐条原因）。
让它在 CI 上真的跑起来需要动 `.github/workflows/ci.yml`（gates job 装浏览器，或 e2e job 跑 `examples:*`），
**属门禁配置变更，本 lane 未越界改**。

### 13.2 `tests/e2e/beacon-quota.spec.mjs:56` 的写死引擎名单

**先复核实际状态**：那是 `for (const browserName of ['chromium', 'webkit'])` 包住 `test(...)`——它**不用**
project 的 `browserName`，于是在每个 project 下都声明同样两条写死引擎的用例。实测修前
`pnpm test:e2e --project=chromium tests/e2e/beacon-quota.spec.mjs` = **2 passed**（标题 `[chromium] …chromium…`
与 `[chromium] …webkit…`，即 chromium project 里同时起了 Chromium 与 WebKit 两个真浏览器）。
**它不是 skip**，是**测错引擎** → Gecko 的信标额度永远取不到数、`results/beacon-quota-firefox.json` 永不产生。

**改法与依据**：换成与 `leave-slice.spec.mjs` **同一套**口径——用例只声明一条、浏览器取自 project 的
`browserName`、真启动探测（唯一实现抽到 `tests/e2e/lib/browser-availability.mjs`，两个 spec 共用）、
起不来才经 `lib/skip-audit.mjs` 登记跳过；判据里无任何引擎名单。判别性证明与回归见
`docs/reports/e2e-real-browser.md` 的「追加节（e2e 基建缺陷 lane，2026-10-16）」证明 ①–④
（`--list` 3 project × 1 条；chromium/webkit 各 `executed=1/skipped=0` 两绿；
`E2E_FORCE_RUN_BROWSER=firefox` ⇒ 真去起 ⇒ `sandbox_init()` EPERM ⇒ **1 failed / EXIT=1** 而非跳过）。
**不得**把本节读成"Firefox 已验证"：本机沙箱内 Firefox 起不来，Gecko 上没有取到任何数。

### 13.3 只报告（未改）：其余写死引擎名 / 平台路径

`tests/e2e/lib/browsers.mjs:26-30` 的 macOS 布局表（仅第 3 回退分支，本机走的是第 2 分支）、
`tests/e2e/lib/d004-anchor-window.mjs:480`（信息性汇总）、`tests/e2e/lib/{d004-run,smoke-browsers}.mjs`
的 CLI 默认值/词汇表；以及**别 lane 范围**的 `tests/compat/scripts/vite-dev-server.mjs:31`、
`tests/compat/scripts/browser-core-path.mjs:38,43`（与 `examples/webpack` 修前同型）。
逐条位置与性质见 `docs/reports/e2e-real-browser.md` 追加节 §5 的表。

### 13.4 编排方裁定后的收尾（2026-10-16，同一 lane）

**裁定 (1)「把 examples 的浏览器复核接到装了浏览器的那个 CI job」——登记为待办，需负责人追认。**
本 lane **未**改 `.github/workflows/ci.yml`（门禁配置 + 范围外）。作为裁定前置，交了 job 覆盖清单
（全文逐行核对，实测 `.github/` 下只有 `ci.yml` 一个 workflow）：

| job | 装浏览器？ | 跑 examples？ | 依据 |
|---|---|---|---|
| `gates`（ubuntu-latest） | **否**（无任何 `playwright install`） | **是**：`pnpm examples:build` / `pnpm examples:test` | `ci.yml:12-31`（`:30`、`:31`） |
| `e2e`（ubuntu-latest，`needs: gates`） | **是**：`pnpm exec playwright install --with-deps` | **否**（只有 `pnpm build` + `pnpm test:e2e`） | `ci.yml:33-47`（`:45`、`:47`） |

⇒ 两 job 交集为空：**webpack 浏览器复核今天在任何 CI job 上都不会执行**（只会 `skipped`）。
`grep -rn "playwright install\|examples:build\|examples:test\|test:e2e" .github/` 仅上述四行命中。
最自然的接法：把 `examples:*` 加进 **`e2e` job**，或给 `gates` job 加 `playwright install chromium`。

**裁定 (2) `EXAMPLES_REQUIRE_BROWSER=1` opt-in——已实现**（详见 `docs/reports/e2e-real-browser.md`
追加节 §6）；默认仍是"定位不到 ⇒ `skipped`（不计 pass，不是失败）"，声明后变 `unavailable` ⇒ 判红 exit 1。
四场景判别性证明（opt-in 有/无浏览器 × 两个脚本）逐条实测于同一节。

**裁定 (3) `tests/e2e/probes/mutant-transport.js`——本 lane 不再管**（编排方另做 `git rm --cached` +
`.gitignore`）。如实记录：该文件由 `leave-slice.spec.mjs` 的 `beforeAll` 从 `packages/transport/dist`
**现场重建**，仓库里那份是**过期**的（含旧的 `BEACON_MAX_BYTES` / `LEAVE_BUDGET.maxBytes=48K`）——
我此前的 `git checkout --` 恢复**恰好把过期证据放回了仓库**，经本 lane 报备后由编排方纠正处置。

**裁定 (4) `tests/compat/scripts/{vite-dev-server.mjs:31, browser-core-path.mjs:38,43}`——只报告，已批准另派。**

**⑦ 残留表中落在本 lane 范围内的两条（各一行，未扩大）**：
`tests/e2e/lib/d004-anchor-window.mjs` 对清单外的 `d004-*.json` 加一行可见告警（判据一字未动，
植入/删除 `d004-firefox.json` 的正负对照见 e2e 报告 §6）；`examples/webpack/README.md:52` 的过期
"若本机存在 `chromium-1223`"改为真实定位链 + skipped/opt-in 语义。

---

## 十四、工具链侧同一病根的剩余项一次收口（2026-10-17，收口 lane）

出处：§12.6 第 1 条的"只报告"项、§12.6 第 2 条的超时面、§12.7 只报告的操作口径。本轮把
"墙钟度量计算量 / 无断言的对照记录 / 超时面 / 疑似竞态"四件事在 `tools/**` 内一次收口。
**可写范围只有 `tools/event-registry/src/__tests__/**`、`tools/config-signer/src/__tests__/**` 与本文件**；
未碰 `packages/**`、`tests/**`、`examples/**`、`vitest.config.ts`、`eslint.config.js`、`.size-limit.json`，
也**没有**跑 `pnpm gates`、**没有任何 git 写操作**（并发另一条 lane 在写 `tests/e2e/**`、`examples/webpack/**`）。

### 14.1 `event-registry` K01-AC-12：第五条同类（墙钟度量计算量）——已修

**复现（修前基线字节）**：自建 CPU 负载 + 10 个并发全量 `unit` 进程，`loadavg` 峰值 108；
**5/10 个进程-run 红**，原文形如
`AssertionError: expected 5031 to be less than or equal to 5000`（另有 5382 / 5445 / 5476 / 6027）。
同一批条件下这三个子命令的 **CPU 时间只有 191–386 ms**（独立量测：8 次采样 191.2–386.4 ms），
即墙钟被抢占/排队抬到 5 s 上限以上、CPU 时间几乎不动。修前基线文件另在 4 并发下 12/12 红（§12.6 第 2 条）。
**真因**：`Date.now()` 度量的是"被抢占多久 + 排队多久"，而命题"500 个事件定义 5 秒内 check+generate+export-rules"
关于**计算量**。**修法**：换成 `process.cpuUsage()` 差值（该包 `tsconfig` 有 `types:["node"]`，直接用全局 `process`，
未加 triple-slash、未 declare），**阈值 5000 ms 原值保留**，无 retry/sleep/放宽/skip/调超时。
**变异反证**：把 CPU 时间人为推到 > 5 s ⇒
`AssertionError: expected 5076.831 to be less than or equal to 5000`（红）；
把统计量退回 `Date.now()` 跑 10 并发全量套件 ⇒ **10/10 红**，原文
`expected 13935 / 14174 / 14436 / 14576 / 14982 / 15644 / 19964 / 20361 / 20823 / 22032 to be less than or equal to 5000`。
恢复后 sha256 `e4ff74143c752ee62e42493a50e566689d8e06ca36e49d8a11bb7c0386e2f9c7`（修前基线 `0d3fbd4436e3347e78984c7f277072b6c656c5cd6453944be5d12df917b8e10b`）。

### 14.2 `config-signer` `leak-scan.test.ts` 的超时面：**已按负责人裁定**改为 I/O 预算 + CPU 护栏

**复现**：受控负载（自建 CPU worker + 2 并发 `vitest --project unit tools/config-signer`，`loadavg` 63–108）
10 个进程-run 里 **2 个红**，原文 `Error: Test timed out in 5000ms.`——命中 `leak-scan.test.ts:219`
（"测试密钥只落在操作系统临时目录"）与 `:197`（"仓库中没有可解析的私钥文件"）；诊断副本另命中过 `:94`。
即**三条用例是同一个超时面**，不只是 §12.6 记录的那一条。
**真因（量出来的，不是猜的）**：该文件是 **I/O 主导、不是 CPU 主导**——用临时诊断副本逐用例量测
（`loadavg` 80、2 并发、各 10 次）：读仓库全部 843 个文件（8.7 MB）CPU 138–169 ms / 墙钟 375–723 ms；
400 文件扫描 CPU 59–65 ms / 墙钟 206–377 ms；`git ls-files -o` 单次墙钟 286 ms 而 **CPU 仅 4.8 ms**（全靠等子进程）。
三用例 CPU 合计 <0.6 s ⇒ 5 s 里约 88–94% 是排队/抢占/等 I/O。**没有可降的 CPU 肉**（能砍的只有"读仓库全部文件"，
而那正是 K02-AC-08 的证据本身，砍了就空转）。
**裁定与落地**（负责人 2026-10-17 批准，附三条条件）：① 三条用例逐用例显式 `15_000`，
**断言/阈值一字未动**，理由写进注释（I/O 主导 + 5 s 是 vitest 默认墙钟守卫而非契约判据）；
② 墙钟分布/最大值（见下）；③ **CPU 护栏**：三条用例各自断言**自身工作量的 CPU 时间上限**
`SCAN_CPU_BUDGET_MS = 3000 ms`（CPU 与负载无关，实测中位数 123–241 ms、极端超订下最大 570 ms，
余量 5–24×）。**护栏选择的理由**：预算一放宽，"跑得慢"就再也撞不死（15 s 才死），所以必须留下一个
**与负载无关、能被真实回归触发**的量；选 CPU 时间而不是墙钟告警，是因为墙钟告警在超订下同样会误报。

**墙钟分布（受控负载实测）**：
- 2 并发 × 30 run（`loadavg` 均值 164）：T1 1230 / p90 1495 / **max 1859 ms**，T2 642 / 841 / **940 ms**，
  T3 247 / 404 / **609 ms**；**30/30 绿、0 超时**。
- 3 并发 × 12 run（`loadavg` 44–59）：T1 **max 1455 ms**，T2 **757 ms**，T3 **465 ms**；12/12 绿。
- 4 并发 × 20 run（`loadavg` 65–214，10 核机上 32 worker）：T1 max 8845 ms、T2 max 9313 ms、T3 max 5014 ms，
  12/20 进程红。**如实记录：这个极端量级已经超过"15 s 有 >2× 余量"的前提**——本节把该组单独列出，
  不当作 15 s 的依据；依据是"一个 vitest 进程"的真实门禁条件（max 1.9 s，≈8× 余量）。
  若负责人认为门禁也可能出现 32-worker 同机超订，请给新的预算数字（我不自行往上加）。

**变异反证**：在 T2 被测操作里注入真实 CPU 燃烧（500 M 次 `sqrt` 反馁进 RNG，避免 JIT 消除）⇒
`AssertionError: 本用例自身工作量的 CPU 耗时 3583.1 ms 应低于 3000 ms`（红，且**没有**先撞 15 s 超时）；
恢复后 sha256 `009e377bcaaadb697d2b1248c7c522156c371e9e9c94fc05dc5f17a96fbfe9a2`
（修前基线 `abf34c8f100ad3bb3bd11fd6932b80da90e7bba5a38ff135744d96a7b2129f7d`）。

### 14.3 `performance.test.ts` 的"对照记录"：**已删除**（无断言 ⇒ 永不失败）

原用例「仅签名与仅验签的核心操作远低于预算（对照记录）」用 `performance.now()` 采样 20+20 次，
**只 `console.log`、无任何断言**。**选择删除而非加断言**，理由：其原始意图已被同文件上面两条用例
**完整且更严**地覆盖——①「进程内签名 100 次：中位数与 p95 均低于 100 ms」、②「进程内验签 100 次」
各取 **100** 个逐次 CPU 样本并断言 median/p95；对照记录只有 20 个样本、无 p95、无断言，属重复口径。
**判别性证明**：把 HEAD 基线（含该用例）复制成临时测试文件，在对照记录里注入人为变慢
（签名循环里加 400 k 次 `sqrt`）⇒ 该用例**照旧绿**（`Tests 8 passed`），全文件无红
⇒ 它确实是"看起来在测"的空转；删除后该文件 7 passed（回归见 14.5）。
修后 sha256 `f593d8c6675b2db65fc823a6c40b1cff4085b1413f785cd6ee7246c964c1f100`
（修前基线 `c076ccf7694c7273f74d0eaed7d30301f114ab9954c33cdd24e4580f6f305133`）。

### 14.4 `mock-receiver` M01-AC-09 `expected 202 to be 429`：**已复现，真因是"上一用例超时后悬挂的请求把状态推走"——属测试缺陷**

**复现**：8 并发全量 `unit`（`loadavg` 56–73）8 个进程-run 里 **2 个红**，原文
`AssertionError: expected 202 to be 429 // Object.is equality`，位置
`injection.acceptance.test.ts:145`（M01-AC-09 清空注入配置后不再注入）；**同一 run 里**
`:124`「比例注入经 HTTP 生效且计数正确」先报 `Error: Test timed out in 5000ms.`。
单跑 40 + 30 + 48 次（1/4/6 并发，低负载）**0 红**，即高负载 + 与 :124 同 run 才出。
**真因**：`:124` 的 300 次串行 HTTP 在超订下超 5 s 默认超时 ⇒ vitest 判该用例失败，
**但已发出的请求不会被取消**；`:145` 紧接着把注入设为 `['429']` 并发出一批，
上一用例遗留在途的请求会在它之前消费掉序列游标（`none` 返回 `NONE` 且**不推进游标**，
见 `injection.ts` 的 `decide()`），于是本应 429 的请求恰好命中序列已耗尽 ⇒ 202。
**排除项（反证）**：① 每次 `startReceiver({ port: 0 })` 都新建独立 `state.injection`（`server.ts:703`），
**无跨进程共享状态**；② 端口复用探测 400 次得到 400 个不同端口、0 次复用（macOS），
"两个进程撞同一端口"不成立；③ HTTP 注入端点 `/__mock/injection` 只作用于本进程实例。
**结论**：属**测试缺陷**（默认 5 s 超时 + 无法取消的串行请求循环），**实现未改**。
可考虑的最小修法（**未做**，请裁定）：给 `:124` 降低请求次数并按二项分布重新校准 25%–35% 带
（n=120 时 3σ ≈ ±0.125 ⇒ 带取 17%–43% 仍能抓住"比例失效"），或给该用例显式超时——
两者都超出本次四点，按"若属实现缺陷只报告、不要改实现"的口径先报。

### 14.5 只报告：`tools/**` 下其余墙钟判据（有断言的）

静态扫描（`Date.now()` / `performance.now()` / `hrtime`，排除 `dist/`）后，**除已修三处外仍有断言的墙钟判据**只有两条，都在 `tools/mock-receiver`：

| 位置 | 被断言的量 | 说明 |
| --- | --- | --- |
| `tools/mock-receiver/src/hosting.acceptance.test.ts:113-116`（M01-AC-13） | `startReceiver()` 单次启动耗时 `elapsed < 2000 ms` | 直接墙钟断言，且**没有**像本文件 M01-AC-14 那样的负载标定注释 |
| `tools/mock-receiver/src/hosting.acceptance.test.ts:20-27,211-216`（M01-AC-14） | 5 轮 × 1.2 s 压测的**吞吐中位数** `perSecond >= 40 批/秒` | 墙钟吞吐（`batches / seconds`）。**本轮实测在最严条件（8 并发全量 `unit`、`loadavg` 56–73）下红过 2 次**：`24.1 批/秒` 与 `32.8 批/秒`，原文 `expected 24.05… to be greater than or equal to 40`。它自称"回归护栏不是规格线"，但负载敏感是事实 |

另外 `tools/event-registry/src/cli.ts`（`generatedAt: Date.now()`）、
`tools/mock-receiver/src/logger.ts`（日志 `ts`）、`tools/mock-receiver/src/server.ts`（`serverTime`/`boundAt`）
里的 `Date.now()` 是**产物字段/时间戳**，不是判据，未登记为风险。

### 14.6 本轮回归与绿跑（均在最终字节上）

| 项 | 条件 | 结果 |
| --- | --- | --- |
| `tools/config-signer`（7 文件 / 99 tests） | 受控负载 2 并发 × 10 run | **10/10 绿、0 超时** |
| `tools/event-registry`（5 文件 / 52 tests） | 受控负载 2 并发 × 10 run | **10/10 绿、0 超时** |
| 两包各 1 次 | 空闲（`loadavg1` 21–24） | 绿（52 + 99 tests） |
| `npx eslint tools/event-registry/src tools/config-signer/src --max-warnings 0` | — | 退出码 0 |
| `npx tsc -p tools/{event-registry,config-signer}/tsconfig.json` | — | 两者退出码 0 |

**最终 sha256（三处全部变异恢复后复核）**：
- `tools/event-registry/src/__tests__/cli.test.ts` `e4ff74143c752ee62e42493a50e566689d8e06ca36e49d8a11bb7c0386e2f9c7`
- `tools/config-signer/src/__tests__/leak-scan.test.ts` `009e377bcaaadb697d2b1248c7c522156c371e9e9c94fc05dc5f17a96fbfe9a2`
- `tools/config-signer/src/__tests__/performance.test.ts` `f593d8c6675b2db65fc823a6c40b1cff4085b1413f785cd6ee7246c964c1f100`

**需负责人裁决**：14.2 的极端超订（32 worker/`loadavg` 214）下 15 s 是否够；14.4 的 `:124` 最小修法是否要另派。
