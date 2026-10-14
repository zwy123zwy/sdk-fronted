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
| 真实 3 标签页接管（AC-17） | ❌ **发现缺陷** | 见 D-2：真实 Web Locks 端口抛 `Illegal invocation`；BroadcastChannel 路径正常（恰好 1 个 leader） |
| 真实无 Web Locks（AC-18） | ✅ 做完 | 在真实 `Navigator.prototype` 上删除 `locks` → 3 标签页仍恰好 1 个 leader，且模式全为 `broadcast` |
| bfcache | ⛔ 未覆盖（环境） | 真实 `goBack()` 的 `navigationType=back_forward`，但 `pageshow` 的 `persisted` **全为 false** → Playwright 驱动的导航没有走 bfcache 恢复。补测：用有头浏览器手工前进/后退，或换用不经过 CDP 的导航 |
| 真实 `QuotaExceededError` | ⛔ 阻塞（配额） | 真实 `navigator.storage.estimate()`：Chromium quota 10.7 GB / WebKit 20.6 GB。构造真实配额耗尽需写入 10 GB+，不现实。补测：在 Chrome DevTools 里用 `Storage` 面板压低配额，或等 T31 存储压力场景 |
| Chromium 里的 K02 发布物验签（K02-AC-03） | ⛔ 未做 | K02（`tools/config-signer`）当前只在 Node 侧验签；浏览器侧验签路径（WebCrypto/SubtleCrypto）在实现里不存在，README 已写明该条不算通过。需要先有签名校验的浏览器实现，才能做端到端验签 |
| 真机 iOS / Android Safari | ⛔ 不做 | 本会话无真机；属 T30 兼容矩阵范围 |

## 缺陷（登记，未修实现 —— T29 无权改 `packages/*/src`）

### D-2（P1，只有真实浏览器能发现）：`createDefaultLocksPort()` 在真实浏览器里必然抛错

- 位置：`packages/transport/src/leader/leader.ts:65` `createDefaultLocksPort()`
- 现象：`TypeError: Failed to execute 'request' on 'LockManager': Illegal invocation`，Chromium 与 WebKit **都必现**（本次 3 个标签页 × 2 引擎全部抛错）。
- 根因：`const request = manager?.request;` 把方法取出后**裸调用** `request(name, {...}, cb)`，丢失了 `this`。Web IDL 方法要求正确的接收者。
- 影响：`createDefaultLocksPort()` 是公开导出、且是接入方启用 Web Locks 的唯一途径；调用即让 `LeaderElection.run()` 直接 reject。单元测试用的是假端口（`locks: { tryAcquire }`），所以从未暴露。
- 复现：`pnpm test:e2e --project=chromium --grep "真实 Web Locks"`（用例 C1 即为该缺陷的红灯）。
- 建议修法（需实现方决定）：`const request = manager?.request?.bind(manager)`，或直接调用 `manager.request(...)`；补一条用**真实 `navigator.locks`** 的测试。

### D-3（P1，接线缺失）：Web Locks 端口在整个 SDK 里**从未被接线**

- 证据：`grep -rn "createDefaultLocksPort\|locks:" packages/*/src --include=*.ts`（排除测试）只有
  `delivery.ts` 的透传与 `leader.ts` 的定义；`createDefaultLocksPort()` 在 `packages/*/src` 中**零调用**，
  `packages/browser/src/assembly.ts` 也没有传 `locks`。
- 影响：`createDelivery` 的 `locks` 缺省为 `undefined` → `createLeaderElection({locks: null})`
  → **选主永远走 BroadcastChannel**，AC-17 里的 Web Locks 路径实际不可达（即使 D-2 修好也不会被用到）。
- 处置建议：T18/T16 的所有者确认「是否要默认接线 Web Locks」；若不需要，应删掉该公开导出或明确标注未接线，避免接入方踩 D-2。

## 实测花絮（供后续参考，非缺陷）

- 真实 `reload` 在 Chromium/WebKit 上触发的是 `visibilitychange → hidden`，**没有** `pagehide`；
  对「离开即送达」的验证要两种信号都覆盖。
- headless 下 `page.bringToFront()` 不改变可见性，真实切后台的 `visibilitychange` 只能在有头浏览器测。
- 离开通道确实按预算切片：5 个 critical 事件 → 1 个请求 1112 B；`leave.stats()` 为 `{sent:5, skipped:0, bytes:1112, requests:1}`。

## 门禁现状

- `pnpm test:e2e`（`playwright test`，收集 `tests/e2e/**`）：Chromium/WebKit 共 14 个用例，
  **12 通过、2 失败**，失败的 2 个是 C1（D-2，两引擎各一）。这是**如实红灯**，不是用例问题。
- `firefox` project 在本机沙箱内**必然失败**（无法启动，见 `tests/e2e/README.md`）。
- `pnpm gates` 不含 `test:e2e`，因此本次新增文件不影响既有门禁；`pnpm exec eslint tests/e2e` 为 0 错。
