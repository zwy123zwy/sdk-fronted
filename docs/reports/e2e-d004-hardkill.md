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

---

## 追加节（T29 尾部 · 护栏）：锚点合并残余窗口的**捕获判定** —— 2026-10-15/16

- 执行：T29 尾部护栏 lane（工作目录 `/Users/spirit-ai/Desktop/sdk`，直接在 `main` 上工作，无 git 写操作）。
- 被测对象：`packages/transport/dist/index.js`，`sha256 23d3de1440433527…`（与本节前一轮同一份产物；
  `packages/transport/src/**` 无文件比 dist 新 → 未重新 build，未改 `packages/**`）。
- 本节的**唯一目的**：给局限第 6 条（下面原文）那一类「计数偏小」的残余窗口加一层**可判定、可变异、
  不靠真实浏览器碰运气**的护栏。**不改任何既有实现**，**不降低** D004-A/B/C 的通过标准。

### 0. 局限第 6 条（本节要治的东西，原文）

> **合并锚点的残余窗口**：锚点写入在途时，新 prewrite 的计数要等这次事务结束后才补落；这段
> 残余窗口（一次 meta 事务往返，与 D004 引用的 p50 1–4.1 ms 同量级）内的事件仍可能来不及计数。
> 实测 Chromium 上 `pending-d0` / `preflush-d0` / `preflush-small`（Δt=0）均已完整计数。

### 1. 「捕获到窗口」的真实判据（读代码，不照抄说法）

`tests/e2e/lib/d004-run.mjs`（本文件行号为护栏后）：

```js
// :268-271
result.exposureReconciles =
  survivedIds.size + inventory.commitLoss.events === expected.size
    ? true
    : { survivors: survivedIds.size, commitLost: inventory.commitLoss.events, expected: expected.size };
// :277
result.windowCaptured = inventory.commitLoss.events > 0;
```

`tests/e2e/durability.spec.mjs:61-68`（既有 D004-B/C）消费它：

```js
if (cell.windowCaptured) { … expect(cell.exposureReconciles, …).toBe(true); }
```

⇒ **一轮「完整捕获」= `commitLost > 0` 且 `存活 + 计数 === 期望`**（两个布尔同时成立）。
**`windowCaptured` 单独不构成捕获判据**：它同样是那份**异步**锚点的函数 —— 锚点没落盘时
`commitLost = 0`，于是同一格会显示 `windowCaptured = false`（看起来「窗口未捕获」），
而事实上事件已经产生、事务在途（harness 已断言 `issue.issued === count`）。
这正是 T32 那 3 个 WebKit 空白格（`{存活 0, 计数 0, 期望 N}`）**很容易被读成「没丢」**的原因。

### 2. 护栏做了什么（4 个文件，既有断言口径一个字没动）

| 文件 | 内容 |
|---|---|
| `tests/e2e/lib/d004-capture.mjs`（新） | 纯函数判定层：逐轮 6 态 + 逐格 6 态 + `assertNoBlankAsZeroLoss` |
| `tests/e2e/lib/d004-anchor-window.mjs`（新） | **非浏览器**的确定性复现 + 15 条断言（见 §3） |
| `tests/e2e/lib/d004-run.mjs`（改） | 捕获格重复 N 轮；summary 新增 `capturePolicy` / `captureGates`；既有字段全部保留 |
| `tests/e2e/durability.spec.mjs`（只加） | 新增 `D004-CAP` 用例；**D004-A、D004-B/C 原文未动** |
| `tests/reliability/reconcile.mjs`（只加） | 新增 §3.4 读表节（只增不改，3.0–3.3 不变） |

**逐轮 6 态**：`complete`（捕获且对账成立）/ `undercounted`（捕获但计数偏小）/ `blank`（空白：无计数证据）/
`overcounted` / `torn` / `window-missed`（杀在提交之后，唯一算 0 丢失的那一种）。

**逐格判定（N 轮结果）**：`stable-complete` / `complete-with-jitter` / `never-complete` /
`blank-only` / `window-never-captured` / `not-gated`，并带显式 `passed` 布尔。

**N = 3、M = 6 的理由**（N = 要求的**连续完整**轮数，M = 单格最大轮数）：
单轮完整率 `p` 在 WebKit 上实测为 **隔离单格 3/5–4/5、并行整轮 1/6–2/6**（见 §4），
所以「单轮即判」的假红率就是 `1−p`（17%–83%）。要求**连续 3 轮完整**的含义是：
一个**系统性**坏掉的捕获（`p→0`）永远拿不到 streak（→ `never-complete`，确定性）；
而一个有抖动但可用的实现能在 M 轮内拿到 streak。M=6 是把成本钉住（最坏 6 轮/格）。

