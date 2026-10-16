# 本次会话交付报告（2026-10-13 ～ 2026-10-16）

- 面向读者：**负责人**。编写日期：2026-10-16；工作目录 `/Users/spirit-ai/Desktop/sdk`（直接在 `main` 上工作）。
- 本报告**不是文件清单**。每一条状态都给出可点击的**证据路径**，并注明它**能不能支撑验收**。
- **编写时工作区有多条 lane 在跑**（见 §3.4），因此**本次没有运行 `pnpm gates`**。报告里引用的门禁数字来自**已有提交的原文**，不是本次实跑。

**这份报告的口径声明（先说清我是怎么得出"12 项"的）**：提交 `8001544` 的原文写了「**12 项任务的关键证据文件全部在 HEAD 里**（逐个 `git cat-file -e HEAD:<path>` 核实）」，但**它没有逐项列出编号**。下表里我按「`git log` 在 2026-10-13～2026-10-16 窗口内出现交付 / 合入 / 状态变更记录，且当前看板仍为评审中/进行中/受阻/已交付」的口径**重建**了这 12 项，并逐项给出证据路径。**这是重建，不是原文抄录**。
> **2026-10-15 编排方修正（权威清单）**：本目标（goal）的 12 项为
> **T14、T18、T20、T29、T30、T31、T32、T33、T34、T35、T36、T37**——
> **不含 T19**（T19 属早于本窗口的既有交付），**含 T14**（C04 上下文/脱敏/同意）。
> 本报告初稿按 git 窗口重建时**误纳 T19、漏 T14**，已更正（详见下表第 2 行）。
> 其余各节的证据路径**均经实核存在**，更正成员编号不牵动它们。

---

## 1. 交付总览（12 项，逐项状态 + 证据 + 能否验收）

