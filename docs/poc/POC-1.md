# POC-1 投递可靠性

- 对应任务：T02（POC-1 投递可靠性）
- 执行 Agent / 对接负责人：A04 投递 / 前端负责人（结对）
- 日期：2026-10-12
- 需求编号：C07-F1、C07-F5、C07-F6、C07-F7（可行性验证）
- 契约：`docs/contracts/ingest-protocol.md` 0.2（已冻结）

## 目标与判定标准

验证假设：**「critical 事件预写到本地离线副本 + 页面离开时冲刷 + 之后补发」的方案，能否在页面离开、浏览器强杀、断网、多标签页四类场景下达到可靠性目标。**

达标阈值（任务卡 T02）：

| 类别 | 目标丢失率 |
|---|---|
| critical | ≤ 0.1% |
| normal | ≤ 1% |

另外三项对比要求：

1. 信标（`navigator.sendBeacon`）、`fetch` keepalive、`visibilitychange` 冲刷、`pagehide` 冲刷四条路径的对比；
2. Web Locks 与 BroadcastChannel 两种选主方式在多标签页下的**重复补发率**；
3. 四类场景 × 三种浏览器**各至少 1,000 次**，分 normal / critical 统计。

## 环境

| 项 | 值 |
|---|---|
| 机器 | Apple M4，10 核；macOS 26.6.2（Darwin 25.6.0，arm64） |
| Node.js | v24.16.0（原生类型剥离，直接跑 M01 的 TypeScript 源码） |
| 接收端 | **M01 `@web-report-sdk/mock-receiver`（T09 已验收）**，进程内 `startReceiver({ port: 0 })`，只监听 `127.0.0.1`；按 `app_id` + `event_id` 去重、提供计数与入库明细 |
| 探针页 | 本地 `node:http` 静态服务，`127.0.0.1:0`（与接收端不同端口 = 跨源，因此**真的走了 CORS 预检**） |
| 网络 | 全程只连 `127.0.0.1`，不访问任何共享环境或真实网络 |
| Chromium | driver `playwright-core 1.60.0` + `chromium-1223` → **Chrome 148.0.7778.96**（headless，持久化 profile） |
| WebKit | driver `playwright-core 1.60.0` + `webkit-2287` → **WebKit 26.4**（headless，持久化 profile） |
| Firefox | driver `playwright-core 1.60.0` + `firefox-1522` → **Firefox 150.0.2**（headless，持久化 profile；**在非沙箱 shell 中运行**，见下） |

**驱动与浏览器版本的偏差（重要，供 T16 判断口径）**：

- 仓库 `package.json` 锁定 `@playwright/test` **1.64.0**，它要求 `chromium-1248` / `firefox-1555` / `webkit-2370`；**这三个构建在本机 `~/Library/Caches/ms-playwright` 里都不存在**，本机装的是 `chromium-1208`、`chromium-1223`、`firefox-1522`、`webkit-2287`，对应 Playwright **1.58.2 / 1.60.0**。
- 本次三个浏览器都用**树外 npx 缓存里的 `playwright-core` 1.60.0**
  （`/Users/spirit-ai/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`，只读引用，**不是新增依赖**，也没有下载任何东西），因为它与已装浏览器构建的 revision 精确匹配。`poc/poc-1/lib/driver.mjs` 用 `browserType.executablePath()` 问出每个候选驱动期望的 revision，**只在文件真实存在时采用**；每个结果 JSON 的 `driver` 字段记录了实际配对（driver id、revision、可执行文件路径）。
- 实际浏览器版本：**Chrome 148.0.7778.96**（chromium-1223）、**WebKit 26.4**（webkit-2287）、**Firefox 150.0.2**（firefox-1522，UA `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0`）。
- 运行环境：**Chromium 与 WebKit 在 DSH 文件沙箱内的常规命令里跑完**（`poc/poc-1/results/2026-10-12T09-57-47-578Z`）；
  **Firefox 必须在非沙箱 shell 里跑**（Firefox 主进程的 macOS `sandbox_init()` 不能嵌套在 DSH 文件沙箱内），
  由上级在非沙箱 shell 里用同一条命令完成（`poc/poc-1/results-firefox/2026-10-12T12-35-48-608Z`，脚本 `poc/poc-1/run-firefox.sh`）。
  首次尝试（`poc/poc-1/results-firefox/2026-10-12T11-41-05-051Z/run.json`）失败于
  `launchPersistentContext: Timeout 60000ms exceeded`，原因是脚本当时导出了 `MOZ_DISABLE_*_SANDBOX` / `MOZ_FORCE_DISABLE_E10S`——
  这些变量会破坏 Playwright 的 juggler 握手；**去掉全部 `MOZ_*` 变量后 Firefox 正常跑通**。脚本与「局限」一节都已据此修正。

## 方法

### 判定「丢失」的口径

- 事件 `event_id` 在 Node 侧用确定性 UUID v4 生成（合法 v4 形状，满足 `batch.schema.json` 的 `uuid` 模式），Node 端持有完整的期望集合；
- **`lost = 期望 event_id 集合 − M01 入库 event_id 集合`**，以 M01 的 `events.list(app_id)` 明细为准（去重后仍缺的才算丢）；
- 分 normal / critical 两类统计；`duplicate` 取 M01 的 `duplicate_events`（命中 `app_id`+`event_id` 去重）；
- 每格都断言 M01 的 `rejected_*` / `failed_storage` 计数为 0，防止把协议错误误判成丢失（全 run 均为 0）。

### 被测原型（`poc/poc-1/public/poc-sdk.js`）

