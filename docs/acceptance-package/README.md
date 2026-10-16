# 终验材料包（T37 中不依赖试点数据的部分）

- 产出任务：T37（终验材料与变更日志）**中不依赖 T36 试点数据的那一部分**
- 产出日期：2026-10-16
- 角色 / 对接负责人：A14（文档）/ 产品负责人
- 工作目录：`/Users/spirit-ai/Desktop/sdk`（直接工作在 main）

> **本材料包不声明终验通过。** T37 的依赖 T36 需要"全量放量后连续两周的试点运行数据"，
> 该数据**尚不存在**（Q2 未确认、两周观察窗未开始）。凡依赖试点结果的条目，本包一律标
> **`待试点数据`** 或 **`待签字`**，并写清缺什么。第 7 节单列 T36 依赖项。

## 0. 怎么读这份索引

三个状态取值，只表示**材料现状**，不表示验收结论：

| 状态 | 含义 |
|---|---|
| `已完成` | **本包已逐条核实**：该结论有仓库内可点开的证据文件/提交，且**证据文件确实存在、报告确实如此陈述、可复跑脚本确实产出该结论**（核实方式见第 1 节；**不等于本包重跑了每个测试**） |
| `待试点数据` | 结论**需要 T36 的试点数据才能下**；当前可能已有部分旁证，但不足以支撑结论（第 7 节列清单） |
| `待签字` | 技术证据已在仓库内，缺的是**有权签字人的签署**（安全负责人 / 项目经理部） |

每条给四列：**状态 / 证据（可点击相对链接）/ 这条能让谁下什么结论**。
"这条能让谁下什么结论"是**结论边界**——它同时说明**不能**下什么结论；**凡证据不支持的说法都不写**。

## 1. 核实方法与自证

1. 本索引的每一条 `已完成`，其"证据"列中的**每个** 相对链接都由脚本逐条解析 → 断言目标真实存在
   （脚本：`verify-links.mjs`，只读、无依赖，`node docs/acceptance-package/verify-links.mjs`）。
2. 脚本另做三件事：**总览与明细的数字逐格比对**、**第 4 节点名的 ID 与明细状态反向比对**、
   以及**反证**（预置 3 条"指向不存在路径"的假条目必须报错并以非 0 退出——见 `NEGATIVE_CASES` 与自检输出）。
3. 本包**不改任何证据文件**；发现证据与结论不符时只改本索引的状态，并在第 6 节登记。

## 2. 维度总览

| # | 维度 | 条目数 | `已完成` | `待试点数据` | `待签字` |
|---|---|---|---|---|---|
| 1 | 契约 | 12 | 11 | 0 | 1 |
| 2 | 性能 | 7 | 6 | 1 | 0 |
| 3 | 可靠性 | 8 | 4 | 4 | 0 |
| 4 | 安全与隐私 | 10 | 5 | 2 | 3 |
| 5 | 兼容性 | 6 | 4 | 2 | 0 |
| 6 | 接入与发布 | 9 | 2 | 2 | 5 |
| 7 | 遗留 | 11 | 1 | 2 | 8 |

（数字由 `verify-links.mjs` 从下面的表里现算并与之比对——**本表不是手抄的**。）

## 3. 维度明细

**列的含义**：`状态` 见第 0 节；`证据` 可点击（脚本逐条核对过文件存在）；**`这条能让谁下什么结论`** 是结论边界——
括号里同时写明**不能**下什么结论，凡证据不支持的说法本包不写。

### 3.1 契约