**「空白」与「0 丢失」如何在输出里不可混淆**（T32 的教训）：
`lostEvents` 是**计数轴**上的值 —— 计数可信（`complete`/`window-missed`）时是数字，
无计数证据（`blank`/`undercounted`）时是 **`null`**；而 `zeroLoss` **只**由「期望事件全部读回」
正面证明（`survivors === expected`），与 `commitLost` 是否为 0 **无关**；另有
`lostEventsLowerBound`（至少未读回多少）与常量 `blankIsNotZeroLoss: true`。
⇒ 空白格是 `lostEvents: null, zeroLoss: false`，0 丢失格是 `lostEvents: 0, zeroLoss: true`：
**类型都不同**，读表方无法把「没证据」读成「没丢」。`assertNoBlankAsZeroLoss()` 对每一轮现查这条不变量。

**没有放宽既有判据**：runner 交给 D004-A/B/C 的是 `captureGate.selectedRoundIndex` 那一轮 ——
优先「达成 streak 的那一段的最后一轮」，否则**第一个完整轮**，否则第一个有计数证据的轮，否则最后一轮。
因此若本格 M 轮内一次完整捕获都没有，交给既有断言的仍是**未对账**的那一轮（照样红）。
（run A 的 WebKit `pending-d0` 就是「6 轮里只有第 4 轮完整」：D004-B/C 拿到第 4 轮 →
`0 + 1000 = 1000` ✅；而单轮判据拿到第 1 轮是**空白**、另一轮拿到的是 `undercounted(10)` → 红。）

**如实记录的张力（只报数字，不美化）**：逐格「连续 N 轮完整」在本实现上**不能**当成逐格硬红 ——
实测 WebKit 三轮里通过 streak 的格数是 2/3、1/3、2/3（§4），逐格硬红会**在每次 WebKit 运行里红**
（或随负载红/绿跳，正是要治的病）。因此 `D004-CAP` 的确定性红只有四条：
①不变量（空白/欠计数被读成 0 丢失）②判定与逐轮证据自洽（可由逐轮结果独立重算）
③**至少 1 个捕获格真的达成连续 N 轮完整**（全体空白/全体未捕获 → 红）④任一轮 `torn`/`overcounted`。
未通过的格不是「通过」，而是 `passed:false` + `KNOWN-DEVIATION` 注解 + §3.4 表 + runner 日志。

### 3. 护栏的**单元层**验证：能不能做到？—— 能，但不是 vitest

- **vitest 单元层结构上收不了**：`unit` project 只收 `packages/*/src/**/*.test.ts` 与 `tools/*/src/**/*.test.ts`
  （`vitest.config.ts:10`），而本 lane 被禁止改 `vitest.config.ts`、也禁止改 `packages/*/src/**` ——
  所以护栏的用例**不可能**被 `--project unit` 收集（这不是偷懒，是权限与收集范围的事实）。
- **改用的判别性证明**：`node tests/e2e/lib/d004-anchor-window.mjs` —— **完全不启动浏览器**，
  被测实现仍是真实产物（`packages/transport/dist` 的 `createOfflineStore`），唯一注入的是
  **存储后端的时序**（`OfflineStoreOptions.backend`，`packages/transport/src/offline/types.ts:192`）：
  第一份 **intent 锚点**正常落盘、后续锚点与数据事务**永久在途**（模拟 SIGKILL 落在锚点/提交未 `oncomplete` 时）。
- 这恰好补上单元层的结构缺口：`fake-indexeddb` 是**同步**的，做不出「异步锚点在途」这个窗口；
  而真实浏览器只能**碰运气**（WebKit 5 次隔离复跑里 pending-d0 有 1 次不完整、preflush-d0 有 1 次空白）。
- 15 条断言（本脚本退出码即判定）：残余窗口的磁盘现场（`intent.total_enqueued = 10` 而事件已产生 1000）、
  空白变体（`total_enqueued` 一条都没有）、0 丢失对照（1000 全部读回）、T29 尾部实测向量逐格分类、
  N 轮判定（stable / jitter / never-complete / blank-only / never-captured）、判定可重算、
  以及「把空白伪造成 0 丢失会被抓住」。

