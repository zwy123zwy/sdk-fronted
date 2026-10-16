# T29 真实浏览器 E2E（`tests/e2e/`）

> 本目录是 `pnpm test:e2e`（即 `playwright test`，`playwright.config.ts` 的 `testDir`）的用例来源。
> T29 之前这里是空的，所以该命令一条用例都没跑。

## 一条命令

```bash
pnpm test:e2e --project=chromium --project=webkit   # 本机沙箱里可跑的两个引擎
pnpm test:e2e --project=firefox                     # 需要非沙箱 shell（见「环境阻塞」）
node tests/e2e/lib/d004-run.mjs --browser chromium  # 不经 Playwright，直接看逐格原始数字
```

## 环境解析（`lib/browsers.mjs`）

仓库锁定 `@playwright/test@1.64.0`，它期望 chromium-1248 / firefox-1555 / webkit-2370，**本机没装**。
本机装的是 chromium-1208/1223、firefox-1522、webkit-2287。解析顺序（不下载、不安装）：

1. `PW_<NAME>_EXE`（如 `PW_CHROMIUM_EXE=/path/to/binary`）显式指定；
2. 树外只读 `playwright-core`（`/Users/spirit-ai/.npm/_npx/.../playwright-core`，1.60.0）
   与已装构建 **revision 精确配对**（默认，`E2E_DRIVER=exact`）；
3. 仓库驱动 + 本机最新构建（`E2E_DRIVER=repo` 可强制）。

实测结论：**仓库 1.64.0 驱动只能带动 chromium**；对 webkit-2287 报
`Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled`，对 firefox-1522 报
`Protocol error (Browser.setDefaultViewport)`。因此默认走「精确配对」的 1.60.0 驱动，
结果 JSON 里 `driver.id` 会写明实际驱动。

## 环境阻塞（不伪造、不静默跳过）

| 浏览器 | 状态 | 缺什么 / 补测步骤 |
|---|---|---|
| chromium | ✅ 可跑 | — |
| webkit | ✅ 可跑（存储测量也通过；见下） | 每个格子后必须清理辅助进程（`lib/harness.mjs` 已做） |
| firefox | ⛔ 本机沙箱内**阻塞** | Firefox 主进程的 macOS `sandbox_init()` 无法嵌套在 DSH 文件沙箱里，`launchPersistentContext` 卡在 juggler 握手直到超时。**补测步骤**：在非 DSH 沙箱的会话里跑 `pnpm test:e2e --project=firefox`；**不得设置任何 `MOZ_*` 变量**（会破坏握手）。 |

`firefox` project 在本会话**不会被静默跳过**：`leave-slice.spec.mjs` 用**运行时真启动探测**
（能起来就跑）判定，起不来才逐条 `skip` 并把真实报错打进输出/HTML 报告；随后**跳过审计**
（`lib/skip-audit.mjs`）会因为这批用例"一条都没跑"而在 `afterAll` **判红** —— 所以
`pnpm test:e2e --project=firefox` 在本机是**红的**（红的原因是环境阻塞，不是用例失败），
语义与上表一致，也不影响 `pnpm gates`（`gates` 本来就不包含 `test:e2e`）。
若负责人希望默认命令在沙箱里保持绿色，需要改门禁配置（`playwright.config.ts` 加 `testIgnore`
或改 `test:e2e` 脚本）——那属于门禁配置变更，需批准。

### 跳过可见性（跳过不可能静默）

- **逐条**：每条跳过都要经 `lib/skip-audit.mjs` 登记真实原因；旁路来的跳过（在 spec 里写死
  `.skip`）由 `afterEach` 判红，`.mjs` 用例里的 `.skip` 也被 eslint 拦（`eslint.config.js`）。
- **run 级数字**：Playwright 在**每个失败用例后会重启 worker 进程**，所以 `afterAll` 会被调用多次、
  每次只看得见自己那一段（实测 `--project=chromium` 6 条 3 红 ⇒ 4 段：executed 2/1/1/2）。
  每次调用落一份 JSON 到 `test-results/skip-audit/`，**run 级判定**要另外跑
  `node tests/e2e/lib/skip-audit-summary.mjs`（把各段相加；`--allow-partial` 只用于 `--grep` 聚焦跑）。