| 机制 | 实现 |
|---|---|
| critical 预写 | `track()` 返回前**同步** `localStorage.setItem` 写入离线副本（键 `wr.poc.pending.v1`），跨标签页共享 |
| normal | 只进内存队列（上限 500，溢出按契约优先淘汰 normal 并计数） |
| 离开冲刷 | 按格子配置：`pagehide` 或 `visibilitychange(hidden)` 触发，传输用 `sendBeacon`（`text/plain`，令牌在 body `auth`）或 `fetch keepalive` |
| 删除离线副本 | **只在常规通道（fetch）收到 202 后**删除（契约 C07-F5；信标通道不删） |
| 补发 | 页面加载 / `online` 事件 / 显式调用；按选主方式决定谁来补发；每批 50 条 |
| 选主 | `navigator.locks.request(..., {mode:'exclusive', ifAvailable:true})`（整个补发放进锁回调）或 BroadcastChannel（广播 claim + settle 窗口，见下） |
| 计数 | 每个页面一套统计键（`wr.poc.meta.v2.<tabId>`），读取时聚合，避免跨渲染进程 read-modify-write 丢更新；丢弃路径都有原因码 |

### 场景与样本量

每个格子的样本量按「事件数」计（每类），`full` 预设：

| 场景 | 格子 | 每格每类样本 | 备注 |
|---|---|---|---|
| 1 页面离开 | `pagehide`/`visibilitychange` × `sendBeacon`/`keepalive` 共 4 格 | 1,000 | 10 次试验 × 100 条/类 |
| 1 页面离开（积压） | `bulk-pagehide-beacon`、`bulk-pagehide-keepalive` | 3,000（每次试验 1,000 条 critical） | 3 次试验，测「离线积压很大时离开时刻能送出多少」 |
| 2 浏览器强杀 | `page.close()`、`context.close()`、`browser.close()`、`SIGKILL`（0/250/1000/2500/4000/5000ms）共 9 格 | 1,000 | 5 次试验 × 200 条/类；**关闭钩子全部关掉**，隔离「预写是否真的落盘」 |
| 3 断网 | 同页断网恢复、断网期间刷新后恢复 | 1,000 | 10 次试验 × 100 条/类 |
| 4 多标签页 | Web Locks、BroadcastChannel（settle 150ms / 10ms / 0ms）、不选主 共 5 格 | 1,500 critical + 1,500 normal | 10 轮 × 3 标签页 × 50 条/类 |

三个浏览器的样本量与格子完全相同（上表），Firefox 的那一次运行在非沙箱 shell 中完成，其余口径一致。

场景 1 的口径细节：

- 离开动作分两种——`pagehide` 格子用**真实导航离开**（`page.goto(同源 blank.html)`），`visibilitychange` 格子用**另开一个页面并 `bringToFront()`** 制造真实的 `visibilityState=hidden`；
- `visibilitychange` 格子隐藏后等 500ms 再关页（真实用户切走标签页的场景），`pagehide` 格子不额外等待；
- 每次试验**离开后立刻打开一个恢复页排空离线副本**——这正是真实 SDK 在「下一次页面加载」做的事。若不做这一步，离线副本会跨试验累积，离开时载荷越滚越大，测到的就不是「一次页面离开」而是「长期不补发的积压」；
- 因此每格给两个数：**离开时一次到达**（离开那一次真正入库的）与**最终**（补发之后）。

场景 3 的口径细节：

- Chromium 用 `context.setOffline(true)`（`navigator.onLine=false`），页面本身在断网期间用 route fulfill 从磁盘供给；
- WebKit 下 Playwright 的 `setOffline(true)` 会让页面无法导航（`WebKit encountered an internal error`，已实测），因此 WebKit 改用「**只把上报端点 abort 掉**」的等价口径：`context.route('**/v1/batch', r => r.abort('internetdisconnected'))`；Firefox 用同一口径（`offlineMode = route-abort-endpoint(firefox)`，实测跑通）。实际口径写进结果 JSON 的 `offlineMode` 字段；
- 恢复网络后，脚本显式调用一次「重连处理」（冲刷内存 normal 队列 + 补发离线副本），保证三个浏览器口径一致。

## 结果

三个浏览器、全部 22 个格子、每个格子每类 ≥1000 条样本（多标签页每类 1500 条），数据来源：

| 浏览器 | 运行 | 驱动 + 浏览器构建 | 运行环境 |
|---|---|---|---|
| Chromium | `poc/poc-1/results/2026-10-12T09-57-47-578Z/`（09:57–10:15 UTC） | 树外 `playwright-core` 1.60.0 + chromium-1223 → Chrome 148.0.7778.96 | DSH 文件沙箱内 |
| WebKit | 同上（同一次运行） | 树外 `playwright-core` 1.60.0 + webkit-2287 → WebKit 26.4 | DSH 文件沙箱内 |
| Firefox | `poc/poc-1/results-firefox/2026-10-12T12-35-48-608Z/`（12:35–12:41 UTC） | 树外 `playwright-core` 1.60.0 + firefox-1522 → Firefox 150.0.2 | **非沙箱 shell**（由上级执行，命令与本次相同） |

### 测量矩阵（每格样本数：normal / critical）

| 场景 | 格子 | chromium 样本量(n/c) | firefox 样本量(n/c) | webkit 样本量(n/c) |
|---|--|--|--|--|
| leave | pagehide-beacon | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| leave | pagehide-keepalive | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| leave | visibility-beacon | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| leave | visibility-keepalive | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| leave | bulk-pagehide-beacon | 0 / 3000 | 0 / 3000 | 0 / 3000 |
| leave | bulk-pagehide-keepalive | 0 / 3000 | 0 / 3000 | 0 / 3000 |
| kill | page-close | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | context-close | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | browser-close | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | sigkill-immediate | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | sigkill-250ms | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | sigkill-1000ms | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | sigkill-2500ms | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | sigkill-4000ms | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| kill | sigkill-5000ms | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| offline | offline-same-page | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| offline | offline-reload | 1000 / 1000 | 1000 / 1000 | 1000 / 1000 |
| multitab | weblocks | 1500 / 1500 | 1500 / 1500 | 1500 / 1500 |
| multitab | broadcastchannel-150ms | 1500 / 1500 | 1500 / 1500 | 1500 / 1500 |
| multitab | broadcastchannel-10ms | 1500 / 1500 | 1500 / 1500 | 1500 / 1500 |
| multitab | broadcastchannel-0ms | 1500 / 1500 | 1500 / 1500 | 1500 / 1500 |
| multitab | no-election | 1500 / 1500 | 1500 / 1500 | 1500 / 1500 |

