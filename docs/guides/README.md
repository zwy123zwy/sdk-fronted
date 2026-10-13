# 接入与接收方指南（索引）

本目录是 T34 的交付物，面向两类读者：

- **接入方**（在自己的 Web 应用里引入 SDK 的一方）：[接入指南](integration.md)、[工具指南](tools.md)、[API 参考](api-reference.md)、[迁移指南](migration.md)
- **接收方**（接收 SDK 上报数据的服务，由接入方或其他团队提供）：[接收方指南](receiver-guide.md)

另见仓库根目录的 [`CHANGELOG.md`](../../CHANGELOG.md)。

## 文档地图

| 文件 | 回答什么问题 |
|---|---|
| [integration.md](integration.md) | 怎么引入（npm / `<script>`）、初始化参数怎么填、同意管理怎么做、调试怎么开、怎么自检 |
| [tools.md](tools.md) | K01 事件注册表与类型生成、K02 配置签名与托管、M01 本地联调怎么用 |
| [api-reference.md](api-reference.md) | 每个公共方法、选项、类型、常量的签名与示例；以及哪些接口**不是**给接入方的 |
| [migration.md](migration.md) | 从已有埋点/第三方 APM 迁到本 SDK 的五步流程、双写适配器配置、三方计数对账 |
| [receiver-guide.md](receiver-guide.md) | 逐条解释 `docs/contracts/receiver-requirements.md`，附可勾选的自查清单 |

## 事实来源与维护规则

本目录**不是**新的事实来源，只是对既有事实的整理。写作与复核时的取值优先级（指南第 1 节）：

1. `docs/contracts/` 下已冻结的契约（0.2）；
2. 各包由 API Extractor 生成的公共 API 报告 `packages/*/etc/*.api.md`；
3. 各包 / 各工具的 `README.md`（交接产物说明，含已裁定的口径与实测数字）；
4. `docs/decisions/` 的决策记录（D002、D003、D004、Q5–Q7）；
5. 代码（`packages/*/src/`、`tools/*/src/`）。

规则：

- 文档中的每个 API、选项、原因码、配置字段都可以在 `etc/*.api.md` 或契约里找到出处；指南不发明 API、选项、原因码或配置字段。
- 公共 API 有变化时，执行 `pnpm api:update` 更新 `etc/*.api.md`，并同步本目录与 `CHANGELOG.md`（指南第 4.2 节）。
- `docs/contracts/` 只读；发现契约与实现不一致时按指南第 7 节升级，不在文档里"圆过去"。
- 示例一律使用占位值：`app_id: "your-app-id"`、`<write_token>`、`https://ingest.example.com`。不得出现真实或形似真实的令牌、密钥、域名与个人信息。

## 能力状态总表（重要）

**先读这张表再读任何示例。** 本仓库当前处于 P5 之前：各模块已分别交付并合入 main，但**把 C01–C08 装配成可端到端上报的浏览器包这一步（T18 装配根）尚未交付**。因此本目录中的示例分成两类：

- **可立即运行**：引入方式、C01 公共 API 的调用形态、三个开发工具、接收方协议自查；
- **形态已定但尚不可端到端运行**：`init` 里的远程配置、插件采集、队列与传输、自监控计数。

