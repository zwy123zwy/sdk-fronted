# SDK 运维手册（T35 交接产物）

- 任务：T35（3 人日 / A10 本 lane）；日期 2026-10-15；版本：**草案 v0.1**
- 配套：`docs/reports/release-checklist.md`（发布检查表）、`docs/reports/release-grayscale-plan.md`（灰度方案）
- 依据：`docs/tasks/T35.md` 的验收用例（运维手册须覆盖 6 项且**每项有演练记录**，在 M01 或预发布环境）、
  `docs/contracts/remote-config.md`（§3 降级表、§5.1 kill switch、§4 签名与轮换）、
  `docs/contracts/receiver-requirements.md`（RR-12 令牌、RR-05 去重、附录 A 读数口径）、
  `docs/decisions/D001-scope.md`（分发形态）、`docs/decisions/D004-*`（暴露窗口口径）

> **🔴 本手册当前状态：6 项全部"未演练"。**
> T35 验收要求"每项有演练记录"，演练需要 M01 或预发布环境 + 一次**人工执行**的配置发布。
> 本 lane **没有**执行任何配置发布/包发布（T35 禁止事项）。→ 演练登记表见 §8，⏳ 待 M01/预发布。
> **未演练就是未演练**，不得因为"步骤写得很清楚"就记成已演练。

---

## 0. 十分钟速查（事故现场用）

| 症状 | 最可能的原因 | 立即动作 | 详见 |
|---|---|---|---|
| 接收方突然没数据 | 令牌被吊销（401 → `paused`） | 换令牌 + 接入方发版；**不要**同时吊销旧令牌 | §4 |
| 上报量骤降但 SDK 无异常 | 命中 `kill_switch.all` 或 `sdk_versions` | 查 `sdk_health.metrics.killed` / `drop_killed`；发布新配置解除 | §1、§2 |
| 只有某几个 SDK 版本没数据 | `kill_switch.sdk_versions` 命中 | 发布新 `config_version` 收窄范围 | §2 |
| 配置改了不生效 | 生效 P95 ≤10 分钟；或 `config_version` 未递增 | 等 ≥10 分钟；查 `dimensions.config_version`；查 `config_*` 原因码 | §2、§3 |
| 配置被拒 | 签名/版本/作用域/格式 | 查 `drop_config_signature_invalid` / `config_version_stale` / `config_scope_mismatch` | §3 |
| 重复流量翻倍 | 离开时刻补发（≈1× critical，**确定性成本**） | 检查接收方 RR-05 去重是否在跑；**不要**关补发 | §5 |
| 看板"窗口"读数很大 | 读错了字段 | 用**成对端点** `lower ≤ W ≤ upper`；上界**不得**用于 SLA | §6 |
| 需要紧急修 SDK | —— | 走 §7 的补丁版本流程 | §7 |

**三条绝对不能做**：
1. **不能**靠"推送一份坏配置"来停采（CR-004：除 WebCrypto 不可用这一唯一例外，"拒绝配置"一律
   **保持当前生效配置**）。停采只能用 `kill_switch.all`。
2. **不能**把旧发布物原样发回去做回滚（`config_version` 单调递增，会被 `config_version_stale` 拒）。
3. **不能**手动清 IndexedDB 离线副本（回滚后旧版还要靠它补发；去重由接收方做）。

---

## 1. 演练 D1：kill switch（全局停采）

**目标**：验证 `kill_switch.all: true` 能在 P95 ≤10 分钟内让 SDK 停止采集与上报，且计数正确。

**机制**（`remote-config.md` §5.1）：
- `kill_switch.all: true` → SDK 进入"已销毁"状态、释放所有监听；**同一页面生命周期内不恢复**（刷新页面才复位）。
- 生效后丢弃的事件计 `killed`（契约指标 `drop_killed` / `killed`，见 `reason-codes.md` 第 24 行）。
- 走的是普通配置通道（签名发布物 + 拉取/可见性触发 + 缓存 5 min）→ **生效 P95 ≤10 分钟**。

**步骤（M01 演练版）**：

