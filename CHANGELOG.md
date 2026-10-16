# 变更日志

本文件记录本 SDK 在**公共 API 与契约层面**的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 semver（`docs/agent-development-guide.md` 第 4.2 节：公共 API 有任何变化都要同步更新类型声明和本文件，破坏性变更只能出现在主版本中）。

**当前状态**：四个包均已定版 `0.1.0`（`private: true`，**尚未发布到任何源**）。版本一致性由 `pnpm version:check` 守着（包清单 ×4 / `SDK_VERSION` / 产物 ×2 / 本文件 / 文档 ×4 —— 实测 `版本号一致: 0.1.0`）。**发布本身被 `docs/reports/release-checklist.md` 第 13 节的 12 条阻塞点阻断**，其中第 1 条是「①优雅退出路径丢失率零数据」。各包公共 API 报告在 `packages/*/etc/*.api.md`，门禁为 `pnpm api:check`。

**条目可追溯性**：下面每一条都给出**出处**——契约变更写 `CR-0xx`，实现与修复写**提交短哈希**（可在 `git show <hash>` 复核），报告类写文件路径。**没有"修复了若干问题"这类不可核对的条目。**

---

## [0.1.0] — 首个公共 API 基线（2026-10-13 建立；2026-10-15 定版）— 2026-10-13

**本版本未发布**，不构成对接入方的可用版本承诺；能力状态与未验证项见 `docs/guides/README.md` 与 §"已知的未交付 / 部分实现 / 未验证"。

### 新增

**公共 API（`@web-report-sdk/browser`，接入方入口包）**

- 入口包 `@web-report-sdk/browser`：重新导出 core 的 **C01 公共 API 子集**（`createClient` / `createSdk` / `createCommandQueue` / `createUuid` / `defineEventDictionary` / `truncate` / `readLocation` 与 `API_REASON_CODES`、`SDK_VERSION`、`PUBLIC_METHODS`、`COMMAND_QUEUE_CAPACITY`、`MAX_DIMENSION_VALUE_LENGTH`、`RESERVED_EVENT_PREFIXES`、`STATE_CAPABILITY`、`STUB_BRIDGE_CAPABILITY`、`WEB_JS_ERROR_LIMITS` 等常量）；另产出 IIFE（`dist/web-report-sdk.iife.js`，全局变量 `WebReportSDK`，导出映射 `@web-report-sdk/browser/iife`）。**API 报告共 60 条导出**（`packages/browser/etc/browser.api.md`）。
- **装配根 `createAssembly()` 与 `Assembly` / `AssemblyOptions` / `CollectorHandles` / `CredentialsLike` 类型（提交 `d02697a` 起，T18 装配根落地）**：把 C01–C08 接起来，使 `init → track → flush` 能真的把批次发到接收方。`AssemblyOptions` 含 `appId` / `endpoint` / `token` / `env` / `release` / `consent` / `consentMode` / `extra_mask_rules` / `sampling` / `locks` / `errorPlugin` / `httpPlugin` / `routePlugin` / `perfPlugin` / `apm` 等（**`init` 侧不消费的字段见下文"已知"**；`assembly.ts:143` 明写「`endpoint` 唯一生效的入口」是装配根）。
- 公共方法（12 个）：`init`、`track`、`log`、`captureError`、`setUser`、`clearUser`、`setContext`、`removeContext`、`setPage`、`setConsent`、`flush`、`destroy`；集成方法 `onEvent`、`onDiagnostics`、只读句柄 `kernel`。全部同步返回、从不抛错。
- 类型化事件：`createClient<TDictionary>()` 按事件字典做字段级类型推导（`FieldSpec` / `EventRequestOf` / `ShapeOf` 等）。
- 命令队列（上限 200，保留最早的调用，溢出计数 `command_queue_overflow`）与 `<script>` 场景的**加载桩**（队列上限 200，压缩 IIFE 1601 B / gzip 781 B，预算 1 KB）。

**其它模块的公共 API**

