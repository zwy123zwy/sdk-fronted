# T32 可靠性对账报告（M6 验收材料）

- 执行：A10（T32），2026-10-16
- 依赖：**T29 已完成并合入**（真实浏览器 E2E + D004 硬杀落盘复测，2026-10-14）
- 口径权威：`docs/decisions/D004-hard-kill-exposure-window.md` 结论第 1 条；任务卡 `docs/tasks/T32.md`（2026-10-13 按 D004 改过）
- **结论只覆盖 SDK 一侧**：本文全部数字是 SDK 自己的「已产生 / 已落盘 / 读回」账目，
  不含接收方（M01）去重前/后的入库计数——本次没有 M01 侧数据，见第 5 节。
- 生成方式：第 3 节由 `node tests/reliability/reconcile.mjs --write` 从 JSON 现算，**不是抄数**。
- 本任务**未做任何 git 写操作**；新增文件见第 7 节。工作树里另有 2 个**与本任务无关**的已修改文件
  （`tests/compat/results/webpack-{dev-server,production}.json`，`generatedAt`/`origin` 变化，T30 的产物），
  在本任务开始前就已处于修改状态，**本任务没有触碰**。

> **一句话结论**：三类分列后——
> **② 硬杀「已确认落盘」的 critical 不丢**：Chromium 与 WebKit 各 1000/1000，计 0（3.0 表）；
> **③ 硬杀暴露窗口内的未提交事件在 Chromium 上 9/9 格完全对账**（含 D-1 子窗口），
> 且第二次独立运行复现（3.2 表）；**但 WebKit 有 3 格（`pending-d0` / `preflush-d0` / `preflush-small`）
> 没捕获到窗口、JSON 计数为 0，账面上是空白而不是 0 丢失**（缺口 3）；
> **① 优雅退出路径完全没有实测数据**——本仓库现在给不出 ≤0.1% / ≤1% 的任何证据（缺口 1）。

> **本报告不给"总丢失率"**，也不给三类之间的加权或平均：理由见第 1 节。

## 1. 为什么三类不能合并成一个丢失率

这不是措辞偏好，而是三个量的**分母语义不同**，合并后必然误导：

1. **① 优雅路径**的分母是「**已产生且有机会按正常路径提交**的事件」，丢的才是缺陷。它有明确指标（critical ≤0.1%）。
2. **② 硬杀已落盘**的分子恒为 0（实测 1000/1000），把它并进丢失率只会**稀释**①的缺陷信号：
   硬杀样本越多，"总体丢失率"越低，而真实缺陷（优雅路径的漏发）反而被掩盖。
3. **③ 暴露窗口内未提交**的"丢失"**不是缺陷，是物理下界**：SIGKILL 在 `oncomplete` 返回前落下，
   事件本来就还没落盘（D004 结论第 1 条明确"其长度由批写提交延迟决定，不再是 0–5 秒"）。
   把它算成"丢失率"等于**把测量装置的分辨率当成系统的可靠性**——窗口多长，丢失率就多高，
   于是"降低丢失率"的最优策略变成"少测一点"。所以 D003 原措辞才被 D004 取代。
4. 三者**不可通约**：①的分母是"有机会提交的事件"，③的分母是"被强杀时刻的在途事件"。
   求和需要一个共同分母，而这个共同分母不存在。
5. **③ 内部还必须再分列**（D-1 子窗口）：`preflush-d0` / `preflush-small` 属于
   「**事件已产生、但连计数用的 intent 锚点都还没落**」。它比普通暴露窗口更早一个事务往返，
   修复前**完全不计入暴露窗口计数**（T29 第一轮：丢失且计 0）。这类事件必须与
   「锚点已落、数据事务在途」分开计，否则看不出"计数锚点"这个装置本身是否覆盖了全窗口。

因此本报告**只做分列对账**，不给任何加权、平均或"总体丢失率"。

## 2. 口径与判据（本报告实际用的，与 D004 逐条对齐）

| D004 类别 | 判据 | 本报告使用的 JSON 字段 |
|---|---|---|
| ① 优雅路径 | critical 丢失率 ≤0.1%、normal ≤1% | **无**（无数据源） |
| ② 已确认落盘不丢 | 存活率 = 1，且 `prewrite_commit_lost` = 0 | `cells[].survived.rate`、`cells[].reopenCommitLoss.events` |
| ③ 暴露窗口 | 存活 + 未提交计数 == 期望（逐格） | `survived.events`、`d004.uncommittedFromIntent`、`expectedEvents`、`exposureReconciles`、`windowCaptured`、`reopenCommitLoss.windowMs` |
| ③-D1 子窗口 | 同③，且该格必须**捕获到窗口**（`windowCaptured=true`） | `windowCaptured`、`nothingCommitted`、`exposureReconciles`（对象形态即"未捕获"） |

