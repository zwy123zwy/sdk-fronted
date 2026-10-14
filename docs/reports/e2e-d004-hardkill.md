# T29 / D004 硬杀落盘复测（真实 Chromium + WebKit，`packages/transport` 真实实现）

- 执行：A09（T29），2026-10-14；**D-1 修复后第二轮复测 2026-10-14（Chromium）**
- 被测对象：`packages/transport/dist/index.js`（单包 build 产物；源码 `packages/transport/src/offline/**`）。
  第一轮 sha256 前缀 `26c232e4112442c6`（含 D-1）；第二轮（已修）sha256 前缀 `454fbb9008176f86`，107257 B
- 驱动/浏览器：`playwright-core@1.60.0`（树外只读，revision **精确配对**）+ 本机已装 chromium-1223 / webkit-2287，headless，每次全新持久化 profile
- 原始数据：`tests/e2e/results/d004-chromium.json`（第二轮已修，Chromium）、`tests/e2e/results/d004-webkit.json`（第一轮，含 D-1，尚未在修复后复跑）
- 一键复现：`pnpm test:e2e --project=chromium --project=webkit`（D004 两个用例）；逐格原始数字：`node tests/e2e/lib/d004-run.mjs --browser chromium`

## 结论（对 D004「结论」第 1 条逐句）

| D004 的承诺 | 实测 | 判定 |
|---|---|---|
| 已确认落盘（事务 `oncomplete` 已返回）的 critical 事件，硬杀下不丢 | Chromium 1000/1000（`settled` 全部为 `durable`，重启后逐条 `read()` 校验 `event_id` 与条数全等） | **成立** |
| 落盘点是且仅是 `oncomplete`（事务在途时不得有可读回记录） | 事务在途时硬杀：可读回 0，且没有任何半落盘批次；锚点落痕只写 `meta`，不写 `records` / `summaries` | **成立** |
| 暴露窗口内未提交的事件必须**单独计数并上报** | 修复后 Chromium：窗口捕获的 4 个格子全部 `存活 + prewrite_commit_lost == 期望`；`preflush-d0` / `preflush-small` 从「丢失且计 0」变为「计 1000 / 100」 | **成立（D-1 已修，见下）** |

## 数字（每格 2 次浏览器启动：预写 → 真 SIGKILL → 同 profile 重启读回）

Chromium **第二轮（D-1 已修）**，`kill = SIGKILL via CDP SystemInfo.getProcessInfo`：

| 格子 | 预写 | 强杀时机（发出后） | 读回存活 | `prewrite_commit_lost` | 窗口捕获 | 对账 |
|---|---|---|---|---|---|---|
| `durable`（等 `oncomplete`） | 100 批 × 10 | 17 ms | **1000/1000** | 0 | — | ✅ |
| `pending-d0` | 100 批 × 10 | 0 ms | **0/1000** | **1000** | 是 | ✅ |
| `pending-d5` | 100 批 × 10 | 6 ms | **0/1000** | **1000** | 是 | ✅ |
| `pending-d20` / `d60` / `d200` | 100 批 × 10 | 21 / 61 / 201 ms | 1000/1000 | 0 | 否（提交已先完成） | ✅ |
| `bulk-d0`（每事件 16 KB） | 500 批 × 10 | 10 ms | **0/5000** | **5000** | 是 | ✅ |
| `preflush-d0`（提交节流窗口人为放大） | 100 批 × 10 | 0 ms | **0/1000** | **1000** | 是 | ✅（修复前 0 ❌） |
| `preflush-small`（**默认配置**，10 批 < `commitBatchSize`） | 10 批 × 10 | 0 ms | **0/100** | **100** | 是 | ✅（修复前 0 ❌） |

