# POC-1（T02）投递可靠性原型

> 只用于测量，**不是正式包代码**，不参与 lint / typecheck / build / 覆盖率门禁（`poc/` 被 eslint 忽略，也不是 pnpm workspace 项目）。
> 接收端固定复用已验收的 M01（`tools/mock-receiver`，T09），POC 侧不另写 mock。

## 一条命令复现

```bash
cd <仓库根>                                  # 本 worktree：temp/wt-T02
node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs --browser all --preset full
```

结果写到 `poc/poc-1/results/<runId>/`：

- `run.json`：环境、驱动/浏览器配对、每个浏览器与场景的参数；
- `<browser>-<scenario>.json`：逐格子的原始数字（期望集合、到达数、丢失数、重复数、接收端计数增量、页内统计与 trace）；
- `run.log`：运行日志（含每格的进度与配对提示）。

Firefox 一栏需要一次非沙箱执行（Firefox 主进程的 macOS `sandbox_init()` 不能嵌套在 DSH 文件沙箱内；
**不要设置任何 `MOZ_*` 变量**，那会破坏 Playwright 的 juggler 握手，见报告「局限」第 1 条）：

```bash
bash poc/poc-1/run-firefox.sh      # 结果写到 poc/poc-1/results-firefox/
```

结果表格生成（报告里的表格就是它的输出；`--dir` 可传多个，同一浏览器取最新的那次运行）：

```bash
node poc/poc-1/tables.mjs --dir poc/poc-1/results --dir poc/poc-1/results-firefox
```

常用选项：

| 选项 | 说明 |
|---|---|
| `--browser chromium\|firefox\|webkit\|all` | 默认 `chromium` |
| `--scenario leave\|kill\|offline\|multitab\|all` | 默认 `all` |
| `--preset full\|quick` | `quick` 只用于冒烟（每格几十个事件），**报告数字一律用 `full`** |
| `--out <目录>` | 默认 `poc/poc-1/results` |
| `--driver <候选驱动 id>` | 默认按 revision 精确配对自动选择（见下） |

`full` 预设的样本量（每个浏览器）：

| 场景 | 格子 | 每格样本（每类） |
|---|---|---|
| leave | 4 个（{visibilitychange,pagehide} × {sendBeacon,fetch keepalive}）+ 2 个积压格子 | 1000 |
| kill | 9 个（page.close / context.close / browser.close / SIGKILL×{0,250,1000,2500,4000,5000}ms） | 1000 |
| offline | 2 个（同页断网恢复 / 断网刷新后恢复） | 1000 |
| multitab | 5 个（Web Locks、BroadcastChannel×3 个 settle 窗口、不选主） | 1500 critical + 1500 normal |

## 目录

| 路径 | 内容 |
|---|---|
| `run.mjs` | 入口：起 M01 与本地静态页、跑场景、落 JSON |
| `lib/register.mjs`、`lib/tsjs-loader.mjs` | 让 Node 24 直接跑 M01 的 TypeScript 源码（把 `./x.js` 说明符映射到 `./x.ts`） |
| `lib/driver.mjs` | Playwright 驱动与浏览器二进制的 **revision 精确配对**（本机缓存与仓库锁定版本不一致，见报告「环境」） |
| `lib/receiver.mjs` | 复用 M01：计数、入库事件查询、协议违规自检 |
| `lib/static-server.mjs` | 只服务 `public/`，监听 `127.0.0.1:0` |
| `lib/harness.mjs` | 持久化 context、探针页、统计读取、真·SIGKILL、补发排空 |
| `lib/scenarios.mjs` | 四个场景的实现 |
| `tables.mjs` | 从结果 JSON 生成报告用的 markdown 表格 |
| `run-firefox.sh` | Firefox 一栏的测量脚本（需非沙箱 shell；不设置任何 `MOZ_*` 变量） |
| `results/<runId>/`、`results-firefox/<runId>/` | 本报告的原始数据：Chromium + WebKit 一次运行、Firefox 一次运行；`results/run-variance.md` 是强杀落盘窗口三次运行的日志片段 |
| `public/poc-sdk.js` | 被测原型：critical 预写 + 冲刷 + 选主补发 |
| `public/probe.html` | 探针页（只加载 `poc-sdk.js`，由 Playwright 驱动 `window.__poc`） |

## 判定「丢失」的口径

事件在 Node 侧用确定性 UUID v4 生成，**以该 `event_id` 是否最终出现在 M01 的入库数据里为准**
（M01 按 `app_id` + `event_id` 去重，`events.list()` 给出入库明细）。
`lost = 期望集合 − 入库集合`，分 normal / critical 两类统计。

## 复现注意事项

- 只连本地：M01 只监听 `127.0.0.1`，静态页也是 `127.0.0.1`，不访问任何共享环境或真实网络。
- 断网场景用 `context.setOffline(true)`；断网期间页面本身用 route fulfill 从磁盘供给，
  并给 Chromium 加 `--disable-features=LocalNetworkAccessChecks`（否则 route fulfill 出来的页面
  会被判成 public→loopback 而拒绝访问 M01）。原因与影响写在报告「局限」一节。
- 强杀用真 SIGKILL：Chromium 走 browser 级 CDP 的 `SystemInfo.getProcessInfo` 取 PID，
  WebKit（以及补跑时的 Firefox）走 `pgrep` 取 PID。`killMode` 会写进结果 JSON。
- 断网口径按浏览器区分：Chromium 用 `context.setOffline(true)`；WebKit/Firefox 用「上报端点 abort」
  （Playwright 的 WebKit 在 offline 下无法导航）。实际口径写在结果 JSON 的 `offlineMode` 字段。
- 驱动与浏览器构建按 revision 精确配对，可能落到树外 `playwright-core 1.60.0`（仓库锁定的是 1.64.0，
  它要求的浏览器构建本机没有）。配对结果写在结果 JSON 的 `driver` 字段。
- 运行前会清理残留浏览器进程；被中断（Ctrl-C / 超时）时可能留下进程，重跑即可。
