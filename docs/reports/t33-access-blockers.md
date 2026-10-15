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