> `pnpm test:e2e --project=chromium` 本轮 **7 passed**（含 durability `D004-A` / `D004-B/C`，以及 `real-browser.spec.mjs` 的「真实浏览器项 A：IDB 重载 / versionchange」）。
>
> WebKit（第一轮数据，含 D-1）见 `tests/e2e/results/d004-webkit.json`：本轮只被允许跑 Chromium，**修复后 WebKit 尚未复跑**；修复位于 IndexedDB 计数锚点、与引擎无关，但按 T29 的要求仍应在锁定版本上补跑。
>
> 第一轮（修复前）同一格数字：Chromium `preflush-d0` 0/1000 + 计 0、`preflush-small` 0/100 + 计 0、`pending-d0` 0/1000 + 计 1000；WebKit `pending-d0` 0/1000 + 计 0。

## 偏差 D-1（**已修**）

**原现象**（第一轮，T29 实测）：预写之后、flush 的 intent 锚点落盘之前硬杀，事件**全部丢失且完全不计入暴露窗口**（`prewrite_commit_lost = 0`）。三种形态：`preflush-small`（默认配置，10 批 < 100，flush 要等 200 ms 定时器）、`preflush-d0`（节流窗口放大到 1000 s）、WebKit `pending-d0`（flush 已排队但 `putMeta(intent)` 未完成）。

**根因**：intent 锚点只在 `flush()` 内写；`prewrite()` 同步只入内存 `pending` 并累加 `totalEnqueued`。重启后 `reconcileCommitLoss()` 找不到该会话的 intent，`lost` 计为 0。

**修复（`packages/transport/src/offline/offline-store.ts`）**：intent 锚点改为在 `prewrite()` 的**同一同步回合**落痕 —— `requestAnchor()` 内联调用 `backend.putMeta({ key: intent:… })`，IndexedDB 事务在 `putMeta` 里同步创建，窗口从 `commitIntervalMs`（默认 200 ms）缩到一次 meta 事务往返：

- **只为计数，不是 durability 点**：锚点只写 `meta`，绝不写 `records` / `summaries`；`list()` / `read()` 读的是内存索引与 `records`，因此未提交的数据不会因为锚点被当成已持久化读回。`oncomplete` 仍是唯一 durability 点（`PrewriteHandle.settled` 的语义未变）。
- **在途合并**：锚点写入在途时把后续 prewrite 合并为「最新一次」，不让热路径退化成逐条事务；写入值在真正写时按当前账目计算。
- **提交前置**：`flush()` 先 `pauseAnchors()`（暂停新锚点并等在途锚点 `oncomplete`），再写一次**整批**锚点，然后才创建数据提交事务 —— 于是 `settledIntent`（`total_committed = total_enqueued`）一定是最后写入的那一份，旧锚点不会覆盖它（否则正常路径会被多计成 lost）。
- **静默降级，零副作用**：锚点写入可能**同步**抛错（`versionchange` 已把连接关掉时 `requireDb()` 抛 `offline database is not open`）。`requestAnchor()` 用 try/catch 吞掉同步抛错、`.catch()` 吞掉异步拒绝，`prewrite()` 仍然不抛错、不阻断调用方；DB 恢复后由下一次 prewrite 或 `flush()` 的整批锚点补落。这正是「落痕不能变成新的失败点」的边界。
- **计数只计一次**：`REASON_PREWRITE_COMMIT_LOST` 仍然只在 `reconcileCommitLoss()` 里按 `total_enqueued - total_committed` 计一次，没有在 prewrite / flush 各计一遍。

**测试**（`packages/transport/src/offline/intent-anchor.test.ts`，新增）：
1. **不依赖 `fake-indexeddb` 的语义断言** —— `prewrite()` 返回后同一同步回合里锚点已写入后端 `meta`（`total_enqueued=1`、`total_committed=0`），且 `records` / `summaries` 为空、`list()` / `read()` 看不到该批次；
2. **锚点落盘后硬杀**（`commit` 永不 `oncomplete`）→ 重启对账 `prewrite_commit_lost == 3`，且计数恰好 3（只计一次）；
3. **正常路径**（等 `oncomplete`）→ 重启对账 0，不多计；
4. **锚点同步抛错**（versionchange 场景）→ `prewrite()` 不抛错，内存账目仍按暴露窗口计量。

