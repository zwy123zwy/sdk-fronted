# T33 试点接入方清单 / 模板（「给出应用名就能立刻跑」）

- 产出任务：T33（试点）中不依赖 Q2 的部分
- 日期：2026-10-16
- 读者：**试点接入方的前端对接人**（照做即可，不必再来问本项目）、项目负责人（Q2 交接）
- 配套可执行脚本：`tests/pilot/00-connectivity.mjs`、`10-three-leg-reconcile.mjs`、`20-receiver-selfcheck.mjs`
- 配套事实清单：`docs/reports/t33-readiness.md`（验收项盘点）、`docs/reports/t33-access-blockers.md`（阻塞点）

> **本文件不声称试点已完成。** 它把「依赖 Q2 的部分」准备到：**拿到应用名/对接人/预发布环境/现有埋点清单
> 之后，按第 7 节顺序执行即可**。

---

## 0. 两条必须先读的已知阻塞（否则接入方会白折腾）

| 编号 | 影响 | 绕过方式（**当前唯一可行**） |
|---|---|---|
| **D-01** | 不设置 `pageId` 时 SDK 产出 `common.page_id: null`，**违反冻结契约**，严格接收方整批 400 拒收 | **必须在 `init` 前或后调 `client.setPage('/你的路由模板')`**（见第 2.3 节） |
| **D-02** | 在装配根上调用公共 API `client.onEvent()` 会让**全部投递静默失效** | **不要用 `onEvent` 观察事件**；要看产出请用 `debug: true` 或直接查接收方计数 |
| **D-03** | 指南第 8.3 节的端点 `/ingest` 是错的 | 用 **`/v1/batch`** |

详见 `docs/reports/t33-access-blockers.md`。**这三条不是接入方的错，是本项目待修的缺陷/文档问题。**

---

## 1. 接入方需要提供什么（Q2 的最小事实集）

每一项都**必需**；缺任一项则对应步骤无法开始。

| 项 | 格式 | 用途 | 缺失后果 |
|---|---|---|---|
| 1. **应用名** | 字符串（建议同时给 `app_id`，须匹配 `^[a-z0-9][a-z0-9_-]{2,63}$`） | 批次头 `app_id`、去重键 `app_id + event_id` | 无法对账（去重键不成立） |
| 2. **应用负责人** | 姓名 + 联系方式 | 预发布环境与数据的授权人；偏差裁定 | 出偏差时无人裁定 |
| 3. **前端对接人** | 姓名 + 联系方式 | 实际改代码、自证接入的人 | 无法推进 |
| 4. **预发布环境** | URL + 访问方式（**不要生产账号**） | 双写与 7 天对账的场所 | 无法取数 |
| 5. **现有埋点清单** | 事件名 → 触发时机 → 现有去向（自研/第三方 APM）；无则明确写「无」 | Q6 迁移流程第 1 步「盘点并逐条映射」 | 无法判断双写的对照口径 |

**另需接入方确认两项（不是"提供"，是"决定"）**：

6. **是否启用同意管理**：若启用，需说明 `consent_mode`（`essential_only` / `buffer` / `full`）；
   选 `full` 需接入方法务确认（`docs/guides/integration.md` 第 6.2 节）。
7. **是否有第三方 APM 共存**：有则启用 `apmCoexistence`，并说明装机顺序（Q7）。

> **接入方不必提供**：SDK 的令牌/密钥。写令牌由本项目在预发布环境发放占位值，
> **任何情况下都不得把真实令牌写进仓库或文档**。

---

## 2. 接入方需要改什么

### 2.1 装依赖（包尚未发布，走本地联调）

```bash
# 正式发布（T35）之后才有 pnpm add 的形态；当前用 link:
pnpm add @web-report-sdk/browser@link:<SDK 仓库路径>/packages/browser
```

> **注意**：`examples/vite` / `examples/node-import` 解析的是 **`dist` 产物**，
> 所以 SDK 仓库必须先 build 一次（`pnpm build`）。Vite dev server 同样解析到 `dist`
> （T30 实测：`/@fs/<仓库>/packages/browser/dist/index.js`）。

### 2.2 装配 + 初始化（照抄这段）

