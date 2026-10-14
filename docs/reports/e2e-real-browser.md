# T29 真实浏览器项复测（Chromium + WebKit）

- 执行：A09（T29），2026-10-14
- 被测对象：`packages/browser/dist/web-report-sdk.iife.js`（T18 装配根的 IIFE 发布物）+ `packages/transport/dist/index.js`（真实实现）
- 驱动/浏览器：`playwright-core@1.60.0`（revision 精确配对）+ chromium-1223 / webkit-2287，headless；本地接收端与静态页都只监听 127.0.0.1
- 用例：`tests/e2e/real-browser.spec.mjs`；复现：`pnpm test:e2e --project=chromium --project=webkit`

## 逐项状态

| 真实浏览器项 | 状态 | 证据 |
|---|---|---|
| 真实 `crypto.randomUUID` | ✅ 做完 | 200 次全为合法 v4 且互不相同 |
| `crypto.randomUUID` 不可用时的回退 | ✅ 做完 | 真实 `crypto` 上删掉 `randomUUID` → 200 次仍全为合法 v4 且互不相同，探测后已恢复 |
| 真实 `location.search`（T12/T13） | ✅ 做完 | `readLocation()` 读到真实 `href`，`?e2e=1&x=2` 原样 |
| 真实 IDB 持久化（T12/T13） | ✅ 做完 | 写 7 事件 → 真实 `reload` → 同 profile 读回 1 批 / 7 事件 |
| 真实 `versionchange`（C07） | ✅ 做完 | SDK 打开 v1 后另一连接升 v2：**未被 blocked**，且随后写入明确失败（未静默丢） |
| 真实 `sendBeacon` 送达（AC-13） | ✅ 做完 | `leave` 通道经真实 `submit(batch,{channel:'page_leave'})`：`sent=5, requests=1, bytes=1112`，接收端真的收到 |
| 真实 80 KB 信标（AC-03） | ⚠️ 部分 | 单次 `navigator.sendBeacon(url, 80 KB)` 在 Chromium **与** WebKit 都返回 **false**（浏览器上限）；实现按预算切片（48 KB 上限）后成功。**AC-03 必须按切片路径验证，不能按「单次 80 KB 信标」验证** |
| 真实 `visibilitychange`（AC-15） | ⚠️ 部分 | 真实 `reload` 时真实实现订阅到 `visibilitychange → hidden`；**但 headless 下 `page.bringToFront()` 不改变 `visibilityState`（两页都 visible），无法复现真实切后台** |
| 真实 `pagehide` | ✅ 做完（触发为脚本派发） | reload 后在新文档重新订阅，把真实 `pagehide` 事件派到真实 `document` → 订阅路径收到。**注意：真实 `reload` 只观察到 `visibilitychange`，没观察到 `pagehide`** |
| 真实 XHR + 超时（T14） | ✅ 做完 | 对端 `/hang`：单次 `timeoutMs=300` → 共 4 次尝试、总 9.1 s（含退避）、终态 `failed` |
| 令牌吊销 401（M01 语义） | ✅ 做完 | 真实 `fetch` 打 `/revoked`（401）→ `failed` 且 `sender.isPaused() === true` |
| 真实 3 标签页接管（AC-17） | ✅ 做完（2026-10-14 复测） | D-2/D-3 已修：真实 Web Locks 端口不再抛错，3 个真实标签页恰好 1 个 leader、模式为 `locks`（见下「已修缺陷」） |
| 真实无 Web Locks（AC-18） | ✅ 做完 | 在真实 `Navigator.prototype` 上删除 `locks` → 3 标签页仍恰好 1 个 leader，且模式全为 `broadcast` |
| bfcache | ⛔ 未覆盖（环境） | 真实 `goBack()` 的 `navigationType=back_forward`，但 `pageshow` 的 `persisted` **全为 false** → Playwright 驱动的导航没有走 bfcache 恢复。补测：用有头浏览器手工前进/后退，或换用不经过 CDP 的导航 |
| 真实 `QuotaExceededError` | ⛔ 阻塞（配额） | 真实 `navigator.storage.estimate()`：Chromium quota 10.7 GB / WebKit 20.6 GB。构造真实配额耗尽需写入 10 GB+，不现实。补测：在 Chrome DevTools 里用 `Storage` 面板压低配额，或等 T31 存储压力场景 |
| Chromium 里的 K02 发布物验签（K02-AC-03） | ⛔ 未做 | K02（`tools/config-signer`）当前只在 Node 侧验签；浏览器侧验签路径（WebCrypto/SubtleCrypto）在实现里不存在，README 已写明该条不算通过。需要先有签名校验的浏览器实现，才能做端到端验签 |
| 真机 iOS / Android Safari | ⛔ 不做 | 本会话无真机；属 T30 兼容矩阵范围 |

## 缺陷（2026-10-14 已修 + 复测通过）

### D-2（P1，只有真实浏览器能发现）：`createDefaultLocksPort()` 在真实浏览器里必然抛错 —— ✅ 已修

