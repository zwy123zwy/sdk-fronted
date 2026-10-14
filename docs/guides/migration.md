# 迁移指南

- 对应交付：T34（A14）；读者：接入方的数据/前端负责人、迁移执行人
- 事实来源：`docs/decisions/Q6-migration.md`（五步流程与验收口径）、`Q7-apm-coexistence.md`（与第三方 APM 共存）、`packages/plugins/README.md`（T19 双写适配器注入契约）、`docs/contracts/receiver-requirements.md` 附录 A 与 `reason-codes.md` 第 4 节（对账口径）

## 0. 前提与边界

**职责边界（Q6 第 1 条）**：本项目提供迁移所需的**能力与流程**（双写适配器、对账所需数据、本指南），**不负责改造接入方的业务代码**。各接入方的迁移由该接入方负责，本项目提供陪同支持。Agent 不修改任何接入方仓库（指南第 0 节）。

**迁移顺序（指南第 4.3 节）**：先双写、再对账、最后切换。

**当前可执行性（必读）**：

| 环节 | 状态 |
|---|---|
| 双写适配器本体（C05-F5/T19） | 已合入 main `62dec1d`，评审中 |
| 把适配器挂到内核插件宿主（装配根 T18） | **已交付**：`createAssembly()` 返回可安装插件的装配实例（`assembly.kernel`），先 `registerPlugin(createApmDualWritePlugin(...))` 再 `applyPluginConfig({ apm_dual_write: true })`，**第 2 步可执行**（见 [API 参考](api-reference.md) 第 7 节） |
| 客户端的发送量计数（C08/T17） | 已合入 main `51a1c56`，评审中；**接线已在 T18 装配根完成**（`calls_total`/`events_enqueued`/`events_sent`/`batches_sent`/`queue_length_max`/三个 p99 随 `sdk_health` 上报） |
| 对账报告（原 S06） | **不在本项目内**（Q6 结论）：改为由 SDK 提供对账所需数据，由接入方/接收方生成报告 |
| 试点迁移对账（T33） | **未就绪**，是 Q6 验收标准（三方计数偏差 ≤1%）的行使者 |

因此本指南给的是**流程与口径**；T18 装配根已交付，第 2 步（双写）现在可执行，但**真实浏览器下的对账（第 3–5 步的自动化）仍归 T33**。

## 1. 五步流程（Q6 第 2 条）

| 步 | 动作 | 产出 / 判据 |
|---|---|---|
| 1 | **盘点与映射**：盘点现有埋点，逐条映射到埋点字典中的事件定义 | 一份"旧埋点 → 事件名 + 字段"的映射表；K01 注册表可通过 `check` |
| 2 | **开启双写**：新 SDK 正常上报，同时通过双写适配器或旧代码继续写旧链路 | 两条链路同时有数据；`forwarded` 与旧链路计数对得上 |
| 3 | **对账**：逐日比对，连续 **7 天偏差不超过 1%** | 三方计数（SDK 发送 / 双写转发 / 接收方入库）每日报告 |
| 4 | **关闭旧链路写入**，保留旧数据只读 | 旧链路只读；新链路计数稳定 |
| 5 | **观察 7 天**，无异常后删除旧埋点代码 | 旧埋点代码移除 |

项目的范围（Q6 第 3 条）：P5 的 2 个试点应用完成**第 1–3 步**即可满足里程碑 M6；第 4、5 步在 M8 之后的 3 个月内完成。下线期限（Q6 第 4 条）：每个接入方**在开始双写后 3 个月内完成第 4 步**；超期由项目发起人裁定是否延期。

### 第 1 步：盘点与映射

事件定义放在接入方自己仓库的 `events/*.json`（元模型 `docs/contracts/schemas/event-definition.schema.json`，契约 0.2）。K01 只读这些文件。

事件定义的关键字段（以一个 `critical` 事件为例，取自 `examples/event-registry/events/checkout_order_complete.v3.json`）：