| # | 任务 | 一句话交付 | 当前状态 | 证据路径（相对本文件） | 现在能不能验收 |
|---|---|---|---|---|---|
| 1 | **T18** C05 采集插件 + 装配根 | 四个采集插件 + `createAssembly()` 把 C01–C08 接成能真的上报的入口 | **评审中（插件与装配根均已合入）** | [board.md](../tasks/board.md)（T18 行）、[assembly.ts](../../packages/browser/src/assembly.ts)、[handover.md](handover.md) 第 1 节（8 项接线义务） | **不能**：① 装配根已落地但 `init({endpoint/token})` 零读取点（L-10）；② 指南 8 处"装配根未交付"表述是否全部同步未复核；③ 整张体积预算表未定案 |
| 2 | **T14** C04 上下文 / 脱敏 / 同意 | `packages/core/src/privacy/{mask,mask-rules,constraints,protocol-fields}.ts`、`context/{consent,session,header,page}.ts` （**本会话在此域修掉 6 处真实缺陷**：脱敏同族 4 处「截断早于脱敏」「顶层字段从不脱敏」「attachment 未脱敏」「client 预截断」、协议字段保护（从 Schema「必填 ∪ 枚举」推导 `event_id`/`event_name`/`event_type`/`priority`/`level`/`view_id`）、设备/会话标识「声称⇔实际」同源） | **评审中（已合入 main）** | [mask.ts](../../packages/core/src/privacy/mask.ts)、[constraints.ts](../../packages/core/src/privacy/constraints.ts)、[protocol-fields.ts](../../packages/core/src/privacy/protocol-fields.ts)、[board.md](../tasks/board.md)（T14 行）、[t33-access-blockers.md](t33-access-blockers.md) §11（脱敏读取点全量审计） | **可验收**：脱敏同族 4 处各有判据与变异验证；协议字段清单有**两侧漂移锁定**（读真 Schema 重算）；读取点审计达 **34 探针 / 34 红 / 0 绿**（边界见 §3.2） |
| 3 | **T20** 性能基准 | `tests/bench/` 受控基准 + 基线报告；**实测出 2 处真实不达标并已修** | **评审中** | [client-bench-baseline.md](client-bench-baseline.md)、[tests/bench/README.md](../../tests/bench/README.md) | **不能**：口径是"本机 node"而非卡上"4 核 + Chrome + 4× 限速"（已裁定接受，权威复测留 T29）；**未进 CI** |
| 4 | **T29** 真实浏览器 E2E | D004 核心承诺在真实实现上首次证实；抓到并修了 3 处真实缺陷 | **评审中** | [e2e-real-browser.md](e2e-real-browser.md)、[e2e-d004-hardkill.md](e2e-d004-hardkill.md)、[durability.spec.mjs](../../tests/e2e/durability.spec.mjs) | **不能**：WebKit 修复后未复跑、Firefox 未跑、bfcache 与真实 `QuotaExceededError` 未覆盖 |
| 5 | **T30** 兼容性测试 | 45 格矩阵（38 pass / 1 fail-by-design / 6 blocked）+ 真实 Chromium 核心路径 | **评审中** | [compat-matrix.md](compat-matrix.md)、[matrix.json](../../tests/compat/results/matrix.json) | **不能**：6 格 blocked 正是灰度目标浏览器；`tests/compat/**` 直到 `aa9f5fb` 才真正进入 HEAD 的门禁 project |
| 6 | **T31** SDK 安全与隐私测试 | `security` project 5 文件/33 用例全绿；两条机器守卫；报告已签发 | **已验收（2026-10-15 签发）** | [security-draft.md](security-draft.md)、[tests/security](../../tests/security)、[board.md](../tasks/board.md)（T31 行） | **可以（有保留）**：报告正文第 149/158 行仍写"未签发/不签发"，与签署区矛盾（L-06）；遗留 `touch()` 零调用 |
| 7 | **T32** 可靠性对账测试 | 三类分列对账 + 可复跑 `reconcile.mjs`；**更正了编排方两处错误陈述** | **评审中** | [reliability-reconciliation.md](reliability-reconciliation.md)、[reconcile.mjs](../../tests/reliability/reconcile.mjs) | **不能**：① 优雅路径零数据；② M01 侧真实浏览器计数未产出；③ 报告 §3 生成区指纹与产物脱节（L-05） |
| 8 | **T33** 试点接入与迁移对账 | 不需 Q2 的部分：就绪盘点、`tests/pilot/**` 工具链、接入方清单/模板、Q2 交接函、9 步顺序 | **进行中（9 条中 5 条已做，余 4 条待 Q2）** | [t33-readiness.md](t33-readiness.md)、[t33-pilot-onboarding-kit.md](t33-pilot-onboarding-kit.md)、[t33-access-blockers.md](t33-access-blockers.md)、[tests/pilot](../../tests/pilot/00-connectivity.mjs) | **不能**：缺 2 个试点应用的真实业务事实；`tests/pilot/**` 是**前置就绪验证，不是验收替代品** |
| 9 | **T34** 接入指南 / API 参考 / 迁移 / 接收方指南 | `docs/guides/` 6 份 + 首个 CHANGELOG；本窗口内修掉它带来的过期表述与文档缺陷 | **评审中** | [guides/README.md](../guides/README.md)、[api-reference.md](../guides/api-reference.md)、[integration.md](../guides/integration.md)、[migration.md](../guides/migration.md) | **不能**：3 项待办（含"`init({endpoint/token})` 用法必须写死或修"——属发布阻塞点 7） |
| 10 | **T35** 正式发布与灰度放量 | 发布检查表（可复跑命令+判据+实跑+反证）+ 灰度方案 + 运维手册 | **已验收（2026-10-15 交付）** | [release-checklist.md](release-checklist.md)、[release-grayscale-plan.md](release-grayscale-plan.md)、[sdk-operations.md](../runbooks/sdk-operations.md) | **可以（作为"发布前要跑什么"的清单）**；**发布本身不能**：§13 实列 **12 条**阻塞点（看板与材料包写"10 条"——见 §3.5） |
| 11 | **T36** 试点稳定运行报告 | **尚未产出**：需要全量放量后连续两周的试点运行数据 | **受阻（不可压缩的日历时间）** | [T36.md](../tasks/T36.md)、[acceptance-package/README.md](../acceptance-package/README.md) 第 7 节（D-1～D-11） | **不能**：数据不在本项目内；依赖 T33 实跑 → 需 Q2 |
| 12 | **T37** 终验材料与变更日志 | 终验材料包 63 条（7 维度）+ `0.1.0` CHANGELOG 从真实历史补全 | **进行中（不依赖试点数据的部分已完成）** | [acceptance-package/README.md](../acceptance-package/README.md)、[verify-links.mjs](../acceptance-package/verify-links.mjs)、[CHANGELOG.md](../../CHANGELOG.md) | **不能**：终验结论需 T36 数据；**它自己如实报出"性能维度证据最薄"**（见 §3.1） |

**可验收的只有 2 项**（T31、T35），且都带保留项。其余 10 项要么缺外部数据、要么缺 clean 基线复跑。

### 1.1 本报告引用的每个数字，以及我的核实方式

| 数字 | 值 | 我的核实方式（可复跑） |
|---|---|---|
| 最新一次**有原文数字**的可信门禁结果 | `pnpm gates` **exit 0 —— 164 文件 / 1582 用例**（提交 `aa9f5fb`） | `git show -s --format=%B aa9f5fb` |
| 终验材料包分布 | 7 维度 / **63 条 = 已完成 33 + 待试点数据 13 + 待签字 17**；本地证据链接 **118** | 实跑 `node docs/acceptance-package/verify-links.mjs`（脚本自己现算并与总览逐格比对） |
| 材料包反证 | 脚本自报 **3/3**（`NEGATIVE_CASES` 长度 = 3） | 同上（脚本输出末行） |
| 契约变更数 | **10 条**（`CR-001`～`CR-010`），全部为 0.2 兼容追加/澄清 | `ls docs/contracts/changes/` |
| CHANGELOG 里的提交短哈希 | **74 个**去重哈希（任务书说"约 70 个"） | `grep -oE '`[0-9a-f]{7}`' CHANGELOG.md \| sort -u \| wc -l` |
| 兼容矩阵 | **45 = 38 pass + 1 fail（by-design CJS）+ 6 blocked** | [compat-matrix.md](compat-matrix.md) 第 2 节 |
| 发布阻塞点 | §13 **实列 12 条**（正文点名的编号 1..12） | [release-checklist.md](release-checklist.md) 第 665 行起 |
| 契约缺陷类数（我归纳） | **5 类**（阻断级 / 隐私脱敏 / 计数与行为 / "门禁里的永远绿" / 文档与账目） | [CHANGELOG.md](../../CHANGELOG.md) 的「修复」段分组 |
| 体积余量（browser） | 预算 37 KB，最新记录实测 **35.47 kB → 余量 1.53 kB** | CHANGELOG「兼容性与版本策略」段；提交 `56aa8b3` |
| "零绿点"审计 | 钉常量法 **34 探针 → 34 红 / 0 绿** | `git show -s --format=%B 99d420b` |