```bash
# 0) 准备：一份 P-256 密钥对（K02；私钥不进仓库）
node tools/config-signer/dist/cli.js keygen --out /tmp/t35-drill-key.json     # 产出 key_id + 私钥文件 + 公钥 JWK
# 1) 起 M01（托管发布物；端口自选）
pnpm --filter @web-report-sdk/mock-receiver run build
node tools/mock-receiver/dist/cli.js --port 8787 --config-file /tmp/t35-config-v1.json
# 2) 取基线：SDK 正常跑，记录 sdk_health 的 events_enqueued/events_sent 与接收方 received_events
# 3) 用 K02 签一份 kill_switch.all=true 的发布物（config_version 必须 > 当前生效版本）
node tools/config-signer/dist/cli.js sign --key-file /tmp/t35-drill-key.json --in /tmp/t35-config-kill.json --out /tmp/t35-envelope-kill.json
# 4) 人工发布：替换 M01 托管的发布物（预发布环境里由负责人发布到静态资源服务）
curl -s -X POST http://127.0.0.1:8787/__mock/config -H 'content-type: application/json' \
  --data-binary @<({"app_id":"<app>","env":"<env>","envelope":$(cat /tmp/t35-envelope-kill.json)})>
# 5) 等 ≥10 分钟（或触发页面重新可见），确认 SDK 侧生效
```

**通过判据**：
1. 发布后 ≤10 分钟内，新窗口的 `sdk_health` 停止上报（`dimensions.config_version` 先变成新号，随后不再有新窗口）；
2. 接收方 `received_events` 落到 0；`stored_events` 不再增长；
3. `drop_killed`（`killed`）计数**出现且 ≥1**，与"停止上报前窗口内被丢弃的事件数"可比；
4. 释放监听可验证：页面不再产生自动采集事件（路线/性能/错误插件静默）；
5. **同一页面生命周期内不恢复**：等待 ≥2 个拉取周期（≥10 min），确认没有自行恢复。

**回滚（解除 kill switch）**：发布 `config_version` 更大的、`kill_switch.all: false` 的发布物；
**已 kill 的页面必须刷新**才会恢复（同一生命周期内不恢复是设计行为）。

**演练记录**：见 §8（⏳ 未演练）。

---

## 2. 演练 D2：按 SDK 版本关闭（`kill_switch.sdk_versions`）

**目标**：验证"只关掉某个版本区间"能精确命中目标版本、且**不误伤**其他版本。

**机制**（§5.1 + CR-003 的 semver 子集）：`sdk_versions` 支持
精确版本 / `>` `>=` `<` `<=` / 合取（空格）/ 析取（`||`）/ `^` / `~` / 通配（`1.2.x`、`1.x`、`*`）。
**明确不支持**（出现即整份配置 `config_schema_invalid`、拒绝该配置并退回保守默认，**不得静默忽略**）：
连字符区间（`1.2.3 - 2.0.0`）、范围表达式里的预发布标识（`>=1.2.3-beta.1`）、以及未列出的任何语法。
**这一条很关键**：一条**无法求值**的 kill switch 规则若被静默当作"不命中"，等于**该关的没关**。

**步骤**：
1. 造两个版本的 SDK 页面（本版本 + 上一版本），或在同一页面注入两个 `SDK_VERSION` 的构建产物；
2. 发布 `kill_switch.sdk_versions: [">=<目标版本> <<目标版本+1>"]`（精确到目标区间）；
3. 观察两个版本各自的 `sdk_health` 是否按预期停/不停。

**通过判据**：
1. **命中版本**：停止上报 + `drop_killed` 计数出现；
2. **未命中版本**：完全不受影响（**必须有一格对照**——没有对照就等于没验证判别力）；
3. `config_version` 生效确认（≥10 min）；
4. **负向用例**：故意发一条连字符区间（`1.2.3 - 2.0.0`）→ 必须计 `config_schema_invalid`、
   **拒绝整份配置**、且**保持当前生效配置**（CR-004 通则），不得静默忽略。

**演练记录**：见 §8（⏳ 未演练）。

---

## 3. 演练 D3：配置回滚（含 `config_version` 单调性）

**目标**：验证"把配置退回到上一级内容"能在一个配置周期内生效，且**不违反单调递增**。

**最容易被写错的一点**：**不能**把旧发布物原样发回去（`config_version_stale` 会拒绝）。
正确做法：**发布一个新的 `config_version`（更大），内容等于上一级（或更保守）的配置**。

**步骤**：
1. 记录当前生效的 `config_version = N` 与内容摘要；
2. 发布 `N+1`（新一级，如放量 20%）；
3. 需要回滚时，发布 `N+2`，内容 = `N` 的内容（人工核对内容等价，而不是"复制旧文件"）；
4. 观察 `dimensions.config_version` 是否从 `N+1` 变为 `N+2`。