- C02 内核：生命周期、六段处理管线、插件宿主、能力注册、计数器、预启动队列、全局注册表（已验收，`228e020`）。
- C03 配置合并/缓存/采样/kill switch：`createConfigRuntime`、`ConfigRuntimeOptions`、`verifyEnvelope`、`CONFIG_REASON_CODES` 等（`62f70f8`）。
- C04 上下文、脱敏、同意管理、字段约束：`ConsentState`（含 `unknown`）、`ContextStoragePort`、`masker` 相关类型（`2ba12e6`）。
- C06 队列与调度：`createTransportQueue`、`BatchSubmitPort` 等五组冻结交接接口（已验收，`fbfccf5`）。
- C07 传输与可靠投递：`createDelivery`、IndexedDB 离线副本（事务 `oncomplete` 为唯一落盘点）、发送器、选主与补发（`005a038`）。
- C08 自监控与调试：`createHealthReporter`、计数/计时装饰器、`createDebugTracer`、`resolveDebugMode`（`51a1c56`）。
- C05 采集插件（error/perf/route/http）与 C05-F5 第三方 APM 双写适配器 `@web-report-sdk/plugins`：`createApmDualWritePlugin`、`ApmDualWriteOptions`、`APM_DUAL_WRITE_PLUGIN_ID`、`APM_DUAL_WRITE_STATS_CAPABILITY` 等（`e6a3bd9`、`62dec1d`）。

**开发工具**

- K01 `@web-report-sdk/event-registry`（已验收，`407f871`）：`check` / `generate` / `export-rules` / `report-unregistered` 四个子命令；事件定义校验、critical 配额（≤10%）、按 `dictionary-compat.md` 的兼容性判定、纯类型声明生成、接收方运行期校验规则导出。
- K02 `@web-report-sdk/config-signer`（`f18355c`）：`validate` / `sign` / `verify` / `keygen`；ES256（ECDSA P-256 + SHA-256、IEEE P1363、base64url）发布物；`config_version` 递增检查；疑似令牌扫描；支持外部签名命令（KMS），进程不接触私钥。**浏览器侧验签（K02-AC-03）仍为部分实现**。
- M01 `@web-report-sdk/mock-receiver`（已验收，`e8e1486`）：本地 mock 接收服务，实现 `receiver-requirements.md` 的全部"必须"条目，供协议自查与集成测试。**只用于测试，不得用于生产。**

**测试与门禁基础设施**

- `tests/contract/` 契约测试框架：Ajv 2020-12 双向校验（Schema 合法性 **+ SDK 真实产出**）、现场密钥签名用例、Schema-样例成对性断言、接收方样例包（`52f7ec5`、`51fcec4`）。
- `tests/bench/` 受控性能基准 harness（`47ef0c8`）。
- `tests/security/` 安全用例与 `security` vitest project（`786563e`）。
- `tests/compat/` 接入方式兼容矩阵（`6040e64`、`b169fff`）。
- `tests/e2e/` 真实浏览器 E2E（Playwright，`a409d9a`）。
- `tests/reliability/reconcile.mjs` 可靠性对账可复跑脚本（`e2cf05b`）。
- `tests/pilot/` 试点前置就绪工具链（`589abc6`）——**前置就绪验证，不是 T33 验收替代品**。
- **新增/修订的门禁**：`pnpm version:check`（`3f7082f`，本文件与包版本、`SDK_VERSION`、产物同步）；`pnpm gates` 的顺序修正为 `lint → build → typecheck → …`（`20ffb6e` 改名自 `ci`，`0ccd564` 修正顺序）。**注意 `pnpm ci` 不可用**：pnpm 11 的内置 `clean-install` 会抢占该名字，不跑门禁却返回 0。
- **新增仓库级机器守卫**：① 源码不得引用 `localStorage`（D004，AST 检测，`de1727f`）；② 截断不得早于脱敏（AST 值传递解析，`87c9e97`）；③ `tests/**` 不得 import `packages/*/src`（`87c9e97`）；④ 「声称端到端送达」的接收端必须过唯一契约校验门（D-06，`ef0cd93`）；⑤ 锚点合并残余窗口的**捕获判定护栏**（N=3/M=6，空白 ≠ 0 丢失，`1495ea8`）。

**文档**

- `docs/guides/`：接入指南、工具指南、API 参考、迁移指南、接收方指南与索引（`5c6dff9` / `a5e4bb9`）。
- `docs/runbooks/sdk-operations.md` 运维手册：kill switch / 配置回滚 / 按版本关闭 / 令牌轮换 / 公钥轮换 / 紧急补丁版本（`08d6d70`）。
- `docs/reports/`：性能基线、可靠性对账、真实浏览器 E2E、D004 硬杀护栏、兼容矩阵、安全与隐私测试、发布检查表、灰度方案（各任务交付）。
- `docs/reports/handover.md` 交接说明与其中的流程条文（含"把字段钉成常量看是否全绿"等审计手段）。