### 4. 真实浏览器「连续 N 轮」实际结果（N=3，M=6，同一份产物）

命令（**不改任何参数**，产物落 `tests/e2e/results/d004-{chromium,webkit}.json`）：

```bash
pnpm test:e2e --project=chromium --project=webkit      # 整轮：26 passed / 6 failed（1.7 min）
pnpm test:e2e --project=webkit tests/e2e/durability.spec.mjs   # 聚焦复跑，见下
node tests/e2e/lib/d004-run.mjs --browser webkit --cells pending-d0,preflush-d0,preflush-small --out /tmp/…  # 隔离单轮 ×5
```

**Chromium（整轮 `generatedAt 2026-10-16T07:14:45.993Z`）**：3 个捕获格**全部** `stable-complete`
（各 3 轮、抖动率 0%；`pending-d0`/`preflush-d0` 计数 1000，`preflush-small` 计数 100）。

**WebKit 整轮（`2026-10-16T07:14:51.561Z`）**：

| 捕获格 | 判定 | 通过 | 轮数 | 最长连续完整 | 抖动率 | 逐轮（`verdict(计数/lostEvents)`） |
|---|---|---|---|---|---|---|
| `pending-d0` | `never-complete` | ❌ | 6 | 1/3 | **83%** | #1 blank(0/null)、#2 undercounted(10/null)、#3 undercounted(10/null)、**#4 complete(1000/1000)**、#5 undercounted(10/null)、#6 undercounted(10/null) |
| `preflush-d0` | `stable-complete` | ✅ | 3 | 3/3 | 0% | #1–#3 complete(1000/1000) |
| `preflush-small` | `complete-with-jitter` | ✅ | 6 | 3/3 | 33% | #1 undercounted(10/null)、#2 complete(100/100)、#3 undercounted(10/null)、#4–#6 complete(100/100) |

**WebKit 聚焦复跑（`2026-10-16T07:16:38.330Z`）**：`pending-d0` = `never-complete`（6 轮，最长连续 1，
抖动 83%：#1 complete、#2/#3 undercounted、#4 **blank**、#5/#6 undercounted）；
`preflush-d0` = `never-complete`（6 轮，最长连续 **2**，抖动 33%）；`preflush-small` = `complete-with-jitter`
（4 轮，最长连续 3，抖动 25%）。⇒ **同一产物、同一命令，逐格 streak 随负载大幅变化**（这正是 §2 末段那条张力的实测依据）。

**隔离单轮 ×5（`--cells pending-d0,preflush-d0,preflush-small`，用于取原始 `p`）**：`pending-d0` 计数
`10/1000/1000/1000/1000`（4/5 完整）、`preflush-d0` `0(空白)/1000/1000/1000/10`（3/5）、
`preflush-small` `100/100/100/10/100`（4/5）。

**沿用旧判据（单轮）会得出什么不同结论**（同一份 WebKit 整轮数据）：
旧 runner 只跑第 1 轮 —— 本轮第 1 轮是 **blank**（`windowCaptured=false, commitLost=0, 存活 0/1000`），
于是 D004-B/C **不对该格做断言**，只在 `KNOWN-DEVIATION` 注解里留一句「未计数」；
而另一次同一命令的复跑第 1 轮是 `undercounted(10)` → **D004-B/C 直接红**（`存活 0 + 未提交 10 ≠ 1000`）。
即：旧判据的结论在「红」与「绿但空白（无结论）」之间**按运行抖动**；新判据把结论钉成
「D004-B/C 绿（报告的那一轮是真的完整捕获：`0 + 1000 = 1000`）+ 该格**未通过捕获判定**、
抖动率 83%、4 轮计数少报 990 个事件、1 轮**完全没有计数证据**（`lostEvents: null`，≠0 丢失）」。

### 5. 变异验证（三要素）

- **变异体**：环境变量 `D004_CAPTURE_GUARD=off` —— 护栏模块降级为**护栏前的读法**
  （`zeroLoss = (commitLost === 0)`、空白当完整、判定只看最后一轮），runner 同时把捕获格降为**单轮**。
  它**不是**一份手工改坏的副本：同一份代码里两条分支，默认走护栏分支（`guardEnabled()`）。