**"窗口真的被捕获"的判据**（沿用 T29 方法学教训第 3 条）：重启后 `prewrite_commit_lost > 0`。
只有在这之后，"未 `oncomplete` 也读得回"才说明是原子性，否则只是「没在 `oncomplete` 之前杀掉」。

### 2.1 T32 验收用例逐条判定

| T32 卡的验收用例 | 本报告判定 | 依据 |
|---|---|---|
| ① 优雅路径按丢失率（critical ≤0.1%、normal ≤1%） | **不可判定**（无数据） | 缺口 1 |
| ② 硬杀已确认落盘的 critical 不丢 | **成立**（Chromium/WebKit 各 1000/1000，计 0） | 3.0 / 3.1 |
| ③ 暴露窗口内未提交按条数与窗口时长计量 | **Chromium 成立；WebKit 3 格无结论** | 3.0 / 3.1 / 3.2 / 缺口 4 |
| ③ 新增 D-1 子窗口（事件已产生、锚点未落）必须计数 | **Chromium 成立（1000/100）；WebKit 无结论** | 3.1 / 3.2 / 缺口 4 |
| 以 M01 去重后入库计数为准 | **无法满足**（无 M01 侧数据） | 缺口 5 |
| 重复送达率如实报告（不设上限） | **无法报告**（无去重前/后计数） | 缺口 5 |
| 场景构成比例 + M01 故障注入比例 | **无法报告**（无场景构成数据） | 缺口 5 |
| 丢失事件按原因码归类 | **③ 可归 `prewrite_commit_lost`；① 无发出点（但码的问题已被 CR-001 裁定）** | 缺口 5 |
| 10 万个会话模拟 | **未达成**（实测规模为 9 格 × 100–500 批，单次运行） | 缺口 5 |

> 关于重复送达率：`reason-codes.md` 第 50 行的 `replayed`（离线补发的批次，C07-AC-14）与
> `retry_network`（第 47 行）就是 CR-001 指定的承载物。**本报告没有这两个量的实测值**——
> 本地接收端不做去重，JSON 里也没有补发/重试计数。

> 结论：**在本次可用的证据范围内，T32 的验收用例只能部分满足**。
> 缺的是数据（①的比率、M01 侧计数、WebKit 修复后复跑），不是口径——本报告没有调整任何口径。

## 3. 分列对账表

<!-- BEGIN GENERATED: node tests/reliability/reconcile.mjs --write -->
#### 3.0 逐格总览与三类归属

- 已归类的格子名（9 个）：`durable`、`pending-d0`、`pending-d5`、`pending-d20`、`pending-d60`、`pending-d200`、`bulk-d0`、`preflush-d0`、`preflush-small`
- **未归类的格子**：无（脚本把新出现的格子名视为口径缺口在此列出，不静默丢弃）

| 引擎 | 类别 | 格子 | 期望 | 存活 | 计数 | 窗口捕获 | 对账等式成立 | `exposureReconciles` |
|---|---|---|---|---|---|---|---|---|
| chromium | ② 硬杀已落盘 | `durable` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| chromium | ③ 暴露窗口 | `pending-d0` | 1000 | 0 | 1000 | 是 | ✅ | `true` |
| chromium | ③ 暴露窗口 | `pending-d5` | 1000 | 0 | 1000 | 是 | ✅ | `true` |
| chromium | ③ 暴露窗口 | `pending-d20` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| chromium | ③ 暴露窗口 | `pending-d60` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| chromium | ③ 暴露窗口 | `pending-d200` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| chromium | ③ 暴露窗口 | `bulk-d0` | 5000 | 0 | 5000 | 是 | ✅ | `true` |
| chromium | ③-D1 锚点子窗口 | `preflush-d0` | 1000 | 0 | 1000 | 是 | ✅ | `true` |
| chromium | ③-D1 锚点子窗口 | `preflush-small` | 100 | 0 | 100 | 是 | ✅ | `true` |
| webkit | ② 硬杀已落盘 | `durable` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| webkit | ③ 暴露窗口 | `pending-d0` | 1000 | 0 | 0 | 否 | ❌ | `{"survivors":0,"commitLost":0,"expected":1000}` |
| webkit | ③ 暴露窗口 | `pending-d5` | 1000 | 0 | 1000 | 是 | ✅ | `true` |
| webkit | ③ 暴露窗口 | `pending-d20` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| webkit | ③ 暴露窗口 | `pending-d60` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| webkit | ③ 暴露窗口 | `pending-d200` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| webkit | ③ 暴露窗口 | `bulk-d0` | 5000 | 0 | 5000 | 是 | ✅ | `true` |
| webkit | ③-D1 锚点子窗口 | `preflush-d0` | 1000 | 0 | 0 | 否 | ❌ | `{"survivors":0,"commitLost":0,"expected":1000}` |
| webkit | ③-D1 锚点子窗口 | `preflush-small` | 100 | 0 | 0 | 否 | ❌ | `{"survivors":0,"commitLost":0,"expected":100}` |

