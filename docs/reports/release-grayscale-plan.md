# T35 灰度（分阶段放量）方案

- 任务：T35（3 人日 / A10 本 lane）；日期 2026-10-15
- 配套：发布检查表 `docs/reports/release-checklist.md`；运维手册 `docs/runbooks/sdk-operations.md`
- 依据：`docs/tasks/T35.md`（放量节奏 5%、20%、50%、100%，每级观察 48 小时；
  机制＝远程配置的 `sampling` 与 `overrides`）、`docs/contracts/remote-config.md` §2/§5.1/§5.2/§5.3、
  `docs/contracts/receiver-requirements.md` 附录 A、（T32）`docs/reports/reliability-reconciliation.md`
  （三类分列口径）、`docs/reports/compat-matrix.md`（灰度前门禁）

> **一句话口径**：**放量的是"面"，判据是"三类分列"** —— 每一级都用 ①优雅路径 / ②硬杀已落盘 /
> ③暴露窗口 三类**各自**的门槛判进与判出，**任何情况下都不得把三类合并成一个"丢失率"**（T32 第 1 节）。
> **执行人**：每一级放量的配置发布都由**人工审批并由人执行**；Agent 只准备变更单与观察报告（T35 禁止事项）。
> **状态**：本方案中所有"真实业务阈值"都要先用 §5 的试点基线校准 → 标 ⏳ 待 Q2/待试点结果的项，
> 在拿到基线之前**不得**当成已批准的数字使用。

---

## 1. 放量机制（怎么"放"）

厂商侧唯一的放量手段是**远程配置发布物**（接入方自托管，`remote-config.md` §1）。三个可用的旋钮：

| 旋钮 | 作用域 | 备注 |
|---|---|---|
| `overrides[]` | 按 `sdk_versions` 范围和/或 `session_bucket` 区间 `[from, to)`（0–100，会话随机数 ×100）对 `sampling`/`plugins`/`transport` **打补丁** | **放量的主旋钮**。`patch` **不能**改 `kill_switch` 与 `privacy`（§5.3） |
| `sampling.session_rate` | 会话级采样率 0–1；会话随机数持久化，`random < session_rate` 命中；未命中的会话**拆除采集监听**，只保留 critical 上报能力 | 命中即"全采"，不命中即"只留 critical"（§5.2） |
| `sampling.allow_users` | 白名单 `user_id`（或其哈希）始终全量采集 | **内部/Stage 0 用这个**，比按桶分更可控 |
| `sampling.rules[]` | 事件级规则（第一条命中生效，`rate: 0` = 禁用该事件） | 用于按事件类型收窄，不是放量主手段 |
| `kill_switch.all` / `.sdk_versions` / `.plugins` | 停采与定向关闭（§5.1） | **回滚主旋钮**，见 §4 |

**四条必须先记住的机制事实（否则分级会设计错）**：

1. **critical 事件不受任何采样影响**（§5.2）。→ 无论哪一级，**critical 通道都是 100% 在跑**。
   所以"1% 放量很安全"是**假的安全感**：真正的高风险路径（离开补发、离线副本、去重）从 Stage 0 起就全覆盖。
   **结论**：分级的第一作用域是**普通事件**，而 critical 路径的正确性必须在 Stage 0 就用 ②③ 类判据验完。
2. **分桶是"会话级"的、且会话随机数在会话开始时生成并持久化**（同意前只存内存）。→ 放量比例是
   **会话占比**，不是用户占比；同一用户的多个会话可能落在不同桶。看板按 `session_bucket` 统计覆盖率时
   必须说明这一点。
3. **配置生效 P95 ≤10 分钟**（缓存 5 min + 拉取周期 5 min，§1）。→ **每次改级后至少等 10 分钟**
   再采数据；并且必须用 `sdk_health.dimensions.config_version` **确认新配置真的生效**，
   不能只看"我已经发布了"。