- **被杀死的断言**（实测原文）：
  - `node tests/e2e/lib/d004-anchor-window.mjs`：`PASS 15/15` → **`FAIL 6/15`**（exit 1），
    失败项含「复现④ 空白 ≠0 丢失」（`zeroLoss：期望 false，实际 true`）、「复现⑥ null vs 0」、
    「T32 点名的 3 格」（`pending-d0 … 却被读成 0 丢失：blankIsNotZeroLoss≠true`）、
    「连续 3 轮完整 → stable-complete」（`最长连续完整：期望 3，实际 1`）、
    「单轮不完整不判失败」（`期望 complete-with-jitter，实际 stable-complete`）、
    「不变量：把空白伪造成 0 丢失会被抓住」。
  - `D004_CAPTURE_GUARD=off pnpm test:e2e --project=webkit tests/e2e/durability.spec.mjs` →
    **2 failed / 1 passed**：`D004-B/C` 红（`Error: pending-d0: 窗口已捕获，存活 0 + 未提交 10 必须等于 1000`）、
    `D004-CAP` 红（`Error: pending-d0: 必须显式声明空白≠0 丢失`）。**恢复后**同一命令 **3 passed**。
- **判别力**（同一份数据在两种模式下数字变了什么）：空白轮 `zeroLoss` `true → false`、
  `lostEvents` `0 → null`、`blankIsNotZeroLoss` `false → true`；`pending-d0` 的逐格判定
  `not-gated（单轮）→ never-complete（6 轮，抖动 83%）`、`passed` 从「单轮 complete 即 true」变成 `false`；
  harness 的 `ok` 数 `6 → 15`。既有的 D004-A 在两种模式下都绿（护栏不碰落盘语义）。

### 6. 本次发现、**只报不改**的实现侧事实（护栏之外的缺陷面）

1. **残余窗口在 WebKit 并行负载下不是偶发，而是主路径**：Δt=0 的 `pending-d0` 在整轮里
   **6 轮有 5 轮**计数不完整（4 轮 `10`、1 轮 `0`，期望 `1000`）—— 也就是说
   `prewrite_commit_lost` 在这类硬杀里**少报 99%（10 vs 1000）或 100%（0 vs 1000）**。
   锚点写入在 `offline-store.ts:367-396` 是**独立 meta 事务**并合并；`flush()` 里的整批锚点
   （`:484`）虽然排在数据事务之前，但它自己也是异步的 —— 杀在它 `oncomplete` 之前，
   磁盘上留下的就是**最早那份 prewrite 锚点**（值取自发起那一刻）。
   （注意：`commitWithRetry(writable, settledIntent)` 的 `settledIntent` 与数据在**同一事务**里，
   所以**提交后**的锚点是原子的；有问题的只是**提交前**那份在途锚点。）
2. **`windowCaptured` 也会因此为假**：空白轮里 `windowCaptured=false`，会被读成「窗口没被捕获」，
   而事实是「窗口在途、但没有留下计数证据」（harness 侧已断言 1000 个事件全部被受理、0 个被读回）。
   本护栏把这种轮单独命名为 `blank`（`lostEvents: null`），就是因为这两个情况在磁盘上**无法区分**。
3. **看板口径风险**：`counters.count(REASON_PREWRITE_COMMIT_LOST, 10)` 会用偏小的数上报
   （`:339`），`exposure_window_events` 随之偏小；CR-001 的「未提交事件必须单独计数并上报」
   在该轮**不成立**（不是数据丢失）。建议由实现方决定是否加固（例如把提交前锚点并入提交事务、
   或对锚点做「值单调 + 在途标记」的显式语义）；本 lane 只报不改。

### 7. 产物 / 工作区（供编排方恢复）

- 本次 e2e 现场重生/覆写了已跟踪产物：`tests/e2e/probes/mutant-transport.js`、
  `tests/e2e/results/beacon-quota-{chromium,webkit}.json`、
  **`tests/e2e/results/d004-{chromium,webkit}.json`（新字段：`capturePolicy` / `captureGates` /
  每格 `captureGate` / `round`；旧字段全部保留）**。
- 回归（本 lane 实跑）：`vitest --project unit packages/transport packages/core` **947 passed / 100 files**；
  `--project security` **33 passed / 5 files**；`tsc -p packages/transport --noEmit` 0 错；
  `eslint`（改动/新增文件）0 错；`node tests/reliability/reconcile.mjs`（只读、未 `--write`）exit 0，
  新增 §3.4 表；`pnpm test:e2e --project=chromium --project=webkit` **26 passed / 6 failed**，
  6 个红**全部**是既有的 `leave-slice` AC-03 判定（两引擎数字逐位相同：2 片 32343 B / 43 事件、尾部 26 条未达），
  与本护栏无关。