---

## 2. 本会话发现并修复的真实缺陷

**归纳为 5 类**（来源：[CHANGELOG.md](../../CHANGELOG.md) 的「修复」段，每条都能 `git show <hash>`）。每类给 1～2 个代表，并写清**如果不修，在生产里会怎样表现**。

### 2.1 阻断级：静默失效 / 违反冻结契约

| 代表 | 现象 | 不修的生产表现 | 证据 |
|---|---|---|---|
| **D-01** `common.page_id: null` | 不调 `setPage` 时把 `null` 提升为 `common.page_id`，而冻结契约要求 `string`（非 required，合法做法是**该键不出现**） | 接收方按结构非法**整批 400 拒收** → 接入方"接好了但库里恒为 0"，且**不报错** | [t33-access-blockers.md](t33-access-blockers.md) D-01 节（含真实批次 + Ajv 校验 + M01 `invalid_structure` 原文）；提交 `e6889f1` |
| **D-02** `client.onEvent()` 是**替换**语义 | 装配根内部也用它接线，于是公共 API 一被调用就**替换掉内部观察者** | 接入方调一个文档里的公共方法，**全部投递静默失效** | 同上「D-02」；修法是新增 `EVENT_OBSERVER_CAPABILITY` 追加语义，**不改公共语义**（有锁定该语义的既有用例） |
| **D-09** `createClient({ consent })` 被忽略 | 公共 API 选项声明了、文档写了，**生产不生效** | 接入方以为已授权全量采集，实际同意门把非必要事件**全丢**（表现为"接了没数据"） | 提交 `d941e76`；[security-draft.md](security-draft.md) |
| **Web Locks（D-2/D-3）** | `LockManager.request` 裸调用必现 `Illegal invocation`；且该端口**全仓零调用点**（路径不可达） | 多标签页选主在真实浏览器里**必现报错**；修好①也没用，因为②从没接线 | [e2e-real-browser.md](e2e-real-browser.md)「D-2/D-3」节（含变异三要素与复测 7 passed） |
| **D-1** "事件已产生、锚点未落"的窗口**不计入暴露窗口** | 违反 D004 结论第 1 条 | `prewrite_commit_lost` **少报**——看板看到的是"没丢"，实际丢了 | [e2e-d004-hardkill.md](e2e-d004-hardkill.md)（修后 `preflush-d0` 1 → 1000、`preflush-small` 1 → 100） |

> **这一类为什么最贵**：它们**全都不报错**。D-01/D-02/D-09 的共同形态是"声明了但不生效"，只在**按冻结契约校验的接收方**面前才暴露——所以它们逃过了 45 格矩阵、T29 与全部 examples。

### 2.2 隐私与脱敏：4 处同族缺口 + "单一脱敏权威"收口

| 代表 | 现象 | 不修的生产表现 | 证据 |
|---|---|---|---|
| `attachment` 未脱敏 | 错误栈走的正是 `attachment`，而它**只按 8 KB 截断**；同一事件里 `dimensions.message` 的 JWT 已变 `Bearer ***`，`attachment` 里的手机号与 JWT **原样** | **接入方的用户手机号/令牌被原样上报到接收方**——隐私条款问题，不是偏好问题 | [board.md](../tasks/board.md) 2026-10-13 T18→C04 缺陷行；提交 `e042e90` |
| `log`/`captureError` 预截断绕过脱敏；`dimensions` 5 处与处理器侧 `url` 同类 | 根因统一是"**截断早于脱敏**"或"只截断不脱敏" | 长字符串（恰好最容易含 PII 的那部分）**只被截断、从没被脱敏** | 提交 `1b3bbab`、`24bb96b`、`dd323cd` |
| 契约"缓存写入时验一次即信任" | 缓存只存 `body`、**没有签名/发布物**；拉取/降级/304 三路读缓存都不验签 | **IndexedDB 对同源脚本可读写** → 被篡改的配置会被直接采用（改采样率、关隐私开关） | 提交 `62f70f8`：改为只存发布物本体，全仓 `verifyEnvelope` **仅一处调用**，补 5 条篡改用例 |

### 2.3 计数与行为正确性

