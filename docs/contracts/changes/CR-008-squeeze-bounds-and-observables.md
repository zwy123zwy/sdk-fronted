# CR-008 `sdk_health.metrics` 追加暴露窗口的**夹逼端点**与两个**观测量**

- 状态：**已批准（2026-10-14）**，改动已应用到 `schemas/builtin-events/sdk_health.schema.json`、`reason-codes.md` 第 4 节与 `receiver-requirements.md` 附录 A.3
- 起草人：执行方（编排方代行）；起草日期：2026-10-14
- 依据：`docs/decisions/D004-hard-kill-exposure-window.md` 结论第 1 条；
  `docs/contracts/changes/CR-001-prewrite-commit-lost.md` §5.2 第 3 条（4 个码的裁定）；
  `docs/contracts/changes/CR-007-exposure-window-upper-bound.md` §5 第 1 条（"若看板必须直接读到真实窗口，需要再开一次兼容追加"）；
  `docs/reports/reliability-reconciliation.md` 缺口 2 的落地表、缺口 5 的逐码复查表
- 流程依据：`docs/contracts/README.md`「契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准，并按『版本与兼容规则』递增版本」

## 1. 变更摘要

**只做一次兼容追加，解决两件已被报告点名的事**，都不新增、不删除、不改名、不改语义任何既有键。

### 1.1 真实暴露窗口只能被**夹逼**，看板需要两个端点

D004 的真实暴露窗口 W =「事件已产生但事务尚未提交」的时长。它的**右端点（进程死亡时刻）在客户端不可观测**，
因此 W **没有**一个能被 SDK 直接测量的读数，只能被夹在区间里：

| 端点 | 客户端可见的锚点 | 偏差方向 | 当前是否可见于契约 |
|---|---|---|---|
| 下界 | 事件产生 → **最后一次「会话仍存活」的证据**（intent 锚点的 `updated_at`，每次 `prewrite()` 的同一同步回合改写） | 提交被卡住时**低估** | ❌ 只是本地观测量 `stats().exposure.commitLostObservedWindowMs`（CR-007 落地） |
| 上界 | 事件产生 → **重启后的对账时刻** | 含强杀+重启+探测页开销，**高估**（T29/T32 实测 923–1712 ms，而 W 只有 0–11 ms，差 2–3 个数量级） | ✅ `exposure_window_ms`（CR-001），但**名字读作窗口本身**，只能靠 CR-007 的正文说明它是上界 |

CR-007 已把"上界"写进正文，并在 §5 第 1 条明说：看板若要直接读到真实窗口量级，**需要再开一次兼容追加（Schema `metrics` 新增可选键）**。
本次即该追加。**注意口径**：客户端**不能**承诺一个叫"真实窗口"的字段（右端点不可观测）；能承诺的只有
**两个显式命名的区间端点**，看板按 `[下界, 上界]` 成对引用。

### 1.2 CR-001 裁定为「观测量」的两个事件至今**没有发出点**

CR-001 §5.2 第 3 条已裁定：POC 建议的另 4 个码**不新增**，其中 `flush_skipped_due_to_budget` 与 `leader_lost`
「都不是丢弃路径（没有任何事件被丢弃），改为**观测量上报**，不计原因码」。
T32 报告的缺口 5 逐码复查进一步指出：这 4 个码**不是待补的契约缺口**（已被有意否决），
**唯一实质缺口是"观测量上报"在实现里尚不存在**——即 **① 优雅路径按因归类无法完成的真正原因是"没有发出点"，不是"没有码"**。

观测量要"供接收方看板区分"，就必须有**契约指标名**（`metrics` 是封闭集合，Schema 是 `additionalProperties: false`）。
本次追加这两个键，并在实现侧补上发出点（见 §4）。

## 2. 精确改动

### 2.1 `schemas/builtin-events/sdk_health.schema.json`：`metrics` 追加 4 个键（只追加）

| 键 | 类型 / 下界 | 语义 | 命名理由 |
|---|---|---|---|
| `exposure_window_lower_bound_ms` | `integer`，`minimum: 0` | 暴露窗口**下界**：窗口内丢失事件中，`事件产生 → 最后一次「会话仍存活」证据`的最大值。来源＝`stats().exposure.commitLostObservedWindowMs`。允许 0（真实窗口可以是 0 ms；它不是计数，不适用"0 不上报"） | `_lower_bound_` 明示这是**区间左端点**，不是窗口本身；`_ms` 与 README 约定一致 |
| `exposure_window_upper_bound_ms` | `integer`，`minimum: 1` | 暴露窗口**上界**：与 `exposure_window_ms` **同源同值**（`reconcileCommitLoss().windowMs`），只是名字显式标注为上界 | `_upper_bound_` 明示**区间右端点**；成对出现才构成夹逼 |
| `flush_skipped_due_to_budget` | `integer`，`minimum: 1` | 本窗口内**离开 burst 内首次因预算（≤48 KB / ≤200 条 / ≤4 批 / 时间窗）用尽而停手**的次数；同一 burst 内后续被跳过的切片不重复计数。**不是**被跳过的事件数（事件数的本地观测量是 `LeaveStats.skipped`）。来源＝`page-leave.ts` 的 `LeaveStats.budgetStops` | **照抄 CR-001 §5.2 的原文名字**，不加 `drop_` / `count_` 前缀——CR-001 已裁定它**不是原因码**（没有事件被丢弃），加前缀会与 `reason-codes.md` 第 1/2 节的口径冲突 |
| `leader_lost` | `integer`，`minimum: 1` | 本窗口内**本标签页从 leader 变为非 leader**的次数（首轮即未当选不计，因为它没有"失去"）。它是 count 而非 drop：POC-1 实测正确性不依赖选主，选主只控制重复流量。来源＝`leader.ts` 的 `LeaderElection.leaderLost()` | 同上，照抄 CR-001 §5.2 的原文名字 |