4. **`config_version` 单调递增**（§3）。→ 改级、回滚、收窄都必须**发新版本号**；
   **把旧发布物原样发回去不会生效**（`config_version_stale`）。

**变更单模板（每级一份，人工审批用）**：

```
变更单：T35 灰度第 N 级
- app_id / env：<试点应用 app_id> / <prod|staging>
- 目标：session_bucket [from, to) = <x>%     （或 sampling.session_rate = <x>）
- config_version：<新号>（必须 > 当前生效版本）
- 内容摘要：overrides[].patch = { sampling: {...} }（只允许 sampling/plugins/transport）
- 回滚脚本：见 release-checklist §10.2（发布 config_version 更大的"上一级内容"）
- 观测窗口：48 小时；观测看板：sdk_health.metrics（三类分列）+ 接收方去重计数
- 审批人：____  执行人：____  时间：____
```

---

## 2. 观测点（用 M01 的 `counters` 与 SDK 的 `stats`）

### 2.1 契约侧（接收方看板读 `sdk_health`）

字段定义以 `docs/contracts/schemas/builtin-events/sdk_health.schema.json` 为准
（`receiver-requirements.md` A.1 明确"不复制字段表"）。灰度必须逐类引用下面这些键：

| 类别 | 观测键（`sdk_health.metrics`） | 读法（**最容易读错的点**） |
|---|---|---|
| ① 优雅路径 | `events_enqueued`、`events_sent`、`batches_sent`、`batches_failed` | **`batches_sent` 与 `batches_failed` 不互补**（A.3 第 4 条）：后者含熔断（未尝试发送）与终态 4xx；两者都**不含**离开通道与补发批次。**不要用 `sent + failed` 反推提交总数** |
| ② 硬杀已落盘 | `offline_written`、`offline_replayed` | 两者**单位是批次数**，不是事件数（A.3 第 2 条） |
| ③ 暴露窗口 | `exposure_window_events` + `exposure_window_lower_bound_ms` + `exposure_window_upper_bound_ms`（+既有 `exposure_window_ms`） | **必须成对引用**（`dependentRequired`）：`lower ≤ W ≤ upper`。**上界含"强杀+重启+开页"开销（实测 923–1712 ms），被重启速度支配，不得用于 SLA/容量判定**；下界是时长、**可以为 0**（0 不是缺数据）（A.3 第 3/7/8 条） |
| 现象计数（**不是丢失归因**） | `flush_skipped_due_to_budget`、`leader_lost` | 前者是"离开 burst 内**首次**因预算用尽而停手的次数"（**不是被跳过的事件数**）；后者是"从 leader 变为非 leader 的次数"（首轮未当选不计）（A.3 第 9 条） |
| 熔断/暂停 | `drop_circuit_open`、`state`（`paused`） | `state` 是生命周期状态；与熔断器状态**不是一回事** |
| 策略性丢弃（**不是缺陷**） | `drop_consent_denied`、`killed`、`drop_killed` | 同意门与 kill switch 的**预期**结果，不得计入丢失 |
| 窗口自身 | `window_ms`、`dimensions.config_version`、`dimensions.sdk_version`、`sample_rate` | **聚合时必须把"同 `window_ms` + 同 `dimensions`"的多条视为同一窗口**（A.4，50 个非零指标会拆条）；按 `sdk_version` 分列，**两个版本不得混成一行** |

**计数类指标值为 0 时不上报**（A.3 第 1 条）→ "某个 `drop_*` 键不出现" **等价于该窗口为 0**，
不要当成缺数据。

### 2.2 SDK 侧（`stats`，比契约更细、用于定位）

```js
assembly.delivery.metrics()
// → { eventsSent, batchesSent, batchesFailed, offlineWritten, offlineWrittenEvents,
//     offlineReplayed, offlineReplayedEvents, offlineEvicted,
//     exposure: { pendingBatches, pendingEvents, oldestPendingMs,
//                 commitLatencyP50Ms, commitLatencyP95Ms,
//                 commitLostEvents, commitLostWindowMs, commitLostObservedWindowMs },
//     leave, retry: { attempts, ratio }, leader: { mode, leader, leaderLost },
//     circuitOpen, paused, lastReplayReason }
assembly.delivery.exposureMetrics()   // CR-001 的两个契约指标（events ≥1 时才有）
```

