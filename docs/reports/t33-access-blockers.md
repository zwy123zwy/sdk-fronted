# T33 接入阻塞点与文档缺陷清单

- 产出任务：T33（试点）中不依赖 Q2 的部分
- 日期：2026-10-16
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
| **D-03** | **阻断级（文档）** | 指南把 M01 的上报端点写成 `/ingest`，真实路径是 `/v1/batch` → 照做必 404 | T34（文档） |
| **D-04** | 高（文档） | 指南第 8.3 节的自检片段**不是可运行代码**（`Assembly` 没有 `track`） | T34（文档） |
| **D-05** | 中（文档） | 指南称"webpack 与开发服务器未在本仓库验证"，**已过期**（T30 已实测通过） | T34（文档） |
| **D-06** | 中（方法论） | 既有"端到端验证"用的是**不校验结构的自定义接收端**，让 D-01 逃过多轮验收 | T30/T29 的口径 |
| **D-07** | 低（文档） | 指南的 flush 后立刻查计数会读到 0（异步投递未说明） | T34（文档） |

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

---

## D-07（低·文档）：`flush()` 后立刻查计数会读到 0

`integration.md` 第 8.3 节把「`track` 后 `flush`」与「查 M01 计数」写成相邻两步（第 3、4 步），
但 `flush()` 是**异步投递**：实测立刻查 `received_batches` 恒为 0，等一次网络往返后才是 1。
指南未说明这一点，接入方易误判为"上报失败"。

### 建议（归 T34）

在该节加一句：`flush()` 只是**发起**投递，查计数前需等待投递完成
（或轮询计数直到非 0，并设超时）。

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
