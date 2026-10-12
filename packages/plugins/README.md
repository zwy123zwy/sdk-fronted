# @web-report-sdk/plugins —— 采集插件包（C05）

本包承载 C05 采集插件（T18）与 **C05-F5 第三方 APM 双写适配器（T19）**。
当前只有双写适配器；T18 的四个内置采集插件尚未实现，`PACKAGE_NAME` 保留不变。

本模块顶层无副作用（不注册原生监听、不访问 `window`），`package.json` 声明 `"sideEffects": false`，
可在 SSR 与 Vitest 中直接导入。**本包当前零依赖**（不依赖 `@web-report-sdk/core`，也不依赖任何第三方包）。

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