### 契约变更（CR-001～CR-010，全部为 0.2 兼容追加／澄清，**均未递增文档版本号**）

| CR | 内容 | 出处 |
|---|---|---|
| CR-001 | 新增原因码 `prewrite_commit_lost`；`sdk_health.metrics` 新增 `exposure_window_events` / `exposure_window_ms` | `CR-001`（`0ccd564`、同日补正 `9404c5f`） |
| CR-002 | `receiver-requirements.md` 追加附录 A：`sdk_health` 字段清单与六条读数口径 | `CR-002`（`5992677`） |
| CR-003 | 新增原因码 `config_schema_invalid`；明确 `sdk_versions` 的 semver 语法子集 | `CR-003`（`b70b63f`、`76419f8`、`4fee816`） |
| CR-004 | 统一配置失败表的"生效配置"语义；把 WebCrypto 不可用显式化为唯一例外 | `CR-004`（`6f7de98`） |
| CR-005 | 容量建议补入「重复 ≈ 1 倍 critical 流量」（新增 4.1 节容量估算示例） | `CR-005`（`d86d813`） |
| CR-006 | 定义链路追踪头名与注入范围（W3C `traceparent`/`tracestate`）；定义 `web_http.failure_reason` 取值集 | `CR-006`（`4208bd7`） |
| CR-007 | 澄清 `exposure_window_ms` 是暴露窗口时长的**上界**、**不得用于 SLA／容量判定** | `CR-007`（`c9c4e88`、`fba52bf`） |
| CR-008 | `sdk_health.metrics` 追加暴露窗口的**夹逼端点**与两个**观测量** | `CR-008`（`90f7141`） |
| CR-009 | 离开通道的**片大小／累计在途额度／预算字节上限**写进契约正文 | `CR-009`（`c931a73`） |
| CR-010 | 离页信标通道的**累计额度是物理约束**（实测同回合 `65536 B`）——修订 `C07-AC-03` 口径 | `CR-010`（`cdcd7f1`） |

**注意 CR-010 的状态**：已批准（2026-10-15，按负责人授权签署），**待安全/前端负责人追认**；`tests/acceptance/C07.md:9` 已按新口径加注（保留原文 + 日期化注记）。

### 修复（真实缺陷，逐条可追）

**阻断级（会静默失效或违反冻结契约）**

- `init({ location })` / `init({ pageId })` 注入非字符串（含 `null`）时，`promoteCommonFields` 会把 `common.page_id` 提升为非法值 → M01 整批 400。（**D-01**，`e6889f1`）
- 公共 API `client.onEvent()` 是**替换**语义，而装配根内部也用它接线 → 投递全部静默失效；改为新增 `EVENT_OBSERVER_CAPABILITY` 的**追加**语义，不改公共语义。（**D-02**，`e6889f1`）
- Web Locks 端口「裸调用」必现 `Illegal invocation`，且该端口从未被接通（真实浏览器才发现）。（**D-2/D-3**，`aad5105`）
- 「事件已产生、锚点未落」的窗口未被计数，违反 D004 结论第 1 条。（**D-1**，`0a9e1ac`）
- `createClient({ consent })` 被静默忽略（公共 API 选项声明了、文档写了、生产不生效）。（**D-09**，`d941e76`）
- 内核 `dispose()` 在「SDK 先装、第三方后装」时**抹掉第三方包装层**；两条路径统一为 `restoreChainIfOwned`。（`a3c9ae5`）
- `view_id` 格式校验收口：非 `$defs/uuid` 的显式值丢弃并回退自动生成，不再产出注定被拒的字段。（`8f5356d`）
- `device_id` 与 stub `event_id` 也接受未校验的外部输入（与 D-01 同形）。（`40eb874`）

**隐私／脱敏（4 处同族缺口，根因都是"截断早于脱敏"或"只截断不脱敏"）**

