# CR-007 澄清 `exposure_window_ms` 是暴露窗口时长的**上界**

- 状态：**已批准（2026-10-13）**，改动已应用到 `reason-codes.md` 第 4 节与 `receiver-requirements.md` 附录 A.3
- 起草人：执行方（C07/T16 收尾，编排方代行）；起草日期：2026-10-13
- 依据：`docs/decisions/D004-hard-kill-exposure-window.md` 结论第 1 条；`docs/reports/reliability-reconciliation.md` 缺口 2；
  `docs/tasks/board.md` 2026-10-13 第 86 行（编排方裁定：把「上界」语义写进契约正文）
- 流程依据：`docs/contracts/README.md`「契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准，并按『版本与兼容规则』递增版本」

## 1. 变更摘要

T32 对账实测发现：契约字段 `exposure_window_ms` **不是** D004 定义的暴露窗口。

| 项 | D004 的暴露窗口 | 实现给 `exposure_window_ms` 的取值 |
|---|---|---|
| 语义 | 「事件已产生但事务尚未提交」的时长 | 该时长的**上界** |
| 起点 | 事件产生（`first_pending_at`） | 同左（一致） |
| **结束点** | **事务提交 / 进程死亡** | **重启后的对账时刻** |
| 实测（T29/T32） | 0–11 ms（`measuredMsAfterIssue`；D004 引用的批写提交延迟 p50 1–4.1 ms / p95 3–17 ms） | 923–1712 ms |

差额正好是「强杀 + 重启 + 打开探测页 + 建立连接」的固定开销，因此该字段的数值**由重启速度决定**，与批写提交延迟无关：
**重启越快，上报的窗口越小**。接收方看板若把它读作真实窗口，会同时犯两个方向的错：低估风险（读数随机器性能漂移）与掩盖真实判据
（真实窗口是否仍在毫秒级）。

**本次变更不新增、不删除、不改名字段，也不改任何取值口径**——它只把实现**已经如此**的语义写进契约正文，
使「读数不是真实窗口」这件事对接收方可见。因此**不改任何机器可读 Schema**，也不改 `exposure_window_events` 的计数口径。

另（本次一并落地，不属契约变更）：实现新增**本地观测量** `stats().exposure.commitLostObservedWindowMs`
（结束点＝最后一个「会话存活」证据），与上界一起把真实窗口夹在 `[observedWindowMs, windowMs]` 之间。
它不是契约指标、不进 `sdk_health`，因此本 CR 不为它申请契约字段。

## 2. 精确改动

### 2.1 `docs/contracts/reason-codes.md` 第 4 节（`sdk_health` 事件）

在 `metrics` 表与「值为 0 的计数不上报……」段之后追加一段字段语义：

> **`exposure_window_ms` 是暴露窗口时长的上界，不是真实窗口。** 起点是事件产生（`first_pending_at`），
> **结束点是重启后的对账时刻**——会话死亡时刻在客户端不可观测，窗口只能在下次打开时闭合，
> 因此该值**包含「强杀 + 重启 + 打开探测页」的固定开销**（T29/T32 实测 923–1712 ms），
> 而 D004 的真实窗口由批写提交延迟决定（实测 0–11 ms / p50 1–4.1 ms / p95 3–17 ms），两者相差 2–3 个数量级。
> 该字段的数值随**重启速度**漂移：重启越快，上报的窗口越小。**不得把它读作真实窗口，也不得用它做 SLA 判定**；
> 真实窗口的本地可观测读数见 `packages/transport` 的 `stats().exposure.commitLostObservedWindowMs`（内部观测量，非契约指标）。

### 2.2 `docs/contracts/receiver-requirements.md` 附录 A.3

第 3 条（`exposure_window_ms` 与 `exposure_window_events` 同现）**保留原判据并补充上界语义**，另追加一条读数口径：

- 第 3 条补充：该指标是**上界**（结束点＝重启后的对账时刻，含重启开销），**不是** D004 的真实窗口；
  接收方看板必须按「上界」标注，不得与批写提交延迟类的量混读。