```json
{
  "event_name": "checkout_order_complete",
  "schema_version": 3,
  "event_type": "custom",
  "description": "订单支付完成并生成结算单",
  "owner": "team-payment",
  "trigger": "支付回调校验通过、结算单落库成功后上报一次",
  "priority": "critical",
  "critical_reason": "结算与对账的唯一数据源，丢失后没有其他数据可以补回",
  "status": "active",
  "app_ids": ["your-app-id"],
  "fields": [
    { "name": "order_type", "kind": "dimension", "type": "enum", "required": true,
      "enum_values": ["normal", "group", "presale"], "sensitivity": "none", "description": "…" },
    { "name": "amount_ratio", "kind": "metric", "type": "number", "required": true,
      "unit": "ratio", "sensitivity": "none", "minimum": 0, "maximum": 1, "description": "…" }
  ]
}
```

映射时逐条决定：

- **投递等级**：只有同时满足 Q3 两条标准的事件才能标 `critical`——① 记录业务终态或不可重放的用户动作；② 丢失会直接影响结算、审计、合规或核心业务指标，且没有其他数据源可补回。**投递等级只能在注册表中声明，业务代码调用时不能改**；注册表声明为 critical 的事件，调用时不写也按 critical 处理（Q3 结论第 2 条）。
- **配额**：`critical` 事件名数 ≤ 事件名去重总数 × 10%，由 K01 在 CI 里检查，超出即失败（Q3 结论第 3 条）。自动采集的错误/性能/页面浏览/HTTP 事件与 SDK 自监控事件**一律 normal**（Q3 结论第 4 条）。
- **敏感度**：字段的 `sensitivity`（`none` / `mask` / `hash` / `drop`）决定接收方脱敏与运行期校验的强度；`unit` 决定指标后缀（`_ms` / `_bytes` / `_ratio`）；`required` 决定必填。
- **版本**：改字段必须递增 `schema_version`（兼容变更也要）；只改 `description` / `trigger` / `owner` 不需要。

CI 里接 K01：

```bash
web-report-event-registry check --registry events/*.json --baseline-git origin/main
# 破坏性变更默认拦截；已获数据负责人批准并递增版本时用 --allow-breaking 放行
```

