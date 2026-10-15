# 变更日志

本文件记录本 SDK 在**公共 API 与契约层面**的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 semver（`docs/agent-development-guide.md` 第 4.2 节：公共 API 有任何变化都要同步更新类型声明和本文件，破坏性变更只能出现在主版本中）。

**当前状态**：所有包都是 `version: 0.0.0`、`private: true`，**尚未发布到任何源**；首个对外发布版本号由 T35（正式发布与灰度，未就绪）决定。各包的公共 API 报告在 `packages/*/etc/*.api.md`，门禁为 `pnpm api:check`。

---

## [0.1.0] — 首个对外版本（2026-10-15 定版；发布仍受发布检查表门禁，试点结果待 Q2）（工作区首个基线） — 2026-10-13

首个可审计的公共 API 基线。**本版本未发布**，不构成对接入方的可用版本承诺；能力状态与未验证项见 `docs/guides/README.md`。

### 新增

**公共 API（`@web-report-sdk/browser`，接入方入口包）**

- 入口包 `@web-report-sdk/browser`：重新导出 `@web-report-sdk/core` 的 **C01 公共 API**（55 条导出）；另产出 IIFE（`dist/web-report-sdk.iife.js`，全局变量 `WebReportSDK`，导出映射 `@web-report-sdk/browser/iife`）。
- 公共方法（12 个）：`init`、`track`、`log`、`captureError`、`setUser`、`clearUser`、`setContext`、`removeContext`、`setPage`、`setConsent`、`flush`、`destroy`；集成方法 `onEvent`、`onDiagnostics`、只读句柄 `kernel`。全部同步返回、从不抛错。
- 类型化事件：`createClient<TDictionary>()` 按事件字典做字段级类型推导（`FieldSpec` / `EventRequestOf` / `ShapeOf` 等）。
- 命令队列（上限 200，保留最早的调用，溢出计数 `command_queue_overflow`）与 `<script>` 场景的**加载桩**（队列上限 200，压缩 IIFE 1601 B / gzip 781 B，预算 1 KB）。
- 原因码常量 `API_REASON_CODES`（8 项）；常量 `COMMAND_QUEUE_CAPACITY`、`MAX_DIMENSION_VALUE_LENGTH`、`PUBLIC_METHODS`、`RESERVED_EVENT_PREFIXES`、`WEB_JS_ERROR_LIMITS`、`SDK_VERSION`、`STATE_CAPABILITY`、`STUB_BRIDGE_CAPABILITY`。

**其它模块的公共 API（合入 main，部分仍在评审中）**

- C02 内核：生命周期、六段处理管线、插件宿主、能力注册、计数器、预启动队列、全局注册表（已验收）。
- C03 配置合并/缓存/采样/kill switch：`createConfigRuntime`、`ConfigRuntimeOptions`、`verifyEnvelope`、`CONFIG_REASON_CODES` 等（评审中）。
- C06 队列与调度：`createTransportQueue`、`BatchSubmitPort` 等五组冻结交接接口（已验收）。
- C07 传输与可靠投递：`createDelivery`、IndexedDB 离线副本（事务 `oncomplete` 为唯一落盘点）、发送器、选主与补发（评审中）。
- C08 自监控与调试：`createHealthReporter`、计数/计时装饰器、`createDebugTracer`、`resolveDebugMode`（评审中）。
- C05-F5 第三方 APM 双写适配器 `@web-report-sdk/plugins`：`createApmDualWritePlugin`、`ApmDualWriteOptions`、`APM_DUAL_WRITE_PLUGIN_ID`、`APM_DUAL_WRITE_STATS_CAPABILITY` 等（评审中）。

**开发工具**