### 3.1 数据源指纹（每个数字都可回指这两份文件）

| 引擎 | 文件 | `generatedAt` | 被测实现 `sha256` 前缀 | 驱动 |
|---|---|---|---|---|
| chromium | `tests/e2e/results/d004-chromium.json` | 2026-10-14T09:27:33.471Z | `454fbb9008176f86` | `npx-cache-playwright-core-1.60.0` |
| webkit | `tests/e2e/results/d004-webkit.json` | 2026-10-14T09:16:59.442Z | `26c232e4112442c6` | `npx-cache-playwright-core-1.60.0` |

> **读表前必读：`exposure_window_ms` 的语义不等于 D004 的"暴露窗口"**（本任务实测发现，见缺口 6）。
> 实现里 `commitLostWindowMs` 来自 `reconcileCommitLoss()` 的 `windowMs = now() - first_pending_at`，
> 源码注释写明"窗口时长是**上界**：会话死亡时刻不可观测，只能给到对账时刻"
> （`packages/transport/src/offline/offline-store.ts:318`）。因此它**包含强杀 + 重启 + 探测页打开**的耗时，
> 是三张表里 900–1700 ms 那一列，**不是** D004 定义的那个"由批写提交延迟决定（p50 1–4.1 ms / p95 3–17 ms）"的窗口。
> 真正的窗口量级只能从 `measuredMsAfterIssue` 与"是否捕获到窗口"的临界点间接看出（③ 表）。

### ① 优雅退出路径（按丢失率：critical ≤0.1%、normal ≤1%）

**本仓库当前没有可供对账的实测数据**（这是缺口，不是"通过"）。缺什么见第 5 节「缺口 1」。

| 场景 | 样本量 | 存活 | 丢失 | 丢失率 | 判据 | 证据来源 |
|---|---|---|---|---|---|---|
| 页面离开 / 隐藏 | — | — | — | — | critical ≤0.1% / normal ≤1% | **无数据源**（归 T29 / 需非沙箱会话） |
| 断网恢复（1–30 min） | — | — | — | — | critical ≤0.1% / normal ≤1% | **无数据源**（归 T29 / 需非沙箱会话） |
| 多标签页（2–5 个） | — | — | — | — | critical ≤0.1% / normal ≤1% | **无数据源**（归 T29 / 需非沙箱会话） |
| 优雅关闭 | — | — | — | — | critical ≤0.1% / normal ≤1% | **无数据源**（归 T29 / 需非沙箱会话） |

> 现有真实浏览器数据不能代替：T29 的功能验证样本量是 5–7 个事件
> （`sendBeacon` 送达 5/5、IDB 写 7 事件 reload 后读回 7），分辨率远粗于 0.1%；
> 且 `tests/e2e/results/*.json` 中**没有任何丢失率字段**。

### ② 硬杀「已确认落盘」（事务 `oncomplete` 已返回）——**不丢**

| 格子 | 样本量 | 期望事件 | 存活（读回） | 读不回 | `prewrite_commit_lost` 计数 | 暴露窗口时长 | 对账 | 证据（JSON 路径） |
|---|---|---|---|---|---|---|---|---|
| chromium `durable` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 17 ms） | 完全对账 ✅（等 `oncomplete` 后杀：1000/1000 全部读回，计 0） | `d004-chromium.json` `cells[0]` |
| webkit `durable` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 16 ms） | 完全对账 ✅（等 `oncomplete` 后杀：1000/1000 全部读回，计 0） | `d004-webkit.json` `cells[0]` |

### ③ 硬杀「暴露窗口内未提交」——事务在途，按条数与窗口时长计量