| 代表 | 现象 | 不修的生产表现 | 证据 |
|---|---|---|---|
| `offline_written`/`offline_replayed` 累加**事件数**而契约定义是**批次数** | 单位不符 | 接收方看板这两个指标**系统性偏高约两个数量级**——看板数字看着有数、其实量错了东西 | 提交 `5b2aaec` |
| 设备/会话标识"**声称与实际不符**" | 批头声称 `device_id_persistent: true` 而存储**根本没有该键**；`device_id` 由 `header.ts` 现场兜底生成，实测**连续 3 次 `header()` 得到 3 个不同 device_id** | **已授权接入方的设备标识逐批漂移** → 设备维度去重/统计全部失效，而字段还标着"已持久化" | 提交 `ee2e1c0`；[board.md](../tasks/board.md) 2026-10-15 定向诊断行（定性为实现缺陷，未回退隐私修复去骗绿） |
| 脱敏器成本**超线性**（约 O(n^1.6)） | 32→256 字符耗时 ×27.6（39→135 ns/字符）→ C04 富化脱敏 P99 0.0312/0.0370/0.0610 ms **超过契约 0.03** | 脱敏在**每条事件的热路径**上且**不能跳过**：单值上限 256 字符时，每条事件都超预算 | [client-bench-baseline.md](client-bench-baseline.md)；修后 142.6→2.3 ns/字符、P99 0.0053–0.0168 |
| C02 预启动队列 500 条 = **317 KB > 256 KB**（生产上界形态 650 B/条） | 计条数约束不了字节 | 预启动阶段（SDK 尚未初始化）**内存超预算**；修法是按字节配额淘汰（255.8 KB / n=403） | 同上；提交 `a9a6872` |
| `consent.buffer()` 每次 push 全量重算字节 → **O(n²)** | 4000 push ≈ 8×10⁶ 次 `sizeOf` | 同意缓冲量大时**主线程被拖住**（表现为卡顿/超时），曾被误判为"flaky 抖动" | 提交 `73fe917`（128 组随机序列差分对照 + 变异对照证明逐条等价，1537 ms → 9 ms） |
| `view_id` / `device_id` / stub `event_id` 接受未校验外部输入 | 产出注定被拒的字段（违反 `$defs/uuid`） | 与 D-01 同形：接收方**整批拒收** | 提交 `8f5356d`、`40eb874` |

### 2.4 "门禁里的永远绿" / "声明了但没读"（检查承不承重）

| 代表 | 现象 | 不修的生产表现 | 证据 |
|---|---|---|---|
| `reportRepeats` **零读取点**，且它的用例是**空转用例** | 字段声明了、用例存在、但**改坏也没人知道** | 门禁给的是**假安全感**：绿 ≠ 被守住；后续重构可以静默删掉行为 | 提交 `b6e8dea`（含一处**无效变异**被自己抓到）、条文 [handover.md](handover.md) §10.7 |
| `VitalsAccumulatorOptions.now`、`windowMs`、`urlTemplate`、`RoutePorts.now`/`HttpPorts.now`/`PerfPorts.now` | **读了但没有任何判别性断言**；钉成常量后用例**仍全绿** | 同上 | 提交 `d26c536`、`9dbeb08`、`374af75`、`99d420b`；`34 探针 → 34 红 / 0 绿` |
| `examples/vite` 的 `test` 是空脚本（`process.exit(0)`）；node-import/script-tag 的 `build` 同类；`browserCheck` 把 `skipped` 算 `pass`；`--passWithNoTests` 让 **0 用例也 exit 0** | "验证声称比结论弱" | **门禁里的检查根本没跑却在报绿**——发布判定会直接踩空 | 提交 `ccb8855`、`7ad3636` |

### 2.5 文档与账目事实错误（"谁改变了事实，谁负责同步"）