| 条目 | 状态 | 证据（可点击） | 这条能让谁下什么结论 |
|---|---|---|---|
| K-01 契约冻结为 0.2，七份正文齐备 | `已完成` | [contracts/README.md](../../docs/contracts/README.md)、[reason-codes.md](../../docs/contracts/reason-codes.md)、[receiver-requirements.md](../../docs/contracts/receiver-requirements.md)、[ingest-protocol.md](../../docs/contracts/ingest-protocol.md)、[remote-config.md](../../docs/contracts/remote-config.md)、[event-standard.md](../../docs/contracts/event-standard.md)、[dictionary-compat.md](../../docs/contracts/dictionary-compat.md) | **架构负责人**可下结论：0.2 是被冻结、可作实现依据的基线。（不能下结论：0.2 之后的 CR 已升版本号——见 K-02，全部为兼容追加、版本号未升。） |
| K-02 CR-001～CR-010 全部已批准并应用 | `已完成` | [changes/CR-001](../../docs/contracts/changes/CR-001-prewrite-commit-lost.md)、[CR-003](../../docs/contracts/changes/CR-003-config-schema-invalid.md)、[CR-005](../../docs/contracts/changes/CR-005-duplicate-critical-traffic-capacity.md)、[CR-007](../../docs/contracts/changes/CR-007-exposure-window-upper-bound.md)、[CR-008](../../docs/contracts/changes/CR-008-squeeze-bounds-and-observables.md)、[CR-009](../../docs/contracts/changes/CR-009-leave-budget-slice-and-inflight.md)、[CR-010](../../docs/contracts/changes/CR-010-leave-quota-physical-bound.md) | **架构负责人 / 接收方对接人**可下结论：十项变更都有独立记录、改动落点与影响面。（不能下结论：CR-010 已完成追认——它的状态栏写明"待安全/前端负责人**追认**"，见 L-08。） |
| K-03 Schema 与样例成对交付 | `已完成` | [schemas/](../../docs/contracts/schemas)、[examples/](../../docs/contracts/examples) | **接收方实现者**可下结论：可用仓库内样例做实现自测。（不能下结论：样例即穷尽——`web_http.failure_reason` 的取值集到 CR-006 才有。） |
| K-04 契约测试双向校验（Schema 合法 + SDK 真实产出） | `已完成` | [tests/contract](../../tests/contract) | **质量负责人**可下结论：契约门禁不只是校验样例，SDK 真实产出也被 Ajv 校验。（不能下结论：契约测试在 `pnpm gates` 里——是的，它在 `unit`/`contract` 两个 vitest project 内。） |
| K-05 CR-001：`prewrite_commit_lost` + 暴露窗口计数进契约 | `已完成` | [CR-001](../../docs/contracts/changes/CR-001-prewrite-commit-lost.md) | **架构负责人**可下结论：D004 第 1 条"未提交事件必须单独计数并上报"有契约依据。（不能下结论：该计数在真实硬杀里准确——见 R-07，实测会少报 99%～100%。） |
| K-06 CR-002：`sdk_health` 字段清单进接收方要求附录 A | `已完成` | [CR-002](../../docs/contracts/changes/CR-002-sdk-health-field-list.md) | **接收方看板建设者**可下结论：字段权威定义是 Schema，附录 A 只给读数口径、不复制字段表（防漂移）。 |
| K-07 CR-003 / CR-004：配置失败原因码与"生效配置"语义统一 | `已完成` | [CR-003](../../docs/contracts/changes/CR-003-config-schema-invalid.md)、[CR-004](../../docs/contracts/changes/CR-004-effective-config-semantics.md) | **架构负责人 / 接入方**可下结论：网络抖动不会把已生效配置打回保守默认（WebCrypto 不可用是唯一例外）。 |
| K-08 CR-005：容量建议计入"重复 ≈1 倍 critical 流量" | `已完成` | [CR-005](../../docs/contracts/changes/CR-005-duplicate-critical-traffic-capacity.md)、[D003](../../docs/decisions/D003-critical-reliability-tiered-target.md) | **接收方容量规划者**可下结论：critical 部分入流量接近翻倍，去重与限流是方案成立的前提而非"配合项"。 |
| K-09 CR-006：追踪头名与 `failure_reason` 取值集落地 | `已完成` | [CR-006](../../docs/contracts/changes/CR-006-trace-header-and-failure-reason.md) | **前端负责人**可下结论：C05-AC-12 / AC-10 的"正确"从不可判定变为可客观判定。 |
| K-10 CR-007：`exposure_window_ms` 是**上界**、不得用于 SLA/容量判定 | `已完成` | [CR-007](../../docs/contracts/changes/CR-007-exposure-window-upper-bound.md)、[reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md) | **接收方看板口径制定者**可下结论：该字段数值由重启速度决定（实测 923–1712 ms），与真实窗口（0–11 ms）差 2–3 个数量级。 |
| K-11 CR-008：暴露窗口的夹逼端点与两个观测量 | `已完成` | [CR-008](../../docs/contracts/changes/CR-008-squeeze-bounds-and-observables.md) | **架构负责人**可下结论：真实窗口右端点（死亡时刻）客户端不可观测，只能夹逼；闭区间两端的语义已进契约。（不能下结论：两个观测量会被上报——见 L-09。） |
| K-12 CR-010：C07-AC-03 口径已按物理约束修订 | `待签字` | [CR-010](../../docs/contracts/changes/CR-010-leave-quota-physical-bound.md)、[tests/acceptance/C07.md](../../tests/acceptance/C07.md) | **前端/安全负责人**可下结论：80 KB 在一次离页内**物理不可达**（同回合累计额度实测 65536 B），AC-03 原文已加注为"在额度内尽可能送达 + 未送达必须可对账"。（不能下结论：该加注已生效——**待负责人签字确认**；在此之前 AC-03 仍按原口径判"不通过"。） |

### 3.2 性能

| 条目 | 状态 | 证据（可点击） | 这条能让谁下什么结论 |
|---|---|---|---|
| P-01 受控基准 harness 已交付 | `已完成` | [tests/bench](../../tests/bench) | **质量负责人**可下结论：P99/吞吐有独立于单元门禁的权威测量装置。（不能下结论：它进了 CI——**未进 CI**，建议只对确定性行与 P50 行设阈值。） |
| P-02 基线数字与测量局限已如实记录 | `已完成` | [client-bench-baseline.md](../../docs/reports/client-bench-baseline.md) | **质量负责人**可下结论：数字、被污染轮次与偏差方向（含 41.7 ns 计时粒度主导亚微秒 P99、同机编译某轮抬高 2–5×）都可追。 |
| P-03 C04 脱敏 P99 超契约目标 → 已修（超线性→线性） | `已完成` | [client-bench-baseline.md](../../docs/reports/client-bench-baseline.md)、[board.md](../../docs/tasks/board.md) | **架构负责人**可下结论：0.0312/0.0370/0.0610 ms > 0.03 已被**修复**（前置门把 ns/字符 142.6→2.3，P99 降至 0.0053–0.0168）。（不能下结论：单元门禁能拦住该类回归——中位数护栏当时拦不到。） |
| P-04 C02 预启动队列超 256 KB 字节预算 → 已修（字节配额淘汰） | `已完成` | [client-bench-baseline.md](../../docs/reports/client-bench-baseline.md)、[board.md](../../docs/tasks/board.md) | **架构负责人**可下结论：317.4 KB（650 B/条上界）已改为按字节配额淘汰，实测 255.8 KB / n=403。（不能下结论：按条数即可约束字节——单值上限 256 字符就 512 B。） |
| P-05 体积预算（门禁口径）四包在预算内 | `已完成` | [.size-limit.json](../../.size-limit.json) | **架构负责人**可下结论：`pnpm size` 在四包上通过；browser 条目 37 KB（实测 35.19 kB，余量 1.81 kB）。（不能下结论：预算表**已定案**——`docs/agent-development-guide.md` 第 6 节正文仍写 13 KB（re-export 壳口径），与 `.size-limit.json` 不一致，见 L-04。） |
| P-06 覆盖率阈值（core/transport ≥90%、plugins/tools ≥80%） | `已完成` | [vitest.config.ts](../../vitest.config.ts) | **质量负责人**可下结论：阈值配置存在且随 `pnpm test` 生效。（不能下结论：覆盖率是**达成**证据——本包只核实配置存在；覆盖率数字以各任务报告为准。） |
| P-07 契约的绝对指标（入队 P99 ≤0.01 ms、初始化 ≤5 ms、30 秒 ≥500 批/秒等） | `待试点数据` | [client-bench-baseline.md](../../docs/reports/client-bench-baseline.md)、[tests/bench](../../tests/bench) | **质量负责人**可下结论：这些指标**只在受控本机 node 环境测过**，"4 核 + Chrome + 4× CPU 限速"的权威口径未达成——T20 的验收环境口径已裁定为"接受本机 node 基线，该环境留到 T29"。**待 T36 项**：见第 7 节 D-2。 |