| 格子 | 样本量 | 期望事件 | 存活（读回） | 读不回 | `prewrite_commit_lost` 计数 | 暴露窗口时长 | 对账 | 证据（JSON 路径） |
|---|---|---|---|---|---|---|---|---|
| chromium `pending-d0` | 100 批 × 10 | 1000 | 0 | 1000 | 1000 | 1213 ms | 完全对账 ✅（窗口已捕获：存活 0 + 未提交 1000 = 期望） | `d004-chromium.json` `cells[1]` |
| chromium `pending-d5` | 100 批 × 10 | 1000 | 0 | 1000 | 1000 | 1213 ms | 完全对账 ✅（窗口已捕获：存活 0 + 未提交 1000 = 期望） | `d004-chromium.json` `cells[2]` |
| chromium `pending-d20` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 21 ms） | 完全对账 ✅（未捕获窗口：事务已先提交，存活 1000/1000，计 0） | `d004-chromium.json` `cells[3]` |
| chromium `pending-d60` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 61 ms） | 完全对账 ✅（未捕获窗口：事务已先提交，存活 1000/1000，计 0） | `d004-chromium.json` `cells[4]` |
| chromium `pending-d200` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 201 ms） | 完全对账 ✅（未捕获窗口：事务已先提交，存活 1000/1000，计 0） | `d004-chromium.json` `cells[5]` |
| chromium `bulk-d0` | 500 批 × 10 | 5000 | 0 | 5000 | 5000 | 1712 ms | 完全对账 ✅（窗口已捕获：存活 0 + 未提交 5000 = 期望） | `d004-chromium.json` `cells[6]` |
| webkit `pending-d0` | 100 批 × 10 | 1000 | 0 | 1000 | 0 | —（未捕获；杀在发出后 0 ms） | ⛔ **窗口未捕获，本格无结论**：SIGKILL 落在任何提交之前（`nothingCommitted=true`），JSON 的 `exposureReconciles` 是对象 `{"survivors":0,"commitLost":0,"expected":1000}` 而非 `true`；存活+计数 0 ≠ 期望 1000。**不得记为 0 丢失，也不得计入"已对账"** | `d004-webkit.json` `cells[1]` |
| webkit `pending-d5` | 100 批 × 10 | 1000 | 0 | 1000 | 1000 | 923 ms | 完全对账 ✅（窗口已捕获：存活 0 + 未提交 1000 = 期望） | `d004-webkit.json` `cells[2]` |
| webkit `pending-d20` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 21 ms） | 完全对账 ✅（未捕获窗口：事务已先提交，存活 1000/1000，计 0） | `d004-webkit.json` `cells[3]` |
| webkit `pending-d60` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 61 ms） | 完全对账 ✅（未捕获窗口：事务已先提交，存活 1000/1000，计 0） | `d004-webkit.json` `cells[4]` |
| webkit `pending-d200` | 100 批 × 10 | 1000 | 1000 | 0 | 0 | —（未捕获；杀在发出后 202 ms） | 完全对账 ✅（未捕获窗口：事务已先提交，存活 1000/1000，计 0） | `d004-webkit.json` `cells[5]` |
| webkit `bulk-d0` | 500 批 × 10 | 5000 | 0 | 5000 | 5000 | 656 ms | 完全对账 ✅（窗口已捕获：存活 0 + 未提交 5000 = 期望） | `d004-webkit.json` `cells[6]` |

### ③-D1 子窗口「事件已产生、锚点未落」（D-1 修复后新增计数）

| 格子 | 样本量 | 期望事件 | 存活（读回） | 读不回 | `prewrite_commit_lost` 计数 | 暴露窗口时长 | 对账 | 证据（JSON 路径） |
|---|---|---|---|---|---|---|---|---|
| chromium `preflush-d0` | 100 批 × 10 | 1000 | 0 | 1000 | 1000 | 935 ms | 完全对账 ✅（窗口已捕获：存活 0 + 未提交 1000 = 期望） | `d004-chromium.json` `cells[7]` |
| chromium `preflush-small` | 10 批 × 10 | 100 | 0 | 100 | 100 | 1205 ms | 完全对账 ✅（窗口已捕获：存活 0 + 未提交 100 = 期望） | `d004-chromium.json` `cells[8]` |
| webkit `preflush-d0` | 100 批 × 10 | 1000 | 0 | 1000 | 0 | —（未捕获；杀在发出后 0 ms） | ⛔ **窗口未捕获，本格无结论**：SIGKILL 落在任何提交之前（`nothingCommitted=true`），JSON 的 `exposureReconciles` 是对象 `{"survivors":0,"commitLost":0,"expected":1000}` 而非 `true`；存活+计数 0 ≠ 期望 1000。**不得记为 0 丢失，也不得计入"已对账"** | `d004-webkit.json` `cells[7]` |
| webkit `preflush-small` | 10 批 × 10 | 100 | 0 | 100 | 0 | —（未捕获；杀在发出后 0 ms） | ⛔ **窗口未捕获，本格无结论**：SIGKILL 落在任何提交之前（`nothingCommitted=true`），JSON 的 `exposureReconciles` 是对象 `{"survivors":0,"commitLost":0,"expected":100}` 而非 `true`；存活+计数 0 ≠ 期望 100。**不得记为 0 丢失，也不得计入"已对账"** | `d004-webkit.json` `cells[8]` |

### 3.2 重复性对账（Chromium 第二次独立运行，T32 本任务新增）

命令（**不改动 T29 的官方产物**，用 `--out` 另存）：

```
node tests/e2e/lib/d004-run.mjs --browser chromium --out tests/reliability/results/d004-chromium-rerun.json
```

