# @web-report-sdk/plugins —— 采集插件包（C05）

本包承载**四个内置采集插件（C05-F1..F4、F6，T18）**与 **C05-F5 第三方 APM 双写适配器（T19）**。

## 0. 四个按需入口（C05-AC-13）

| 入口 | 内容 | gzip 实测（本轮） |
|---|---|---|
| `@web-report-sdk/plugins/error` | C05-F1 错误归一化、指纹、去重、面包屑 | 3.4 KB |
| `@web-report-sdk/plugins/perf` | C05-F2 核心指标与长任务 | — |
| `@web-report-sdk/plugins/route` | C05-F3 自动路由与页面浏览 | — |
| `@web-report-sdk/plugins/http` | C05-F4 HTTP 采集与追踪头注入 | — |
| `@web-report-sdk/plugins` | 全量聚合（含 T19 双写适配器） | 9.2 KB |

体积预算（T18-plan §5）：全量入口 **gzip 后不超过 20 KB**。AC-13 的"仅错误插件构建"由
`tsup.error.config.ts` + `scripts/check-error-only-bundle.mjs` 在 `pnpm build` 里强制：
产物出现 perf/route/http/双写适配器的可识别符号即**非零退出**。

> AC-13 的产物扫描放在 `scripts/`（构建脚本域）而不是包内单元测试：本包是**浏览器包**，
> `tsconfig.json` 刻意是 `"types": []`；为了一个测试能 `import 'node:fs'` 而给整包打开 node types，
> 等于允许实现代码随手用 `fs`/`path`/`process`——这些在浏览器里会直接炸。

本模块顶层无副作用（不注册原生监听、不访问 `window`），`package.json` 声明 `"sideEffects": false`，
可在 SSR 与 Vitest 中直接导入。本包只依赖 `@web-report-sdk/core`（workspace）用于 C02 插件宿主类型，
**不依赖任何第三方包**。

---

## 0.1 接入方需要知道的行为（照实现写清，避免"实现定义"）

### F1 错误插件（`/error`）

- **指纹构成**（去重的键，接入方可据此预测去重行为）：
  `error_type` + `source` + **归一化后的 message** + `line` + `column` 的 FNV-1a 32 位十六进制哈希（8 字符）。
  "归一化"= 剥离 URL 查询参数（`?...`）并把连续数字替换为 `N`，因此同一处代码在不同请求/不同计数下
  得到**同一指纹**；反过来，**只靠数字区分的两条消息会被判为同一错误**。
- **聚合窗口（用户可见的时延变化）**：同一指纹在 **1 秒窗口**内只上报**一条** `web_js_error`，
  其 `metrics.count` 为窗口内总次数；被折叠的重复计原因码 `filtered_by_plugin`。
  **错误事件最多延迟 1 个窗口（≤1s）**；页面离开（`pagehide` / 隐藏）、`uninstall()` 与显式
  `flush()` 都会立即结算，避免"离开前发生的错误"丢失。
- **面包屑**：固定 **20 条**容量、**不开放配置**；只记元素标识（标签名 + `id`/`data-track`/`data-testid`）
  与动作类型，**绝不记录输入框的 `value`**；路由面包屑只记路径（去掉 `?query`/`#hash`）。
  承载方式：`web_js_error.dimensions` 是契约里的**封闭四键**、`metrics` 只认 `count/line/column`，
  因此面包屑写在事件的 `context` 上（`bc_00`…`bc_19`，键名匹配 Schema 的 `fieldKey`）。
- **脱敏边界**：本插件**不做**脱敏，只把原始 message/stack 交给管线（脱敏归 C04）。
  ⚠️ 已知缺口：C04 的 `constrainEvent` 只对 `dimensions`/`context` 的字符串值脱敏，
  `attachment`（错误栈）**只做 8 KB 截断、不脱敏**——AC-01 的"脱敏后的错误栈"当前只覆盖到
  `dimensions.message`，待 C04 修复后回改（修复后 `src/error/capture.test.ts` 里那条哨兵会变红，那是预期）。

### F2 性能插件（`/perf`）