### 3.3 可靠性

| 条目 | 状态 | 证据（可点击） | 这条能让谁下什么结论 |
|---|---|---|---|
| R-01 D004 核心承诺（②硬杀"已确认落盘"的 critical 不丢） | `已完成` | [durability.spec.mjs](../../tests/e2e/durability.spec.mjs)、[reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md) | **架构负责人**可下结论：Chromium 与 WebKit 各 1000/1000、计 0——**在真实浏览器上**（不是 fake-indexeddb）成立。 |
| R-02 ③硬杀暴露窗口内未提交事件在 Chromium 上完全对账 | `已完成` | [reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md)、[reconcile.mjs](../../tests/reliability/reconcile.mjs) | **质量负责人**可下结论：Chromium 9/9 格对账，D-1 子窗口（`preflush-d0`=1000、`preflush-small`=100）第二次独立运行 sha256 一致。 |
| R-03 对账数字由可复跑脚本现算（非人工抄数） | `已完成` | [reconcile.mjs](../../tests/reliability/reconcile.mjs) | **审阅者**可下结论：可自己 `--compare` 复核，不必信报告措辞。（注意：**报告 §3 生成区与已提交产物脱节**，指纹 454fbb90… vs 现文件 88ca1e9c…，见 L-05。） |
| R-04 ①优雅退出路径 critical ≤0.1% / normal ≤1% | `待试点数据` | [reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md)、[release-checklist.md](../../docs/reports/release-checklist.md) | **项目经理部**可下结论：**目前给不出任何证据**——T29 只做 5–7 事件功能验证，结果 JSON 里没有 `lost`/`lossRate` 字段。需新写 N≥10⁵ 优雅路径 harness。**待 T36 项**：见第 7 节 D-1。 |
| R-05 WebKit 3 格"空白 ≠ 0 丢失" | `待试点数据` | [reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md)、[e2e-d004-hardkill.md](../../docs/reports/e2e-d004-hardkill.md) | **质量负责人**可下结论：`pending-d0`/`preflush-d0`/`preflush-small` 的 `windowCaptured=false`、`nothingCommitted=true`——**账面上是空的**。→ 灰度覆盖 Safari/WebKit 前必须复跑。**待 T36 项**：见第 7 节 D-3。 |
| R-06 M01 侧去重/入库/计数（对账的另一半） | `待试点数据` | [reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md)、[t33-readiness.md](../../docs/reports/t33-readiness.md) | **质量负责人**可下结论：M01 的能力已补齐并有可执行证据（"重复 ≈1 倍 critical 流量"首次被量出来），但**真实浏览器运行下的 M01 计数仍待 T29 复跑产出**；10 万会话规模未达成。**待 T36 项**：见第 7 节 D-4。 |
| R-07 硬杀场景 `prewrite_commit_lost` 的实际计数准确度 | `待试点数据` | [e2e-d004-hardkill.md](../../docs/reports/e2e-d004-hardkill.md) | **架构负责人**可下结论：残余窗口在 WebKit 并行负载下**不是偶发而是主路径**——6 轮有 5 轮计数不完整，`prewrite_commit_lost` **少报 99%（10 vs 1000）或 100%（0 vs 1000）**；CR-001 的"必须单独计数并上报"在该轮**不成立**（不是数据丢失）。**待 T36 项**：见第 7 节 D-5。 |
| R-08 三类分列口径（不得合并成一个丢失率） | `已完成` | [reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md)、[D004](../../docs/decisions/D004-hard-kill-exposure-window.md) | **审阅者**可下结论：三类分母语义不同、不可通约，本材料包**不给总丢失率**，也不给加权平均。 |

### 3.4 安全与隐私