**读数纪律（T32 缺口 2 的落地）**：
- `commitLostWindowMs`（＝契约 `exposure_window_ms`／上界）**不是 D004 的真实窗口**；
  真实窗口只能**夹逼**：`commitLostObservedWindowMs ≤ W ≤ commitLostWindowMs`（两个端点**都不得单独当 W**）。
- `commitLatencyP50Ms/P95Ms` 在**重启后的新会话里恒为 `null`**（新会话一个事务都没提交过）——
  它度量的是优雅提交路径的延迟，**恰好在最需要它的场景里为空**（T32 缺口 2 的落地表）。
  → **不要拿它当窗口**。
- `leader_lost` / `flush_skipped_due_to_budget` 是**观测量不是原因码**（CR-008）。

### 2.3 接收方侧（M01 的 `counters`；**生产接收方必须实现同一口径**）

```bash
# 本地测量装置（M01，只用于测试）
curl -s http://127.0.0.1:8787/__mock/counters        # 别名 /__mock/stats
curl -s http://127.0.0.1:8787/__mock/events         # 入库数据（X-App-Id 过滤）
curl -s -X POST http://127.0.0.1:8787/__mock/counters/reset

# T32 的本地对账装置（字段更全，只在 tests/e2e/**）
#   tests/e2e/lib/receiver.mjs 的 counters.snapshot()
```

| 量 | 用途 | 期望 |
|---|---|---|
| `received_batches` / `received_events` | **去重前**收到量 | — |
| `stored_batches` / `stored_events` | **去重后入库量（对账以它为准）** | — |
| `duplicate_events` | 重复送达 | 恒等式：`received_events − stored_events === duplicate_events` |
| `duplicate_rate` | 重复率（只在 `tests/e2e/lib/receiver.mjs`；**M01 的 HTTP 接口不提供**） | 与 D003/CR-005 的"**≈1 × critical 流量**"对齐；容量规划按 §7.1 另加一份 |
| `rejected_<code>`（9 类） | 拒收归类 | **`rejected_invalid_structure` 必须为 0**（D-01 那种契约违反会被它抓到） |
| `injected_*` | 故障注入（只 M01） | 演练用 |

**⚠ 一处口径纠正（本次核实）**：`tests/pilot/20-receiver-selfcheck.mjs` 与 `t33-readiness.md` 把
"`duplicate_rate` / `by_event_name` / `by_batch`"记成 M01 的计数口径；实际上**这三个字段只在
`tests/e2e/lib/receiver.mjs`（T32 本地对账装置）里**，`tools/mock-receiver` 的 `/__mock/counters`
只给 `received_*` / `stored_*` / `duplicate_events` / `rejected_*` / `injected_*`。
灰度看板的重复率字段**由生产接收方实现**（RR-05 + 容量建议 §4），不是 M01 的产出。

### 2.4 业务侧（A/B 对比，归试点）

按 T33 预置的 LCP / INP P75 A/B 判据（`docs/reports/t33-pilot-onboarding-kit.md` 第 5 节）：
劣化 ≤2%。**真实站点数字未测** → ⏳ 待 Q2。

---

## 3. 分阶段放量（每阶段的进入/退出判据）

**节奏来源**：`docs/tasks/T35.md` 写的是 **5% → 20% → 50% → 100%**，每级 **48 小时**。
派工建议里给的是 **1% → 10% → 50% → 100%**。两者**不是同一张表**，本方案：

