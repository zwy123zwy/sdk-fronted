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

`docs/guides/integration.md:14`：

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

**同族残留（未在本任务范围，值得后续处理）**：`examples/vite/package.json` 的 `test` 是
`node -e "process.exit(0)"`（**永远绿的空测试**）、`examples/node-import` 只断言 `SDK_VERSION`
是字符串、`examples/script-tag/check.mjs` 同理——"examples 验证"里仍有几处只证"导入得到常量"，
不证"装配与投递链路活着"；`verify-bundle.mjs` 的 `checks.bundleEvaluated` 是**恒真常量**。

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