| 条目 | 状态 | 证据（可点击） | 这条能让谁下什么结论 |
|---|---|---|---|
| S-01 `security` vitest project 与可执行用例（含门禁纳入） | `已完成` | [tests/security](../../tests/security)、[vitest.config.ts](../../vitest.config.ts) | **安全负责人**可下结论：安全用例可执行且随门禁运行（报告记 5 文件 / 33 用例全绿）。 |
| S-02 供应链：零第三方运行时依赖 + 产物秘密形态扫描 | `已完成` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：`dependencies` 仅 workspace 内部包；`dist` 扫令牌/私钥形态 0 命中。 |
| S-03 端上脱敏：4 处同族缺口已修 + 机器守卫 | `已完成` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：`attachment`/`dimensions`/`url`/顶层字符串 4 处"截断早于脱敏"已修，并把根因固化为守卫（85 文件、8 反例全抓 / 6 正确写法零误报）。 |
| S-04 撤回同意后的清除（三腿实测） | `已完成` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：设备标识消失、离线副本另开 store 复读证明被清、会话随机数重置——三腿各一次变异验证。 |
| S-05 安全测试报告签发 | `待签字` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：报告顶部写"已签发（2026-10-15）"，依据是**负责人在会话中的明确授权**；**签发权不在编排方**，这是给签发人的输入材料。（不能下结论：报告正文内部一致——第 149/158 行仍写"未经签发/不签发"，与签发区矛盾，见 L-06。） |
| S-06 无高危 / 无中危结论 | `待试点数据` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：**该结论目前下不了**——它依赖 T29 的真实信标通道与端到端 URL 验证。 |
| S-07 低危问题清单与处置计划 | `待试点数据` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：任务卡要求"低危问题有处置计划"，而**问题清单本身尚未列出**（报告第 2 节第 7 条记为待办）。 |
| S-08 令牌不出现在 URL / 调试输出 / 离线明文 | `待签字` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：`sanitizeUrl` 按白名单过滤、白名单为空时删全部参数，已由独立复验（4 条含精确相等断言）与"让诊断记录带上令牌值"的**否证实验**证明"不泄漏"断言仍可失败。端到端形态归 T29。 |
| S-09 设备/会话标识"声称与实际同源"修复 | `待签字` | [security-draft.md](../../docs/reports/security-draft.md)、[board.md](../../docs/tasks/board.md) | **安全负责人**可下结论：批头声称 `persistent:true` 而存储为空那一类已修并加了"已授权 ⇒ 落盘"对照（原有 13 条**只覆盖未授权方向**，结构上发现不了）。 |
| S-10 `localStorage` 仓库级守卫（D004） | `已完成` | [localstorage-guard.test.ts](../../tests/contract/localstorage-guard.test.ts) | **质量负责人**可下结论：源码不得引用 `localStorage` 已从一次性人工 grep 固化为门禁（AST 检测、含反空转与正/负向对照，判别力经真实植入实测）。 |

### 3.5 兼容性

| 条目 | 状态 | 证据（可点击） | 这条能让谁下什么结论 |
|---|---|---|---|
| C-01 兼容矩阵 45 格（38 pass / 1 by-design / 6 blocked） | `已完成` | [matrix.json](../../tests/compat/results/matrix.json)、[compat-matrix.md](../../docs/reports/compat-matrix.md) | **前端负责人**可下结论：接入方式（ESM/IIFE/Vite 生产与 dev/Jest-ESM/webpack 生产与 dev/无 DOM）均真跑 `createAssembly→init→track→flush` 并断言接收方收到批次，另带对照格证明非空转。 |
| C-02 CJS `require()` 不支持（by-design，非缺陷） | `已完成` | [compat-matrix.md](../../docs/reports/compat-matrix.md)、[contracts/README.md](../../docs/contracts/README.md)、[agent-development-guide.md](../../docs/agent-development-guide.md) | **接入方**可下结论：SDK 是 ESM-only，`require("@web-report-sdk/browser")` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，`Jest` 需 ESM 模式——**这是有意识的不支持**（`09bf63b` 由 fail 改 by-design，指南 4.2 已改口径）。（不能下结论：会有 CJS 构建——已决定不为浏览器 SDK 增加 CJS 构建。） |
| C-03 内核 `dispose()` 共存缺陷已修 | `已完成` | [compat-matrix.md](../../docs/reports/compat-matrix.md)、[tests/compat](../../tests/compat) | **前端负责人**可下结论："SDK 先装、第三方后装"时 `destroy()` 不再抹掉第三方包装层（两条路径统一为 `restoreChainIfOwned`，复现脚本 exit 0）。 |
| C-04 降级路径 7 格（每组带对照格）与真实 Chromium 核心路径 11 项 | `已完成` | [matrix.json](../../tests/compat/results/matrix.json) | **前端负责人**可下结论：能力缺失时的降级行为有独立格子。 |
| C-05 Firefox / Edge / 最低版本 / iOS 真机 / Android 真机 6 格 | `待试点数据` | [compat-matrix.md](../../docs/reports/compat-matrix.md)、[release-checklist.md](../../docs/reports/release-checklist.md) | **前端负责人**可下结论：这 6 格 `blocked`，而它们**正是灰度要覆盖的浏览器**；沙箱内 `pnpm test:e2e`（不带 `--project`）必然红。→ 发布判定必须显式声明"本期已验证浏览器集合"。**待 T36 项**：见第 7 节 D-6。 |
| C-06 K02 浏览器侧验签（K02-AC-03） | `待试点数据` | [compat-matrix.md](../../docs/reports/compat-matrix.md)、[board.md](../../docs/tasks/board.md) | **质量负责人**可下结论：该 AC 记为**部分实现**（单测走 Node 24 全局 `crypto.subtle`，Chromium 侧未执行），README 已写明"这一条不算通过"。**待 T36 项**：见第 7 节 D-7。 |

### 3.6 接入与发布