- A：`/Users/spirit-ai/Desktop/sdk/tests/e2e/results/d004-chromium.json`（chromium，sha256 `454fbb9008176f86`，2026-10-14T09:27:33.471Z）
- B：`/Users/spirit-ai/Desktop/sdk/tests/reliability/results/d004-chromium-rerun.json`（chromium，sha256 `454fbb9008176f86`，2026-10-14T10:15:01.484Z）
- 同一份被测实现：**是**

| 格子 | A 窗口捕获 | B 窗口捕获 | A 存活+计数=期望 | B 存活+计数=期望 | A 窗口时长 | B 窗口时长 | A 杀在发出后 | B 杀在发出后 | 判定 |
|---|---|---|---|---|---|---|---|---|---|
| `durable` | 否 | 否 | 1000+0=1000 ✅ | 1000+0=1000 ✅ | 0 ms | 0 ms | 17 ms | 52 ms | 守恒且一致 |
| `pending-d0` | 是 | 是 | 0+1000=1000 ✅ | 0+1000=1000 ✅ | 1213 ms | 1356 ms | 0 ms | 0 ms | 守恒且一致 |
| `pending-d5` | 是 | 是 | 0+1000=1000 ✅ | 0+1000=1000 ✅ | 1213 ms | 1117 ms | 6 ms | 5 ms | 守恒且一致 |
| `pending-d20` | 否 | 否 | 1000+0=1000 ✅ | 1000+0=1000 ✅ | 0 ms | 0 ms | 21 ms | 22 ms | 守恒且一致 |
| `pending-d60` | 否 | 否 | 1000+0=1000 ✅ | 1000+0=1000 ✅ | 0 ms | 0 ms | 61 ms | 61 ms | 守恒且一致 |
| `pending-d200` | 否 | 否 | 1000+0=1000 ✅ | 1000+0=1000 ✅ | 0 ms | 0 ms | 201 ms | 201 ms | 守恒且一致 |
| `bulk-d0` | 是 | 是 | 0+5000=5000 ✅ | 0+5000=5000 ✅ | 1712 ms | 1233 ms | 10 ms | 11 ms | 守恒且一致 |
| `preflush-d0` | 是 | 是 | 0+1000=1000 ✅ | 0+1000=1000 ✅ | 935 ms | 1294 ms | 0 ms | 0 ms | 守恒且一致 |
| `preflush-small` | 是 | 是 | 0+100=100 ✅ | 0+100=100 ✅ | 1205 ms | 1300 ms | 0 ms | 0 ms | 守恒且一致 |

**读法（只陈述两次运行里实际变了什么）**：

- **可重复**：两次运行捕获到窗口的格子数分别为 5 / 5（同一组格名），**9/9 格的对账等式两次都成立**；
- **D-1 子窗口的计数装置可重复**：`preflush-small`（默认配置、最贴近生产的那一格）两次都是「存活 0 + 计数 100 = 期望 100」与「存活 0 + 计数 100 = 期望 100」——第二次独立复现了"计数锚点覆盖到该子窗口"这一结论。
- **不可重复（绝对值）**：暴露窗口时长在两次运行间的相对偏离为 12% / 8% / 28% / 38% / 8%（各捕获格）；`durable` 格的"杀在发出后"从 17 ms 变到 52 ms。**因此本报告不把任何单次窗口时长当作分布或 SLA 输入**（D004 引用的 p50 1–4.1 ms / p95 3–17 ms 是 POC-1 的批写提交延迟，不是这里的端到端窗口时长）。
- **仍不能说明的事**：两次运行都是 Chromium、都是单次、都是 headless；**WebKit 没有第二次运行**（本任务不允许覆写 T29 的 webkit 产物），Firefox 未测。

<!-- END GENERATED -->

## 4. 复跑方式

- **重新生成本报告第 3 节的全部表格**（只读 JSON，秒级、无浏览器依赖）：
  ```
  node tests/reliability/reconcile.mjs            # 打印到 stdout
  node tests/reliability/reconcile.mjs --write    # 覆写本文件生成区
  ```
- **单独比对任意两份逐格 JSON**（3.2 那种"同一 harness 再跑一次"的重复性核对）：
  ```
  node tests/reliability/reconcile.mjs --compare <A.json> <B.json>
  ```
- **重新产生第 3.0–3.1 节的原始数据**（要真实浏览器）：
  ```
  pnpm test:e2e --project=chromium --project=webkit        # 断言口径；会覆写 tests/e2e/results/
  node tests/e2e/lib/d004-run.mjs --browser chromium --out <另存路径>   # 只要数字、不动官方产物
  ```
- **重跑第 3.2 节的重复性数据**：
  ```
  node tests/e2e/lib/d004-run.mjs --browser chromium --out tests/reliability/results/d004-chromium-rerun.json
  ```