- K01 `@web-report-sdk/event-registry`（已验收）：`check` / `generate` / `export-rules` / `report-unregistered` 四个子命令；事件定义校验、critical 配额（≤10%）、按 `dictionary-compat.md` 的兼容性判定、纯类型声明生成、接收方运行期校验规则导出。
- K02 `@web-report-sdk/config-signer`（评审中）：`validate` / `sign` / `verify` / `keygen`；ES256（ECDSA P-256 + SHA-256、IEEE P1363、base64url）发布物；`config_version` 递增检查；疑似令牌扫描；支持外部签名命令（KMS），进程不接触私钥。
- M01 `@web-report-sdk/mock-receiver`（已验收）：本地 mock 接收服务，实现 `receiver-requirements.md` 的全部"必须"条目，供协议自查与集成测试。**只用于测试，不得用于生产。**

**契约与文档**

- 契约 0.2 冻结；2026-10-13 的兼容追加（**不递增文档版本号**）：CR-001 新增原因码 `prewrite_commit_lost` 与指标 `exposure_window_events`、`exposure_window_ms`；CR-002 补全 `receiver-requirements.md` 附录 A（`sdk_health` 字段与六条读数口径）；CR-003 新增原因码 `config_schema_invalid` 并明确 `sdk_versions` 的 semver 语法子集；CR-004 统一配置失败表的"生效配置"语义并把 WebCrypto 不可用显式化为唯一例外。
- 新增接入侧文档：`docs/guides/`（接入指南、工具指南、API 参考、迁移指南、接收方指南与索引）。

### 已知的未交付 / 部分实现 / 未验证（不要当成已可用）

- **装配根未交付（T18 未就绪）**：`@web-report-sdk/browser` 目前只重新导出 C01 的公共 API；C03–C08（配置、插件采集、队列与传输、自监控）**尚未接进入口包**，因此事件还不会真正发到接收方；`init` 的 `endpoint` / `token` / `env` / `release` 也不被 C01 消费。`packages/browser/package.json` 的导出映射与 `etc/browser.api.md` 是这一状态的依据。
- **C05 采集插件（error/perf/route/http）未交付**：自动采集能力尚不可用。
- **C08 的装配根接线未完成**：`calls_total`、`events_enqueued`、`queue_length_max` 与三个 p99 在接线前为 0 且不上报。
- **`K02-AC-03` 的浏览器侧验签（Playwright Chromium）属部分实现**：单测走 Node 24 全局 `crypto.subtle`（同一条 W3C 路径），Chromium 验签未执行，已移交 T29。
- **真实浏览器 E2E 未执行（T29 未就绪）**：真机 IndexedDB `oncomplete` 落盘 + SIGKILL 读回、真实信标/`visibilitychange`/多标签页接管等均未验证。
- **性能基准未执行（T20 未就绪）**：契约中的绝对指标（入队 P99 ≤0.01 ms、初始化 ≤5 ms、管线 P99 ≤0.05 ms、30 秒 ≥500 批/秒等）不进单元门禁，权威验证归 T20；单元测试只保留带文档余量的中位数回归护栏。
- **安全与隐私测试（T31）未就绪**；"离线实现不得引用 `localStorage`"目前只有一次性人工 grep，尚未固化为自动化守卫。
- **可靠性对账（T32）、试点迁移对账（T33）、正式发布与灰度（T35）均未就绪**；`critical ≤0.1%` 只在有优雅退出路径的场景成立（D003 第 1 条），硬杀场景按 D004 的**暴露窗口**分列计量，**不承诺该类场景下的丢失率**。
- **`pnpm test:e2e` 尚无用例**；CI 首次流水线运行未验证。

### 兼容性与版本策略

- 契约文档版本 0.2 与线上协议版本（URL `/v1/`、`protocol_version: 1`、`format_version: 1`）是两回事；后者决定兼容性。
- 公共 API 变更流程：修改各包 `src/index.ts` 的导出 → `pnpm api:update` 重新生成 `etc/*.api.md` → 同步本文件与 `docs/guides/` → `pnpm api:check` 通过。破坏性变更只能出现在主版本，且需在合入请求中说明。
- 原因码新增属兼容变更；删除或修改语义属破坏性变更。
- 事件 Schema 的兼容规则见 `docs/contracts/README.md`「版本与兼容规则」。

<!-- 后续版本在此之上追加，保持"最新在上"的顺序。 -->