| 条目 | 状态 | 证据（可点击） | 这条能让谁下什么结论 |
|---|---|---|---|
| A-01 接入侧文档六份（含运维手册） | `已完成` | [guides/README.md](../../docs/guides/README.md)、[integration.md](../../docs/guides/integration.md)、[api-reference.md](../../docs/guides/api-reference.md)、[migration.md](../../docs/guides/migration.md)、[receiver-guide.md](../../docs/guides/receiver-guide.md)、[tools.md](../../docs/guides/tools.md)、[sdk-operations.md](../../docs/runbooks/sdk-operations.md) | **接入方**可下结论：引用方式、API 参考、迁移步骤、接收方要求与运维（kill switch / 配置回滚 / 令牌与公钥轮换 / 紧急补丁）都有成文材料。 |
| A-02 `examples/` 五个工程 | `已完成` | [examples/](../../examples) | **接入方 / 质量负责人**可下结论：`node-import`、`script-tag`、`vite`、`webpack`、`event-registry` 五条路径存在且被 `examples:build`/`examples:test` 覆盖。（注意：`examples/quickstart` **缺失**，见 L-07。） |
| A-03 `pnpm gates` 全量门禁 | `待签字` | [package.json](../../package.json)、[t08-gates.md](../../docs/reports/t08-gates.md) | **质量负责人**可下结论：命令定义与 CI 顺序在仓库内可查。**本包的实跑结果**以本次 T37 交付报告为准（见 L-01）。（不能下结论：CI 首次推送已验证——**未验证**。） |
| A-04 发布检查表（命令 + 判据 + 实跑 + 反证 + 回滚） | `待签字` | [release-checklist.md](../../docs/reports/release-checklist.md) | **项目经理部**可下结论：发布前要跑什么、什么算过、反证怎么做、怎么回滚，都有成文清单；**13 条发布阻塞点**在同一文件第 13 节。（不能下结论：清单在 clean 基线上跑过——第 12 条阻塞点：本次门禁是在**含其他 lane 17 个未提交修改**的工作树上跑的。） |
| A-05 灰度方案（分阶段放量 + 进入/退出判据 + 回滚阈值） | `待签字` | [release-grayscale-plan.md](../../docs/reports/release-grayscale-plan.md) | **项目经理部**可下结论：如何分阶段放量、每阶段的判据按 D004 三类分列。（不能下结论：可以开始放量——受第 3.6 节 `待试点数据` 项阻塞。） |
| A-06 10 条发布阻塞点 | `待签字` | [release-checklist.md](../../docs/reports/release-checklist.md) | **项目经理部**可下结论：前 3 条是"发布判定不得被写成通过"的硬阻断（① 零数据、WebKit 空白、6 格 blocked）；其余含版本号门禁缺失、预算表未定案、T31 报告自相矛盾、D-09 同类残留、`touch()` 零调用、门禁自检缺口、T33 残余、对账报告脱节、发布基线未冻结。**本包第 3.7 节逐条对应。** |
| A-07 首个发布版本号与版本一致性门禁 | `待试点数据` | [CHANGELOG.md](../../CHANGELOG.md)、[release-checklist.md](../../docs/reports/release-checklist.md) | **项目经理部**可下结论：`0.1.0` 已定版（4 包清单 + `SDK_VERSION` + CHANGELOG + docs 4 处同步），**新建的版本门禁立刻抓出过期产物**。（不能下结论：有自动化版本号门禁——`api:check` 只比导出面、**不比版本号**。） |
| A-08 CHANGELOG 覆盖已发布版本 | `待签字` | [CHANGELOG.md](../../CHANGELOG.md) | **接入方 / 审阅者**可下结论：`0.1.0` 条目覆盖公共 API、契约变更、工具与未交付项，且**每条可追到 CR 或提交**。（不能下结论：有 0.0.x 历史——工作区首个基线就是 `0.1.0`。） |
| A-09 CI（`.github/workflows/ci.yml`） | `待试点数据` | [package.json](../../package.json)、[release-checklist.md](../../docs/reports/release-checklist.md) | **DevOps**可下结论：CI 工作流逐条调用门禁命令；`build` 顺序与指南/`gates` **相反**（第 9 条阻塞点）。（不能下结论：CI 跑过——**首次推送未验证**。） |

### 3.7 遗留