- 把任务卡的 **5/20/50/100** 作为**基线梯度**（任务卡是验收依据）；
- 把 **1%** 作为**可选的前置级**（当 Stage 0 的 ① 类代理指标接近门槛、或试点应用的错误预算很紧时启用）；
- 用 `overrides[].session_bucket` 实现（`patch` 只改 `sampling`），`allow_users` 实现 Stage 0。
- **梯度本身需要负责人确认**（标 ⏳）：本方案不擅自改变任务卡的节奏。

> 每一级的"退出"都有两种方向：**升级**（进下一级）或**回滚/暂停**（触发 §4 的阈值）。
> 没有"保持不动继续观察超过 48h 还不下结论"这一选项——超时未定的必须升级给负责人。

### Stage 0 —— 内部（白名单，非按桶）

| 项 | 内容 |
|---|---|
| 作用域 | `sampling.allow_users` = 内部账号白名单；或内部工具类试点应用的 `app_id`（若 Q2 给了） |
| 放量面 | **普通事件**：白名单用户全量采集；**critical 事件：从本阶段起就是 100%** |
| 进入判据 | ① `pnpm gates` exit 0（§1）；② 兼容矩阵**无新 `fail`**（§6）；③ **非沙箱** `pnpm test:e2e --project=chromium --project=webkit` 绿（§5）；④ M01/预发布上**演练通过**：`kill_switch.all` 生效 + 配置回滚（发更大 `config_version`）+ 版本回滚（§10/runbook）；⑤ 发布检查表 §13 的阻塞点 1–5 已有负责人裁定 |
| 观测（48h） | 契约侧：`events_enqueued/sent`、`offline_written/replayed`、`drop_*`、`state`、`config_version`；SDK 侧：`assembly.delivery.metrics()`；接收方：恒等式 + `rejected_*` |
| 退出判据（**逐类**） | **①** 代理：`events_sent / events_enqueued` 的窗口缺口 ≤ 基线（见下方"① 无数据"说明），且**无新增 `drop_*` 归因**；**②** 无"已 `oncomplete` 却读不回"的实例（`offline_written` 的批次最终都 `replayed` 或成功提交）；**③** `exposure_window_events` 出现时，**下界**与批次提交延迟同量级（毫秒级，T33 实测 1–7 ms），上界**只记录、不判 SLA**；**重复**：`duplicate_rate` 与"≈1× critical"可比；**业务**：无新增前端错误、无 LCP/INP 劣化 |
| 不通过就回滚 | 见 §4 |

**⚠ "① 无数据"必须写在观察报告里**：T32 缺口 1 —— ① 类（优雅退出路径 critical ≤0.1% / normal ≤1%）
**当前没有可对账的实测数据**（T29 只有 5–7 事件的**功能验证**，`tests/e2e/results/*.json` 里**没有任何
`lost`/`lossRate` 字段**）。→ 灰度期间 ① 只能用**代理指标**（`events_enqueued − events_sent`、
`stored_events` 与 `events_sent` 的差、`drop_*` 归因），
**代理指标不是 ≤0.1% 的证据**。观察报告必须**显式标注这是代理**，不得写成"① 类达标"。

### Stage 1 —— 5%（可选前置级 1%）

| 项 | 内容 |
|---|---|
| 机制 | `overrides: [{ session_bucket: [0, 5)  /* 或 [0,1) */, patch: { sampling: { session_rate: 1 } } }]`；桶外 `session_rate: 0`（只留 critical）。**或**直接 `sampling.session_rate = 0.05`（更简单，但无法按版本收窄） |
| 进入判据 | Stage 0 的**全部退出判据**成立 + 48h 内**零** §4 的即时回滚触发 + 负责人审批 |
| 观测（48h） | 同 Stage 0；**新增**按 `sdk_version` 分列（确认新版本真的在跑）+ 放量覆盖率（`session_bucket` 命中占比是否 ≈5%） |
| 退出判据（逐类） | ① 代理缺口**不劣化于 Stage 0**（相对基线，同一窗口长度）；② 无读不回；③ 下界不出现趋势性上升（**看趋势，不看单点**：T32 已证明单次窗口时长的运行间偏离可达 8%–38%，**不得把单次值当分布**）；重复率可比；业务指标不劣化 |
| 特别检查 | `config_version` 生效确认（≥10 分钟后）；`drop_killed`/`killed` 必须为 0（否则说明 kill switch 误命中） |