```ts
import { createAssembly } from '@web-report-sdk/browser';

const assembly = createAssembly({
  appId: 'your-app-id',              // ← 接入方的 app_id（第 1 节第 1 项）
  endpoint: 'https://<预发布接收方>/v1/batch',   // ← 路径是 /v1/batch（D-03）
  token: '<本项目在预发布环境发放的占位令牌>',
  env: 'staging',                    // 预发布用 staging
  release: '<你的应用版本>',          // 批次头 release
  consent: 'granted',                // 或按第 1 节第 6 项决定；缺省 unknown（Q5）
  // apmCoexistence: true,           // 若有第三方 APM（第 1 节第 7 项）
});

assembly.init();

// ← **必须**：见 D-01。用你的路由模板，不要用带查询串的完整 URL。
assembly.client.setPage('/your-route-template');

// 业务埋点：注意方法在 assembly.client 上（D-04），不在 assembly 上
assembly.client.track('your_event_name', { dimensions: { key: 'value' } });

// 断言没有踩 D-02：不要调用 assembly.client.onEvent(...)
```

### 2.3 三条硬约束（每一条都对应一个实测过的坑）

1. **必须 `setPage`**（D-01）。不设就是 `page_id: null` → 严格接收方整批拒收。
2. **不要用 `onEvent`**（D-02）。想看产出用 `createAssembly({ client: { debug: true } })`。
3. **端点路径是 `/v1/batch`**（D-03）。

---

## 3. 接入方如何自证接入成功

按顺序跑，**每一步都要留下输出**（这就是自查结果的证据）。

### 步骤 1：引入自检（不需要网络）

```ts
import { SDK_VERSION, PUBLIC_METHODS } from '@web-report-sdk/browser';
console.log(SDK_VERSION, PUBLIC_METHODS.length);
```

### 步骤 2：端到端自检（本项目提供的可执行脚本，接入方可直接借）

```bash
# 在 SDK 仓库里先跑一遍，确认工具链本身是好的（本任务实测 exit 0）
node tests/pilot/00-connectivity.mjs
```

期望输出（**本任务实测**）：

```
[PASS] createAssembly 返回装配实例
[PASS] Assembly 暴露 client 句柄
[PASS] SDK 侧认为批次已发出 — batchesSent=1, batchesFailed=0
[PASS] 接收方收到批次 — received_batches=1
[PASS] 接收方入库事件 — stored_events=1
[PASS] 对账恒等式 received_events - stored_events === duplicate_events — 1 - 1 vs dup=0
[PASS] 没有批次被拒绝 — 全 0
结论：最小接入自检通过（这条路径接入方照做即可）。
```

**接入方要自证的是同一组事实**，只是端点换成预发布接收方：
`batchesSent ≥ 1` 且 `batchesFailed == 0` 且接收方 `stored_events ≥ 1` 且 `rejected_* == 0`。

> **注意（D-07）**：`flush()` 是异步投递，查计数前要等一次网络往返（脚本里等 500 ms）；
> 立刻查会看到 0，**那不是失败**。

### 步骤 3：接收方自查（仅当试点方使用**自己的**接收服务）

T33 验收用例第 3 条要求这个。本项目把契约的「必须」条目转成了可执行探针：

```bash
node tests/pilot/20-receiver-selfcheck.mjs \
  --base-url https://<试点方预发布接收方> \
  --token <占位令牌> \
  --app-id <app_id>
```

对 M01 自测的基线（**本任务实测**）：**PASS 7 / FAIL 0 / SKIP 3**。
`SKIP` 一律**不算通过** —— 需接收方补实现说明。脚本会直接打印一张可贴进自查结果的 Markdown 表。

---

## 4. 如何对账（口径：T32 三类分列 + M01 新计数器）

### 4.1 三腿定义（Q6：偏差 ≤1%）

| 腿 | 计数来源 | 说明 |
|---|---|---|
| ① SDK 发送 | C08 的 `sdk_health` 计数（预发布环境）／本地演示用装配根 `delivery.metrics()` | 客户端一侧事实 |
| ② 双写转发 | **T19 双写适配器**的转发计数 | 本任务**不伪造**该数字 |
| ③ 接收方入库 | 接收方**去重后**入库计数（M01：`GET /__mock/counters` 的 `stored_events`） | **对账以此为准**（RR-05） |