**为什么不直接改 `exposure_window_ms`**：既有键的语义受 CR-007 保护（上界），且事件 Schema 的字段改名/改语义属**破坏性变更**；
本 CR 一律**追加**。

**关于 `leader_lost` / `flush_skipped_due_to_budget` 的语义**：CR-001 只给了名字与「观测量」这一裁定，
D004「需要改的文档」一节明确列出「POC 未给出、必须由设计决定的部分」（`leader_lost` 的语义与它是 count 还是 drop）。
本 CR 用上面的表格把这两点**定案并写进契约**（count、非 drop），不改变 CR-001 的命名与"不新增原因码"的裁定。

### 2.2 `dependentRequired`（机器可校验的成对/同现规则）

在既有 `{"exposure_window_ms": ["exposure_window_events"]}` 基础上追加两条（**JSON Schema 2020-12**）：

```json
"exposure_window_lower_bound_ms": ["exposure_window_upper_bound_ms", "exposure_window_events", "exposure_window_ms"],
"exposure_window_upper_bound_ms": ["exposure_window_lower_bound_ms", "exposure_window_events", "exposure_window_ms"]
```

即：**夹逼端点必须成对、且必须与 `exposure_window_events` 和既有 `exposure_window_ms` 同现**——
"夹逼"是一个区间，单独一个端点没有意义（下界单独出现会被误读成一个下界就够；上界单独出现就是 `exposure_window_ms` 的重复）；
而端点与既有 `exposure_window_ms` 同现，保证接收方看到的新端点永远是"同一窗口、同一读数"的完整三元组，
不会出现"只有新上界、没有旧上界"的半截读数。没有捕获到窗口时，两个端点都**不得**上报
（映射层先行保证，Schema 兜底）。

### 2.3 `docs/contracts/reason-codes.md` 第 4 节

- `metrics` 列表追加这 4 个键名，并注明后两者**不是原因码**（无 `drop_` / `count_` 前缀）；
- 新增一段「暴露窗口的夹逼口径」：W 被夹在 `[exposure_window_lower_bound_ms, exposure_window_upper_bound_ms]` 之间，
  两端偏差方向（下界低估 / 上界高估）与"不得把任一端点单独读作窗口、不得用于 SLA"；
  `exposure_window_upper_bound_ms` 与 `exposure_window_ms` **同源同值**，不得相加或平均；
- 新增一段「两个观测量」：`flush_skipped_due_to_budget` / `leader_lost` 的语义、burst 边界、以及它们的依据（CR-001 §5.2 第 3 条）；
- 第 5 节变更记录追加一行「0.2（兼容追加） | 2026-10-14 | 经 CR-008 …」。

### 2.4 `docs/contracts/receiver-requirements.md` 附录 A.3

- 新增第 8 条：夹逼端点必须成对引用，任一端点都**不是**真实窗口；`exposure_window_ms` 与上界同源同值；
- 新增第 9 条：两个观测量**不是原因码**（没有 `drop_` / `count_` 前缀，值为 0 时不上报），看板按"现象计数"而非丢失归因处理；
- 变更记录追加一行「0.2（兼容追加） | 2026-10-14 | 经 CR-008 …」。

### 2.5 版本记录

按 `docs/contracts/README.md` 的「版本与兼容规则」：**事件 Schema 新增可选字段 = 兼容变更**；
参照 CR-001/CR-003/CR-005/CR-007 的既有先例（标注「0.2（兼容追加）」、**不递增文档版本号**、`schema_version` 仍为 `1`）：

- `reason-codes.md` 变更记录追加一行；
- `receiver-requirements.md` 变更记录追加一行；
- `docs/contracts/README.md` 状态表**本次未改**（沿用 CR-007 的先例，见 §5 第 2 条）。

## 3. 兼容性判定