| 条目 | 状态 | 证据（可点击） | 这条能让谁下什么结论 |
|---|---|---|---|
| L-01 发布阻塞点（10 条）在本包逐条落位 | `已完成` | [release-checklist.md](../../docs/reports/release-checklist.md) | **项目经理部**可下结论：10 条阻塞点**一条都没有被本包"消掉"**——其中 R-04/R-05/C-05/S-06/S-07/L-04/L-06/L-08/A-03/A-09 各对应一条或数条。本包的作用是**把它们带进终验**，不是清掉它们。 |
| L-02 `touch()` 生产零调用 ⇒ `session_id` 30 分钟空闲轮换从不发生 | `待签字` | [security-draft.md](../../docs/reports/security-draft.md)、[board.md](../../docs/tasks/board.md) | **项目经理部 / 安全负责人**可下结论：这是已登记待立项的缺陷类（不是"待观察"），签发遗留项里已显式写出。 |
| L-03 三处新的无覆盖读取点（`RoutePorts.now` / `HttpPorts.now` / `PerfPorts.now`） | `待签字` | [t33-access-blockers.md](../../docs/reports/t33-access-blockers.md) | **质量负责人**可下结论：三处**读取点真实存在、注入后无任何断言**——钉成常量 `9_999` 后 `packages/plugins` **124/124 全绿**（即改坏也没人知道）。补法已写明（注入不可能出现的 `now` → 断言 `at`/`occurred_at` 等于注入值），**本轮只报告未处置**。 |
| L-04 体积预算表未定案 + 指南正文与 `.size-limit.json` 不一致 | `待签字` | [release-checklist.md](../../docs/reports/release-checklist.md)、[agent-development-guide.md](../../docs/agent-development-guide.md)、[.size-limit.json](../../.size-limit.json) | **项目经理部**可下结论：指南第 6 节仍写 browser 13 KB（re-export 壳口径），实际已重推为 37 KB（实测 35.19 kB）——**未定案前不得发布**。 |
| L-05 T32 报告 §3 生成区与已提交产物脱节 | `待签字` | [reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md)、[reconcile.mjs](../../tests/reliability/reconcile.mjs) | **审阅者**可下结论：报告指纹与实际文件不一致（`--compare` 判定"同一份被测实现：否"），**结论未变但发布记录不得引用已无法回指的指纹**。修法：`node tests/reliability/reconcile.mjs --write`（需授权后再跑）。 |
| L-06 T31 报告正文与签发结论自相矛盾 | `待签字` | [security-draft.md](../../docs/reports/security-draft.md) | **安全负责人**可下结论：第 149/158 行仍写"未经签发/不签发"，签发区写"已签发"——**审计口径风险，发布前清掉**。 |
| L-07 T33 三项残余 + Q2 未确认 | `待试点数据` | [t33-readiness.md](../../docs/reports/t33-readiness.md)、[Q2-pilot-apps.md](../../docs/decisions/Q2-pilot-apps.md)、[t33-access-blockers.md](../../docs/reports/t33-access-blockers.md) | **产品负责人**可下结论：腿③（双写转发）未接入、`examples/quickstart` 缺失、`docs/guides` 3 项待办；且 `tests/acceptance/` 下**没有 T33 对应的验收文件**。**待 T36 项**：见第 7 节 D-8。 |
| L-08 CR-010 待追认 | `待签字` | [CR-010](../../docs/contracts/changes/CR-010-leave-quota-physical-bound.md)、[tests/acceptance/C07.md](../../tests/acceptance/C07.md) | **安全/前端负责人**可下结论：AC-03 加注已落盘，但 CR 状态栏写明"**待安全/前端负责人追认**"。 |
| L-09 门禁里的"永远绿"缺口与 `pnpm gates:selftest` | `待签字` | [release-checklist.md](../../docs/reports/release-checklist.md)、[package.json](../../package.json)、[handover.md](../../docs/reports/handover.md) | **质量负责人**可下结论：`gates:selftest` 只覆盖 4 个门禁（`lint`/`typecheck`/`size`/`api:check`），`examples:build`/`examples:test`/`test:contract`/`test:e2e` 无自检，且本次**未运行** `gates:selftest`；另有两条候选（`examples` 的 `build` 是空脚本、`--passWithNoTests` 让 0 用例也 exit 0）。 |
| L-10 D-09 同类残留（`init({endpoint/token/...})` 被静默忽略） | `待签字` | [t33-access-blockers.md](../../docs/reports/t33-access-blockers.md)、[release-checklist.md](../../docs/reports/release-checklist.md) | **前端负责人**可下结论：`endpoint`/`token` 在 core `client.ts` 内**零读取点**，接入方按 API 参考在 `init` 里传端点会得到"零上报且不报错"——发布前必须裁定"修"或"在接入指南写死正确用法"。 |
| L-11 无法在本仓库闭环的外部事项 | `待试点数据` | [handover.md](../../docs/reports/handover.md)、[board.md](../../docs/tasks/board.md)、[release-checklist.md](../../docs/reports/release-checklist.md) | **项目经理部**可下结论：接收方看板同步 CR-001 新原因码（不在本项目内）、R-003 的飞书线上文档同步、CI 首次推送、T29 的 WebKit/Firefox 复跑需**非沙箱会话**、真实 `QuotaExceededError` 与 iOS/Android 真机——这些本仓库做不到。**待 T36 项**：见第 7 节 D-9。 |

## 4. 维度覆盖一览（审阅者最关心的三句话）

**只看这三个数**：**33 条 `已完成` / 13 条 `待试点数据` / 17 条 `待签字`**（合计 63）。下面三条把它们各自的 ID **逐条点名**；**每一条都被自证脚本反向核对过**（第 4 节点名的 ID 必须在本节明细表里正是那个状态——点名与表格不一致即判失败）。

1. **`已完成`（33 条）——已有证据、可据此下结论**：K-01、K-02、K-03、K-04、K-05、K-06、K-07、K-08、K-09、K-10、K-11、P-01、P-02、P-03、P-04、P-05、P-06、R-01、R-02、R-03、R-08、S-01、S-02、S-03、S-04、S-10、C-01、C-02、C-03、C-04、A-01、A-02、L-01。证据路径逐条由脚本核对存在。
2. **`待试点数据`（13 条）——证据尚不存在，现在不能下结论**：P-07、R-04、R-05、R-06、R-07、S-06、S-07、C-05、C-06、A-07、A-09、L-07、L-11。逐条对应第 7 节的 D-1～D-11。
3. **`待签字`（17 条）——技术证据已在仓库，缺有权签字人**：K-12、S-05、S-08、S-09、A-03、A-04、A-05、A-06、A-08、L-02、L-03、L-04、L-05、L-06、L-08、L-09、L-10。

**SUM 行**（脚本按明细现算并与第 2 节总览**逐格**比对；不一致即判失败）：

| 维度 | 条目数 | `已完成` | `待试点数据` | `待签字` |
|---|---|---|---|---|
| **合计** | 63 | 33 | 13 | 17 |

**按角色分**（同一角色关心哪几条）：

| 角色 | 应当先看 | 关键判据 |
|---|---|---|
| 项目发起人 / 项目经理部 | 第 3.6、3.7 节 | **发布判定目前不得写成"通过"**：R-04 零数据、R-05 WebKit 空白、C-05 六格 blocked、A-03/A-09 未验证 |
| 安全负责人 | 第 3.4 节 + [security-draft.md](../../docs/reports/security-draft.md) | 可签发什么、S-05 报告内部矛盾、L-02 `touch()` 零调用、L-10 D-09 同类残留 |
| 架构负责人 | 第 3.1、3.3 节 | 契约十项变更、②③类可靠性的精确边界（R-07 少报 99%） |
| 质量负责人 | 第 3.2、3.5、3.7 节 | 基准数字与局限、兼容矩阵证据、L-03/L-09 "门禁里的永远绿" |
| 接入方 | 第 3.6 节 `已完成` 两条 | 可用的是文档与 examples；`init({endpoint/token})` 当前被静默忽略（L-10） |

