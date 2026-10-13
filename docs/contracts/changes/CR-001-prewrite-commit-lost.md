# CR-001 新增原因码 `prewrite_commit_lost` 与 `sdk_health` 暴露窗口计数

- 状态：**草案（待架构负责人批准）**
- 起草人：A01（编排方代行）；起草日期：2026-10-13
- 依据：`docs/decisions/D004-hard-kill-exposure-window.md`；`docs/poc/POC-1-storage.md`
- 流程依据：`docs/contracts/README.md`「契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准，并按『版本与兼容规则』递增版本」

## 1. 变更摘要

D004 第 1 条要求：硬杀场景下「**事件已产生但 IndexedDB 事务未提交**」的那部分事件**必须单独计数并上报，供接收方看板区分**，不得与优雅路径的丢失混算。

现有原因码无法表达这一事件：

| 候选现有码 | 为何不适用 |
|---|---|
| `offline_evicted` | 事件并未因容量或过期被淘汰；淘汰发生在写入之前，而这里是写入**未完成** |
| `storage_unavailable` | 存储**可用**（IndexedDB 正常打开，事务正常发起）；是页面/进程被强杀导致事务被中断 |
| `retry_exhausted` | 与重试无关，事件从未进入发送阶段 |
| `queue_evicted` | 属 C06 的内存队列淘汰，语义不同 |

因此请求新增一个原因码，并扩展 `sdk_health` 的计数面。**这是本次变更的全部内容**，不涉及任何既有字段的删除或语义修改。

## 2. 精确改动

### 2.1 `docs/contracts/reason-codes.md` 第 1 节（客户端丢弃）新增一行

| 原因码 | 环节 | 说明 | 验收用例 |
|---|---|---|---|
| `prewrite_commit_lost` | C07 | critical 事件已产生且已发起离线预写，但 IndexedDB 事务在 `oncomplete` 之前被中断（页面或进程被强杀），该事件未落盘且无法补发 | **C07-AC-28（新增，见 §2.3）** |

计数形态按第 1 节既有约定：`drop_prewrite_commit_lost`。置于第 1 节（客户端丢弃）而非第 2 节（只计数），因为该事件**确实被丢弃了**——这与 D004「不得与优雅路径混算」的口径一致。

### 2.2 `docs/contracts/reason-codes.md` 的 `sdk_health.metrics` 新增两个字段

在既有 `metrics` 列表中（`calls_total`、…、`window_ms`、`drop_<原因码>`、`count_<原因码>`）追加：

- `exposure_window_events`：本次会话内经暴露窗口丢失的事件数（与 `drop_prewrite_commit_lost` 同源，便于看板直接取用而不必解析原因码命名）；
- `exposure_window_ms`：观测到的暴露窗口时长（自事件产生到判定未落盘的最长间隔），单位毫秒。

理由：D004 要求按「条数**与窗口时长**」计量，仅有原因码计数不足以表达时长。

### 2.3 `tests/acceptance/C07.md` 需新增 `C07-AC-28`（由 A09 提供）

契约第 1 节的每一行都必须挂一条验收用例，因此本 CR **依赖**一条新验收用例，建议内容：

> **C07-AC-28**：在 `critical` 事件已发起 IndexedDB 预写、事务尚未 `oncomplete` 时强杀页面/进程；重启后 SDK 必须：① 该事件记为 `drop_prewrite_commit_lost` 并计入 `exposure_window_events`；② 上报 `exposure_window_ms` 且其值为正；③ **不得**把它计入优雅路径的丢失率统计。

同时需 A00 把 `docs/tasks/T16.md` 的验收用例范围由 AC-27 更新为 AC-28。

### 2.4 版本记录

按 `docs/contracts/README.md` 的「版本与兼容规则」，**新增原因码属兼容变更**；参照 2026-10-12 对 `schemas/builtin-events/`、`examples/builtin-events/`、`examples/compat-pairs/` 的既有先例（标注「0.2（兼容追加）」、**不递增文档版本号**），本次同样处理：

- `docs/contracts/README.md` 状态表：`reason-codes.md` 行标注 `0.2（兼容追加）` 并注明日期与内容；
- `reason-codes.md` 的版本历史表追加一行：`0.2（兼容追加） | 2026-10-13 | 新增 prewrite_commit_lost（C07）；sdk_health.metrics 新增 exposure_window_events / exposure_window_ms`。

## 3. 兼容性判定

| 判据（版本与兼容规则） | 本次改动 | 结论 |
|---|---|---|
| 原因码：新增原因码 = 兼容变更 | 新增 1 个码，未删除、未改既有码语义 | 兼容 |
| 上报协议 / 事件 Schema：新增可选字段 = 兼容变更 | `sdk_health.metrics` 新增 2 个字段 | 兼容 |
| 接收方行为 | 接收方按「忽略不认识的字段」实现（`ingest-protocol.md`）；未见过的原因码不应导致拒收 | 兼容，但**需接收方确认**（见 §5） |

## 4. 若不予批准的退路

只用观测量上报（`stats().exposure` / `metrics` 之外的自定义字段），**不动契约**。代价：与 D004「必须单独计数并上报，供接收方看板区分」的要求**只部分符合**——看板拿不到契约级的原因码，跨版本难以稳定聚合。写进 T16 计划的局限一节即可。**T16 的实现成本差异很小**：这两个名字集中在 `offline/constants.ts` 一处导出，取舍只影响常量是否保留（约 10 分钟）。

## 5. 需一并确认的事项

1. **接收方是否需要同步确认**：`ingest-protocol.md` 已规定接收方忽略不认识的字段，但新增一个**原因码**意味着看板要新增一列／一个指标。接收方不在本项目内（D001），本 CR 只能给出建议，不能替接收方承诺。建议由前端负责人与接收方对接人在下次同步时确认。
2. **POC 建议的另外 4 个码不予采纳**，改由现有码或观测量覆盖（T16 计划的裁定）：
   - `recovery_duplicate` → 用既有 `replayed`；
   - `beacon_rejected` → 用既有 `retry_network`；
   - `flush_skipped_due_to_budget`、`prewrite_commit_lost` **以外的**、`leader_lost` → 均**不新增**：这三者都不是丢弃路径（没有任何事件被丢弃），改为观测量上报，不计原因码。
3. 本 CR **不涉及** `receiver-requirements.md` 的容量建议补充（「重复 ≈1 倍 critical 流量」），那是另一项独立的兼容变更，另行起草。

## 6. 批准记录

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 起草 | A01（编排方代行） | 提交草案 | 2026-10-13 |
| 架构负责人 | （待签署） | — | — |
