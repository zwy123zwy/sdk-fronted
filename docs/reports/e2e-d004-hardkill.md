# T29 / D004 硬杀落盘复测（真实 Chromium + WebKit，`packages/transport` 真实实现）

- 执行：A09（T29），2026-10-14
- 被测对象：`packages/transport/dist/index.js`（单包 build 产物；源码 `packages/transport/src/offline/**`），sha256 前缀 `26c232e4112442c6`
- 驱动/浏览器：`playwright-core@1.60.0`（树外只读，revision **精确配对**）+ 本机已装 chromium-1223 / webkit-2287，headless，每次全新持久化 profile
- 原始数据：`tests/e2e/results/d004-chromium.json`、`tests/e2e/results/d004-webkit.json`（逐格含期望集合、存活集合、kill 方式、重启后 SDK 统计与 commitLoss）
- 一键复现：`pnpm test:e2e --project=chromium --project=webkit`（D004 两个用例，实测 27 s）；逐格原始数字：`node tests/e2e/lib/d004-run.mjs --browser chromium`

## 结论（对 D004「结论」第 1 条逐句）

| D004 的承诺 | 实测 | 判定 |
|---|---|---|
| 已确认落盘（事务 `oncomplete` 已返回）的 critical 事件，硬杀下不丢 | Chromium 1000/1000、WebKit 1000/1000（`settled` 全部为 `durable`，重启后逐条 `read()` 校验 `event_id` 与条数全等） | **成立** |
| 落盘点是且仅是 `oncomplete`（事务在途时不得有可读回记录） | 事务在途时硬杀（约 82 MB / 500 批）：两引擎均 **0/5000** 可读回，且没有任何半落盘批次 | **成立** |
| 暴露窗口内未提交的事件必须**单独计数并上报** | 窗口被捕获时完全可对账（存活 + `prewrite_commit_lost` == 期望）；**但 flush 发起之前硬杀时，事件既丢失又不计数** | **不成立（见偏差 D-1）** |

## 数字（每格 2 次浏览器启动：预写 → 真 SIGKILL → 同 profile 重启读回）

下表取自最终一次运行，逐格原始数据见 `tests/e2e/results/d004-*.json`。

Chromium（`kill = SIGKILL via CDP SystemInfo.getProcessInfo`）：

| 格子 | 预写 | 强杀时机（发出后） | 读回存活 | `prewrite_commit_lost` | 窗口捕获 | 对账 |
|---|---|---|---|---|---|---|
| `durable`（等 `oncomplete`） | 100 批 × 10 | 31 ms | **1000/1000** | 0 | — | ✅ |
| `pending-d0` | 100 批 × 10 | 0 ms | **0/1000** | 1000 | 是 | ✅ |
| `pending-d5` | 100 批 × 10 | 6 ms | **0/1000** | 1000 | 是 | ✅ |
| `pending-d20` | 100 批 × 10 | 21 ms | 1000/1000 | 0 | 否（提交已先完成） | ✅ |
| `pending-d60` / `d200` | 100 批 × 10 | 62 / 201 ms | 1000/1000 | 0 | 否 | ✅ |
| `bulk-d0`（每事件 16 KB） | 500 批 × 10 | 11 ms | **0/5000** | **5000** | 是 | ✅ |
| `preflush-d0`（提交节流窗口人为放大） | 100 批 × 10 | 0 ms | **0/1000** | **0** | 否 | ❌ 差 1000 |
| `preflush-small`（**默认配置**，10 批 < `commitBatchSize`） | 10 批 × 10 | 0 ms | **0/100** | **0** | 否 | ❌ 差 100 |

WebKit（`kill = SIGKILL via 启动后记录的 launch-pids`）：

| 格子 | 强杀时机 | 读回存活 | `prewrite_commit_lost` | 窗口捕获 | 对账 |
|---|---|---|---|---|---|
| `durable` | 16 ms | **1000/1000** | 0 | — | ✅ |
| `pending-d0` | 0 ms | **0/1000**（另一次运行是 1000/1000：提交先于强杀完成） | **0**（该次运行） | 否 | ❌ 差 1000 |
| `pending-d5` | 6 ms | **0/1000** | 1000 | 是 | ✅ |
| `pending-d20`…`d200` | 21–202 ms | 1000/1000（提交已先完成，未捕获窗口） | 0 | 否 | ✅ |
| `bulk-d0`（16 KB × 500 批） | 11 ms | **0/5000** | **5000** | 是 | ✅ |
| `preflush-d0` / `preflush-small` | 0 ms | **0/1000 / 0/100** | **0** | 否 | ❌ 差 1000 / 100 |

> 窗口宽度（本实现、批 100）：Chromium 在 Δt=5 ms 仍是 0/1000、Δt=20 ms 已 1000/1000 → 暴露窗口落在 **5–20 ms**；
> 大负载（82 MB）在 11 ms 时确定仍在窗口内。这与 D004 引用的 POC 数据（p50 1–4.1 ms、p95 3–17 ms）量级一致。

## 偏差 D-1（**与 D004 结论第 1 条不符**，未修实现，按任务要求登记）