**通过判据**：
1. `dimensions.config_version` 变为 `N+2`，且**功能语义等于 `N`**（放量比例、开关、采样率逐项核对）；
2. 回滚过程中**不得**出现 `drop_config_version_stale` 累积（它是"有人试图覆盖回旧版本号"的信号）；
3. 回滚期间采集不中断（除非本来就要停采——那时用 kill switch）；
4. **不得**把 `config_signature_invalid` 当成回滚成功的证据（那是签名坏了，不是回滚成功）。

**演练记录**：见 §8（⏳ 未演练）。

---

## 4. 演练 D4：令牌轮换后的 SDK 行为

**目标**：验证令牌轮换不造成采集空洞，且吊销后 SDK 行为正确（`paused` + 离线副本保留 + 恢复后补发）。

**机制**：`token` 在初始化时由接入方传入（装配根 `AssemblyOptions.token`，**不是** `init({token})`——
见下方"已知坑"）。接收方按 RR-12 只写不读、可吊销；吊销后返回 401。

**步骤**：
1. 接入方发版：新令牌写入初始化参数（**新旧令牌在接收方并存**）；
2. 观察 48h：**不要**在此期间吊销旧令牌（否则重叠窗口内会 401）；
3. 观察期过后在接收方吊销旧令牌；
4. 观察旧令牌客户端的 SDK 行为。

**通过判据**：
1. 轮换期间**无采集空洞**：`received_events` 无台阶式下跌；
2. 旧令牌被吊销后：SDK 进入 `paused`（`state=paused` 出现），**离线副本不丢**（`offline_written` 的批次仍在）；
3. 换到有效令牌后：补发发生（`offline_replayed` 增长），接收方 `stored_events` 追平；
4. **重复流量符合预期**：补发会产生 `duplicate_events`（≈1× critical），由 RR-05 去重吸收。

**⚠ 已知坑（必须先看，否则演练会得到假失败）**：
- `init({ token })` / `init({ endpoint })` 会被**静默忽略**（`t33-access-blockers.md` D-09 节末表）。
  令牌与端点只能在**装配根** `createAssembly({ endpoint, token, ... })` 里给。
- `flush()` **不返回 Promise**（同步返回 `undefined`）；查计数前必须**轮询直到非 0 并设超时**（D-07）。

**演练记录**：见 §8（⏳ 未演练）。

---

## 5. 演练 D5：配置公钥轮换

**目标**：验证新旧公钥并存期间，两边签名的发布物都能验签成功；且篡改必然失败。

**机制**（§4）：`config_public_keys` 由接入方在**初始化参数**传入（SDK 不内置公钥）。
轮换顺序：**先发布"新旧公钥并存"的接入方页面 → 再切签名私钥**；**旧公钥至少保留 30 天**。

**步骤**：
1. 接入方发版：`config_public_keys` 同时含 `key_id_old` 与 `key_id_new`；
2. 先用 `key_id_old` 签一份发布物 → 验签必须成功；
3. 切到 `key_id_new` 签 → 验签必须成功；
4. 构造篡改（改 `payload` 1 字节 / 改 `signature`）→ 必须 `config_signature_invalid`；
5. 构造未知 `key_id` → 必须 `config_signature_invalid`。

**通过判据**：
1. 并存期内两个 `key_id` 都能验签成功；
2. 篡改/未知 `key_id` → 计 `drop_config_signature_invalid`，**保持当前生效配置**（CR-004 通则），
   **不得**退回保守默认（唯一例外是 WebCrypto 不可用）；
3. 缓存路径也必须重新验签（T13 的返工点：缓存只存发布物本体，拉取/降级/304 三路共用同一验签入口）——
   演练时**必须**包含一次 304/缓存命中场景，否则验不到这条；
4. 旧公钥保留期满 30 天后再移除，移除前确认线上已无旧 `key_id` 的发布物。

**演练记录**：见 §8（⏳ 未演练）。

---

## 6. 演练 D6：紧急发布补丁版本（patch）

**目标**：验证从"发现缺陷"到"补丁版本上线并可回滚"的最短路径是**可执行的**，且每一步都有证据。

**步骤（人工的用 🧑 标出）**：