- 五类核心指标共用 `web_vitals`：`FCP`/`LCP`/`CLS`/`INP`/`TTFB`，值在 `metrics.value`/`metrics.delta`；
  `rating` 三档。上报时机：加载完成 → FCP/LCP/TTFB；交互后 → INP；页面隐藏 → CLS。
- **`rating` 阈值（本任务按 Web Vitals 官方值定，真实浏览器差异归 T29）**：
  FCP ≤1800 good / >3000 poor；LCP ≤2500 / >4000；CLS ≤0.1 / >0.25；INP ≤200 / >500；TTFB ≤800 / >1800；
  区间之间为 `needs-improvement`。
- 长任务单列 `web_long_task`，其 `dimensions` 是**空对象**（契约不允许任何维度键）。
- **不采集** `resource` 与 `navigation` 的明细条目（契约没有承载字段）。

### F3 路由插件（`/route`）

- 默认 `mode: 'history'`：包装 `pushState`/`replaceState` 并监听 `popstate`；`mode: 'hash'` 只监听
  `hashchange`；`mode: 'manual'` 不包装不监听，只在业务调用 `setPage` 时通知。
- 包装遵循 Q7 叠加规则：安装时保存**当前**引用并叠在其上，卸载时**仅当当前值仍是自己的包装**才还原；
  不改变原生签名/返回值/`this`，不吞宿主异常。
- `page_id` 的最终计算归 C04；本插件只发 `path`（路由模板）+ `via`。

### F4 HTTP 插件（`/http`）

- **请求体默认不采集**（硬约束）：不注册任何读取 `body`/`FormData`/`Blob` 的逻辑。
- SDK 自身的上报请求靠**显式标记**（`x-web-report-sdk-internal`，请求上的 `sdkInternal`）识别，不靠 URL 猜测。
- `failure_reason` 取值集（CR-006，只表达传输层失败）：`network_error`/`timeout`/`aborted`/`cors`；
  **成功请求省略该维度**；4xx/5xx 走 `metrics.status` + `dimensions.status_class`（`1xx`…`5xx`），不用该维度。
- URL 进的是 `dimensions.url_template`（缺省去掉 `?query`/`#hash`），**不是实参 URL**。
- 链路追踪头（AC-12，CR-006）：W3C `traceparent`（必需）/`tracestate`（可选）；
  **值由接入方注入**（`traceContextProvider`），未提供则**不注入**；只对**同源或白名单**注入，
  白名单外一律不注入（不做降级注入）；远程配置只能**收紧**范围（`narrowScope`）。

---

## 1. 第三方 APM 双写适配器（C05-F5，T19）

迁移期把本 SDK 的自定义事件按可配置映射转发给接入方已有的 APM SDK，用于 T33 的对账。

### 1.1 硬约束（Q7、指南第 4.2 / 11 节）

| 约束 | 说明 |
|---|---|
| 注入，不 import | 第三方接口由接入方**注入**；适配器源码与产物都不出现任何第三方包（C05-AC-18） |
| 单向 | 只把本 SDK 的事件写出去，**不从第三方 APM 读取数据**（Q7 第 3 条） |
| 默认关闭 | 只 `registerPlugin` 不会转发；必须显式 `applyPluginConfig({ apm_dual_write: true })`（Q7 第 2 条） |
| 映射可配置 | 字段映射、固定字段、转发范围都由配置给出，便于对账与字段对齐 |
| 异常隔离 | 第三方接口抛错或不存在时只计数 `processor_error`，本 SDK 照常上报（C05-AC-16） |
| 零运行时依赖 | 只用 ES2020 语言特性与闭包，无 class、无 `any`、无 `@ts-ignore` |

### 1.2 注入接口

```ts
/** 第三方 APM 接口：接收按映射构造的记录，返回值忽略。 */
type ApmForward = (record: Readonly<Record<string, unknown>>) => void;

interface ApmDualWriteOptions {
  forward?: ApmForward;                       // 直接注入（第三方 SDK 已在手）
  resolve?: () => ApmForward | undefined;     // 惰性解析：第三方 SDK 未加载时返回 undefined
  fieldMap?: Readonly<Record<string, string>>; // 目标字段名 → SDK 事件字段路径
  constants?: Readonly<Record<string, unknown>>; // 每条记录附加的固定字段
  eventTypes?: readonly string[];             // 转发的 event_type，缺省 ['custom']
}
```