### 场景 1 页面离开：四条冲刷路径

| 格子 | chromium 离开时 normal 丢失 | chromium 离开时 critical 丢失 | chromium 最终 normal 丢失 | chromium 最终 critical 丢失 | chromium 重复事件 | firefox 离开时 normal 丢失 | firefox 离开时 critical 丢失 | firefox 最终 normal 丢失 | firefox 最终 critical 丢失 | firefox 重复事件 | webkit 离开时 normal 丢失 | webkit 离开时 critical 丢失 | webkit 最终 normal 丢失 | webkit 最终 critical 丢失 | webkit 重复事件 |
|---|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|
| pagehide-beacon | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 |
| pagehide-keepalive | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 |
| visibility-beacon | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 1000/1000（100.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | 0 |
| visibility-keepalive | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 1000 | 1000/1000（100.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | 0 |
| bulk-pagehide-beacon | 0/0（0.000%） | 2100/3000（70.000%） | 0/0（0.000%） | 0/3000（0.000%） | 900 | 0/0（0.000%） | 0/3000（0.000%） | 0/0（0.000%） | 0/3000（0.000%） | 3000 | 0/0（0.000%） | 2100/3000（70.000%） | 0/0（0.000%） | 0/3000（0.000%） | 900 |
| bulk-pagehide-keepalive | 0/0（0.000%） | 2100/3000（70.000%） | 0/0（0.000%） | 0/3000（0.000%） | 900 | 0/0（0.000%） | 2100/3000（70.000%） | 0/0（0.000%） | 0/3000（0.000%） | 900 | 0/0（0.000%） | 2100/3000（70.000%） | 0/0（0.000%） | 0/3000（0.000%） | 900 |

**分析（场景 1）**

- **Chromium 与 Firefox 四条路径的离开时一次到达率都是 100%**（normal 与 critical 各 1000/1000），`hooksFired.firedAllTrials` 在四个格子上都是 `true`——两个引擎里 `pagehide` 与 `visibilitychange` 都**真的触发**了。
- **WebKit 只有 `pagehide` 两格触发**（`true`）；`visibilitychange` 两格 `firedAllTrials = false`（`bringToFront()` 在 WebKit headless 下 10/10 次没有制造 hidden），那两格的 normal「100% 丢失」是「触发没有发生」的观测，**不能**当作该冲刷路径的丢失率。
- 三个引擎的**重复事件都是 1000**（= 每个 critical 恰好多送一次；WebKit 未触发的两格是 0）：离开时刻无论 beacon 还是 keepalive 都拿不到 202（beacon 没有响应通道；keepalive 的 Promise 在页面销毁时被丢弃），按契约 C07-F5 不删离线副本，于是下一次页面加载会再补发一遍，由 M01 去重兜底。这 1000 条重复是这套方案的**确定性带宽成本**。
- 差异体现在**机制信号**上（各结果 JSON 的 `pageStats`）：`pagehide-keepalive` 格子里 Chromium 与 Firefox 都有 40 次 keepalive 请求的 Promise **全部 reject**（`batch_network_error = 40`），但事件仍然全部入库——**不能把 fetch 的 resolve/reject 当送达信号**；`visibility-keepalive` 格子里 40 次请求一次回调都没有（既没 resolve 也没 reject），事件同样全部入库。
- **积压格子（bulk，1000 条 critical = 20 个批次 ≈ 250 KB）在三个引擎上表现不同**：
  - Chromium：beacon 60 次尝试只有 18 次被接受（42 次 `sendBeacon` 返回 `false`，每来源约 64 KB 队列上限）；keepalive 只有 6 批（300 条）出去。**离开时分别只送达 900/3000**。
  - WebKit：与 Chromium 完全一致（beacon 18/60、900/3000；keepalive 900/3000）。
  - **Firefox：beacon 60 次尝试全部被接受（`beacon_rejected = 0`），3000/3000 全部送达**；但 keepalive 同样只有 900/3000（42 次请求失败）。
  - 三个引擎**最终丢失率都是 0%**：没送出去的 70% 由下一次加载补发。
  - 结论：`sendBeacon` 的「离开预算」上限是 **Chromium/WebKit 的实现细节**，Firefox 没有这个上限；而 `fetch keepalive` 在页面离开时**三个引擎一致地只能送出约 6 个批次**。所以「按预算切片」应当作为跨引擎的保守默认值，而不是因为 Firefox 能全发就取消。

### 场景 2 浏览器强杀

| 变体 | chromium 强杀方式 | chromium 预写存活（存活/应有） | chromium normal 丢失 | chromium critical 丢失 | firefox 强杀方式 | firefox 预写存活（存活/应有） | firefox normal 丢失 | firefox critical 丢失 | webkit 强杀方式 | webkit 预写存活（存活/应有） | webkit normal 丢失 | webkit critical 丢失 |
|---|--|--|--|--|--|--|--|--|--|--|--|--|
| page-close | page.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | page.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | page.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| context-close | context.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | context.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | context.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| browser-close | browser.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | browser.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | browser.close() | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| sigkill-immediate | SIGKILL via CDP SystemInfo pid=51603 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=25805 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=67959 | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| sigkill-250ms | SIGKILL via CDP SystemInfo pid=52122 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=26284 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=68391 | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| sigkill-1000ms | SIGKILL via CDP SystemInfo pid=52678 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=26827 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=68953 | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| sigkill-2500ms | SIGKILL via CDP SystemInfo pid=53249 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=27495 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=69564 | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| sigkill-4000ms | SIGKILL via CDP SystemInfo pid=53947 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=28299 | 0/1000（0.000%） | 1000/1000（100.000%） | 1000/1000（100.000%） | SIGKILL via pgrep pid=70312 | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |
| sigkill-5000ms | SIGKILL via CDP SystemInfo pid=54695 | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | SIGKILL via pgrep pid=29212 | 800/1000（80.000%） | 1000/1000（100.000%） | 200/1000（20.000%） | SIGKILL via pgrep pid=71644 | 1000/1000（100.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |

**分析（场景 2）**

- 关闭钩子刻意全部关掉（`leave.trigger = none`），所以 normal 在 9 个变体里三个引擎都是 **100% 丢**——这是「没有离开冲刷机会」的基线，不是缺陷。
- 优雅关闭（`page.close()` / `context.close()` / `browser.close()`）：三个引擎的**离线副本都 100% 存活**，重启后补发 → critical 0% 丢。
- **真 SIGKILL**（Chromium 经 browser 级 CDP 的 `SystemInfo.getProcessInfo` 取浏览器进程 PID；Firefox/WebKit 经 `pgrep` 取进程 PID，都是真 `SIGKILL`，`killMode` 已写进结果 JSON）：**三个引擎表现不同**：
  - **Chromium**：延迟 0 / 250 / 1000 / 2500 / 4000 ms 五个变体，离线副本存活 **0/1000**，critical **100% 丢**；延迟 5000 ms 时存活 1000/1000、0% 丢。
  - **Firefox**：延迟 0 / 250 / 1000 / 2500 / 4000 ms 同样是 **0/1000 存活、100% 丢**；**延迟 5000 ms 时仍只有 800/1000 存活，critical 丢 20%**——窗口比 Chromium 更宽。
  - **WebKit**：0 / 250 / 1000 / 2500 / 4000 / 5000 ms **全部** 1000/1000 存活、critical 0% 丢——localStorage 写入后很快落盘，强杀窗口基本不存在。
- 也就是说 **localStorage 的落盘时机是引擎实现细节**，Chromium 与 Firefox 都是「定时批量提交」，提交前被强杀就全丢；只有 WebKit 接近同步落盘。同一条命令的多次 Chromium 运行还在 1000–4000 ms 上出现过 20%、40% 存活（见 `poc/poc-1/results/run-variance.md`），说明窗口边界**不确定**。
- 结论：**「critical 预写」的强杀可靠性不能跨浏览器依赖**；在 Chromium 与 Firefox 上都不能当作强杀兜底。

### 场景 3 断网

| 变体 | chromium normal 丢失 | chromium critical 丢失 | firefox normal 丢失 | firefox critical 丢失 | webkit normal 丢失 | webkit critical 丢失 |
|---|--|--|--|--|--|--|
| offline-same-page | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） | 0/1000（0.000%） |
| offline-reload | 1000/1000（100.000%） | 0/1000（0.000%） | 1000/1000（100.000%） | 0/1000（0.000%） | 1000/1000（100.000%） | 0/1000（0.000%） |

**分析（场景 3）**

- 断网期间的上报尝试全部失败（`offlineArrived` 全 0），符合预期。
- **断网 + 同页恢复**：三个引擎 normal 0% 丢、critical 0% 丢。normal 靠「重连处理」把内存队列冲出去；critical 靠离线副本补发。
- **断网 + 页面刷新**：三个引擎 normal **100% 丢**（内存队列随页面销毁），critical 0% 丢（预写副本 + 下一次加载补发）。
- 口径说明：`onlineAutoRecoverRuns = 0` —— Playwright 的 `context.setOffline(false)` 只把 `navigator.onLine` 改回 `true`，**没有派发 `online` 事件**，所以这一格里的补发是脚本显式调用「重连处理」完成的（与 SDK 的 online 处理是同一段代码）。WebKit 与 Firefox 的断网口径是「上报端点 abort」（`offlineMode = route-abort-endpoint(webkit/firefox)`），因为 Playwright 的 WebKit 在 `setOffline(true)` 下无法导航。

### 场景 4 多标签页重复补发

| 选主方式 | chromium 首轮并发重复 | chromium 重复/入库 | chromium 重复/离线副本 | chromium 当选主标签页数 | chromium critical 丢失 | firefox 首轮并发重复 | firefox 重复/入库 | firefox 重复/离线副本 | firefox 当选主标签页数 | firefox critical 丢失 | webkit 首轮并发重复 | webkit 重复/入库 | webkit 重复/离线副本 | webkit 当选主标签页数 | webkit critical 丢失 |
|---|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|
| weblocks | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） |
| broadcastchannel-150ms | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） |
| broadcastchannel-10ms | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） | 0 | 0.0% | 0.0% | 10/30 | 0/1500（0.000%） |
| broadcastchannel-0ms | 3000 | 100.0% | 200.0% | 30/30 | 0/1500（0.000%） | 1950 | 65.0% | 130.0% | 23/30 | 0/1500（0.000%） | 3000 | 100.0% | 200.0% | 30/30 | 0/1500（0.000%） |
| no-election | 3000 | 100.0% | 200.0% | 30/30 | 0/1500（0.000%） | 3000 | 100.0% | 200.0% | 30/30 | 0/1500（0.000%） | 3000 | 100.0% | 200.0% | 30/30 | 0/1500（0.000%） |

（重复补发率按两种口径给出：重复事件 / 入库事件（含 normal 与 critical）、重复事件 / 该场景的离线副本事件数（critical）。「当选主标签页数」= 全部轮次里首轮并发中 `recover_leader` 计数 > 0 的「标签页 × 轮次」数 / 总「标签页 × 轮次」数。）

结果目录：`poc/poc-1/results/2026-10-12T09-57-47-578Z`（Chromium + WebKit）、`poc/poc-1/results-firefox/2026-10-12T12-35-48-608Z`（Firefox），`preset=full`。

**分析（场景 4）**