| # | 步骤 | 命令/判据 |
|---|---|---|
| 1 | 定位缺陷 + 影响面（哪些 `sdk_version`、哪些浏览器） | 按 `dimensions.sdk_version` + `ua` 分列 |
| 2 | 判定是否要**立即停采** | 若是隐私/同意/数据正确性 → **先 `kill_switch.sdk_versions` 定向关闭该版本**（§2），再修 |
| 3 | 修缺陷 + 补**失败先行的断言级用例** + **变异验证三要素** | 指南第 6 节；handover 第 4 节第 6 条 |
| 4 | 全量门禁 | `pnpm gates` exit 0（§1 检查表） |
| 5 | 版本号 + CHANGELOG + `api:check` | `pnpm api:check` exit 0；版本一致性自检（检查表 §3.3） |
| 6 🧑 | 发布补丁版本到渠道 | 人工审批 + 人工执行 |
| 7 🧑 | 解除定向关闭（发布新 `config_version`） | 确认目标版本已升级 |
| 8 | 观察 48h | 灰度方案 §3 的逐类退出判据 |

**通过判据**：
1. **从发现到"定向关闭生效"≤ 1 个配置周期（≤10 分钟）**——这条是补丁流程真正的 SLA，
   因为代码修复可能要几小时/几天，而停采只需要一份配置；
2. 补丁版本的门禁与契约证据齐全（**不得**用"紧急"当跳门禁的理由）；
3. 定向关闭解除后 48h 内无回滚触发；
4. 全过程有发布记录（交接产物）。

**回滚补丁版本**：走检查表 §10.1（重新发布上一版产物 + 接入方改引用）；**不要**改
`packages/*/etc/*.api.md` 让 `api:check` 变绿。

**演练记录**：见 §8（⏳ 未演练）。

---

## 7. 常态监控与告警建议

| 监控项 | 来源 | 建议告警 |
|---|---|---|
| 三类分列（**不得合并**） | `sdk_health.metrics` + 接收方计数 | 见灰度方案 §4 |
| 采集覆盖 | `events_enqueued` vs `events_sent`（**代理**） | 相对基线劣化 >1%（`[建议]`，待基线定案） |
| 传输健康 | `batches_failed`、`drop_circuit_open`、`state=paused` | 比值 >5% 持续 3 窗口（`[建议]`） |
| 离线存储健康 | `offline_written` / `offline_replayed` / `drop_offline_evicted` | 出现淘汰即查（5 MB / 2000 批 / 7 天上限） |
| 配置健康 | `config_version`、`drop_config_*` 各码 | 任何 `config_signature_invalid` / `config_schema_invalid` 都要看 |
| 去重健康 | 接收方 `received − stored === duplicate_events` | 恒等式破坏 = 计费/对账口径故障 |
| 自监控分片 | 同 `window_ms` + 同 `dimensions` 的多条 = 同一窗口 | 聚合规则错了会把一个窗口算成多份（A.4） |

---

## 8. 演练登记表（**每项都必须有一行，未演练的写"未演练"**）

| # | 演练 | 环境 | 执行人 | 日期 | 结果 | 证据（日志/截图/产物路径） |
|---|---|---|---|---|---|---|
| D1 | kill switch（全局停采） | M01 或预发布 | — | — | **未演练** | — |
| D2 | 按 SDK 版本关闭（`sdk_versions`，含负向用例） | M01 或预发布 | — | — | **未演练** | — |
| D3 | 配置回滚（发更大 `config_version`） | M01 或预发布 | — | — | **未演练** | — |
| D4 | 令牌轮换 + 吊销后 `paused`/补发 | M01 或预发布 | — | — | **未演练** | — |
| D5 | 配置公钥轮换（含 304 缓存命中场景） | M01 或预发布 | — | — | **未演练** | — |
| D6 | 紧急补丁版本（含"≤10 分钟定向关闭"） | 全流程 | — | — | **未演练** | — |
| D7 | **版本回滚方案**（T35 验收用例单独要求"经过验证"） | M01 或预发布 | — | — | **未演练** | — |

**为什么全部未演练（如实登记）**：
1. 本 lane 的可写范围是文档；执行配置发布/包发布属 T35 禁止事项（"由人工审批并由人执行"）；
2. `kill_switch` / 公钥轮换 / 令牌轮换的完整演练需要**签名发布物 + 静态资源托管**，
   在预发布环境才有意义；M01 只是本地装置（不做真实鉴权与签名校验，不得作为生产参考实现）；
3. 演练还需要 §3 的试点基线（⏳ Q2）才能判定"是否劣化"。

**拿到环境后的执行顺序**：D1 → D3 → D2 → D5 → D4 → D7 → D6（先学"怎么停"，再学"怎么退"，
最后做综合的紧急补丁流程）。