### 4.2 必须遵守的两条口径

1. **对账以"去重后入库"为准**。M01 的恒等式：
   `received_events - stored_events === duplicate_events`（**本任务实测 ≥3 次成立**）。
2. **三类分列，不得合并成一个丢失率**（D004，`docs/reports/reliability-reconciliation.md`）：
   - ① 有优雅退出路径的场景 → 按丢失率（critical ≤0.1%、normal ≤1%）；
   - ② 硬杀「已确认落盘」（事务 `oncomplete` 已返回）→ 不丢；
   - ③ 硬杀「暴露窗口内未提交」→ 按**条数 + 窗口时长**；窗口须成对引用
     `observedWindowMs ≤ W ≤ windowMs`（上界字段 `exposure_window_ms` 已由 CR-007 写明
     **不得用于 SLA/容量判定**）。

### 4.3 **禁止**把空白读成达标（T32 用真金白银换来的教训）

**任何一腿为 0 时，不得宣称「偏差 0% / 在 1% 内」。** 空白不是 0 丢失，也不是完美对齐。

本任务的对账脚本为此**显式实现**了这条：两侧任一为 0 → 输出 `不可判定` 且 **exit 1**：

```
sent=0 stored=0 -> 不可判定 (exit 1)
sent=5 stored=0 -> 不可判定 (exit 1)
sent=3 stored=3 -> 0.0000%
```

（这条守卫是**必要的**：本任务第一版脚本在 `eventsSent=0, received=0` 时打印了
「偏差 0.0000% / 在 1% 内」—— 正是 T32 警告过的那个错误。已修正，见 D-06 与
`t33-access-blockers.md`。）

### 4.4 本地预演

```bash
node tests/pilot/10-three-leg-reconcile.mjs --repeat 3
```

**本任务实测**（exit 0）：腿①`eventsSent=3`、腿②`received_events=3 / stored_events=3 /
duplicate_events=0`、偏差 `0.0000%`；腿③显式标注「未接入（不伪造）」。

### 4.5 偏差来源分类表（Q6 要求「偏差来源已解释」）

| 类别 | 典型原因 | 判定线索 |
|---|---|---|
| 预期内重复 | SDK 为保证不丢失会重复送达（重试/补发/多标签页） | `duplicate_events > 0` 且 `received - stored === duplicate` |
| 接收方拒收 | 结构非法、令牌错、超限 | `rejected_*` 任一 > 0（**先查 D-01 类结构性原因**） |
| SDK 侧丢弃 | 采样、同意、容量淘汰、队列溢出 | `sdk_health` 的 `reason_codes` 计数 |
| 离线未回放 | 硬杀后仍在离线队列 | `offline_*` 指标 + `prewrite_commit_lost` |
| 双写差异 | 旧链路与新链路触发条件不同 | 逐事件名比对（M01 支持 `by_event_name`） |

---

## 5. 非功能判据（T33 卡的 LCP / INP P75 ≤2%）

1. 用接入方的 A/B 能力（同一发布物，开/关 SDK）各自取 **P75**；
2. 判据：`（开启 − 关闭）/ 关闭 ≤ 2%`，LCP 与 INP 各判一次；
3. **必须记录**样本量、时间窗、设备/网络口径 —— 否则数字不可比；
4. 本任务**未做真实站点测量**（需要真实应用，属 Q2 之后）。

> 采集侧的可执行基础已在本仓库验证：`packages/plugins` 的 perf 插件提供 vitals 采集，
> 真实浏览器 E2E 归 T29（本任务不跑浏览器）。

---

## 6. Q2 交接函（可直接发给业务方）