- 每轮 3 个标签页共享同一个 localStorage 离线副本（共 150 条 critical），恢复网络后 3 个标签页**同时**调用「冲刷 normal + 补发离线副本」，共 10 轮。
- **Web Locks**：三个引擎都是 30 次「标签页 × 轮次」里正好 10 次拿到锁（每轮 1 个），重复补发 **0**。
- **BroadcastChannel（settle 150 ms / 10 ms）**：三个引擎都是每轮 1 个「当选者」、重复 **0**。
- **BroadcastChannel（settle 0 ms）** 会退化：Chromium 30/30 都自认当选、重复 3000/3000（与不选主相同）；WebKit 同样 30/30、3000/3000；**Firefox 是 23/30、重复 1950/3000（65%）**——比另两个引擎好一点，但仍然不可接受。说明这个朴素 BC 协议**必须有 settle 窗口**，10 ms 在三个引擎上都够用，0 ms 都不够。
- 重复/入库在退化时是 65%–100%、重复/离线副本是 130%–200%（不选主时每条 critical 被 3 个标签页各送一次 = 2 条重复）。**丢失率在所有选主方式与所有引擎下都是 0%**：去重由接收方兜底，选主只影响带宽，不影响正确性。
- normal（每标签页自己的内存队列）在各方式下都是 0% 丢、0 重复，与选主无关。

### 汇总判定

| 场景 | normal 目标 ≤1% | critical 目标 ≤0.1% |
|---|---|---|
| 1 页面离开（四条路径，正常负载） | ✅ Chromium 四格全 0；Firefox 四格全 0；WebKit `pagehide` 两格 0（`visibilitychange` 两格触发未发生） | ✅ 同上，三个引擎 critical 全 0 |
| 1 页面离开（1000 条 critical 积压） | 未测（该格只放 critical） | ✅ 最终 0%（Chromium/WebKit 离开时送出 900/3000；Firefox beacon 全送出） |
| 2 优雅关闭 `page.close()` / `context.close()` / `browser.close()`（无离开钩子） | ❌ 100%（三引擎） | ✅ 0%（三引擎） |
| 2 `SIGKILL` 强杀（延迟 0–4000 ms） | ❌ 100%（三引擎） | ❌ **100%**（Chromium、Firefox）；✅ 0%（WebKit） |
| 2 `SIGKILL` 强杀（延迟 5000 ms） | ❌ 100%（三引擎） | ✅ 0%（Chromium 1000/1000、WebKit 1000/1000 存活）；❌ **20%**（Firefox 仅 800/1000 存活） |
| 3 断网 + 同页恢复 | ✅ 0%（三引擎） | ✅ 0%（三引擎） |
| 3 断网 + 页面刷新 | ❌ 100%（三引擎） | ✅ 0%（三引擎） |
| 4 多标签页（3 标签页并发补发） | ✅ 0%（三引擎） | ✅ 0%（三引擎，所有选主方式） |

**判定结果**

- **critical ≤ 0.1%：不达标（跨浏览器确认）。** 三个引擎里**两个（Chromium、Firefox）在 SIGKILL 下 100% 丢失 critical 预写**（延迟 0/250/1000/2500/4000 ms 各 1000 条全部丢失），只有 WebKit 存活；Firefox 的窗口**更宽**——连 5000 ms 都还有 20% 丢（800/1000 存活）。因此 **「critical 预写」不能作为强杀兜底**，`critical ≤0.1%` 在强杀场景下未达标，需要重新界定目标或改设计（风险 R02，已由上级升级）。
- **normal ≤ 1%：部分达标。** 在「有离开冲刷机会」（页面离开四格、多标签页）、「断网后同页恢复」下三个引擎都是 0%；在「强杀」与「断网期间页面刷新」下为 100%——`normal` 不做本地持久化，这是方案的既定取舍，不是实现缺陷。
- 其余全部格子（页面离开、断网、多标签页、优雅关闭）三个引擎的 critical 与 normal 均为 **0% 丢失**。

原始数据位置：`poc/poc-1/results/2026-10-12T09-57-47-578Z/`（Chromium + WebKit）与
`poc/poc-1/results-firefox/2026-10-12T12-35-48-608Z/`（Firefox）
（每个运行目录含 `run.json` 环境与驱动配对、`<browser>-<scenario>.json` 逐格原始数字、`run.log` 运行日志；
报告里的表格由 `node poc/poc-1/tables.mjs --dir poc/poc-1/results --dir poc/poc-1/results-firefox` 从这些 JSON 直接生成）。
强杀落盘窗口的跨运行波动另见 `poc/poc-1/results/run-variance.md`（三次独立运行的原始日志片段）。

## 复现命令

```bash
cd /Users/spirit-ai/Desktop/sdk/temp/wt-T02          # 本 worktree 根目录

# 主命令：Chromium + WebKit 四类场景全量（报告里的全部数字）
node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs --browser all --preset full

# 结果表格（直接从 result JSON 生成，报告里的表格就是它的输出；可传多个 --dir）
node poc/poc-1/tables.mjs --dir poc/poc-1/results --dir poc/poc-1/results-firefox

# 单场景重跑（例如只重跑强杀，约 4 分钟）
node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs --browser chromium --scenario kill

# Firefox 一栏（必须在非沙箱 shell 里执行；脚本不设置任何 MOZ_* 变量）
bash poc/poc-1/run-firefox.sh
```

`full` 预设实测：Chromium 约 6.5 分钟（leave 56.6s + kill 246.5s + offline 43.3s + multitab 45.4s）、
WebKit 约 5.1 分钟（59.9 + 143.6 + 43.2 + 60.4）；`--browser all` 在沙箱内全程 **17.7 分钟**
（其中约 6 分钟是 Firefox 两次启动超时，Firefox 一栏由 `--browser firefox` 单独在非沙箱 shell 中约 5.6 分钟跑完）。
结果目录 `poc/poc-1/results/<runId>/` 与 `poc/poc-1/results-firefox/<runId>/`，
其中 `profiles/` 是浏览器中间产物（23 MB 级，已 gitignore，可删；保留后不影响任何数字）。

