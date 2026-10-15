# CR-009 离开通道的**片大小 / 累计在途额度 / 预算字节上限**写进契约正文

- 状态：**已批准（2026-10-15）**，改动已应用到 `reason-codes.md` 第 4 节与
  `schemas/builtin-events/sdk_health.schema.json` 的 `flush_skipped_due_to_budget` 描述
- 起草人：执行方（AC-03 修复 lane，C07/T16）；起草日期：2026-10-15
- 依据：`docs/reports/e2e-real-browser.md`「AC-03」追加节（两引擎实测）；`tests/acceptance/C07.md:9`（AC-03 原文）；
  单元规格 `packages/transport/src/sender/page-leave.test.ts` 的 4 条「AC-03 修复」用例
- 流程依据：`docs/contracts/README.md`「契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准，并按『版本与兼容规则』递增版本」

## 1. 变更摘要

**只做一次兼容澄清，不新增、不删除、不改名任何键，也不改任何键的类型与下界。**

CR-008 落地 `flush_skipped_due_to_budget` 时，把它的语义写成「因预算（**≤48 KB** / ≤200 条 / ≤4 批 / 时间窗）
用尽而停手」。**48 KB 是 POC-1 的旧默认值，不是契约常量**，而且它**与 AC-03 直接冲突**：

| 约束 | 出处 | 数值 |
|---|---|---|
| AC-03 要求的离页载荷 | `tests/acceptance/C07.md:9` | **80 KB**，且「拆成至少两个不超过 60 KB 的请求」 |
| 旧默认离开预算 | `sender/constants.ts`（POC-1 推荐值） | `maxBytes = 48 KB` **< 80 KB** |
| 旧切片阈值 | `BEACON_MAX_BYTES - 256` | `61184 B` **≈ 60 KB** |

实测（`docs/reports/e2e-real-browser.md`）证明这条旧参数组合**必然不合格**，且丢失是静默的：

1. **预算 48 KB < 片大小 ≈60 KB**，且超预算的片被**整片丢弃**（不二次切片）→ **丢头部**
   （`{sent:46, skipped:66, requests:1}`，接收端只见尾部一片）；
2. 放宽预算后确实切成 2 片，但片大小 ≈60 KB 贴着 Chromium 的**累计在途额度 ≈64 KiB**
   （实测 `[60K]→true`、`[30K+30K]→true,true`、`[40K+40K]→true,false`、`[49K+34K]→true,false`）
   → 第二片被 `sendBeacon` **静默拒绝**，**丢尾部**。

因此本 CR 把「**片大小 / 累计在途额度 / 预算字节上限**」三者的口径与取值写进契约正文，
使「离开 budget 相关读数」的上下文不再依赖一份会被改动的实现默认值。

## 2. 精确改动

### 2.1 `docs/contracts/reason-codes.md` 第 4 节「两个观测量」表

`flush_skipped_due_to_budget` 一行的预算口径从

> 因预算（≤48 KB / ≤200 条 / ≤4 批 / 时间窗）用尽而**停手**

改为

> 因预算（**字节上限 / ≤200 条 / ≤4 批 / 时间窗**）用尽而**停手**

并补一句口径说明：字节上限的**默认值**（当前 `LEAVE_BUDGET.maxBytes = 96 KiB`，必须 ≥ AC-03 的 80 KB 载荷）
是**实现参数、不是契约常量**；契约只固定「**离页时不得因预算而丢弃头部**」与「超预算时必须二次切片」两条行为。
其余键名、类型、下界、`drop_`/`count_` 前缀口径与「值为 0 不上报」全部不变。

### 2.2 `schemas/builtin-events/sdk_health.schema.json`

`metrics.properties.flush_skipped_due_to_budget` 的 `description` 里同一处「≤48 KB」改为「字节上限 / ≤200 条 / ≤4 批 / 时间窗」，
并追加一句「字节上限是**实现参数**（默认 96 KiB，须 ≥ AC-03 的 80 KB 载荷）；见 CR-009」。

**前缀 `CR-008：` 不得改动**：`packages/transport/src/monitor/cr008-observables.test.ts` 的漂移锁定
从「description 以 `CR-008：` 开头的键」推导追加键集合，改前缀会让该守卫失效。
`type`、`minimum`、键名、`dependentRequired` 与其余键的 description **不动**。

### 2.3 变更记录