- `attachment` 未脱敏（错误栈走的正是 `attachment`，AC-01 要求"附带脱敏后的错误栈"）。（`e042e90`）
- `client.ts` 的 `log` / `captureError` attachment **预截断**绕过脱敏。（`1b3bbab`）
- `dimensions` 的 5 个调用点与处理器侧 `url` 路径同类；确立「处理器是唯一脱敏权威」。（`24bb96b`）
- 顶层字符串字段「只截断、从不脱敏」。（`dd323cd`）
- 按「必填 ∪ 枚举」从 Schema 推导协议字段清单并排除在脱敏之外，保护协议语义（`42829bc`）；随后把脱敏优化的内部字段（`gate`/`added`）移出公共面（`3cb1dc9`）。
- 「缓存写入时验一次即信任」：改为只存发布物本体 + 拉取/降级/304 三路共用唯一验签入口（全仓 `verifyEnvelope` 仅一处调用）。（`62f70f8`）

**行为／计数正确性**

- `offline_written` / `offline_replayed` 累加的是**事件数**而契约定义为**批次数**（看板会偏高约两个数量级）；改为批次计数，事件数另存 `offlineWrittenEvents`/`offlineReplayedEvents`。（`5b2aaec`）
- `LeaveStats.bytes` 的 per-burst 与累计口径不一致。（`5b2aaec`）
- 设备标识／会话标识「声称字段与实际字段同源」——批头声称 `device_id_persistent: true` 而存储为空、且 `device_id` 逐批漂移；根因是 `touch()` 零调用 + D-09 使 `performInit` 的 consent 守卫被跳过。（`ee2e1c0`）
- 脱敏器成本**超线性**（32→256 字符：39→135 ns/字符，约 O(n^1.6)）使 C04 富化脱敏 P99 超契约目标；加逐规则廉价前置门后恢复线性（142.6→2.3 ns/字符）。（`47ef0c8` 测出，`a9a6872` 修复）
- C02 预启动队列 500 条 = 317 KB > 256 KB 字节预算；改为按字节配额淘汰。（`a9a6872`）
- `consent.buffer()` 每次 push 全量重算字节 → **O(n²)**（4000 push ≈ 8×10⁶ 次 `sizeOf`）；改增量维护，配 128 组随机序列差分对照。（`73fe917`）
- `schema-validation.test.ts`「多实例」的运气型间歇失败（命中率≈0.06%）：内置 `cn_mobile` 偶然命中随机 uuid 末段并把 `view_id` 改成非 uuid；判据加「Schema 约束为非 PII 形态」第③条。（`73fe917`、`8f5356d`）

**"门禁里的永远绿" / "声明了但没读"（检查承不承重）**

- `reportRepeats` 有零读取点且其用例是**空转用例**；`sources`、`route.match` 同为"声明了但没读"；逐处补判别性用例并做变异验证（含一处**无效变异**被自己抓到：把同一行原样重写导致假全绿）。（`b6e8dea`、`9dbeb08`、`d26c536`）
- `VitalsAccumulatorOptions.now`、`windowMs`、`urlTemplate` 三处"读了但没人守着"：补双侧断言与变异三要素。（`d26c536`、`9dbeb08`）
- 「验证声称比结论弱」5 处（`examples/vite` 的 `test` 用 `process.exit(0)`、node-import/script-tag 走最小装配路径、`bundleEvaluated` 改真实检查、探针口径降级、接收端加 `assertNoUnparsableBatches`）。（`ccb8855`）
- 「门禁里的永远绿」①②③修复（逐条判别性证明）。（`7ad3636`）
- 指南第 8.2 节片段"看起来在验证、实际什么都收不到"（缺 `consent:'granted'`，默认 `unknown` + `essential_only` 把非必要事件全丢）。（**D-08**，`0bf7f8d`）
- 单元门禁的绝对墙钟断言（T12 遗留的 P99、以及用"总耗时"做统计量）改为中位数回归护栏，契约目标值的权威验证移交 `tests/bench/`。（`edaaaa7`、`3560c3d`、`77e67c9`）

**文档事实错误**