## 结论

**明确结论：未达标（critical）/ 部分达标（normal）。**

1. **critical 丢失率 ≤ 0.1%：未达标（三个引擎里两个确认不达标）。**
   - 页面离开、断网、多标签页、优雅关闭四类场景下，**三个引擎**的 critical 丢失率都是 **0%**（每格 1000–3000 条样本），方案在这些场景下成立；
   - 但 **浏览器强杀**场景下，**Chromium 与 Firefox 的离线副本在 SIGKILL 后 100% 没有落盘**：延迟 0 / 250 / 1000 / 2500 / 4000 ms 各 1000 条样本，critical 丢失率 **100%**，重启后无法补发；只有 **WebKit** 在全部延迟点都 1000/1000 存活、0% 丢。
   - **Firefox 的落盘窗口比 Chromium 更宽**：延迟 5000 ms 时只存活 800/1000，critical 仍丢 **20%**；Chromium 在同一延迟下（本次运行）存活 1000/1000。同一条命令的多次 Chromium 运行在 1000–4000 ms 上还出现过 20%、40% 存活（`poc/poc-1/results/run-variance.md`），说明窗口边界**不确定**，不能当作可依赖的常数。
   - 因此可以给出**跨浏览器的明确判断：「critical 预写」不能作为强杀兜底**。localStorage 的落盘时机是引擎实现细节（Chromium/Firefox 定时批量提交，WebKit 近似同步），任何依赖它的可靠性承诺都只能覆盖「进程正常关闭」而不是「强杀」。
   - 按任务卡 T02「结论为不达标时，立即升级给前端负责人和架构负责人（风险 R02）」，本 POC 触发升级；上级已确认升级，并需要重新界定 `critical ≤0.1%` 的目标口径或改设计（见「对 T16 的建议」）。
2. **normal 丢失率 ≤ 1%：部分达标。** 有离开冲刷机会时（`pagehide`/`visibilitychange` 四格、多标签页并发）与断网后同页恢复时，三个引擎都是 0%；强杀与断网刷新时 100%，因为 normal 只在内存队列里（方案本来就是只对 critical 预写）。需要 T16 明确 normal 的 1% 目标口径：**「页面正常离开或被隐藏」前提下成立，「页面被强杀或刷新」前提下不成立**。
3. **方案可行性（除强杀窗口外）：成立且跨引擎一致。** critical 预写 + 离开冲刷 + 下次加载补发，在页面离开、断网、多标签页、优雅关闭下把三个引擎的 critical 丢失率都压到 0%，代价是每个 critical 会被补发一次（重复 ≈ 100%，但各引擎的机制不同：Firefox 的 `sendBeacon` 没有 Chromium/WebKit 的 64 KB 队列上限，`fetch keepalive` 则在三个引擎上都只能送出约 6 个批次）。
4. **对 T16 的影响**：见「对 T16 的建议」。最关键的一条是——**不要把「critical 预写」当作强杀兜底**；要在 T16 里把「事件产生即发送 critical」和「离开时按预算切片」做成设计，并单独验证 IndexedDB/OPFS 能否把落盘窗口压到 0（验证要点见「后续验证建议」）。

## 后续验证建议（IndexedDB / OPFS 落盘窗口）

> 上级正在请示是否先补这一轮 POC；**在得到答复前不执行**。以下是本 POC 整理出的验证要点，获批后可直接照此实现。

1. **要测的落盘点**（同一场景脚本，只换存储实现）：
   - `localStorage.setItem`（本轮基线）；
   - `IndexedDB`：单条 `add` 在**显式事务 `oncomplete` 之后**被强杀（这才是「已提交」的语义）；以及事务未完成时被强杀（对照组）；
   - `OPFS`（`navigator.storage.getDirectory()` + `createSyncAccessHandle`/`createWritable` 的 `close()` 之后）；
   - 可选对照：`Cache API`、`CompressionStream` 写文件等不适用项不必测。
2. **判定「落盘窗口」的口径**：与 POC-1 完全一致——`预写 N 条 → 等待 Δt → SIGKILL（真杀，Chromium 走 CDP 取 PID、Firefox/WebKit 走 pgrep）→ 同一 profile 重启 → 读回离线副本`，统计 `存活 = 重启后能读回的条数 / N`。Δt 至少取 `0 / 100 / 250 / 500 / 1000 / 2500 / 4000 / 5000 ms`，每点 ≥1000 条样本（5 次试验 × 200 条，与 POC-1 对齐），**每个点重复 3 次独立运行**以暴露不确定的提交时机（POC-1 的教训）。
3. **必须与 localStorage 用同一套判定口径**：同样的 `event_id` 集合、同样的「以 M01 入库明细判定丢失」、同样的关闭钩子（`leave.trigger = none`），否则两个存储的数字不可比。
4. **额外要看的两件事**：
   - IndexedDB 在**跨标签页并发写**下的行为（POC-1 的 localStorage 读改写不是跨渲染进程原子的；如果 IndexedDB 事务能解决，S4 的重复补发率与补发正确性会一起变好）；
   - 容量与配额：`QuotaExceededError` 的触发点、以及溢出时「优先淘汰 normal」的策略在两种存储上的实现成本。
5. **通过标准**：如果 IndexedDB 显式事务在 Δt ≥ 250 ms 时能稳定 `存活 = N`（3 次运行都成立），并且跨标签页语义更好，则建议 T16 用 IndexedDB 替换 localStorage 作离线副本，并把强杀窗口的残余风险重新评估。

## 对 T16 的建议

### 推荐参数（可直接采用）