完整子命令、选项、退出码与判定表见[工具指南 · K01](tools.md#k01-事件注册表与类型生成)。

### 第 2 步：开启双写

双写适配器把**本 SDK 的自定义事件**按可配置映射转发给接入方已有的 APM SDK，用于对账。它**不 import 任何第三方包**：接入方在自己的应用代码里把第三方的上报函数注入进去（升级本 SDK 不会与第三方包的版本耦合）。

```ts
import { createApmDualWritePlugin, APM_DUAL_WRITE_PLUGIN_ID } from '@web-report-sdk/plugins';

const dualWrite = createApmDualWritePlugin({
  // 二选一：第三方 SDK 已在手用 forward；可能后加载用 resolve 惰性解析
  resolve: () => (window as unknown as { thirdPartyApm?: { track: (r: unknown) => void } })
    .thirdPartyApm?.track,

  // fieldMap 的键是第三方字段名，值是本 SDK 事件字段路径（. 表示层级）
  fieldMap: {
    eventName: 'event_name',        // 重命名：第三方用 camelCase
    timestamp: 'occurred_at',
    level: 'priority',
    page: 'page_id',
    taskId: 'dimensions.task_id',   // 从 dimensions 里挑一个维度拍平
    duration: 'metrics.duration_ms',
  },

  constants: { source: 'web-report-sdk' },   // 每条记录都带；被 fieldMap 命中时以映射值为准
  eventTypes: ['custom'],                    // 缺省就是 ['custom']：只转发自定义事件
});

// 只登记定义：默认不转发（Q7 第 2 条）
kernel.registerPlugin(dualWrite);
// 显式开启
kernel.applyPluginConfig({ [APM_DUAL_WRITE_PLUGIN_ID]: true });
// 回滚：立刻停止转发（处理器与计数能力一起释放）
kernel.applyPluginConfig({ [APM_DUAL_WRITE_PLUGIN_ID]: false });
```

配置规则（`packages/plugins/README.md` 第 1 节，逐条对齐 `ApmDualWriteOptions`）：

- `forward` 与 `resolve` 二选一，同时给出时 `forward` 优先；两者都没有（或 `resolve()` 返回 `undefined`）时按"第三方接口不存在"处理：**每条命中事件计数一次 `processor_error`**，事件继续流转。
- 取值缺失的目标字段**不写入记录**（不会写 `undefined`）；`0`、`''`、`false` 会写入。`constants` 先铺底，`fieldMap` 的结果覆盖同名目标字段。
- `eventTypes` 缺省 `['custom']`（`DEFAULT_APM_EVENT_TYPES`）：**只转发自定义事件**。要连同错误/性能一起转发时显式放宽，例如 `eventTypes: ['custom', 'error', 'perf']`；`event_type` 不是字符串的事件一律跳过。
- 适配器在 **`before_send`** 段注册处理器（校验→富化→过滤→采样→构建之后），因此转发的是最终形态的事件，且**被采样/过滤掉的事件不会转发**。
- `ApmForward` 收到的是每条事件新建的对象；其中的 `dimensions` / `metrics` 是按引用传入的，**第三方实现应当只读使用**（不要就地修改）。

**这一步的现状**：`kernel` 与 `applyPluginConfig` 属于装配根接线面。用 `createAssembly()` 拿到装配实例后即可启用：适配器本体与计数已实现并测试（C05-AC-15..18 共 10 个测试），**已在真实装配里可启用**；真实浏览器验证仍归 T29。

### 第 3 步：三方计数对账

Q6 结论把对账数据来源定为三处，对账报告由接入方/接收方生成（原 S06 控制台不在本项目内）：

| 计数 | 来源 | 口径与注意事项 |
|---|---|---|
| SDK 发送量 | C08 的 `sdk_health` 指标：`events_sent`、`batches_sent`（另见 `offline_replayed`） | **0 值不上报**（键不出现等价于 0）；`batches_sent` 只计常规通道成功提交的批次；`batches_failed` **与 `batches_sent` 不互补**（含熔断与终态 4xx，且两者都不含离开通道与补发批次）——**不要用 `sent + failed` 反推总数**；`offline_written` / `offline_replayed` 的单位是**批次数**不是事件数（`receiver-requirements.md` 附录 A.3） |
| 双写转发量 | 适配器的 `stats()` 或内核能力 `apm_dual_write.stats`：`forwarded` / `failed` / `skipped` | 只统计 `eventTypes` 范围内的记录；`skipped` 通常只是 `eventTypes` 没放开该 `event_type`，不是故障；`failed > 0` 先排查第三方接口 |
| 接收方入库量 | 接收方自己的入库计数（去重后） | 去重由接收方按 `app_id` + `event_id` 在至少 7 天内完成（RR-05） |

对账方法：

1. **口径先对齐再比数**。三方都以"自定义事件（`event_type: 'custom'`）"为范围，因为双写缺省只转发 `custom`。`sdk_health` 自身也是上报事件（约占业务流量计数的 0.100%，附录 A.5），比较时要么在两边都排除、要么在两边都包含，不要一边排一边不排。
2. **用"发送成功"对"转发成功"对"去重后入库"**：`replayed`（补发）与重试会造成重复送达，同一事件可能被计数多次；接收方去重后入库量会小于发送量。对账要固定比较口径（例如"当日唯一条数"或"当日发送/入库批次数"），并在报告里写明。
3. **偏差 ≤1%，连续 7 天**（Q6 第 3 步）。T33 的验收标准是：在试点应用的预发布环境中，**SDK 发送计数、双写转发计数、mock 接收服务（或试点方接收服务）入库计数三者一致，偏差不超过 1%**（Q6 结论）。
4. **`sdk_health` 的分片要按窗口聚合**：一个窗口内非零指标超过 50 个时 SDK 会拆成多条 `sdk_health`，每条带**相同的 `window_ms` 与 `dimensions`**；接收方聚合时必须把"同 `window_ms` + 同 `dimensions`"的多条视为同一窗口（附录 A.4）。
5. **硬杀场景不要混算**：D004 把硬杀场景改为按**暴露窗口**计量（`exposure_window_events` / `exposure_window_ms` / `drop_prewrite_commit_lost`），"已确认落盘"（IndexedDB 事务 `oncomplete`）的 critical 事件承诺不丢，暴露窗口内（事件已产生但事务未提交）的事件单独计数。**不得把三类合并成一个丢失率**（D004「对设计与验收的影响」）。**文档不承诺"critical 一定不丢"**——承诺只覆盖"已确认落盘"的那部分。

> 口径提示：以上"不能用 sent+failed 反推""offline_* 是批次数""分片按窗口聚合""硬杀三类分列"都来自已冻结的契约与决策；而"当日唯一条数 vs 批次数"这类具体对账口径，Q6 与契约都未规定，需要 T33 在试点中确定并写进对账报告。

### 第 4 步：关闭旧链路写入

- 关闭旧链路的**写入**，旧数据保留只读。
- 关闭前确认第 3 步已连续 7 天偏差 ≤1%。
- 期限：开始双写后 3 个月内完成（Q6 第 4 条）。
- 双写的回滚方式：`applyPluginConfig({ apm_dual_write: false })` 即刻停止转发（适配器默认关闭是刻意的，Q7 第 2 条）。

### 第 5 步：观察 7 天并删除旧埋点

观察 7 天无异常后删除旧埋点代码。删除前建议再核对一次：K01 注册表里没有只为旧链路存在的死定义，且 `check --baseline-git` 通过。

## 2. 与第三方 APM 共存（Q7）

迁移期两套 SDK 同时 hook 全局对象（`window.onerror`、`fetch`、`XMLHttpRequest`、`history`），存在冲突与重复采集风险。Q7 的结论：

1. **迁移期保留第三方 APM 的错误与性能监控**，直到本 SDK 的 C05 插件在该接入方连续 7 天对账达标。
2. **共存期间默认关闭本 SDK 中与第三方 APM 重叠的插件**：错误、性能、HTTP 插件默认关闭，只启用自定义事件、页面浏览和自监控；接入方可以通过远程配置逐个开启，开启后进入对账。
3. **双写适配器是单向的**：本 SDK 的自定义事件可以转发给第三方 APM，**不从第三方 APM 读取数据**。
4. **hook 冲突的处理**：本 SDK 不论初始化早晚都要和已安装的第三方 hook 正常协作；卸载时只还原自己装上的那一层（C02 的 registry 保证"hook 只包装不替换、注销时恢复包装前的函数"）。

落到配置上要注意一处**默认值差异**：C03 的内建默认是 `error` / `perf` / `route` 开、`http` / `apm_dual_write` 关（`packages/core/README.md` 第 22 节），而 Q7 要求迁移共存期**关闭 error / perf / http**。所以迁移期请用远程配置显式关闭重叠插件，**不要依赖内建默认**。无可用配置时的"保守默认"只保留 `error` 开，同样不等于 Q7 的共存期要求。

**未验证项**：Q7 第 4 条要求 T18 包含"与第三方 APM 共存"的专项用例、T30 在兼容性矩阵中覆盖——**两者都未就绪**（`docs/tasks/board.md`）。在它们交付前，共存行为只有 C02 的 hook 包装/还原单测（`packages/core` 内核用例）作为证据，没有真实第三方 APM 的共存验证。

## 3. 迁移期不能做的事

- 不能让 SDK 去改造接入方代码或读接入方的埋点（Q6 第 1 条；本项目只提供能力与流程）。
- 不能在调用时把 normal 事件临时升级为 critical（Q3 结论第 2 条）。
- 不能把双写当成长期方案：它是**单向的过渡手段**，终点是第 4、5 步下线旧链路。
- 不能把硬杀场景的暴露窗口与优雅路径的丢失率混算（D004），也不能据此承诺"critical 一定不丢"。
- 不能用本指南的示例令牌/应用标识之外的真实值：示例一律用 `app_id: "your-app-id"`、`<write_token>` 等占位值。

## 4. 迁移自查清单

- [ ] 所有旧埋点都已映射到注册表事件（含未映射项的处置结论）
- [ ] `web-report-event-registry check --registry events/*.json --baseline-git <基线>` 通过
- [ ] critical 事件满足 Q3 两条标准，且占比 ≤10%
- [ ] 自动采集事件与 `sdk_health` 都是 normal
- [ ] 双写适配器已注入第三方上报函数，`fieldMap` 与旧链路字段逐条对照过
- [ ] 双写默认关闭、显式开启、并有回滚方式（`enabled: false`）
- [ ] 三方计数口径已在报告中写明（范围、单位、是否含 `sdk_health`、补发/重复如何处理）
- [ ] 连续 7 天偏差 ≤1%
- [ ] 关闭旧链路写入后旧数据只读，3 个月内在期限内完成第 4 步
- [ ] 观察 7 天无异常后删除旧埋点代码
- [ ] 迁移期重叠插件（error/perf/http）已按 Q7 显式关闭，而非依赖默认值