| 判据（版本与兼容规则） | 本次改动 | 结论 |
|---|---|---|
| 事件 Schema：新增可选字段 | `metrics` 追加 4 个键 + 2 条 `dependentRequired` | **兼容** |
| 事件 Schema：删除 / 改名 / 改类型或语义 | 无（`exposure_window_events`、`exposure_window_ms` 名字、类型、取值口径均不变；CR-007 的上界语义不变） | 兼容 |
| 上报协议 / 批次格式 | 无变化 | 兼容 |
| 原因码 | **不新增、不删除、不改语义**（CR-001 §5.2 的裁定不动；两个观测量不是原因码） | 兼容 |
| 接收方行为 | 接收方按「忽略不认识的字段」实现（`ingest-protocol.md`）；新增键只在 SDK 侧产生，旧接收方不受影响。但看板要展示夹逼与观测量需新增列 → **需接收方确认**（见 §5） | 兼容，但需接收方确认 |

## 4. 实现发出点（与契约同步落地，不属契约变更）

| 指标 | 发出点（真实事件处） | 到 `sdk_health` 的路径 |
|---|---|---|
| `exposure_window_lower_bound_ms` | `packages/transport/src/offline/offline-store.ts` 的 `reconcileCommitLoss()`：`observedWindowMs = updated_at - first_pending_at` | `stats().exposure.commitLostObservedWindowMs` → `monitor/adapters.ts` 的 `createOfflineExposureSource` → `ExposureWindowInput.observedWindowMs` → `monitor/metrics.ts` |
| `exposure_window_upper_bound_ms` | 同上，`windowMs = now() - first_pending_at` | `stats().exposure.commitLostWindowMs` → 同一条路径（与 `exposure_window_ms` 同源同值） |
| `flush_skipped_due_to_budget` | `packages/transport/src/sender/page-leave.ts`：`exhausted()` 或字节上限触发跳过时报 1 次（每 burst 至多 1 次） | `LeaveStats.budgetStops` → `monitor/adapters.ts` 的 `createObservableMetricsSource`（窗口差分）→ `monitor/metrics.ts` |
| `leader_lost` | `packages/transport/src/leader/leader.ts`：`run()` 里 `lastWasLeader` 由 `true` 变 `false` 时 +1 | `LeaderElection.leaderLost()` → 同一个观测量适配器（窗口差分）→ `monitor/metrics.ts` |

契约与实现的**漂移锁定**：`packages/transport/src/monitor/cr008-observables.test.ts`
从**真实 Schema**（`metrics.properties` 里 description 以 `CR-008：` 开头的键）推导出本次追加的键集合，
与本模块的常量清单**双向**比对（少一个、多一个、错序都红），并断言其余键集合的**封闭性**（Schema 里没有未登记的 `metrics` 键）。

## 5. 需一并确认的事项

1. **接收方看板**：需要新增「夹逼区间」与两个观测量的列/面板；本 CR 只给出字段与读数口径，
   接收方不在本项目内（D001），需前端负责人与接收方对接人在下次同步时确认。
2. **`docs/contracts/README.md` 状态表未同步**（沿用 CR-007 的先例）：待编排方按 CR 惯例标注。
3. **①「优雅路径按因归类」的口径现在齐了，数据仍缺**：`flush_skipped_due_to_budget`（观测量）、
   `leader_lost`（观测量）、`beacon_rejected` → 既有 `count_retry_network`、`recovery_duplicate` → 既有 `count_replayed`
   四个路径现在**都有发出点或既有承载物**；但 T32 缺口 1（优雅路径 4 类场景的测量 harness、N≥10⁵、分层样本）**仍未做**，
   因此 ① 的**丢失率**依然无数据。本 CR 不改变该结论。

## 6. 批准记录

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 起草 | 执行方（编排方代行） | 提交草案 | 2026-10-14 |
| 批准 | 编排方 / 架构负责人（`docs/tasks/board.md` 2026-10-14 裁定） | **批准**：按兼容变更处理（`metrics` 追加 4 个可选键 + 2 条 `dependentRequired`），**不递增文档版本号** | 2026-10-14 |

批准后的落地情况：

- [x] `schemas/builtin-events/sdk_health.schema.json`：`metrics` 追加 4 个键 + 2 条 `dependentRequired`（只追加，未动既有键）；
- [x] `reason-codes.md` 第 4 节：`metrics` 列表、夹逼口径段、两个观测量段、第 5 节变更记录行；
- [x] `receiver-requirements.md` 附录 A.3：新增第 8、9 条 + 变更记录行；
- [x] 实现发出点：`monitor/observables.ts`（键名常量）+ `monitor/metrics.ts` + `monitor/adapters.ts` + `monitor/reporter.ts` + `sender/page-leave.ts`（`budgetStops`）+ `leader/leader.ts`（`leaderLost`）；
- [x] 漂移锁定与 fail-first 用例：`packages/transport/src/monitor/cr008-observables.test.ts`；
- [x] T32 对账脚本只增：`tests/reliability/reconcile.mjs` 新增夹逼读数区（既有判定口径未改）；
- [ ] `docs/contracts/README.md` 状态表标注（**不在本次执行范围**，待编排方处理）；
- [ ] 接收方看板同步（**不在本项目内**）；
- [ ] 优雅路径 4 类场景的测量 harness（T32 缺口 1，**不在本次范围**）。