`reason-codes.md` 第 5 节追加一行「0.2（兼容追加） | 2026-10-15 | 经 CR-009 …」。
`receiver-requirements.md` 附录 A.3 **不改**（本次不涉及接收方的新义务：它只需继续忽略不认识的字段、
把 `flush_skipped_due_to_budget` 当"现象计数"读）。

## 3. 兼容性判定

| 判据（版本与兼容规则） | 本次改动 | 结论 |
|---|---|---|
| 事件 Schema：新增 / 删除 / 改名 / 改类型或下界 | 无（只改 `description` 正文） | 兼容 |
| 上报协议 / 批次格式 | 无变化 | 兼容 |
| 原因码 | 不新增、不删除、不改语义（`flush_skipped_due_to_budget` 仍是**观测量**、仍不是原因码） | 兼容 |
| 接收方行为 | 键名、类型、下界、"0 不上报"口径全不变；只有 description 的正文更精确 | 兼容 |
| 实现侧默认值 | 离开预算字节上限由 48 KiB 提到 96 KiB（≥ AC-03 的 80 KB 载荷） | **实现参数变更**，不属契约变更；报文逐片仍 ≤ `BEACON_MAX_BYTES`（60 KiB），单请求上限不变 |

## 4. 实现落点（与契约同步，不属契约变更）

| 常量 / 行为 | 取值 | 出处 |
|---|---|---|
| `BEACON_SLICE_BYTES` | `32 KiB` | `packages/transport/src/sender/constants.ts`；远离实测 ≈64 KiB 的累计在途额度 |
| `BEACON_INFLIGHT_BYTES` | `64 KiB` | 同上；`BEACON_SLICE_BYTES * 2 ≤ BEACON_INFLIGHT_BYTES` 是切片参数的自洽约束 |
| `LEAVE_BUDGET.maxBytes` | `96 KiB` | 同上；必须 ≥ AC-03 的 80 KB 载荷，留 ≈16 KB 余量（auth / 批头 / JSON 开销） |
| `LEAVE_BUDGET.maxEvents` / `maxBatches` / `maxMs` | `200` / `4` / `50` | 沿用 POC-1，不放宽 |
| 超预算的片 | **二次切片（头部优先）**，不整片丢弃 | `packages/transport/src/sender/page-leave.ts` |
| 累计在途控制 | 再写一片就会超过 `BEACON_INFLIGHT_BYTES` 时先 `schedule()` 让出主线程 | 同上（`schedule` 为可注入钩子，缺省改为**宏任务让出**（`setTimeout(flush,0)`）——**实测同一任务内累计写入超 ~64 KiB 后会被 `sendBeacon` 拒绝，而新任务会重置该额度（微任务不会）**；`send()` 仍**同步写满第一个回合**（在实测接受额度内），只把超额度尾部让出到新任务） |
| 丢失出口 | 被跳过的事件数进 `LeaveStats.skipped`；预算停手进 `LeaveStats.budgetStops` → `flush_skipped_due_to_budget` | **复用 CR-008 的现成观测量，不新增码** |

## 5. 批准记录

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 起草 | 执行方（AC-03 修复 lane，C07/T16） | 提交草案并同步落地 | 2026-10-15 |
| 批准 | 编排方 / 架构负责人（AC-03 修复 lane 的裁定：确需新码才开 CR-009；本 CR 按「已批准、0.2 兼容追加、不升版本号」起草） | **批准**：只澄清预算口径为"字节上限"，不改键名/类型/下界 | 2026-10-15 |

批准后的落地情况：

- [x] `reason-codes.md` 第 4 节：预算口径改为「字节上限 / ≤200 条 / ≤4 批 / 时间窗」+ 变更记录行；
- [x] `sdk_health.schema.json`：`flush_skipped_due_to_budget` 的 description 同步（`CR-008：` 前缀保持）；
- [x] 实现：`constants.ts` 的 `BEACON_SLICE_BYTES` / `BEACON_INFLIGHT_BYTES` / `LEAVE_BUDGET.maxBytes`；
      `page-leave.ts` 的二次切片与波次让出；
- [x] 单元层验证：`page-leave.test.ts` 的 4 条「AC-03 修复」用例 + 3 个变异体（见 `docs/reports/` 的下轮报告）；
- [ ] **真实浏览器验证**：本 CR 的取值必须由 `tests/e2e/leave-slice.spec.mjs`（C07-AC-03 接收端送达）在真实
      Chromium 上复验（**不在本次单元层 lane 的范围**）；
- [ ] `docs/contracts/README.md` 状态表标注（沿用 CR-007/CR-008 先例，待编排方处理）。