| 能力 | 状态 | 依据 |
|---|---|---|
| C01 公共 API、命令队列、加载桩（T12） | 已验收（main `0c55f8c`） | `docs/tasks/board.md` T12 行 |
| C02 内核（T11） | 已验收（main `228e020`） | `docs/tasks/board.md` T11 行 |
| C03 配置合并、采样、kill switch（T13） | 已合入 main `62f70f8`，**评审中** | 同上 T13 行；`docs/reports/wave3-lanes.md` |
| C06 队列与调度（T15） | 已验收（main `fbfccf5`） | `docs/tasks/board.md` T15 行 |
| C07 传输与可靠投递（T16） | 已合入 main `005a038`，**评审中** | 同上 T16 行 |
| C08 自监控与调试模式（T17） | 已合入 main `51a1c56`，**评审中** | 同上 T17 行；且**装配根接线未完成**（见下） |
| C05 采集插件（T18：error/perf/route/http） | **未就绪**（`docs/tasks/board.md` T18 为"未就绪"） | 同上 T18 行 |
| C05-F5 第三方 APM 双写适配器（T19） | 已合入 main `62dec1d`，**评审中**；两项义务留待 T18 | 同上 T19 行 |
| **装配根：`@web-report-sdk/browser` 把 C01–C08 接起来** | **未交付**。`packages/browser/src/index.ts` 目前只重新导出 `@web-report-sdk/core` 的 C01 面，`etc/browser.api.md` 中只有 core 的符号 | `packages/browser/etc/browser.api.md`、`packages/browser/package.json` |
| K01 事件注册表与类型生成（T22） | 已验收（main `407f871`） | `docs/tasks/board.md` T22 行 |
| K02 配置签名 CLI（T25） | 已合入 main `f18355c`，**评审中**；`K02-AC-03` 的浏览器侧验签**属部分实现** | 同上 T25 行；`tools/config-signer/README.md`「未完全覆盖的验收条目」 |
| M01 本地 mock 接收服务（T09） | 已验收（main `e8e1486`）；**只用于测试，不得用于生产** | 同上 T09 行；`tools/mock-receiver/README.md` |
| 包的可安装性 | 全部包 `version: 0.0.0`、`private: true`，**尚未发布到任何源**；接入方目前只能用本地 `link:` 联调 | 各 `packages/*/package.json`；指南第 3、4.1 节 |

装配根交付后，`packages/browser` 的导出面与体积预算都需要重新推导（指南第 6 节的硬约束、看板 2026-10-13 记录）。

## 已知未验证项（截至 2026-10-13，不要当成"已通过"）

以下项目在本仓库中**未执行或只做了部分验证**，本目录所有文档都不把它们写成可用能力：

1. **真实浏览器 E2E（T29，未就绪）**：T16 的 6 项真实浏览器行为（真实 80 KB 信标、真实 `sendBeacon`、真实 `visibilitychange`、真实 3 标签页接管、真实无 Web Locks、真机 IndexedDB `oncomplete` 落盘 + SIGKILL 读回）；T13 的真实 IDB/`sessionStorage`、真实 `visibilitychange`、Chromium 验签；T17 的真实 `location.search` 解析、真实 60 秒节奏、真实控制台接线。见 `docs/reports/wave3-lanes.md` 各任务的「未执行 / 未验证」。
2. **K02-AC-03 的浏览器侧验签（Playwright Chromium）属部分实现**：单测走 Node 24 全局 `crypto.subtle`（同一条 W3C ECDSA P-256 路径），**Chromium 验签未执行**，已移交 T29。见 `tools/config-signer/README.md`。
3. **T20 性能基准未执行**：契约里的绝对指标（入队 P99 ≤0.01 ms、初始化 ≤5 ms、管线 P99 ≤0.05 ms、30 秒 ≥500 批/秒等）按仓库政策**不进单元门禁**，其权威验证归 T20（未就绪）。单元测试里只有带文档余量的中位数回归护栏。
4. **T31 安全与隐私测试未执行**；「离线实现不得引用 `localStorage`」目前只有一次性人工 grep，**尚未固化为自动化守卫**。
5. **T32 可靠性对账、T33 试点接入与迁移对账未就绪**：`receiver-requirements.md` 的端到端指标（critical 丢失率、不重复入库）只有 `critical ≤0.1%` 在**有优雅退出路径**的场景下成立（D003 第 1 条）；硬杀场景按 D004 的**暴露窗口**口径，不承诺一个丢失率。
6. **`pnpm test:e2e` 尚无用例**（T29 才启用）；CI 首次流水线运行未验证（T08 验收记录）。
7. **接收方实现不由本项目验证**（`receiver-requirements.md` 开头）：M01 覆盖全部"必须"条目，但 M01 不覆盖 RR-11（HTTPS）、RR-14（来源白名单）、RR-15（限流）。

## 术语与占位值约定

| 写法 | 含义 |
|---|---|
| `app_id: "your-app-id"` / `appId: 'your-app-id'` | 占位应用标识。契约里叫 `app_id`，公共 API 里叫 `appId` |
| `<write_token>` | 占位写令牌（只写不读，由接收方按应用签发） |
| `https://ingest.example.com` | 占位上报端点 |
| `https://config.example.com` | 占位配置端点 |
| `Txx` / `Cxx` / `Kxx` / `Mxx` | 任务编号 / 模块编号 / 工具编号，定义见 `docs/agent-development-guide.md` 与 `docs/tasks/board.md` |