- 数据来源分级：3.0/3.1 来自 T29 官方产物 `tests/e2e/results/d004-{chromium,webkit}.json`；
  3.2 来自 **T32 本任务新增**的第二次独立运行 `tests/reliability/results/d004-chromium-rerun.json`。
- **本任务没有新增任何测量脚本**：测量仍走 T29 的 `tests/e2e/lib/d004-run.mjs`；
  新增的只有"从 JSON 到表格"的 `tests/reliability/reconcile.mjs`，以及一次复跑产物。

## 5. 数据缺口与与 D004 不符之处（最重要的一节）

### 缺口 1：类别 ①（优雅退出路径）零数据 —— **验收用例中最关键的一项无法判定**

`docs/tasks/T32.md` 要求按 4 类优雅场景（页面离开/隐藏、断网恢复、多标签页、优雅关闭）给 critical ≤0.1%、normal ≤1%。
现状核查：

- T29 的两个 spec（`tests/e2e/durability.spec.mjs`、`tests/e2e/real-browser.spec.mjs`）里**没有任何一处输出丢失率**，
  两个 results JSON 里也**没有任何 `lost` / `lossRate` 字段**；
- 真实浏览器侧只验证了**单点行为**（`sendBeacon` 送达 5/5、IDB 写 7 事件 reload 后读回 7、3 标签页恰好 1 个 leader），
  这些是**功能验证**，不是**比率测量**：样本量 5–7 个事件，任何丢失率的分辨率都远粗于 0.1%；
- 因此：**① 的"不达标升级"判据当前不可判定**。按 T32 卡「不得调整统计口径」，这里只能如实报缺，
  不能拿②③的数字代替，也不能把 T29 的功能验证当比率证据。

> **归 T29 / 需非沙箱会话**。缺的东西具体是：
> ① 一个「优雅路径」测量 harness：N≥10⁵ 量级事件、按 critical/normal 分层，
> 事件产生后走正常提交（`oncomplete`）或正常离开提交，计数 `enqueued` 与「落地可读回」；
> ② 4 类场景各自的样本构成与比例；③ 断网 1–30 分钟、2–5 标签页的执行脚本。
> 现有 `tests/e2e/lib/d004-run.mjs` 只做硬杀，**不能**复用为优雅路径测量（它的每格都以 SIGKILL 结束）。

### 缺口 2：**契约字段 `exposure_window_ms` 的语义与 D004 的"暴露窗口"不一致**（本次新发现，比缺数据更值得处理）

这是本次对账里**唯一一条"有数据但与口径不符"**的发现：

- **D004 的定义**（结论第 1 条）：暴露窗口 = 「**事件已产生但事务尚未提交**」，
  长度"由批写提交延迟决定（实测 p50 1–4.1 ms、p95 3–17 ms）"。
  即窗口的**结束**点是"事务提交/进程死亡"。
- **实现的实际语义**（`packages/transport/src/offline/offline-store.ts:304–320`）：

  ```ts
  // 窗口时长是**上界**：会话死亡时刻不可观测，只能给到对账时刻。
  windowMs = Math.max(windowMs, Math.max(0, now() - state.first_pending_at));
  ```

  它在 `reconcileCommitLoss()` 里计算，`now()` 是**重启后第一次对账的时刻**，不是事务提交时刻。
- **实测差距**：T29/T32 的 JSON 里该字段为 **923 / 1205 / 1294 / 1712 ms**（按格），
  与 `measuredMsAfterIssue`（0–11 ms：发出到 SIGKILL）相差 **2–3 个数量级**。
  差额正好是"强杀 + 重启 Chromium + 打开探测页 + 建立连接"的固定开销（见 3.2 两次运行一致的 ~1 s 量级）。
- **它已经进了契约与看板口径**：`docs/contracts/reason-codes.md:84` 把 `exposure_window_ms` 列为
  `sdk_health` 的 `metrics` 之一（CR-001，0.2 兼容追加）；
  `docs/contracts/receiver-requirements.md:94` 还要求它与 `exposure_window_events` **同时出现**（Schema `dependentRequired`）。
  T32 卡也把"暴露窗口的计数与窗口时长必须可观测"写进验收。
- **风险**：接收方看板拿到的是**上界**，而字段名与 D004 的措辞都读作"窗口本身"。
  这是**乐观方向的误导**？不是——它**高估**了暴露窗口，从而让残余风险看起来比实际大 2–3 个数量级；
  但同时它**掩盖**了真正的判据（真实窗口是否仍 ≤ 毫秒级），因为该字段的数值由**重启速度**决定，
  与批写提交延迟无关：**重启越快，上报的"窗口"越小**，指标会随机器性能漂移。