- **判据自检**（确定性、不用浏览器）：`node tests/e2e/lib/skip-audit-selftest.mjs`。

## 目录

| 路径 | 内容 |
|---|---|
| `durability.spec.mjs` | D004 核心承诺（硬杀落盘）的 Playwright 入口（Chromium/WebKit 均通过） |
| `real-browser.spec.mjs` | 真实浏览器项（APIs/信标/XHR/401/选主/pagehide 等）；C1 为 D-2 缺陷的红灯 |
| `lib/browsers.mjs` | 驱动/浏览器解析（见上） |
| `lib/skip-audit.mjs` | 跳过审计：唯一跳过入口 + 旁路跳过判红 + 每次 `afterAll` 的汇总/JSON |
| `lib/skip-audit-summary.mjs` | run 级汇总与判定（把各 worker 段的 JSON 相加） |
| `lib/skip-audit-selftest.mjs` | 上面两组判据的确定性自检（`node` 直接跑） |
| `lib/static-server.mjs` | 只服务白名单目录的 127.0.0.1 静态服务器 |
| `lib/receiver.mjs` | 本地接收端（202 / 401 / 永不响应 三个端点） |
| `lib/harness.mjs` | 持久化 context、真 SIGKILL、按 profile 的进程清理、结果落盘 |
| `lib/d004-run.mjs` | D004 逐格测量器（也可 `node` 直接跑） |
| `lib/smoke-browsers.mjs` | 冒烟：`node tests/e2e/lib/smoke-browsers.mjs all` |
| `probes/durability.html`、`probes/durability-driver.js` | 页内探针：驱动**真实实现** `packages/transport/dist`（单包 build 产物） |
| `results/d004-<browser>.json` | 逐格原始数字（含实际驱动、二进制、实现产物 sha256） |

## 两个必须知道的坑（本会话实测）

1. **强杀 WebKit 不能只杀 `pw_run.sh`。** 它只是 shell 包装，真正的浏览器是
   `.../webkit-2287/Playwright.app/Contents/MacOS/Playwright` 及其 XPC 辅助进程；
   只杀包装脚本会让事务在「强杀」之后继续提交，落盘数字全部虚高。
   `lib/harness.mjs` 现在**在启动后立刻记下本 profile 的 PID**（`profilePids`）并直接 SIGKILL，
   不走 `pgrep` 扫描 —— 既精确又低延迟（并行负载下 `pgrep` 的开销足以让 WebKit 的事务先提交完）。
2. **进程清理必须按 profile，不能按浏览器构建目录。** 按构建目录（`.../ms-playwright/<name>-<rev>/`）
   `pgrep` 会杀掉**并行 worker** 里同一浏览器的实例，表现为莫名其妙的 `Target closed`
   （本会话实测：webkit 的 durability 用例杀掉了另一个 worker 的浏览器）。
   每个格子/用例都有唯一 `user-data-dir`，`profilePids(dir)` 不会误伤。
   `killStaleBrowsers(executablePath)`（按构建目录扫全部）只在手工清理残留时使用，
   不要在用例里调用。
3. **先验证「窗口是否真的被捕获」再报落盘率。** 小 load（100 批）在 WebKit 上提交可能快于
   Playwright 的往返，Δt=0 的对照组也会 100% 存活 —— 那不是「未 oncomplete 也持久」，
   而是根本没在 oncomplete 之前杀掉。判据见 `windowCaptured`
   （来自重启后的 `prewrite_commit_lost > 0`）；`bulk-d0` 在未捕获时会自动加大负载重试。
4. **重启打开必须与首次打开用同一组 `limits`。** 否则大负载会被默认 `maxBytes=5 MB` 淘汰，
   把「SDK 主动淘汰」误判成「硬杀丢失」（本会话据此一度误判 WebKit 事务非原子）。
   `lib/d004-run.mjs` 在重启时若发生淘汰会直接判本次测量无效并抛错。