| 代表 | 现象 | 不修的生产表现 | 证据 |
|---|---|---|---|
| 指南两处明写「`ConsentState` **没有** `unknown`」 | T14 落地后即为**错的事实** | **接入方照错误的文档写代码**——错误的文档比没有文档更危险 | 提交 `05ae80c` |
| 指南 8.2 节片段"看起来在验证、实际什么都收不到"（缺 `consent:'granted'`，默认 `unknown` + `essential_only` 把非必要事件全丢） | 片段不报错但 `seen` 恒为 0 | 接入方**以为验证通过** | **D-08**，提交 `0bf7f8d` |
| 指南第 4.2 节「Jest 不需要额外配置」不成立（ESM-only，CJS `require()` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`） | 口径与实现相反 | 接入方 CJS 工程**照文档接必失败** | 提交 `38aede6`、`09bf63b`（口径改为"须开 ESM 模式"） |
| 指南体积表 **37 KB 改一处漏一处** | 同一处错误**第二次**发生 | 审阅者按指南判断体积余量会得到错误结论 | 提交 `56aa8b3` |
| 看板 **5 行状态滞后**（T31/T33/T35/T36/T37 仍写"未就绪/进行中"） | 看板是**向负责人汇报进度的账目** | 负责人**据错误账目判断项目状态** | 提交 `8001544`（附逐行依据与证据路径） |
| **`compat` project 未提交却已宣布"已进门禁"** | 修复只存在于工作区；`git show HEAD:vitest.config.ts` 里**没有** `compat` project | 任何按 HEAD 检出的环境（含 CI）**都不运行 `tests/compat`** → D-06 那道"接收端必须过契约校验"的守卫**在 main 上从未在守** | 提交 `aa9f5fb`（"本笔之后 HEAD 才与工作区一致"） |

---

## 3. 诚实边界（本节最重要）

> 这一节回答的是："**这份交付报告不能证明什么**"。凡本报告没有实测的，一律写"未运行/未核实"，**不写成"已通过"**。

### 3.1 材料包自己报出的"证据最薄"（原文出处：提交 `56aa8b3` §⑤、[acceptance-package/README.md](../acceptance-package/README.md) 第 6 节）

材料包 `63 条`里的 **33 条"已完成"，含义是"证据路径存在 + 报告自述 + 可复跑脚本存在"，不是"本包重跑了每个测试"**。T37 自己如实报出的最薄处：

- **最薄的是性能维度**：`P-01`～`P-06` 的"已完成"**只意味着"装置与数字已记录"，没有一条是本机复现的**。
  - `P-06`（覆盖率阈值）：只核实了 [vitest.config.ts](../../vitest.config.ts) 里**阈值存在**，**未复现任何覆盖率数字**；
  - `P-05`/`P-03`/`P-04`（体积与性能达标）：只核到 [.size-limit.json](../../.size-limit.json) 与基准报告存在；**browser 余量仅约 1.5 kB（35.47 / 37 KB）几乎贴线**；
  - `P-01`/`P-02`（基准）：`tests/bench/` **未进 CI**，数字只在**单机 node 环境**测过（无浏览器、未限速、同机另有编译/门禁在跑）。
- **其余"已完成"同样只是"文件在"**：`K-03`/`K-04` 的证据是**目录存在**（未复现"是否覆盖每个 Schema"）；`C-01`/`C-04` 只核到 [matrix.json](../../tests/compat/results/matrix.json) 存在，**未重跑矩阵、未逐格核 45 格**；`S-01`～`S-04` 同理。
- 材料包**不声明终验通过**——按 T36 卡，结论由项目发起人在 M8 给出。

### 3.2 T37 的"零绿点"边界表述（**必须原样继承，不得简化成"实现正确"**）

本会话最有价值的一句结论，也最容易在转述里被夸大：

> **"零绿点"仅表示：在当前用例集下，这 34 个读取点每一个都至少有一条能被"钉常量"打死的断言**，
> 即 **"注入值 / 返回值确实有人在守"**；
> **不等于实现正确**——钉常量法**不覆盖**：**契约语义 / 边界取值 / 时序竞态 / 契约-实现一致性错误**，
> **也不覆盖探针清单之外的读取点（清单本身是人工枚举的）**。
> —— 原文见提交 `99d420b`（结果：**34 探针 → 34 红 / 0 绿**）

**换成人话**：这只能说明"**改坏了会被抓住**"，不能说明"**没改坏**"。特别是：钉常量法**测不出**
"契约写的是 A、实现做的是 B，而用例也按 B 写"这类**契约-实现一致性错误**。

### 3.3 未进 CI / 未进本地门禁的检查

核实方式：`package.json` 的 `gates` 链 + [vitest.config.ts](../../vitest.config.ts) 的 4 个 project + [.github/workflows/ci.yml](../../.github/workflows/ci.yml)。

| 检查 | 是否进本地 `pnpm gates` | 现状 |
|---|---|---|
| `tests/bench/**` 基准 | **否** | 它有自己的 `tests/bench/vitest.config.ts`，root `pnpm test` 的 `unit`/`contract`/`security`/`compat` **都不收集它**；`gates` 链里也无 benchmark 步骤 |
| 真实浏览器 E2E（`pnpm test:e2e`） | **否** | `gates` 链里没有它。CI 配置里有一个独立 `e2e` job，**但 CI 首次推送未验证**；且沙箱内不带 `--project` 的 `pnpm test:e2e` **必然红** |
| `pnpm gates:selftest` 整链 | **否** | `gates` 链里没有它；它本身也只覆盖 **4 个**门禁（`lint`/`typecheck`/`size`/`api:check`），`examples:build`/`examples:test`/`test:contract`/`test:e2e` **无自检**；本次**未运行** |
| `version:check` | **是**（在 `gates` 链内） | 但 **CI 配置里没有这一步**——CI 与 `gates` 的步骤集不一致，且 CI 的 `build` 顺序与指南/`gates` **相反** |

### 3.4 本报告编写时**未跑门禁**——以及最新一次可信门禁结果是什么

- **为什么没跑**：编写时**工作区有多条 lane 在跑**（本次会话的并发环境：`gate-selftest` 扩面、`leave-slice` 跳过可见化、compat 产物幂等、3 条负载敏感用例）。它们在途的**变异中间态与未提交改动会让门禁结果不可信**——跑出来的绿/红都无法归因。**这正是发布检查表第 12 条阻塞点**（发布基线未冻结）。
- **当时的实测证据**（我在编写时读取的 `git status`，证明确实有在途写入，未做任何写操作去"清理"它）：
  `scripts/gate-selftest.mjs`（另有未跟踪的 `packages/core/src/__gate_disable.ts`、`scripts/__gate_selftest_falsify.mjs`）、
  `eslint.config.js` 与 `tests/e2e/leave-slice.spec.mjs`（另有未跟踪的 `tests/e2e/lib/skip-audit*.mjs`、`tests/e2e/proof-eslint-skip.spec.mjs`）、
  `tests/compat/results/*.json` **6 个**（产物 churn，**不是缺陷**）。
- **最新一次有原文数字的可信门禁结果**：提交 **`aa9f5fb`**（2026-10-16 16:32），原文：

  > **验证**：`pnpm gates` **exit 0 —— 164 文件 / 1582 用例**（该数字**本就包含 compat**，因为工作区一直带着这个改动；**本笔之后，HEAD 才与工作区一致**）。

  可复核：`git show -s --format=%B aa9f5fb`。
  **注意两点（不要把上面这行读成"发布可放行"）**：① 它是**工作树**结果，不是 clean 基线结果；② 它之后的两笔提交（`8001544`、`d83e76c`）是**看板与交接文档**改动，**没有重跑门禁**。

### 3.5 我在交叉核对中另外发现的口径不一致（如实登记，不改别人的文件）

| 不一致 | 两处说法 | 我的处理 |
|---|---|---|
| 材料包反证数 | 脚本输出是 **3/3**（`NEGATIVE_CASES` 长度为 3，见 [verify-links.mjs](../acceptance-package/verify-links.mjs)）；看板与提交 `56aa8b3` 写"**反证 4/4**"（又说"预置 3 条 + 现场注入 2 条"） | **以脚本实测为准：3/3**；另有 2 条人工现场注入（README 第 6 节有记） |
| browser 体积余量 | 材料包 `P-05` 写 **35.19 kB / 余量 1.81 kB**（那是 `a23b508` 抬高预算时的量）；最新记录是 **35.47 kB / 37 KB → 余量 1.53 kB**（提交 `56aa8b3`） | 两者都能追到提交，但**1.81 kB 不是最新值**；本报告采用 **1.53 kB** |
| 发布阻塞点条数 | 看板 T35 行与材料包 `A-06` 写"**10 条**"；[release-checklist.md](release-checklist.md) 第 13 节**实列 12 条** | **按 12 条读**（材料包第 6 节自己也提示了这一点） |
| 安全报告自相矛盾 | 第 149/158 行仍写"未经签发/不签发"，签署区写"已签发（2026-10-15）" | 已登记为 `L-06`，**发布前必须清掉**；不影响"已签发"这一事实本身 |
| 对账报告指纹脱节 | 报告 §3 写 `454fbb9008176f86`，现文件是 `88ca1e9c49dc0f61`；`--compare` 判定"同一份被测实现：**否**" | 已登记为 `L-05`；**结论未变**（判定列逐格相同），但**发布记录不得引用已无法回指的指纹** |

---

## 4. 阻塞与所需

### 4.1 Q2：缺的是**真实业务事实**，逐字段列出（不得编造）

来源：[Q2-pilot-apps.md](../decisions/Q2-pilot-apps.md)（状态"**待确认**"，**结论表为空**）、[acceptance-package/README.md](../acceptance-package/README.md) 第 7 节 `D-8`。

| 字段 | 缺什么 | 谁提供 |
|---|---|---|
| **试点应用名（2 个）** | 建议一个**内部工具类**（UC-04）+ 一个**对外应用**（UC-01/02/07）；**现在没有任何名字** | 负责人确认（确认人栏写 `wenye.zhang`） |
| **应用负责人** | 每个应用一名 | 同上 |
| **前端对接人** | 每个应用一名（要能改代码、能跑 `tests/pilot/**`） | 同上 |
| **预发布环境** | 可部署、可访问 M01/接收方的环境地址 | 同上 |
| **现有埋点清单（如有）** | 用于迁移对账；没有则写"无" | 试点应用方 |

- **时间**：记录写明**需在 M0（2026-10-30）前确定**，否则触发 R07 风险；卡上最晚 **2026-12-21**。
- **拿到后怎么用**：T33 的**余 4 条**（试点接入双写、连续 7 天三方对账、LCP/INP、试点报告）即可开工；`tests/pilot/**` 工具链**已实测可跑**（`00` 7 项 PASS、`10 --repeat 3` 偏差 0.0000%、`20` 对 M01 PASS 7/FAIL 0），**给出应用名即可立刻跑**。
- **一处必须说清的边界**：`tests/pilot/**` 是**试点前置就绪验证，不是 T33 的验收替代品**（原文见 [t33-readiness.md](t33-readiness.md) §0.1）。
- **附带缺口**：`tests/acceptance/` 下**没有 T33 对应的验收文件**——T33 的验收依据是"Q2 决策 + 试点对账数据"还是"本应有验收文件而它缺失"，**待负责人裁定**（[board.md](../tasks/board.md) 2026-10-14 行）。

### 4.2 T36：两周放量数据（谁提供、拿到后怎么用）

来源：[acceptance-package/README.md](../acceptance-package/README.md) 第 7 节 `D-9`、[T36.md](../tasks/T36.md)。

- **缺什么**：**连续两周**的 `sdk_health` 汇总数据，至少要能逐指标判达标——
  ① 内部异常数；② **按原因码的丢弃率**；③ 主线程长任务；④ 体积。
- **谁提供**：**试点团队导出**（**看板不在本项目内**）+ 接收方对接人。
- **拿到后怎么用**：写出 **`docs/reports/stability-*.md`**（T36 唯一新增文件），**逐指标**判"连续两周达标"；把 `D-1`～`D-11` 逐条置为"已关闭/仍阻塞"；再回材料包把对应条目的 `待试点数据` 改成 `已完成` 或保留——**改状态时必须同时补上新的证据路径**（材料包的 `verify-links.mjs` 会核）。
- **为什么"不可压缩"**：即使今天确定 Q2，也要先**接入** → 再**全量放量**（[release-grayscale-plan.md](release-grayscale-plan.md)：5% → 20% → 50% → 100%，**每级观察 48 小时**）→ 再 **+14 天**。**这是日历时间，不能用任何 agent 压缩。**

### 4.3 非沙箱宿主 / 需要真人或真机的项

| 需要的项 | 为什么本仓库做不到 | 归属 |
|---|---|---|
| **Firefox / Edge / 最低版本 / iOS 真机 / Android 真机（6 格）** | Firefox 主进程**无法在 DSH 沙箱内嵌套启动**；真机不在本会话 | `D-6`（[compat-matrix.md](compat-matrix.md)） |
| **WebKit 3 格窗口捕获复跑** | 沙箱内 WebKit 存储测量不可靠（沙箱曾**静默阻塞 WebKit 的 OPFS 写入**，导致"OPFS 在 WebKit 不可用"的错误结论）；命令 `pnpm test:e2e --project=webkit` | `D-3` |
| **Chromium 里 K02 发布物验签** | **浏览器侧验签实现不存在**（当前只有 Node 侧），需先补实现才能端到端验 | `D-7` |
| 真实 `QuotaExceededError` | 真实配额 Chromium 10.7 GB / WebKit 20.6 GB，构造耗尽不现实 | [e2e-real-browser.md](e2e-real-browser.md) |
| **优雅路径丢失率 N≥10⁵** | `tests/e2e/lib/d004-run.mjs` **不能复用**（每格都以 SIGKILL 结束）→ 需**新写** harness + 非沙箱会话 | `D-1`（发布阻塞点 1） |

---

## 5. 方法论产出（本会话最可复用的部分）

### 5.1 流程条文 10.6～10.9 / 10.8b 各解决了什么（原文：`handover.md` 第 4 节）

| 条文 | 解决的**具体**问题 | 关键做法（可执行） |
|---|---|---|
| **10.6** | 本会话有 **4 条**用例被怀疑是"抖动"；排查后真相是 **1 条 O(n²) 实现缺陷 + 1 条"运气型"间歇失败（命中率≈0.06%）+ 2 条真·重负载敏感**——**把实现缺陷误判成"环境噪声"会掩盖真缺陷** | ① 先确认机器空闲（`loadavg` + `pgrep -lf node`）；② 空闲复现不出时用**两个并发 vitest**构造受控负载；③ **长期留存门禁日志**（那条运气型失败是靠**从留存的 `/tmp/gates-*.log` 里找回 `instancePath: /events/0/view_id`** 才定位的）；④ **门禁不与重任务并行跑** |
| **10.7** | "声明了但没读"与"读了但没人守着"两类盲区 | ① 静态核对每个 `*Options` 字段的读取点；② 探针给 true/false 两组输入看输出是否逐字相同；③ **钉常量法**——把字段钉成常量，**全绿 ⇒ 该字段没有判别性覆盖**（它比①更进一步：①只能发现"没读"，③能发现"改坏也没人知道"）；④ 反面检查：判据**必须同时有开启/关闭两侧** |
| **10.8** | **同一 brief 派给两条 lane**：`send_message` 会**重新启动已结束的 agent**，紧接着又派新 lane → 两个写入者同时改同一批文件 | 危害三条：可写清单不同会写到对方范围外；并发 vitest/tsc **互相污染回归结论**；**最严重**——变异验证要临时改同一实现文件，两人并发变异互相覆盖 → **`sha256` 不可能一致 ⇒"变异三要素"这个证据本身失效**。规矩：追加工作与派新 lane **二选一**；派工前确认上一条同 brief 的 lane 已停；**执行方提并发告警应立即裁决** |
| **10.8b** | 编排方**在写下 10.8 之后、同一会话内又犯一次**：派 compat 幂等 lane 时**仍写"本轮只有你一条 lane"**，而当时**有 4 条** | 后果实测：① 它依赖的 `examples/webpack/scripts/lib/verify-bundle.mjs` 被另一条 lane 的**变异中间态**覆盖 → `pnpm examples:build` **失败过一次**（`sdkVersionMatchesPackage: false`），**是并发污染而非真实门禁失败**；② **"跑完 gates 后 `git status` 为空"这个验收标准，在多 lane 并行时不可判定**。**可执行版规矩**：派工前**逐条列出在跑的 lane 及其可写范围并写进提示词**；若验收标准依赖工作区干净，**派工时即改判**为"机制 + 判别性证明"，真树复核由编排方在**独占工作区**时做 |
| **10.9** | **无效变异会给出全绿假信号**（本会话由执行方**自己**抓到） | 实例：把 `:56` **原样重写了一遍** → **全绿**，看起来像"该检查不承重"；改成真正不同的 `const base = COEXISTENCE_DEFAULTS;` 后 **2 红**。**⇒ 绿有两种含义：① 该检查真的不承重；② 你的变异根本没改到东西。两者必须区分。** 规矩：变异后**必须确认实现文件确实变了**（`git diff` 非空 / sha256 变化）；**同一读取点要做两个口径的变异**——"**不调用**"与"**调用了但不用返回值**"（会被不同的断言打死） |

### 5.2 本会话被纠正的错误（**包括编排方自己的**——知道"哪些结论曾经是错的"是这份报告价值的一部分）

| # | 曾经的结论 | 真相 | 谁纠正的 |
|---|---|---|---|
| 1 | 「**9 格全部** `reconciles=true`」 | **错**：Chromium 9/9，**WebKit 只有 6/9**；那 3 格是**空白（`windowCaptured=false`）不是 0 丢失** | T32 执行方核原始 JSON 后更正；编排方的原句是**转述未经核实**就写进了提交信息 |
| 2 | 「**4 个 C08 原因码**是待补的契约缺口」 | **不准**：那 4 个码**已由 CR-001 明确裁定"不新增"**；真正缺的是**观测量 / `replayed` 的发出点** | 同上（T32） |
| 3 | 「**本轮只有你一条 lane**」（模板句） | 第一次说时实际有 3 条，第二次说时实际有 **4** 条 | 第一次由"验证声称"lane 质疑；第二次由 compat 幂等 lane **逐秒采样 `git status`** 抓出，**两次都拦下了真实污染** |
| 4 | 编排方称「T33 卡里有一条**回落条款**」（试点不用某些插件时改在 `examples/` 验证） | **该文字不在 T33 卡**（全文 38 行）；真实出处是 [Q2-pilot-apps.md](../decisions/Q2-pilot-apps.md) 的「**如果结论与建议不同**」一节，是**条件条款**；Q2 待确认 ⇒ **当前不是生效授权** | T33 执行方核实后**停下来问**，未擅自扩大范围；编排方撤销该引用 |
| 5 | 编排方判「T18 任务卡过期」（按 `C05.md` 的 AC 编号总数） | **原卡一直是对的**（第 3 行写明 AC-01..14/19/20 属 T18）——**是编排方的"修正"错了** | T18 执行方读文件时发现，已回退（`a312c47`） |
| 6 | 「compat 已进门禁」「看板状态是最新的」「体积表已改完」 | **`compat` project 从未提交**；**看板 5 行滞后**；**体积表改了一处漏一处** | 编排方自查后更正（`aa9f5fb`、`8001544`、`56aa8b3`）。**共同形态：局部动作完成后，未核对持久状态是否真的变了** |
| 7 | T17 的"测试先行"证据 | 补跑只得到 `Failed to resolve import`，**证明不了断言本身有判别力** | 编排方确立"变异验证三要素"作为替代标准 |
| 8 | 单元门禁的 perf 护栏 | 编排方自己用"**总耗时**"做统计量，与 T12 遗留的绝对 P99 同族 | 改为中位数回归护栏，契约目标值权威验证移交 `tests/bench/` |
| 9 | 「OPFS 在 WebKit 上不可用」 | 真相：**沙箱静默阻塞了 WebKit 的 OPFS 写入**（每次 `resolved=false`），被误判成引擎限制 | 已撤回并改非沙箱运行（`b631ae9`） |
| 10 | AC-03 第 3 步据以决策的「`delay0-21x4` 被接受」 | `beacon-quota-driver.js` 的 `yieldToBrowser('timeout')` **是死代码**（`plan()` 只调 `'raf'`）→ 实际测的是 **rAF 而非 `setTimeout`**；`setTimeout(0)` 首次实测**第 3 片被拒** | 执行方如实标注（提交 `fe085ec`） |

---

## 6. 接手入口（新会话第一句该读什么）

**按顺序读这 5 份，不要先读代码**：

1. **[handover.md](handover.md)** —— 唯一入口。含：当前状态、T18/T16/T17 的接线义务、以及**第 4 节的流程条文 10.5～10.9 / 10.8b**（本会话最贵的产出）。
2. **[board.md](../tasks/board.md)** 的「**阻塞与升级记录**」表尾 —— 约 30 条裁定、义务、更正，逐条有处置与状态。**接手前通读。**
3. **[acceptance-package/README.md](../acceptance-package/README.md)** —— 63 条终验材料（33/13/17）+ **第 7 节 `D-1`～`D-11`**（缺什么 / 谁提供 / 拿到后怎么用）。自证命令：`node docs/acceptance-package/verify-links.mjs`。
4. **[release-checklist.md](release-checklist.md) 第 13 节** —— **12 条发布阻塞点**（前 3 条是"发布判定不得被写成通过"的硬阻断）。
5. **本报告 `delivery-report.md`** —— 12 项交付总览 + **本会话被纠正的 10 处错误**。

**开工前必做（用真金白银换来的三条）**：

1. **确认机器空闲**（`loadavg` + `pgrep -lf node`），**且确认当前在跑哪些 lane、各自可写范围**——不要再用"本轮只有你一条 lane"这种模板句（条文 10.6 / 10.8b）。
2. **新工作树先 `pnpm build` 再 `pnpm gates`**（`gates` 链是 `lint → build → typecheck → test → size → api:check → version:check → examples:build → examples:test`）。
3. **发布判定必须在 clean 基线上重跑 `pnpm gates`**——不要引用任何脏树上的绿（发布阻塞点 12）。

**最后一句**：本会话所有的麻烦都来自"**把检查通过当成事实正确**"。读本报告时请**优先读第 3 节**——它写的是我们**没有**证明什么。