- **本次不改实现**（`packages/*/src/**` 属禁止修改范围），也不改契约。**需负责人裁定**：
  ① 接受该字段是"上界"并在契约/receiver-requirements 里写明语义（最小改动，纯文档）；
  ② 或让实现改用可观测的 `commitLatencyP50Ms/P95Ms`（`stats().exposure` 里已有！）作为窗口口径；
  ③ 或在暂停/离开路径记录"最后一次提交时刻"，让上界退化为真实窗口。
  **本报告的三张表按 JSON 原样列出该字段，并在此显式标注它不是 D004 的窗口。**

### 缺口 3：WebKit 的 3 个格子没有捕获暴露窗口，JSON 计数为 0 —— **不能算作"完全对账"**

`docs/tasks/T32` 的派工说明写「T29 的实测数据，含 **9 格 `reconciles=true`**」。**逐格核对后不成立**：

- Chromium `d004-chromium.json`：`cells` 9 格，`exposureReconciles` **均为 `true`** → 9/9 对账；
- WebKit `d004-webkit.json`：`cells` 9 格，其中 **6 格** `exposureReconciles === true`；
  另外 **3 格**的值是**对象**而非 `true`：`pending-d0` → `{survivors:0, commitLost:0, expected:1000}`、
  `preflush-d0` → `{survivors:0, commitLost:0, expected:1000}`、
  `preflush-small` → `{survivors:0, commitLost:0, expected:100}`。
  这三格同时 `windowCaptured=false`、`nothingCommitted=true`、`measuredMsAfterIssue=0`：
  **杀进程落在任何数据被提交之前，窗口没被捕获**，所以"存活 0 + 计数 0 < 期望"。
- 这与 `docs/reports/e2e-d004-hardkill.md` 第 34/96 行的自述一致（"WebKit 修复后未复跑"、
  "`d004-webkit.json` 仍是含 D-1 的第一轮数据"），但与该报告第 16 行表格中
  `preflush-d0` / `preflush-small` 列写的 **1000 / 100** **不是同一份数据**——那两个数字是 Chromium 第二轮的。
- **风险**：`docs/reports/e2e-d004-hardkill.md` 第 22–30 行的表格标题是「Chromium 第二轮」，
  但其"数字"小节若被跨引擎引用，容易把 Chromium 的 1000/100 误读成两引擎共同结果。
  本报告按 JSON 原文分别列出，**不给 WebKit 补这些数字**。

> **归 T29 / 需非沙箱会话**：WebKit 必须在 D-1 修复后（`packages/transport/dist/index.js`
> `sha256` 前缀 `454fbb9008176f86`）复跑一次 `pnpm test:e2e --project=webkit`，
> 使 `d004-webkit.json` 与 `d004-chromium.json` 同基线。复跑前 WebKit 的
> ③-D1 子窗口与 `pending-d0` 在账面上是**空白**，不是 0。

### 缺口 4：③-D1 的窗口时长只在 Chromium 上有，且是"锚点事务往返 + 定时器"的混合量

`preflush-d0` 的配置把 `commitBatchSize` / `commitIntervalMs` 都放大到 1e9
（即**故意关掉**正常 flush 路径），因此它的窗口时长（Chromium 935 ms / 1205 ms）**不代表生产默认配置**。
生产默认配置的可比数字只有 `preflush-small`（10 批 < `commitBatchSize=100`，走默认 200 ms 定时器）：
Chromium 单次 1205 ms。**单次运行、单格样本 100 事件**——这只够证明"计数装置覆盖到了这个子窗口"，
不够给出该窗口的分布（p50/p95）。D004 引用的 p50 1–4.1 ms / p95 3–17 ms 是 **POC-1 的批写提交延迟**，
不是本 JSON 里的端到端窗口时长，两者不能互相代替。

### 缺口 5：T32 卡的另外两项要求没有数据源

- **M01 去重后入库计数**（T32 验收用例："以上均以 M01 去重后入库计数为准"）：
  `tests/e2e/lib/receiver.mjs` 是一个只做请求收发的本地接收端，**没有去重、没有入库、没有计数**；
  两个 JSON 里也没有任何 `received` / `deduped` 字段。
  所以本报告**无法**给出重复送达率（去重前 − 去重后），也无法以 M01 口径复核②③。
- **「10 万个会话」与「场景构成比例」**（正常 / 页面关闭 / 强杀 / 断网 1–30 分钟 / 2–5 标签页，
  以及 M01 故障注入比例）：现有数据是 **9 格 × 100–500 批 = 单次运行**，量级差 2–3 个数量级。
  本报告不把它表述成"10 万会话模拟"。