- 位置：`packages/transport/src/leader/leader.ts:65` `createDefaultLocksPort()`
- 现象（修复前）：`TypeError: Failed to execute 'request' on 'LockManager': Illegal invocation`，Chromium 与 WebKit **都必现**（本次 3 个标签页 × 2 引擎全部抛错）。
- 根因：`const request = manager?.request;` 把方法取出后**裸调用** `request(name, {...}, cb)`，丢失了 `this`。Web IDL 方法要求正确的接收者。
- 修法：`request.call(manager, name, { mode: 'exclusive', ifAvailable: true }, cb)`，并在拿到 `manager` 后先判 `null`（happy-dom 的 `navigator.locks` 就是 `null`）。
- 回归防线：`packages/transport/src/leader/leader.test.ts` 的「默认 Web Locks 端口：以 LockManager 为接收者调用 request」——替身记录 `this`，断言 `this === globalThis.navigator.locks`。
- 变异验证（把 `request.call(manager, …)` 改回裸调用 `request(…)`）：该用例红灯，`AssertionError: expected undefined to be { request: [Function request] }`（`leader.test.ts:227`，裸调用时 `this` 是 `undefined`）。恢复后 23/23 绿。
- 复测（2026-10-14，Chromium）：`pnpm test:e2e --project=chromium --grep "Web Locks"` → C1、C2 两条 **全绿**；`pnpm test:e2e --project=chromium` → 7 passed。

### D-3（P1，接线缺失）：Web Locks 端口在整个 SDK 里**从未被接线** —— ✅ 已修

- 证据（修复前）：`grep -rn "createDefaultLocksPort\|locks:" packages/*/src --include=*.ts`（排除测试）只有
  `delivery.ts` 的透传与 `leader.ts` 的定义；`createDefaultLocksPort()` 在 `packages/*/src` 中**零调用**，
  `packages/browser/src/assembly.ts` 也没有传 `locks`。
- 影响：`createDelivery` 的 `locks` 缺省为 `undefined` → `createLeaderElection({locks: null})`
  → **选主永远走 BroadcastChannel**，AC-17 里的 Web Locks 路径实际不可达（即使 D-2 修好也不会被用到）。
- 修法（无需 core 变更）：装配根 `packages/browser/src/assembly.ts` 新增注入点
  `AssemblyOptions.locks`，缺省 `createDefaultLocksPort()`（有 Web Locks 才非 null），并传给
  `createDelivery({ locks })`；`DeliveryOptions.locks` 早已存在，只是从没有人接。
- 回归防线：`packages/browser/src/assembly.test.ts` 的「④ 选主端口接线」——替身 `navigator.locks`
  后断言 `delivery.metrics().leader.mode === 'locks'` 且替身收到的接收者正确；再来一条显式注入端口被透传。
- 变异验证（撤掉装配根的 `const locks = …` 与 `createDelivery({ locks })`）：两条用例红灯
  （`leader.mode` 停在 `'none'`，`waitFor` 超时，`assembly.test.ts:297` / `:315`）。恢复后 23/23 绿。
- 注意：`packages/browser/src/*.test.ts` 经包名解析 `@web-report-sdk/transport` 到**已构建的 `dist`**，
  所以改 `packages/transport/src` 后必须 `pnpm --filter @web-report-sdk/transport run build` 才能被装配测试看到。

## 实测花絮（供后续参考，非缺陷）

- 真实 `reload` 在 Chromium/WebKit 上触发的是 `visibilitychange → hidden`，**没有** `pagehide`；
  对「离开即送达」的验证要两种信号都覆盖。
- headless 下 `page.bringToFront()` 不改变可见性，真实切后台的 `visibilitychange` 只能在有头浏览器测。
- 离开通道确实按预算切片：5 个 critical 事件 → 1 个请求 1112 B；`leave.stats()` 为 `{sent:5, skipped:0, bytes:1112, requests:1}`。

## 门禁现状

- `pnpm test:e2e`（`playwright test`，收集 `tests/e2e/**`）：Chromium/WebKit 共 14 个用例。
  **2026-10-14 复测（Chromium）**：
  - `--grep "Web Locks"`（即 D-2/D-3 的靶心）：C1、C2 **全绿**（修复前 C1 两引擎各一红灯）。
  - 全量：**5 passed / 2 failed**。两个红分别是「真实浏览器项 A」与依赖它的 durability `D004-B/C`，
    失败是 `page.evaluate: Error: offline database is not open`（`versionchangeProbe` → `store.prewrite`
    → `requireDb`），**与本报告的 D-2/D-3 无关**：它由本次会话期间工作区里**他人未提交**的
    `packages/transport/src/offline/offline-store.ts`（intent anchor）引起；把该文件 `git stash` 后重建
    transport 再跑，用例 A 立即转绿，`git stash pop` 后复红。该文件的处置归其所有者。
  - 未复测：WebKit 与 Firefox（本次只允许跑 `--project=chromium`；firefox 在本机沙箱内无法启动）。
- `firefox` project 在本机沙箱内**必然失败**（无法启动，见 `tests/e2e/README.md`）。
- `pnpm gates` 不含 `test:e2e`，因此本次新增文件不影响既有门禁；`pnpm exec eslint tests/e2e` 为 0 错。
- 修复后的单测/类型/eslint（当前工作区状态）：`packages/transport` + `packages/browser` 的 unit project
  **294 passed / 35 files**；`tsc -p packages/transport`、`tsc -p packages/browser` 均 0 错；
  `eslint` 改动文件 0 错。体积：`packages/browser/dist/index.js` 11.30 kB（预算 35 KB，未触限）。