### Stage 2 —— 20%（可选前置级 10%）

| 项 | 内容 |
|---|---|
| 机制 | `session_bucket: [0, 20)`（或 `[0,10)`） |
| 进入判据 | Stage 1 退出判据成立 + 48h 零触发 + 审批；**且**接收方容量核对过：按 §7.1 的"critical 实际流量 **+** ≈1×critical 重复流量"再加 3 倍余量（`receiver-requirements.md` §4） |
| 观测（48h） | 同前；**新增**接收方限流/429 观测（RR-15）：429 必须**限流而非丢弃**；`Retry-After` 存在 |
| 退出判据（逐类） | 同 Stage 1；**另加**：③ 的 `exposure_window_events` 若出现，必须有**成对端点**（缺一即数据口径故障，不是"窗口为 0"）；② `offline_evicted`（`drop_offline_evicted`）不得增长（5 MB/2000 批/7 天上限） |

### Stage 3 —— 50%

| 项 | 内容 |
|---|---|
| 机制 | `session_bucket: [0, 50)` |
| 进入判据 | Stage 2 退出判据成立 + 48h 零触发 + 审批；**且** ① 的代理指标在这三级里**没有单调变差**（若有，先查再放） |
| 观测（48h） | 同前；**新增**跨浏览器/平台的失败分列（若接入方有 `ua` 维度）：Firefox/WebKit 的 `batches_failed` 是否异常。**注意**：本仓库对这 6 格浏览器仍是 `blocked`（§6），所以这一栏在试点里是**唯一**的真实浏览器证据来源 |
| 退出判据（逐类） | 同 Stage 2；**50% 是"业务影响面过半"的关口**：业务指标（错误率、核心接口耗时、LCP/INP P75）若劣化 **>2%**，**必须回滚**而不是"继续观察"（T33 N1 判据） |

### Stage 4 —— 100%（撤掉分级）

| 项 | 内容 |
|---|---|
| 机制 | 移除 `overrides` 分级条目（或 `session_rate: 1` 全量）；`kill_switch.all` **保持禁用但通道常备** |
| 进入判据 | Stage 3 退出判据成立 + 48h 零触发 + 审批；**且**发布检查表 §13 的**全部**阻塞点有结论 |
| 观测（48h，之后进入常态监控） | 全量三类分列 + 接收方容量（峰值 2 万条/秒、3 倍余量口径） |
| 退出判据 | 48h 后无回滚触发 → **全量稳态**；此后进入 T36（试点稳定运行报告） |

**总时长下限**：4 级 × 48h = **8 天**（若启用 1%/10% 则为 6 级 × 48h = 12 天），
**不含**每次改级后的 ≥10 分钟生效确认与试点 7 天对账（T33 A2b）的并行时间。

---

## 4. 触发回滚的阈值

**回滚动作本身见** `docs/reports/release-checklist.md` §10 与 `docs/runbooks/sdk-operations.md`。
下面分三档；**所有具体数字都标了来源**：`[契约]` = 契约/决策已定的；`[建议]` = 本方案提出、
**待负责人批准**；`[代理]` = 无真实判据时的替代观测，不得写成达标。

### 4.1 立即回滚（kill switch / 配置回退，一个配置周期内，P95 ≤10 min）