- `forward` 与 `resolve` 二选一，同时给出时 `forward` 优先；两者都没有（或 `resolve()` 返回 `undefined`）
  时按「第三方接口不存在」处理：**每条命中事件计数一次 `processor_error`**，事件继续流转。
- `ApmForward` 收到的是**每条事件新建的对象**；其中的 `dimensions` / `metrics` 是按引用传入的，
  第三方实现应当只读使用（不要就地修改）。

### 1.3 映射配置格式

`fieldMap` 的键是**第三方字段名**，值是**本 SDK 事件字段路径**（用 `.` 表示层级，支持
`dimensions.<key>`、`metrics.<key>`、`context.<key>` 等；`context` 由 C04 在此前写入事件）。

```ts
const plugin = createApmDualWritePlugin({
  forward: (record) => thirdPartyApm.track(record),
  fieldMap: {
    eventName: 'event_name',        // 重命名：第三方用 camelCase
    timestamp: 'occurred_at',
    level: 'priority',
    page: 'page_id',
    taskId: 'dimensions.task_id',   // 从 dimensions 里挑一个维度拍平
    duration: 'metrics.duration_ms',
  },
  constants: { source: 'web-report-sdk' },  // 每条记录都带；被 fieldMap 命中时以映射值为准
});
// 事件 { event_name:'task_submit_complete', dimensions:{task_id:'t-1'}, metrics:{duration_ms:12} }
// → { source:'web-report-sdk', eventName:'task_submit_complete', timestamp:…, page:…, taskId:'t-1', duration:12 }
```

规则：

- **取值缺失的目标字段不写入记录**（不会写 `undefined`）；`0`、`''`、`false` 会写入。
- `constants` 先铺底，`fieldMap` 的结果覆盖同名目标字段。
- 缺省 `fieldMap`（`DEFAULT_APM_FIELD_MAP`）保留 SDK 字段名，并把 `dimensions` / `metrics`
  整个对象传出去：

  | 目标字段 | SDK 路径 | | 目标字段 | SDK 路径 |
  |---|---|---|---|---|
  | `event_name` | `event_name` | | `priority` | `priority` |
  | `event_type` | `event_type` | | `page_id` | `page_id` |
  | `occurred_at` | `occurred_at` | | `url` | `url` |
  | `event_id` | `event_id` | | `dimensions` | `dimensions` |
  | | | | `metrics` | `metrics` |

- `eventTypes` 缺省 `['custom']`（`DEFAULT_APM_EVENT_TYPES`）：**只转发自定义事件**，与 Q7
  「本 SDK 的自定义事件可以转发给第三方 APM」一致；要连同错误/性能一起转发时显式放宽，例如
  `eventTypes: ['custom', 'error', 'perf']`。`event_type` 不是字符串的事件一律跳过。

### 1.4 开启与关闭

插件 id 是 **`apm_dual_write`**，与 `docs/contracts/schemas/remote-config.schema.json` 的
`pluginName` 枚举一致；远程配置用 `plugins.apm_dual_write.enabled` 控制。

```ts
import { createApmDualWritePlugin, APM_DUAL_WRITE_PLUGIN_ID } from '@web-report-sdk/plugins';

const dualWrite = createApmDualWritePlugin({ resolve: () => window.thirdPartyApm?.track });

kernel.registerPlugin(dualWrite);                                  // 只登记定义：默认关闭
kernel.applyPluginConfig({ [APM_DUAL_WRITE_PLUGIN_ID]: true });    // 显式开启：安装并开始转发
kernel.applyPluginConfig({ [APM_DUAL_WRITE_PLUGIN_ID]: false });   // 关闭：卸载，处理器与能力一起释放
```

- 适配器在 **`before_send`** 段注册处理器（校验→富化→过滤→采样→构建之后），因此转发的是
  最终形态的事件，且被采样/过滤掉的事件不会转发。
- 卸载由 C02 插件宿主负责：`applyPluginConfig({ apm_dual_write: false })` 会注销处理器与计数能力，
  不会残留监听或定时器。