- T14 落地使 5 处同意状态表述过期（含两处明写「`ConsentState` 没有 `unknown`」）。（`05ae80c`）
- 指南第 4.2 节「Jest 不需要额外配置」不成立：SDK 是 ESM-only，CJS `require()` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`；口径改为"须开 ESM 模式"并记录 CJS 缺口。（`38aede6`、`09bf63b`）
- T33 发现的文档缺陷 D-03～D-05/D-07。（`9776671`）

### 兼容性与版本策略

- 契约文档版本 **0.2** 与线上协议版本（URL `/v1/`、`protocol_version: 1`、`format_version: 1`）是两回事；后者决定兼容性。
- 公共 API 变更流程：修改各包 `src/index.ts` 的导出 → `pnpm api:update` 重新生成 `etc/*.api.md` → 同步本文件与 `docs/guides/` → `pnpm api:check` 通过。破坏性变更只能出现在主版本，且需在合入请求中说明。**`api:check` 只比导出面，不比较版本号**。
- 原因码新增属兼容变更；删除或修改语义属破坏性变更。
- 事件 Schema 的兼容规则见 `docs/contracts/README.md`「版本与兼容规则」。
- **CJS 不支持是 by-design**：SDK 为 ESM-only，不提供 CJS 构建；`require("@web-report-sdk/browser")` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。（`38aede6`、`09bf63b`）
- 体积预算的历次调整（全部经负责人批准）：browser 10→13 KB（re-export 壳口径）→ **37 KB**（装配根落地后按**真实 bundle** 重推，实测 35.19→35.47 kB）；core 10→16→21 KB；transport 10→15→18 KB；plugins 20 KB；加载桩 1 KB。**预算表整体重推仍未定案**（见下文待办）。

### 已知的未交付 / 部分实现 / 未验证（不要当成已可用）

> 以下条目**改自** 2026-10-13 的初始记录：当时写「装配根未交付」「C05 插件未交付」等，**这些事实已被后续提交改变**，故此处按现状重写。

- **装配根的 `init` 侧字段仍未消费**：`endpoint` / `token` 在 core `client.ts` 内**零读取点**，消费点在装配根 `AssemblyOptions.endpoint/token`；接入方按 API 参考在 `init({ endpoint })` 里传端点会得到「零上报且不报错」。`extra_mask_rules` 同类。发布前必须裁定"修"或"在接入指南写死正确用法"。（`docs/reports/t33-access-blockers.md`、`docs/reports/release-checklist.md` 第 7 条）
- **`touch()` 在全仓 `packages/*/src` 零调用点** ⇒ `session_id` 的 30 分钟空闲轮换**从不发生**。
- **三处无判别性覆盖的读取点**：`RoutePorts.now`、`HttpPorts.now`、`PerfPorts.now`——钉成常量后 `packages/plugins` 124/124 全绿（读取点真实、注入后无断言）。只报告，未处置。
- **`K02-AC-03` 的浏览器侧验签属部分实现**：单测走 Node 24 全局 `crypto.subtle`（同一条 W3C 路径），Chromium 验签未执行。
- **①优雅退出路径的 `critical ≤0.1%` / `normal ≤1%` 无任何证据**：E2E 只做 5–7 事件功能验证，结果 JSON 无 `lost`/`lossRate` 字段。**硬杀场景的暴露窗口按条数与窗口时长计量，不承诺该类场景下的丢失率**（D004）。
- **WebKit 3 格是"空白"不是"0 丢失"**：`pending-d0`/`preflush-d0`/`preflush-small` 的 `windowCaptured=false`；且残余窗口在 WebKit 并行负载下 `prewrite_commit_lost` **少报 99%（10 vs 1000）或 100%（0 vs 1000）**。
- **Firefox / Edge / 最低版本 / iOS 真机 / Android 真机共 6 格 `blocked`**，而它们正是灰度要覆盖的浏览器。
- **性能基准未进 CI**：`tests/bench/` 只在受控本机 node 环境跑过；「4 核 + Chrome + 4× CPU 限速」口径留待复测。
- **`tests/compat/**` 不在任何 vitest project 的 include 里** → `pnpm test` 不收集它，45 格矩阵的测试证据没有被门禁守着。
- **安全与隐私测试报告内部仍有矛盾行**（正文第 149/158 行写"不签发"，签发区写"已签发（2026-10-15）"）；报告已按负责人授权签发，但**签发权不在编排方**。
- **可靠性与试点对账**：M01 侧真实浏览器计数未产出；10 万会话规模未达成；`pnpm test:e2e` 在沙箱内不带 `--project` 必然红。
- **发布与灰度未执行**：`docs/reports/release-checklist.md` 第 13 节列 12 条阻塞点（含"发布基线未冻结"——最近一次全部门禁是在含其他 lane 未提交修改的工作树上跑的）。
- **CI 首次推送未验证**；`pnpm gates:selftest` 只覆盖 4 个门禁，且本次未运行。
- **`examples/quickstart` 缺失**，任务卡"文档中的示例代码都能在 `examples/` 中运行"仍无法由现有 examples 完全证明。

<!-- 后续版本在此之上追加，保持"最新在上"的顺序。 -->