| # | 触发 | 阈值 | 依据 |
|---|---|---|---|
| T1 | **隐私/同意面异常** | 任何一例"未授权却落盘/上报"、或发现未脱敏的个人信息（手机号/邮箱/身份证/银行卡/JWT/Bearer/IP） | 契约 C04-F4/F5 + T31 签发口径；**零容忍** |
| T2 | **`rejected_invalid_structure` > 0** 且可归因到本版本 | > 0 | `receiver-requirements.md` RR-01/RR-21；D-01 的教训 |
| T3 | **凭据故障**：`state=paused` 会话占比突增（401/403） | `[建议]` 相对上一级基线 >10× | 401→paused 是设计行为，突增一定是令牌/轮换问题 |
| T4 | **配置面故障** | `drop_config_signature_invalid` > 0 或 `drop_config_schema_invalid` > 0 | §3 降级表；配置本身坏掉 |
| T5 | **真实暴露窗口扩大** | `[建议]` `exposure_window_lower_bound_ms` 的窗口 P50 相对基线 >10×（**用下界，不用上界**） | CR-007 第 7 条：上界被重启速度支配，不可用于判定 |
| T6 | **传输不可用** | `[建议]` `batches_failed / (batches_sent + batches_failed)` > 5% 且持续 3 个窗口 | 熔断/终态 4xx 的可见口径（A.3 第 4 条：不得用 `sent+failed` 反推总量，但**比值可以用**） |
| T7 | **业务面** | `[建议]` 前端错误率或核心接口耗时相对基线劣化 >2%；或 LCP/INP P75 劣化 >2% | T33 N1 判据（⏳ 真实基线待 Q2） |
| T8 | **离线副本异常淘汰** | `drop_offline_evicted` 在 48h 内出现且非容量演练导致 | C07-AC-16；淘汰=真丢 |

**回滚怎么"退"**（§10.2 的要点复述）：**不能**把旧发布物原样发回去（`config_version` 单调递增）。
必须发布一个 **`config_version` 更大、内容等于上一级（或更保守）** 的新发布物；
最紧急时用 `kill_switch.all: true` 完全停采（丢弃计 `killed`），**但注意它在本页面生命周期内不恢复**。

### 4.2 暂停升级（保持当前级，不下结论也不前进）

| # | 触发 | 阈值 | 依据 |
|---|---|---|---|
| H1 | ① 代理缺口劣化 | `[代理]` `events_enqueued − events_sent` 相对同长度窗口的基线上升 >1% | ① 无真实数据（T32 缺口 1），只能用代理 |
| H2 | 重复率偏离 | `[建议]` 接收方 `duplicate_rate` 显著高于"≈1× critical"的预期且 >1 个窗口 | CR-005 的确定性成本口径 |
| H3 | ③ 端点缺一 | `exposure_window_events > 0` 但两个端点**没有同时出现** | Schema `dependentRequired`；这是**数据口径故障**，不是"窗口 0 ms" |
| H4 | ③ 窗口未捕获占比 | `[建议]` 未捕获窗口的会话占比 > 基线 + 5 个百分点——**必须记为"空白"，不得记为 0 丢失** | T32 缺口 3（WebKit 3 格就是这个形状） |
| H5 | 观测面缺失 | 某个应上报的键窗口内**连续 3 个窗口**缺失（而非值为 0） | A.3 第 1 条：键不出现＝0，但"连续缺失"要先排除上报通道故障 |

### 4.3 不得用作回滚判据的量（写下来免得被误用）

1. **任何合并后的"总丢失率"**（T32 第 1 节：三类分母语义不同，合并会**稀释** ① 的信号）。
2. **`exposure_window_ms` / `exposure_window_upper_bound_ms` 单独值**（含重启开销、被重启速度支配；
   **重启越快读数越小**，会随机器性能漂移）。两个端点必须成对引用。
3. **`commitLatencyP50Ms/P95Ms`**（重启后的新会话里恒为 `null`；它量的是优雅提交路径）。
4. **单次运行的窗口时长绝对值**（T32 §3.2：两次运行相对偏离 8%–38%，不能当分布）。
5. **`flush_skipped_due_to_budget` / `leader_lost` 当作丢失数**（它们是现象计数，不是被丢弃的事件数）。
6. **`drop_consent_denied` / `killed`** 当作丢失（这是策略与 kill switch 的预期结果）。