- `ApmDualWritePlugin` 的 `id` / `install` 与 C02 `Plugin` 结构一致，可直接交给
  `kernel.registerPlugin`（`ApmDualWriteContext` 是 `PluginContext` 的结构子集；见测试文件
  末尾的编译期赋值检查）。

### 1.5 计数口径（给 T33 对账用）

| 计数 | 位置 | 含义 |
|---|---|---|
| `processor_error` | 内核计数器 `kernel.counters.get('processor_error')` | 第三方接口抛错或不存在，**每条命中事件计 1**（契约 `reason-codes.md` 第 2 节，不新增原因码） |
| `forwarded` | 能力 `apm_dual_write.stats` / `dualWrite.stats()` | 成功交给第三方接口的记录数 —— Q6 的「双写转发计数」 |
| `failed` | 同上 | 抛错或不存在而跳过的记录数 |
| `skipped` | 同上 | `event_type` 不在 `eventTypes` 范围内而未转发的记录数 |

```ts
import { APM_DUAL_WRITE_STATS_CAPABILITY } from '@web-report-sdk/plugins';
import type { ApmDualWriteStats } from '@web-report-sdk/plugins';

const stats = kernel.getCapability(APM_DUAL_WRITE_STATS_CAPABILITY) as ApmDualWriteStats | undefined;
// T33：SDK 侧 events_sent（C08） ≈ 双写 forwarded ≈ 接收方入库量，偏差 ≤ 1%
```

能力值在插件安装期间持续可读（**实时计数对象**，请只读使用）；插件卸载后能力被移除，
此时仍可用之前持有的 `dualWrite.stats()` 快照（返回副本）。`failed > 0` 时先排查第三方接口，
不要把它当成 SDK 的丢弃。

### 1.6 体积与「不含第三方包」的实测（C05-AC-18）

```bash
node packages/plugins/scripts/measure-apm-adapter.mjs
```

脚本用仓库自带的 tsup 把适配器入口 `src/apm-dual-write/index.ts` 打成**与交付形态一致的**
压缩 ESM（ES2020），然后：扫描源码确认所有模块说明符都是相对路径、扫描产物确认没有裸模块
说明符或 `require()`、最后度量 gzip（level 9）。gzip 超过 1536 B（1.5 KB）或有第三方引用时
返回非零退出码。2026-10-12 实测（本仓库当前代码）：

```
第三方包检查：ok（源码 2 个文件、产物均无裸模块说明符）
apm-dual-write 压缩 ESM（与交付形态一致）：raw 1199 B，gzip 705 B，brotli 585 B
gzip 705 B <= 1536 B：ok
```

---

## 2. 给 T33（试点迁移对账）的要点

1. 接入方注入自己的 APM 上报函数（`forward`，或 `resolve` 以支持第三方 SDK 后加载）。
2. 对照旧链路字段逐条写 `fieldMap`，把新旧字段名差异显式记录下来 —— 这张表就是迁移对账的字段依据。
3. 显式开启双写并跑 7 天；每天比对 `events_sent`（C08）、`forwarded`（本适配器）与接收方入库量，
   偏差 ≤ 1% 视为达标（Q6）。
4. `processor_error` 增长说明第三方接口不可用；`failed` 与 `skipped` 分开看：
   `skipped` 通常只是 `eventTypes` 没有放开该 `event_type`，不是故障。

## 3. 给 T34（迁移指南）的要点

- 双写是**单向**的过渡手段：开启 → 对账 → 关旧链路 → 删除旧埋点（Q6 的 5 步流程）。
- 迁移指南里说明「适配器不 import 任何第三方包」：接入方在自己的应用代码里把第三方 SDK 的
  上报函数传给适配器即可，升级 SDK 不会与第三方包的版本耦合。
- 默认关闭是刻意的（Q7 第 2 条）：迁移指南要写清开启方式与回滚方式（`enabled: false` 即刻停止转发）。

---

## 4. 本地自检

```bash
pnpm exec vitest run --coverage.enabled=false packages/plugins/src/apm-dual-write
pnpm exec vitest run --coverage
pnpm exec tsc -p packages/plugins/tsconfig.json
pnpm exec eslint packages/plugins/src packages/plugins/scripts
node packages/plugins/scripts/measure-apm-adapter.mjs
```