| 参数 | 建议值 | 依据 |
|---|---|---|
| 离开触发 | `visibilitychange(hidden)` **和** `pagehide` 都要装 | 两者互补：`visibilitychange` 给了页面存活时间（Chromium 下四条路径都能送达）；`pagehide` 是最后的兜底 |
| 离开传输 | **`sendBeacon` 为主**（`text/plain;charset=UTF-8`，令牌放 body `auth`），`fetch keepalive` 为备 | 正常负载下三个引擎两者都能送达；`fetch keepalive` 的 Promise 在页面销毁时不可信（见下「不能依赖的信号」） |
| 离开时发送预算 | **≤ 48 KB、≤ 200 条、≤ 4 个批次**（每批 50 条）——作为跨引擎的保守默认值 | 积压 1000 条（20 批 ≈ 250 KB）时：Chromium/WebKit 的 beacon 只有 18/60 批被接受（其余 `sendBeacon` 返回 `false`，每来源约 64 KB 队列上限）、只送出 900/3000；**Firefox 的 beacon 60/60 全接受、3000/3000 全送出**；`fetch keepalive` 则三个引擎一致地只送出 900/3000。上限是引擎实现细节，Firefox 能全发不等于可以不切片 |
| 离线副本上限 | 5,000 条（本次未触发淘汰） | 建议按 7 天 × 峰值速率估算，溢出按契约**优先淘汰 normal** |
| 删除离线副本的时机 | 只在**常规通道收到 202** 之后；信标通道不删 | 契约 C07-F5；实测离开时的响应回调拿不到（beacon 无响应通道、keepalive 的 Promise 被丢弃），所以 critical 必然被补发一次 |
| 补发批量/限速 | 单批 ≤ 100 条，批间隔 100–200 ms，单轮补发 ≤ 500 条 | 避免回前台/重连瞬间打爆接收端（对齐接收方限流 RR-15 与 M01 的 500 批/秒规格线） |
| 补发保留期 | 7 天（与 RR-05 去重窗口一致） | 早于窗口的副本即使补发也会被接收方当新事件 |
| 选主 | **Web Locks**（`ifAvailable: true`，整个补发放进锁回调内 await 完成）；BroadcastChannel 只作降级，且 `settle ≥ 50 ms` | 三个引擎的 Web Locks 与 BC(10/150 ms) 都是 0 重复；BC(0 ms) 退化到 3000/3000（Chromium、WebKit）与 1950/3000（Firefox），≈不选主 |
| 断网恢复触发 | `online` 事件 + 定时器 + 页面加载三条路径都要有 | 三个引擎同页断网恢复 normal 0% 丢、critical 0% 丢；页面刷新后 normal 必丢、critical 靠预写+补发 0% 丢 |
| 强杀场景的目标 | 需要重新界定（例如「优雅关闭下 critical ≤0.1%」＋「强杀下 best-effort」），或改用别的持久化 | Chromium 与 Firefox 在 SIGKILL 0–4000 ms 下 critical 100% 丢；Firefox 5000 ms 仍丢 20% |

### 对 T16 设计的修改建议

1. **不要把「critical 预写」当成强杀兜底。** 实测 Chromium 与 Firefox 上预写都有落盘窗口，且长度不确定：Chromium 同一条命令的三次独立运行在 1000–4000 ms 上的存活率是 0%、20%、0%（运行 A/B/C 原始日志见 `poc/poc-1/results/run-variance.md`），只有 5000 ms 三次都是 1000/1000；**Firefox 的窗口更宽，5000 ms 仍只存活 800/1000（丢 20%）**；只有 WebKit 在全部延迟点都 100% 存活。把「事件产生后**立即**走常规通道发送 critical（微批 + 200 ms 合并）」提升为一等公民，预写只作兜底；并在接入文档里把「强杀窗口内 critical 可能丢」写成已知限制（R02 的残余风险）。
2. **单独验证更强的本地持久化**（IndexedDB 显式事务 `oncomplete`、OPFS）。POC-1 只测了 localStorage，不能替 T16 下结论；建议 T16 用同一套场景脚本换存储实现再测一轮，看落盘窗口能否压到 0。
3. **把「离开时发送预算」变成显式设计**：C07 在 `pagehide`/`visibilitychange` 时先按 critical 优先、时间倒序切片，预算用尽就停手并计数（新增原因码，例如 `flush_skipped_due_to_budget`），把剩余部分明确交给下次加载补发。不要为了「尽量多发」把队列打满——`sendBeacon` 返回 `false` 的批次在旧实现里会静默丢失。
4. **明确记录「重复补发 ≈ 1 倍 critical 流量」是设计成本**，写进契约与容量估算：因为离开时刻拿不到 202，每个 critical 都会在下一次加载被补发一次（接收方去重，正确性不受影响）。T16 可据此评估接收端带宽与去重窗口压力。
5. **补发路径要限速并分片**，且必须有选主；没有选主时 3 标签页会产生 2 倍重复（实测重复/入库 = 100%）。BroadcastChannel 方案必须给出 settle 窗口的下界（10 ms 够用，0 ms 不够），并处理「窗口内收不到对方 claim」的情况。
6. **C08 计数建议（需走契约变更请求，尚未确定）**：建议为 `beacon_rejected`（`sendBeacon` 返回 false）、`flush_skipped_due_to_budget`、`prewrite_commit_lost`（重启后发现离线副本缺失/回退）、`leader_lost`、`recovery_duplicate` 建独立原因码。POC-1 的计数器已经按这个粒度实现（`poc/poc-1/public/poc-sdk.js`），可以直接搬，但**新增原因码属于 `docs/contracts/reason-codes.md` 的契约变更**（按契约版本规则属兼容变更），必须走契约变更请求，由架构负责人批准后才能进 T16；本报告只作为建议，不代表已确定。
7. **对接收方（RR）的建议**：M01 的去重按 `app_id`+`event_id` 生效，是这套方案成立的前提；RR-05 的 7 天窗口与 RR-15 限流必须在生产接收方落实，否则补发流量会变成重复入库与限流放大。

## 局限