**变异验证**：临时删掉 `prewrite()` 里的 `requestAnchor()`（`offline-store.ts:630`）→ 第 1、2 条断言红（`expected null to deeply equal {…total_enqueued: 1…}`；`expected 0 to be greater than 0`）→ 恢复后 4/4 绿。

**prewrite 延迟影响**（`tests/bench/c07-offline.bench.ts`，同步路径即 T16 的 ≤ 1 ms 口径）：

| 指标 | 基线（`run_id=vis-final`） | 修复后 | 契约 |
|---|---|---|---|
| 单条事件批次 p99 | 0.004667 ms | **0.005167 ms** | ≤ 1 ms（余量 193.5×） |
| 单条事件批次 p50 | 0.000917 ms | 0.000917 ms | — |
| 100 事件批次 p99 | 0.091625 ms | **0.090042 ms** | ≤ 1 ms（余量 11.1×） |
| 100 事件批次 p50 | 0.045250 ms | 0.045333 ms | — |

同步新增成本只有一次极小的 intent 序列化 + 合并后的 meta 事务发起；同 tick 的突发 prewrite 只发 1 次锚点事务（合并），且 IndexedDB 事务提交是异步的、不阻塞主线程。两次测量都在同一量级与噪声范围内，契约目标仍有 ≥11× 余量。

**影响面**：`prewrite` 返回即代表「已产生」，D004 把暴露窗口定义为「已产生但事务尚未提交」。修复后这段事件在库里有锚点可对账，T32 的三类分列口径能拿到数据：既不丢进「无法归类」，也不再把「flush 发起前」整段错算成 0。

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
5. **新增同步 I/O 要按「可能同步抛错」设计**：D-1 修复第一版让 `prewrite()` 同步经由
   `backend.putMeta()` → `requireDb()`，在 `versionchange` 关掉连接后把 `prewrite()` 打挂
   （`offline database is not open`，`real-browser.spec.mjs` 的「真实浏览器项 A」红）。
   同步落痕必须自带 try/catch 并静默降级，锚点失败不得成为新的失败点。

## 局限（未覆盖部分）

- **WebKit 修复后未复跑**：本轮只被允许跑 Chromium；`d004-webkit.json` 仍是含 D-1 的第一轮数据。
  补跑：`pnpm test:e2e --project=chromium --project=webkit`。
- **Firefox 未测**：本机沙箱内 Firefox 主进程 `sandbox_init()` 无法嵌套，`launchPersistentContext` 卡在
  juggler 握手直到超时。补测：在非 DSH 沙箱的会话里跑 `pnpm test:e2e --project=firefox`（**不要设任何 `MOZ_*` 变量**）。
- 只用 headless；未覆盖无痕模式、存储压力驱逐、真机 iOS/Android Safari。
- 驱动不是仓库锁定的 1.64.0（它要求的 chromium-1248/firefox-1555/webkit-2370 本机未装）：
  Chromium 在 1.64.0 下也能启动且 D004 结论相同，WebKit 只有精确配对的 1.60.0 能启动。
  锁定版本的完整矩阵需要先 `playwright install`（需批准）。
- 每格样本 100 或 500 批（1000/5000 事件），单次运行；WebKit 的 `pending-d*` 未捕获到窗口，
  因此 WebKit 的「小负载暴露窗口」没有数字。
- **合并锚点的残余窗口**：锚点写入在途时，新 prewrite 的计数要等这次事务结束后才补落；这段
  残余窗口（一次 meta 事务往返，与 D004 引用的 p50 1–4.1 ms 同量级）内的事件仍可能来不及计数。
  实测 Chromium 上 `pending-d0` / `preflush-d0` / `preflush-small`（Δt=0）均已完整计数。