**现象**：预写之后、flush 的 intent 锚点落盘之前硬杀，事件**全部丢失且完全不计入暴露窗口**：
`prewrite_commit_lost = 0`，`exposure_window_events` 也不会出现。三种实测形态：

- `preflush-small`（**默认配置**，10 批 < `commitBatchSize`=100，flush 要等 200 ms 定时器）→ 0/100 存活、计 0；
- `preflush-d0`（提交节流窗口人为放大到 1000 s）→ 0/1000 存活、计 0；
- WebKit `pending-d0`（**默认配置、100 批**，flush 已排队但它的 `putMeta(intent)` 尚未完成）→ 0/1000 存活、计 0。

对照：同一批配置下如果 kill 落在 intent 已落盘、记录事务在途的那一段，则完全可对账
（WebKit `pending-d5` 0/1000 + 1000；两引擎 `bulk-d0` 0/5000 + 5000）。**差别只在锚点有没有落盘。**

**根因（源码级，只读定位）**：intent 锚点只在 `flush()` 内写 ——
`packages/transport/src/offline/offline-store.ts:390-400` 先 `putMeta(intent)`，再提交记录事务；
而 `prewrite()`（同文件 `:507-540`）只把记录放进内存 `pending` 并同步累加 `totalEnqueued`。
因此「事件已产生但锚点还没落」这段窗口在库里**没有任何痕迹**，重启后 `reconcileCommitLoss()`
（`:284-340`）找不到该会话的 intent，`lost` 计为 0。

**影响面**：`prewrite` 返回即代表「已产生」，D004 把暴露窗口定义为「已产生但事务尚未提交」，
所以这段属于暴露窗口；按 T32 的三类分列口径，这些事件会落进「无法归类」——
既不进「硬杀已落盘（不丢）」，也不进「暴露窗口内未提交（按条数与时长计量）」，看板会少报。
窗口长度 = `commitIntervalMs`（默认 200 ms）与 `commitBatchSize`（默认 100）中先到者的等待时间。

**建议（不在 T29 权限内实施）**：intent 锚点在 `prewrite()` 里同步（或按批）写一次，
使「已产生」在库里有痕迹；或把该窗口明确定义为不计入并写进 D004/T32 口径。
需负责人选一条 → 若选前者属实现变更，若选后者属决策记录变更。

## 方法学教训（T32 直接复用，避免重复踩）

1. **强杀 WebKit 不能只杀 `pw_run.sh`**：它只是包装脚本，真身是
   `.../webkit-2287/Playwright.app/Contents/MacOS/Playwright` 及 XPC 辅助进程。只杀包装脚本时，
   「强杀」后事务仍会提交，落盘率虚高到 100%（本会话第一版 webkit 数据因此作废、已重做）。
2. **进程清理必须按 profile，不能按浏览器构建目录**：按构建目录 `pgrep` 会杀掉**并行 worker** 里
   同一浏览器的实例（实测报 `Target closed`）。`tests/e2e/lib/harness.mjs` 现在按每个格子独有的
   `user-data-dir` 匹配。
3. **必须先证明「窗口真的被捕获」再报落盘率**：判据是重启后 `prewrite_commit_lost > 0`。
   小负载（100 批）在 WebKit 上提交快于 Playwright 往返，Δt=0 的对照组也会 100% 存活 ——
   那不是「未 `oncomplete` 也持久」，而是根本没在 `oncomplete` 之前杀掉。
4. **重启打开必须与首次打开用同一组 `limits`**：否则大负载会被默认 `maxBytes=5 MB` 淘汰，
   把「SDK 主动淘汰」误判成「硬杀丢失」。本会话一度据此怀疑 WebKit 事务非原子
   （2300/5000 可读、`commitLost=0`），用**不经过 SDK 的原始 IDB 计数**（`records/summaries` 各 500 条、
   intent `total_committed=5000`）才定位到是 harness 自己的上限不一致。对齐后 5000/5000。
   `d004-run.mjs` 现在会在重启时淘汰非 0 时**直接判本次测量无效并抛错**。

## 局限（未覆盖部分）

- **Firefox 未测**：本机沙箱内 Firefox 主进程 `sandbox_init()` 无法嵌套，`launchPersistentContext` 卡在
  juggler 握手直到超时。补测：在非 DSH 沙箱的会话里跑 `pnpm test:e2e --project=firefox`（**不要设任何 `MOZ_*` 变量**）。
- 只用 headless；未覆盖无痕模式、存储压力驱逐、真机 iOS/Android Safari。
- 驱动不是仓库锁定的 1.64.0（它要求的 chromium-1248/firefox-1555/webkit-2370 本机未装）：
  Chromium 在 1.64.0 下也能启动且 D004 结论相同，WebKit 只有精确配对的 1.60.0 能启动。
  锁定版本的完整矩阵需要先 `playwright install`（需批准）。
- 每格样本 100 或 500 批（1000/5000 事件），单次运行；WebKit 的 `pending-d*` 未捕获到窗口，
  因此 WebKit 的「小负载暴露窗口」没有数字。