1. **Firefox 已测量（150.0.2，驱动 `playwright-core` 1.60.0 + firefox-1522），但运行环境与另两个引擎不同：必须在非沙箱 shell 里运行。** 原因是 Firefox 主进程的 macOS `sandbox_init()` 不能嵌套在 DSH 文件沙箱内，在沙箱内启动会卡在启动阶段（`-juggler-pipe` 始终没有握手输出）。本报告采用的 Firefox 数据由上级在非沙箱 shell 里用同一条命令跑出（`poc/poc-1/results-firefox/2026-10-12T12-35-48-608Z/`，每格样本量与另两个引擎相同）。
   - **修正记录（重要，避免后来者重复踩坑）**：`poc/poc-1/run-firefox.sh` 最初导出了 `MOZ_DISABLE_CONTENT_SANDBOX` / `MOZ_DISABLE_GPU_SANDBOX` / `MOZ_DISABLE_RDD_SANDBOX` / `MOZ_DISABLE_SOCKET_PROCESS_SANDBOX` / `MOZ_DISABLE_UTILITY_SANDBOX` / `MOZ_FORCE_DISABLE_E10S`，这些变量会**破坏 Playwright 的 juggler 握手**，表现为 `launchPersistentContext: Timeout 60000ms exceeded`（失败运行留档：`poc/poc-1/results-firefox/2026-10-12T11-41-05-051Z/run.json`）。**去掉全部 `MOZ_*` 变量后 Firefox 正常跑通**。脚本已改为不设置任何 `MOZ_*`；同时，本次 POC 早前基于「带着这些变量在沙箱内仍挂住」得出的「放开沙箱也不一定能解决」的判断**不成立**，已作废——那个结论混淆了「DSH 沙箱本身」与「错误环境变量」两个原因。
   - Firefox 一栏与另两个引擎的口径差异：断网用「上报端点 abort」（与 WebKit 相同，`offlineMode = route-abort-endpoint(firefox)`），强杀经 `pgrep` 取 PID 后发真 `SIGKILL`。
2. **驱动/浏览器版本不是仓库锁定的那一组**：仓库锁定 `@playwright/test` 1.64.0（要求 chromium-1248 / firefox-1555 / webkit-2370），本机只有 1.58.2/1.60.0 时代的构建。POC 精确配对到 `playwright-core` 1.60.0（树外只读缓存），每个结果 JSON 的 `driver` 字段记录了配对。浏览器行为结论（信标、keepalive、Web Locks、localStorage 落盘）在版本间可能有差异，尤其**localStorage 落盘窗口**与 **beacon 队列上限**这两条属于实现细节。
3. **headless 环境的固有偏差**：
   - `visibilitychange` 靠 `page.bringToFront()` 制造 `hidden`。**Chromium 与 Firefox 下 10/10 次试验都真的触发了；WebKit 下 0/10 次触发**，所以 WebKit 的 `visibilitychange` 两个格子的数字应视为「该触发在 headless 下没有发生」的观测，而不是该冲刷路径的真实丢失率（报告里已单列标注）。
   - 「浏览器强杀」用真 `SIGKILL`（Chromium 经 browser 级 CDP 取 PID，Firefox/WebKit 经 `pgrep` 取 PID），但它与用户态强杀（系统内存压力、系统回收页面）不完全等价，`bfcache`/系统回收未覆盖。
   - 无 GPU、无真实标签页切换、无真实用户交互；打开/关闭页面的时序比真实用户快得多。
4. **`online` 事件没有被触发**：Playwright 的 `context.setOffline(false)` 只把 `navigator.onLine` 改回 `true`，实测没有派发 `online` 事件（该格的 `recover_runs` 增量恒为 0）。因此断网格子里的补发是由脚本显式调用「重连处理」完成的（与 SDK 的 online 处理走同一代码路径）；「定时器触发补发」这条路径本次没有单独测。
5. **WebKit 与 Firefox 的断网口径不同**：因为 Playwright 的 WebKit 在 `setOffline(true)` 下无法导航（Firefox 为了一次跑通采用同一口径），这两个引擎用「上报端点 abort」代替 `navigator.onLine=false`；只有 Chromium 是真的 `setOffline`。两种口径对「发送失败 + 之后补发」是等价的，但对「依赖 `online` 事件的实现」不等价。
6. **强杀落盘窗口给不出可靠临界值**：Chromium 同一条命令的三次独立运行在 1000–4000 ms 上的存活率组合各不相同（0/0/0、200/200/200、0/400/0 条），说明 localStorage 的提交时机不确定；只有 5000 ms 三次都是 1000/1000 存活。三次运行的原始日志片段保留在 `poc/poc-1/results/run-variance.md`（报告采用的这次是运行 C）。Firefox 只跑了**一次**（5000 ms 存活 800/1000、其余延迟点 0/1000），因此 Firefox 的窗口边界没有做重复观测，只能给出「≥5000 ms 仍不保证」这一下界。本 POC 只能给出「窗口约 0–5 秒且不确定」，不能给出可依赖的秒数。
7. **批次大小影响离开时的送达上限**：本次每批 50 条（约 12.5 KB）。改变批次大小会改变「离开时能送出多少条」的结果（Chromium/WebKit 的 beacon 上限约 4–6 批 / 64 KB，`fetch keepalive` 三个引擎都约 6 批，Firefox 的 beacon 本次未见上限），参数建议里已给出具体预算，但不同批次大小的曲线没有逐点测，Firefox 的 beacon 上限也没有专门加压到更大体量。
8. **页内统计是辅助数据**：`pageStats` / `trace` 通过 localStorage 聚合，只用于解释机制（触发是否发生、`sendBeacon` 是否被接受）。所有丢失率判定一律以 M01 的入库明细为准。
9. **未覆盖**：真实弱网/高延迟/丢包、TLS 与中间盒、接收端限流与 5xx 的真实退避曲线（M01 的故障注入本次没有开启）、IndexedDB/OPFS 落盘、配额耗尽（`prewrite_failed_quota` 全 run 为 0，未触发）、Service Worker 场景、移动端浏览器、页面被系统回收。