---

## 5. 试点基线校准（拿到 Q2 后必须补的第一件事）

本方案里所有 `[建议]` 阈值都需要**试点应用的基线**才能定案。拿到 Q2 后按顺序做：

| 步 | 动作 | 产出 | 命令/判据 |
|---|---|---|---|
| B1 | 试点应用接入并在预发布环境跑通 | T33 A1 | `node tests/pilot/00-connectivity.mjs` → 7 项 PASS（端点/令牌换成试点值） |
| B2 | 采集 **≥48h 的 A/A 基线**（不放量，原样） | 三类分列 + 业务指标的基线分布 | `sdk_health` 逐类 + `assembly.delivery.metrics()` |
| B3 | 用基线把 §4 的 `[建议]` 阈值**逐个定案**（含噪声带） | 批准后的阈值表 | 由负责人签署 |
| B4 | 连续 7 天三方对账（SDK 发送 / 双写转发 / 接收方入库，偏差 ≤1%） | T33 A2b | `node tests/pilot/10-three-leg-reconcile.mjs --repeat 3`；**腿③（双写转发）当前未接入，脚本显式不伪造** |
| B5 | LCP / INP P75 A/B 实测 | T33 N1 | 判据模板见 `t33-pilot-onboarding-kit.md` 第 5 节 |

**在 B3 完成之前，Stage 1 及以后的一级都不得发布**——没有基线的"阈值"等于事后编数字。

---

## 6. 灰度前的门禁（与发布检查表一致）

| 门禁 | 命令 | 判据 |
|---|---|---|
| 全量门禁 | `pnpm gates` | exit 0 |
| API 兼容 | `pnpm api:check` | exit 0（4 包 `ok`） |
| 契约 | `pnpm test:contract` | exit 0（9 文件 / 191 用例） |
| 安全 | `pnpm exec vitest run --project security` | exit 0（5 文件 / 33 用例）+ T31 已签发 |
| **兼容矩阵回归** | `pnpm exec vitest run --project compat` | exit 0（5 文件 / 28 用例）；矩阵仍是 **38 pass / 1 by-design / 6 blocked**，**无新 `fail`** |
| 可靠性对账 | `node tests/reliability/reconcile.mjs` | ②③ 逐格成立；**① 仍无数据**（必须如实写） |
| E2E | `pnpm test:e2e --project=chromium --project=webkit` | 🚫 **需非沙箱**；不带 `--project` 在沙箱内必红（Firefox） |
| 体积 | `pnpm size` | 4 条全部在预算内（browser 35.19/37、core 19.02/21、plugins 5.97/20、transport 15.90/18） |

**未验证浏览器集合的声明**：`blocked` 的 6 格（Firefox/WebKit/Edge/最低版本/iOS 真机/Android 真机）
正是灰度要覆盖的对象。→ **灰度放量不得早于**"至少有一轮真实浏览器（Chromium+WebKit，最好加 Firefox）
的证据"；否则等于在未验证的浏览器上放量。灰度期间**必须**按浏览器/平台分列 `batches_failed`。

---

## 7. 与任务卡验收用例的对应

| T35 验收用例 | 本方案/检查表怎么满足 | 状态 |
|---|---|---|
| 每一级放量前后的 `sdk_health` 指标和业务性能指标对比，不劣化 | §3 每级的退出判据（逐类）+ §5 的基线校准 | ⏳ 待 Q2 |
| 运维手册覆盖 kill switch / 配置回滚 / 按 SDK 版本关闭 / 令牌轮换 / 配置公钥轮换 / 紧急补丁版本，每项有演练记录（M01 或预发布） | `docs/runbooks/sdk-operations.md` 的 6 项演练步骤 + 登记表 | ⏳ 演练待 M01/预发布 |
| 版本回滚方案经过验证 | 检查表 §10.1 + runbook 演练 R-1/R-4 | 🚫 未演练（需环境） |