> **主题：T33 试点应用接入 —— 需要确认 2 个试点应用与对接人（Q2）**
>
> 我们这边 SDK 的接入工具链已经就绪：接入模板、自检脚本、接收方自查脚本、对账脚本都可以直接跑，
> 不依赖贵方的代码。**现在只缺两个试点应用的基本信息**，拿到就能开始。
>
> **请提供（每个应用一套）：**
> 1. 应用名（建议同时给出 `app_id`，小写字母/数字/`-`/`_`，3–64 位）
> 2. 应用负责人（姓名 + 联系方式）
> 3. 前端对接人（姓名 + 联系方式）
> 4. 预发布环境地址 + 访问方式（**不需要生产环境或生产账号**）
> 5. 现有埋点清单（事件名 → 触发时机 → 现有去向）；没有就写「无」
>
> **另请确认两项决定：**
> 6. 是否启用同意管理？若启用，用哪种 `consent_mode`？（`full` 需贵方法务确认）
> 7. 是否已有第三方 APM 需要共存？（如有，请说明装机顺序）
>
> **建议的试点组合**（`docs/decisions/Q2-pilot-apps.md` 的建议方案）：
> 一个内部工具类应用（用户可控、影响面小）+ 一个面向外部用户的应用（覆盖同意管理与大流量）。
>
> **我们需要贵方配合的动作**：只在预发布环境改接线与调用 SDK，**不会动贵方生产数据、不会改贵方仓库**；
> 计数由贵方按我们给的脚本导出。
>
> **时限**：`docs/decisions/Q2-pilot-apps.md` 写明需在 **M0（2026-10-30）前**确定，否则触发 R07；
> `docs/tasks/board.md` 的阻塞记录里最晚期限为 **2026-12-21**。当前状态：**待确认（结论表为空）**。

**当前实际状态（诚实版）**：`docs/decisions/Q2-pilot-apps.md` 状态是「待确认」，确认日期与结论表**均为空**。
`docs/tasks/board.md` 第 59 行记录（2026-10-09，对接人 wenye.zhang）：「Q2 试点应用未确认 / 需指定 2 个
试点应用与对接人 / 未解决，最晚 2026-12-21」。**因此 T33 仍为「未就绪」，不能开工试点。**

---

## 7. 拿到 Q2 后的执行顺序与预计步骤

前置：T33 卡还依赖 **T19、T29**（看板记「未就绪」）。下列步骤假设这两项已按各自卡片收尾。

| # | 步骤 | 产出 | 预计 |
|---|---|---|---|
| 1 | 把第 1 节 5 项事实填进 `docs/decisions/Q2-pilot-apps.md` 的结论表，并请确认人签字 | Q2 关闭 | 0.5 d |
| 2 | 对每个应用：按第 2 节改接线（预发布环境），**先只跑 `00-connectivity` 等价自检** | 接入成功证据（`batchesSent`/`stored_events`/`rejected_*`） | 0.5 d / 应用 |
| 3 | **确认 D-01 已修或已按 2.3 规避**；确认没有用 `onEvent`（D-02） | 排查记录 | 0.5 d |
| 4 | 试点方若自建接收服务：跑 `20-receiver-selfcheck.mjs`，把 SKIP 逐条补证据 | 自查结果表（T33 验收第 3 条） | 0.5–1 d |
| 5 | 开启双写（T19 适配器），确认三腿计数都能取到 | 双写开启记录 | 0.5 d / 应用 |
| 6 | **连续 7 天**每日导出：SDK 发送、双写转发、接收方去重后入库 | 逐日三腿数据 | 7 d（自然日） |
| 7 | 用第 4.5 节分类表解释每一处偏差；任一腿为 0 的**报不可判定**，不得算达标 | 对账报告（三类分列） | 1 d |
| 8 | 出「试点报告」与「接入问题清单」给 T34 | T33 交接产物 | 1 d |
| 9 | 该应用不使用的插件：按 `docs/decisions/Q2-pilot-apps.md:28` 的条款处理 —— **注意该条款是条件条款**，只有当 Q2 结论偏离建议方案时才生效；若确需生效，应先把它并入 T33 卡（属扩大范围，需负责人裁定） | 裁定记录 | 0.5 d |

**合计 ≈ 5 个自然日 + 7 天观察窗**（与 T33 卡的 5 人日口径一致，观察窗不占人日）。

### 第 7 步「不可判定」的判定规则（避免又出现"空白当达标"）

| 情形 | 结论 |
|---|---|
| 三腿都 > 0 且偏差 ≤1% | **达标** |
| 三腿都 > 0 但偏差 >1% | **不达标**，须按分类表解释并归因 |
| **任一腿 = 0** | **不可判定**（不是达标，也不是不达标）→ 必须查明该腿为 0 的原因 |
| 数据缺失某天 | 该天记「缺数据」，**不得**用相邻日插值或跳过 |