- **丢失事件按原因码归类**：③ 的计数对应 `prewrite_commit_lost`（CR-001 已入契约，见 `docs/contracts/reason-codes.md`，
  本次复查 `packages/*/src` 命中 9 个文件），这是**唯一**能在本 JSON 里对应到原因码的量。
  **本次逐码复查（`grep -rl <code> packages/*/src docs/contracts`）结果**：

  | 码 | `packages/*/src` | `docs/contracts/reason-codes.md` | 本次复查结论 |
  |---|---|---|---|
  | `prewrite_commit_lost` | 9 个文件 | 已登记（CR-001） | 可归因 |
  | `recovery_duplicate` | 0 | **未登记** | 只在 `docs/contracts/changes/CR-001-*.md` 第 75 行作为**被否决的提案**出现（"→ 用既有 `replayed`"） |
  | `beacon_rejected` | 0 | **未登记** | 同上，CR-001 第 76 行："→ 用既有 `retry_network`" |
  | `flush_skipped_due_to_budget` | 0 | **未登记** | CR-001 第 77 行："不新增……改为观测量上报，不计原因码" |
  | `leader_lost` | 0 | **未登记** | 同上一行 |

  > **对 D004 的一处措辞订正**（不改变任何结论）：D004 第 63 行写这 4 个码
  > "**在 `docs/contracts/reason-codes.md` 中不存在，在实现中也没有被发出**"——
  > 前半句成立，但更准确的表述是：它们**已被 CR-001 明确裁定"不新增原因码"**
  > （`recovery_duplicate`/`beacon_rejected` 改用既有码，另两个改为观测量）。
  > 所以这 4 个码不是"待补的契约缺口"，而是**已被有意否决**；D004 第 64 行"补齐需要两件事"
  > 的第 ① 项（契约变更）与 CR-001 的裁定**冲突**，开工前需由负责人先澄清要走哪条路。
  > 唯一实质缺口是"观测量上报"（第 77 行要求的做法）在实现里**尚不存在**，因此 ① 类
  > 事件的原因归类当前确实**无法完成**——但原因是"没有发出点"，不是"没有码"。

### 缺口 6：`pnpm test:e2e` 的默认 project 集合在沙箱内**必然有一条红**

`playwright.config.ts` 定义了 3 个 project（chromium / firefox / webkit），`tests/e2e/README.md`
已写明 firefox 在 DSH 沙箱内必然失败（`sandbox_init()` 无法嵌套）。因此不带 `--project` 的
`pnpm test:e2e` 在沙箱里**不是绿的**（T29 报告里"7 passed"是加了 `--project=chromium` 的结果）。
T32 没有改门禁配置（属禁止事项），只在此登记：**发布判定时不要用不带 `--project` 的 e2e 结果。**

## 6. 覆盖范围限制（沿用 T29，未在本任务内消除）

- 只用 headless；无痕模式、存储压力驱逐、真机 iOS/Android Safari 未覆盖。
- **驱动与仓库锁定的 1.64.0 不一致**：`lib/browsers.mjs` 默认走树外只读、revision 精确配对的
  `playwright-core@1.60.0`（本机只装了 chromium-1223 / webkit-2287）。装 1.64.0 期望的构建需
  `playwright install`，**本任务未获批准**（属"装浏览器需先报批"）。
- **Firefox 未测**：本机 DSH 沙箱内 Firefox 主进程无法嵌套启动（卡在 juggler 握手）。
  补测：**非沙箱会话**里跑 `pnpm test:e2e --project=firefox`，**不要设任何 `MOZ_*` 变量**。
- **WebKit 只有第一次运行**（含 D-1 的产物），**没有重复性数据**；重复性只有 Chromium（见 3.2）。
- 每格单次运行（除 3.2 的 Chromium 复跑），样本 100–1000 事件；③ 的窗口时长因此**不报分布**。
- **未覆盖的场景**：断网 1–30 分钟、2–5 标签页的**丢失率**测量、优雅关闭预算用尽（`flush_skipped_due_to_budget`
  无码）、`sendBeacon` 被拒（`beacon_rejected` 无码）——这些都属于 ① 类，见缺口 1。

## 7. 本任务新增的文件（门禁前需 `git add`）

| 文件 | 作用 | 是否可复跑 |
|---|---|---|
| `docs/reports/reliability-reconciliation.md` | 本报告（第 3 节为生成区） | `node tests/reliability/reconcile.mjs --write` |
| `tests/reliability/reconcile.mjs` | 从 `tests/e2e/results/*.json` 现算第 3 节表格 + 两份 JSON 的逐格比对 | 是（纯读、无浏览器） |
| `tests/reliability/results/d004-chromium-rerun.json` | 第 3.2 节的第二次独立运行原始数据（Chromium，sha256 `454fbb9008176f86`） | `node tests/e2e/lib/d004-run.mjs --browser chromium --out tests/reliability/results/d004-chromium-rerun.json` |

**未新增**：测量脚本（沿用 T29 的 `tests/e2e/lib/d004-run.mjs`）、验收用例、门禁配置、契约、实现代码。
`pnpm exec eslint tests/reliability/reconcile.mjs` → **0 错**（本次实跑）。