## 5. 材料清单（审阅者按图索骥）

| 材料 | 路径 | 状态 |
|---|---|---|
| 契约正文（7 份）与 Schema/样例 | [docs/contracts/](../../docs/contracts/README.md) | 已冻结 0.2 |
| 契约变更记录 CR-001～CR-010 | [docs/contracts/changes/](../../docs/contracts/changes/CR-001-prewrite-commit-lost.md) | 已批准并应用（CR-010 待追认） |
| 决策记录 D001～D004、Q1～Q7 | [docs/decisions/](../../docs/decisions/) | 已确认（Q2 待确认） |
| 评审记录 R-001～R-016 | [docs/review-log.md](../../docs/review-log.md) | 全部已关闭 |
| 任务看板与 37 张任务卡 | [docs/tasks/board.md](../../docs/tasks/board.md) | 维护中（T33～T37 未就绪） |
| 性能基线报告 | [client-bench-baseline.md](../../docs/reports/client-bench-baseline.md) | 已交付（未进 CI） |
| 可靠性对账报告 | [reliability-reconciliation.md](../../docs/reports/reliability-reconciliation.md) | 已交付（生成区脱节，见 L-05） |
| 真实浏览器 E2E 报告 | [e2e-real-browser.md](../../docs/reports/e2e-real-browser.md) | 已交付（Firefox/WebKit 复跑待非沙箱会话） |
| D004 硬杀护栏报告 | [e2e-d004-hardkill.md](../../docs/reports/e2e-d004-hardkill.md) | 已交付（含"只报不改"的 3 条实现侧事实） |
| 兼容矩阵报告 | [compat-matrix.md](../../docs/reports/compat-matrix.md) | 已交付（6 格 blocked） |
| 安全与隐私测试报告 | [security-draft.md](../../docs/reports/security-draft.md) | 已签发（正文有过期行，见 L-06） |
| 发布检查表（10 条阻塞点） | [release-checklist.md](../../docs/reports/release-checklist.md) | 已交付（发布基线未冻结） |
| 灰度放量方案 | [release-grayscale-plan.md](../../docs/reports/release-grayscale-plan.md) | 已交付（真实阈值待试点基线校准） |
| 运维手册 | [sdk-operations.md](../../docs/runbooks/sdk-operations.md) | 已交付（6 项演练待 M01/预发布） |
| 接入侧文档（6 份） | [docs/guides/](../../docs/guides/README.md) | 已交付（3 项待办） |
| 试点工具链与就绪盘点 | [t33-readiness.md](../../docs/reports/t33-readiness.md)、[t33-pilot-onboarding-kit.md](../../docs/reports/t33-pilot-onboarding-kit.md)、[t33-access-blockers.md](../../docs/reports/t33-access-blockers.md) | 已交付（**不含试点结果**） |
| 变更日志 | [CHANGELOG.md](../../CHANGELOG.md) | `0.1.0` 已补全（本任务） |
| 本材料包与自证脚本 | [README.md](README.md)、[verify-links.mjs](verify-links.mjs) | 本任务 |

## 6. 本包的核验边界与自证（不夸大）

1. **核验的是"证据路径存在 + 报告自述 + 可复跑脚本"**，不是"本包重跑了每个测试"。`node docs/acceptance-package/verify-links.mjs` 现做四件事（全部**实跑过**，exit 0）：① 63 条明细的 118 个本地证据链接**逐条存在**；② 第 2 节总览的条目数与三个状态计数与明细**逐格相等**；③ **第 4 节点名的 ID 与明细表的实际状态反向比对**（点名与表格不符即失败）；④ **3 条反证**（指向不存在路径的假条目）必须被抓到，另有**声明外的现场注入反证**见下条。
   **未核**：各报告内部数字的一致性（例如 L-05 的指纹脱节、L-06 的正文矛盾**是**核出来的，但报告里其余数字未逐项重算）。
2. **现场注入反证（2 条，先红后绿）**：① 把 S-10 的证据链接改成 `tests/contract/localstorage-guard-GONE.test.ts` → 脚本报 `证据不存在` + `标为已完成但证据缺文件`；② 把第 4 节 `已完成` 清单里的 `K-01` 换成 `K-12` → 脚本报 `点名 K-12 为「已完成」，而明细表里它是「待签字」`。两次注入后脚本 exit 1、`diff` 恢复后与注入前**逐字节相同**、脚本回到 exit 0。
3. **本次实跑的门禁只有 `pnpm gates` 一条**（结果见 T37 交付报告），它是**本轮**工作树的结果，**不代表**发布检查表要求的 clean 基线（第 12 条阻塞点）。**且本轮工作树并不干净**：跑门禁时 `packages/plugins/src/route/plugin.ts` 等 6 个文件带着**另一条 lane 的在途改动**（其中一个是在途变异痕迹，见 T37 交付报告的"并发"一节）。
4. **本包未做任何 git 写操作**，未改 `packages/*/src/**`、`docs/contracts/**`、`docs/decisions/**`、`tests/**`、门禁配置与 `.size-limit.json`。
5. **发现的事实不一致（登记不改）**：
   - `docs/agent-development-guide.md` 第 6 节的 browser 预算写 **13 KB**（re-export 壳口径），`.size-limit.json` 实物是 **37 KB**——已对应 L-04；
   - `docs/reports/security-draft.md` 第 149/158 行与签发区矛盾——已对应 L-06；
   - `docs/reports/reliability-reconciliation.md` 生成区指纹与现文件不符——已对应 L-05；
   - `docs/reports/release-checklist.md` 第 13 节标题写"10 条"，实际列了 **12 条**（含 11、12）——**审阅者请按 12 条读**，本包 A-06 已如实记 10 条为清单正文所述。