- 新增第 7 条：**`exposure_window_ms` 不得用于 SLA 或容量判定**——它由重启速度决定，
  同一段真实窗口在不同机器上会得到不同的读数；接收方若需要真实窗口量级，应取 SDK 一侧的本地观测量或专门的测量口径。

### 2.3 版本记录

按 `docs/contracts/README.md` 的「版本与兼容规则」，**澄清既有字段的语义属兼容变更**（无字段增删、无类型变化、
无取值口径变化，仅补足机器不可读的语义描述）；参照 CR-001/CR-003/CR-005 的既有先例（标注「0.2（兼容追加）」、
**不递增文档版本号**）：

- `reason-codes.md` 的版本历史表追加一行；
- `receiver-requirements.md` 的变更记录表追加一行；
- `docs/contracts/README.md` 状态表：**本次未改**（不在本次执行范围，见 §5）。

## 3. 兼容性判定

| 判据（版本与兼容规则） | 本次改动 | 结论 |
|---|---|---|
| 事件 Schema：字段增删改 = 需递增版本 | **无**（未动 `schemas/builtin-events/sdk_health.schema.json`） | 兼容 |
| 上报协议 / 批次格式：无变化 | 无 | 兼容 |
| 字段取值口径 | **无变化**（实现行为未改；仅把注释里已有的「上界」语义写进契约正文） | 兼容 |
| 接收方行为 | 接收方若此前把该读数当真实窗口，需改标注；**不构成破坏性变更**（字段与其 `dependentRequired` 规则不变） | 兼容，但**需接收方确认**（见 §5） |

## 4. 未做的事

- **未**把真实窗口做成新的契约指标（那要改 `schemas/builtin-events/sdk_health.schema.json` 的封闭 `metrics` 集合，
  属另一项兼容追加，本次不申请）；
- **未**改 `exposure_window_ms` 的取值口径（实现仍给上界）；
- **未**改 D004（决策记录不动）；
- **未**改 `prewrite_commit_lost` / `exposure_window_events` 的计数口径，**未**改 `oncomplete` 的 durability 语义。

## 5. 需一并确认的事项

1. **接收方看板是否需要真实窗口作为契约指标**：本次只把「上界」写明，并把真实窗口留给本地观测量
   （`stats().exposure.commitLostObservedWindowMs`）。若看板**必须**直接读到真实窗口，需要再开一次兼容追加
   （Schema `metrics` 新增可选键），本次未做。
2. **`docs/contracts/README.md` 状态表未同步**：该文件不在本次执行范围，待编排方按 CR 惯例标注。
3. **`reopenCommitLoss` / `reopenStats` 是 T29 harness 的 JSON 字段**，本次新增的 `observedWindowMs` 会随
   下一次 `pnpm test:e2e --project=chromium` 自动出现在 `tests/e2e/results/*.json`，无需改 harness。

## 6. 批准记录

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 起草 | 执行方（编排方代行） | 提交草案 | 2026-10-13 |
| 批准 | 编排方（`docs/tasks/board.md` 2026-10-13 第 86 行裁定 ①③） | **批准**：把「上界」语义写进契约正文，并开 CR 记录该澄清；按兼容澄清处理，**不递增文档版本号** | 2026-10-13 |

批准后的落地情况：

- [x] `reason-codes.md` 第 4 节补 `exposure_window_ms` 的上界语义（本次）；
- [x] `receiver-requirements.md` 附录 A.3 第 3 条补充 + 新增第 7 条（本次）；
- [x] 两个契约文档的版本/变更记录表各追加一行「0.2（兼容追加）」（本次）；
- [x] 实现侧新增本地观测量 `commitLostObservedWindowMs` 与回归用例（`packages/transport/src/offline/**`，本次）；
- [ ] `docs/contracts/README.md` 状态表标注（**不在本次执行范围**，待编排方处理）；
- [ ] 接收方看板同步（**不在本项目内**，需前端负责人与接收方对接人确认）。