6. **不使用 `class`/`any`/`@ts-ignore`/`eslint-disable`/`.skip`/`.only`**，不新增依赖；脚本用 Node 内置模块（`node:fs`/`node:path`/`node:url`）。
7. 本包**不声明终验通过**——按 T36 卡：结论由项目发起人在 M8 给出。

## 7. T36 依赖项（单列）

**T36 需要什么**：`docs/tasks/T36.md` 的验收用例要求「SDK 健康指标（内部异常数、丢弃率按原因码、主线程长任务、体积）**连续两周达标**，数据来源可追溯」，且数据来源是「**试点方导出的 `sdk_health` 汇总数据**（看板不在本项目内，数据由试点团队提供）」。

**现在为什么做不了**：
- **Q2 未确认**（[Q2-pilot-apps.md](../../docs/decisions/Q2-pilot-apps.md) 状态"待确认"、结论表为空）：试点应用名、应用负责人、前端对接人、预发布环境都没有；
- 因此 **T33 未就绪 → T35 未就绪 → T36 未就绪**（[board.md](../../docs/tasks/board.md)）；
- **两周观察窗未开始**：即使今天确定 Q2，也要先接入、再全量放量（[release-grayscale-plan.md](../../docs/reports/release-grayscale-plan.md) 的 5%/20%/50%/100%，每级观察 48 小时）再加 14 天。

**依赖项清单**（每条写清：缺什么数据 / 由谁提供 / 拿到后怎么用）：

| ID | 缺什么 | 由谁提供 | 拿到后怎么用 |
|---|---|---|---|
| **D-1** | ①优雅退出路径的**丢失率实测数据**（critical ≤0.1% / normal ≤1%），样本 N≥10⁵ | **质量负责人 + T29**（需新写优雅路径 harness；`tests/e2e/lib/d004-run.mjs` 不能复用）+ **非沙箱会话** | 填 R-04；在此之前发布记录**不得**声称达成 D003/D004 的①类目标 |
| **D-2** | 「4 核 + Chrome + 4× CPU 限速」环境下的性能基准数字 | **质量负责人**（T29 在该环境复测；T20 已裁定先接受本机 node 基线） | 校准 P-07；据此定契约绝对指标是否达标 |
| **D-3** | WebKit 3 格（`pending-d0`/`preflush-d0`/`preflush-small`）的**窗口捕获**结果 | **质量负责人 + 非沙箱会话**（`pnpm test:e2e --project=webkit`） | 关闭 R-05；WebKit 的③类结论从"空白"变成有数 |
| **D-4** | 真实浏览器运行下的 **M01 侧去重/入库计数** + 10 万会话规模 | **试点团队导出 `sdk_health` 汇总 + 接收方对接人** | 关闭 R-06，得到"三方对账"（SDK / 接收方 / 业务） |
| **D-5** | 硬杀场景 `prewrite_commit_lost` 的**真实计数准确度**（现测少报 99%～100%） | **前端负责人**（实现侧加固：提交前锚点并入提交事务，或显式在途标记）+ 非沙箱会话复跑 | 关闭 R-07；使 CR-001「未提交事件必须单独计数」在真实硬杀下成立 |
| **D-6** | Firefox / Edge / 最低版本 / iOS 真机 / Android 真机 的 E2E 结果 | **质量负责人**（需装浏览器 / 非沙箱会话 / 真机） | 关闭 C-05；发布判定才能声明"本期已验证浏览器集合"覆盖灰度目标浏览器 |
| **D-7** | Chromium 里 K02 发布物验签（K02-AC-03） | **质量负责人**（T29 补一条 Chromium 用例：`crypto.subtle.verify` 通过 + 篡改 1 字节失败） | 关闭 C-06，把该 AC 从"部分实现"改为"通过" |
| **D-8** | 2 个试点应用接入与 **连续 7 天三方对账**；以及 Q2 的四个字段（应用名/负责人/前端对接人/预发布环境） | **负责人确认 Q2**（`wenye.zhang`）+ **试点应用负责人与前端对接人**（工具链已就绪，见 [t33-pilot-onboarding-kit.md](../../docs/reports/t33-pilot-onboarding-kit.md) 与 [tests/pilot](tests/pilot)） | 关闭 L-07 与 T33；`tests/pilot/**` 是**前置就绪验证，不是 T33 验收替代品** |
| **D-9** | 连续两周的 `sdk_health` 汇总（内部异常数、**按原因码的丢弃率**、主线程长任务、体积） | **试点团队**（看板不在本项目内） | 这是 T36 报告的主体：逐指标判"连续两周达标"；同时关闭 R-04/R-06 的试点侧 |
| **D-10** | 接收方看板同步 CR-001 新原因码与两个暴露窗口指标 | **前端负责人 + 接收方对接人**（不在本项目内） | 使 `sdk_health` 的新指标真的被消费；否则 K-05 只在 SDK 侧成立 |
| **D-11** | 维护移交清单已与接手团队确认 | **项目负责人 / 接手团队** | T36 验收用例第 3 条；本包只提供材料，不代替确认 |

**拿到数据后的动作**：把 `docs/reports/stability-*.md` 写出来（T36 唯一新增文件），把 D-1～D-11 逐条置为"已关闭/仍阻塞"，再回到本索引把对应条目的 `待试点数据` 改成 `已完成` 或保留——**改状态时必须同时补上新的证据路径**（本包的 1.3 脚本会核）。

---

## 附：本包的自证命令

```bash
node docs/acceptance-package/verify-links.mjs   # exit 0 = 证据路径全部存在、总览与明细一致、3 条反证全部被抓到
```

**最后一次实跑结果**：维度 7；明细 63；本地证据链接 118；指向不存在路径的证据 **0**；反证 **3/3** 被抓到。
