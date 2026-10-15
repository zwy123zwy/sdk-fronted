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

## 追加节：AC-03（C07-AC-03 离开通道**切片路径**）实测 —— Chromium

- 执行：A09 子任务（AC-03 切片路径验证），2026-10-14
- 背景：T29 已实测**单次** 80 KB `sendBeacon` 在 Chromium 与 WebKit 都返回 `false`（见上「真实 80 KB 信标」一行），
  因此 AC-03 只能按**切片路径**验证；而 T29 只测了 5 个事件 / 1112 B / `requests=1`，**切片路径此前没有被测过**。
  本节只**追加**结论，不改 T29 已写的任何判定。
- 被测对象：`packages/transport/dist/index.js`（真实实现；本次改动只落在 `tests/e2e/**` 与本节，未改 `packages/` 下任何文件）
- 用例（新增，未改既有断言）：`tests/e2e/leave-slice.spec.mjs` + 探针 `tests/e2e/probes/leave-slice.html`、`probes/leave-slice-driver.js`
- 复现命令：
  - `pnpm test:e2e --project=chromium --grep "C07-AC-03"`（4 绿 / 2 红，红即本节的 AC-03 不合格判定）
  - 变异：`AC03_TRANSPORT_VARIANT=mutant pnpm test:e2e --project=chromium --grep "接收端送达"`

### 验收口径（`tests/acceptance/C07.md:9` 原文）

> | C07-AC-03 | C07-F1 | 页面离开时冲刷 80 KB 数据 | 使用信标通道，拆成至少两个不超过 60 KB 的请求；`Content-Type` 为 `text/plain`；令牌在 `auth` 字段 |

### 切片实现的关键参数（读自 `packages/transport/src/sender/`）

| 参数 | 值 | 出处 |
|---|---|---|
| 单请求上限 `BEACON_MAX_BYTES` | `60 * 1024` | `sender/constants.ts:32` |
| 切片阈值（传给 `sliceForBeacon`） | `BEACON_MAX_BYTES - 256` = `61184` | `sender/page-leave.ts:156` |
| 切片度量 | `estimateEventBytes(event) + 2` 累加，超阈值即开新片 | `sender/page-leave.ts:96-114` |
| 顺序 | 保持原事件顺序；`event_id` 不变、`batch_id` 每片重新生成 | 同上 |
| 离开预算 `LEAVE_BUDGET` | `{maxBytes: 49152, maxEvents: 200, maxBatches: 4, maxMs: 50}`（实测读到） | `sender/constants.ts:35-41` |
| 信标失败重试 | **不重试**：`sendBeacon` 返回 `false` 只 `counters.count('retry_network')` | `sender/page-leave.ts:186` |
| 离开通道终态 | `complete('failed')`，**不删离线副本**（AC-13） | `sender/delivery.ts:277-289` |

### 实测结果（真实 Chromium + 真实 `navigator.sendBeacon`，载荷 112 事件 / 序列化 83603 B / 估算 103600 B）

| 场景 | SDK 侧 `leave.stats()` | 接收端实际收到 | AC-03 |
|---|---|---|---|
| 对照组：单次 80 KB `sendBeacon` | — | `accepted=false`（复现 T29） | — |
| 对照组：单次 32 KB | — | `accepted=true`，真的到达 | — |
| **默认配置**（`leaveBudget` 不传） | `{sent:46, skipped:66, bytes:34575, requests:1}` | **1 片** 34575 B / 46 事件 / 起下标 66 | ❌ 不通过 |
| **预算放宽**（`leaveBudget.maxBytes=4 MB`） | `{sent:112, skipped:0, bytes:84030, requests:2}`，`counters={retry_network:1}` | **1 片** 49455 B / 66 事件 / 起下标 0（第二片被浏览器拒绝） | ❌ 不通过 |

- 每片均满足 `Content-Type: text/plain;charset=UTF-8`、令牌在 `auth` 字段（无 `x-write-token` 请求头）、
  片内事件顺序与原始一致、已送达部分**无重复无丢失**（按 `event_id` 逐项重组核对）。
  **但两次都没做到「拆成至少两个请求且 80 KB 全部送达」**，且丢失是静默的：默认配置丢前 66 条，
  放宽预算丢后 46 条，接收端只看到一个请求。

### 根因对照（与实现无关的纯浏览器特性刻画）

同任务内连续调用真实 `sendBeacon`：

| 尺寸序列 | 返回值 | 实际到达 |
|---|---|---|
| `[60 KB]` | `[true]` | `61440 B` |
| `[40 KB, 40 KB]` | `[true, false]` | 只有 `40960 B` |
| `[30 KB, 30 KB]` | `[true, true]` | `30720 B` + `30720 B` |
| `[49 KB, 34 KB]` | `[true, false]` | 只有 `50176 B` |

→ Chromium 除单次上限外还有**累计在途额度**（实测 ≈ 64 KiB）：两片合计 > 64 KiB 时，后一片的
`sendBeacon` 直接返回 `false`。因此「每片 ≤ 60 KB」这一条本身**不足以**让 80 KB 通过信标通道离页。

### 结论：AC-03 **不通过**（两条独立原因；切片算法本身正确）

1. **默认配置**：离开预算 `maxBytes=49152` **小于**切片阈值 `61184`，且预算判断是「整片丢弃」
   （`usedBytes + size > maxBytes` → `skipped`，不二次切片）。结果是**第一片（前 66 条）被预算整片丢掉**，
   只发出尾部 46 条 —— `requests=1`，AC-03 的「至少两个」与「80 KB」都不成立。
2. **预算放宽后**：实现确实切成了 2 片（`requests=2, sent=112, skipped=0`，切点/顺序/`event_id`/`batch_id`
   口径全部正确），但 49455 B + 34575 B 合计超过浏览器累计在途额度，**第二片被 `sendBeacon` 拒绝**
   （`retry_network=1`），46 条丢失。
3. 因此：**切片逻辑「此前只是没测」，不是坏的；坏的是参数** —— 片大小（≈60 KB）贴着浏览器上限，
   且离开预算（48 KB）比切片阈值还小。修复属实现方决策（如把片大小降到 32 KB 量级并让预算 ≥ 载荷 /
   对超预算的片二次切片），本节只报不改。
4. 另注：两条路径的丢失都没有对外的原因码（`beacon_rejected` / `flush_skipped_due_to_budget`
   按 D004 第 63-66 行**未登记**），只能从 `metrics().leave.skipped` 与内部 `retry_network` 计数看到。

### 变异验证（三要素）

- **变异体**：把真实产物复制一份，只把 `var BEACON_MAX_BYTES = 60 * 1024;` 改成
  `var BEACON_MAX_BYTES = 10 * 1024 * 1024;`（等价于关掉切片）。产物由 `beforeAll` 从 `dist` 现场生成到
  `tests/e2e/probes/mutant-transport.js`，`diff` 确认与 `dist` **只差这一行**；`packages/` 下无改动，
  不需要还原（不碰 `src`，每次运行重新生成）。
- **被杀死的断言**：`C07-AC-03 接收端送达…` → `slices.length >= 2`（判据函数 `ac03Violations` 同时报出
  `信标请求数 0 < 2` 与 `重组事件数 0 ≠ 原始 112（丢失 112）`）。真实产物在同一用例上是
  `信标请求数 1 < 2（丢失 46）`（且另有「浏览器拒绝了 1 次信标」），二者都是红。
- **判别力**：变异体下 `leave.stats().requests` 从 2 掉到 1、单请求体从 49455 B 涨到 83653 B，
  接收端从 1 片掉到 0 片（整批被浏览器拒绝）——同一判据两种红，说明用例对「切片存在/不存在」敏感；
  对照用例（单次 80 KB=false、32 KB=true、根因对照）与变异无关，保持绿。

### 本次未做

- WebKit：本次任务只允许 Chromium（`test.skip` 已写明原因）。
- 真实 `pagehide`/`visibilitychange` 触发的**队列**离页冲刷（本节从 `submit(batch,{channel:'page_leave'})`
  入口驱动，与 T29 的 AC-13 口径一致）；队列路径共用同一个 `createLeaveSender`，预算行为相同。

---

## 追加节（第 2 次）：AC-03 切片路径复测 —— `c931a73`（32 KiB 片 / 64 KiB 在途 / 96 KiB 预算 + 二次切片 + 波次让出）之后

- 执行：2026-10-15，独立验证 lane（**只跑不改**：未改 `packages/**`、`tests/**`、任何配置；无 git 写操作）
- 被测对象：`packages/transport/dist/index.js`（`sha256 f56b472e014b8acfc72c15b50446c2958e0dad62576e00e57f0748aab9c8e952`，mtime 2026-10-15 10:39:59；
  `packages/transport/src/**` 无任何文件比它新 → **dist 不落后于 src，未重新 build**）；仓库 `HEAD=c931a73`
- 环境：Node v24.16.0 / pnpm 11.18.0；跑前 `loadavg` 5.04、10 核；无残留 Chromium/WebKit（残留的只有一个 Playwright
  `test-server` pid 47909，非浏览器、不影响本次结果）
- 复现命令（两条都跑）：
  - `pnpm test:e2e --project=chromium --grep "C07-AC-03"` → **6 passed / 2 failed**（33.9 s）
  - `pnpm test:e2e --project=webkit tests/e2e/leave-slice.spec.mjs` → **4 passed / 2 failed**（24.5 s）
  - 逐请求**原始报文字节**由只读复测脚本另跑一次取得（复用 `tests/e2e/lib/*` 与同一探针，Chromium 与 WebKit 各一次）

### 判据逐条判定（Chromium 与 WebKit 数字**完全相同**）

| # | 判据 | 实测 | 判定 |
|---|---|---|---|
| 1 | 接收端 ≥2 个真实信标请求 | **3** 个（SDK 侧尝试 4 次） | ✅ 通过 |
| 2 | 重组 `event_id` 序列 = 原始 112 条，无重复无缺失 | **77 / 112**，缺失 35 条（`ac03-0070`…`ac03-0104`），重复 0 | ❌ **不通过** |
| 3 | 每请求 < 60 KB | 最大 **26391 B**（另有 26391 B、5559 B） | ✅ 通过 |
| 4 | `Content-Type: text/plain;charset=UTF-8` | 接收端三个请求都是 `"text/plain;charset=utf-8"`（**小写 `utf-8`**，Chromium/WebKit 一致） | ✅ 通过（前缀口径 `text/plain` 成立；与判据字面量的 `UTF-8` 大小写不同） |
| 5 | 令牌在 body `auth`，URL 无令牌 | 三请求 `body.auth={"app_id":"ac03","write_token":"tok-ac03"}`；`x-write-token` 头 = `null`；URL = `/beacon`，不含令牌 | ✅ 通过 |
| 6 | 对照：单次 80 KB = `false`、32 KB = `true` | `80 KB accepted=false`；`32 KB accepted=true`（真的到达 1 次）——两引擎一致 | ✅ 通过 |
| 7 | 先验：探针 `config()` 读到 `leaveBudget.maxBytes` | `{"maxBytes":98304,"maxEvents":200,"maxBatches":4,"maxMs":50}` → **98304**（可读，写法无问题） | ✅ 通过 |

### 接收端逐请求明细（原始报文，Chromium；WebKit 逐字节相同）

| 序 | URL | 字节 | 事件数 | `event_id` 区间 | `Content-Type` | 令牌位置 |
|---|---|---|---|---|---|---|
| #1 | `/beacon` POST | 26391 | 35 | `ac03-0000`–`ac03-0034` | `text/plain;charset=utf-8` | body `auth`，无请求头 |
| #2 | `/beacon` POST | 26391 | 35 | `ac03-0035`–`ac03-0069` | `text/plain;charset=utf-8` | body `auth`，无请求头 |
| #3 | `/beacon` POST | 5559 | 7 | `ac03-0105`–`ac03-0111` | `text/plain;charset=utf-8` | body `auth`，无请求头 |

- 接收字节合计 58341 B（事件原文合计 57289 B，原始事件数组 83329 B，整批序列化 83603 B）。
- SDK 侧自报：`leave.stats={"sent":112,"skipped":0,"bytes":84732,"requests":4,"budgetStops":0}`，
  `counters={"retry_network":1}`。预算放宽（`maxBytes=4 MB`）后 SDK 侧数字**一字不变**，接收端仍是这 3 片 / 77 条。

### 失败形态（哪一条、差多少、有没有 `retry_network`）

- 唯一失败的判据是 **#2（全量送达）**，差 **35 条事件 / 26391 B**；另两条红都源自它。
- 第 **4** 片（`ac03-0070`–`ac03-0104`，26391 B）**被浏览器拒绝**：SDK 侧 `requests=4` 而接收端只有 3 片，
  `counters={retry_network:1}` 恰好为 1 → 该片 `sendBeacon` 返回 `false`，事件既未重试也未再切，直接丢失。
- 被拒原因可由同批数据反推（浏览器累计在途额度）：接受到 26391+26391 = **58341 B** 时再请求 26391 B
  （累计 **79173 B**）被拒，随后 5559 B（累计 58341 B）却被接受 → 额度落在 **(65536, 79173] B**。
  与 `beacon-quota` 用例同机实测一致（`single-64K`→`true`、`sync-32x32`=65536 B→`true,true`、`sync-32x32x32`→`true,true,false`）。
- 两引擎（Chromium 9 项 / WebKit 9 项）额度刻画完全相同，**WebKit 的累计额度与 Chromium 无差异**。

### 本次观察到、但不在判据里的异常

1. **`Content-Type` 大小写**：实现传的 Blob type 是 `text/plain;charset=UTF-8`，两个引擎落到线上的头部都是
   `text/plain;charset=utf-8`（charset 小写）。判据 #4 若按字面量做全等比较会误判为不通过（HTTP 里 charset 大小写不敏感）。
2. **`leave.stats()` 是乐观自报**：接收端只到 77/112 条，SDK 侧仍报 `sent:112, skipped:0, budgetStops:0`；
   唯一线索是没有进 `leave.stats` 的 `counters.retry_network=1`。被 `sendBeacon` 拒绝的整片事件被计入 `sent` 且不再重切。
3. **估算器高估 24% 直接放大了片数**：单事件实际 743 B，`estimateEventBytes` 923 B（估 103600 B vs 实测 83603 B），
   于是 32 KiB 的阈值只产出 **26391 B** 的片 —— 80 KB 需要 **4 片**而不是 3 片；
   4 次尝试落在同一回合内，第 3 次就撞上累计额度。（同上：仅报数字）
4. **波次让出在当前默认路径上无实际效果**：接收端可见的拒绝发生在“第 3 次写”（累计 79173 B > 65536 B），
   说明让出没有把后续片推到下一个同步回合。默认 `schedule` 即刻执行（`sender/page-leave.ts` 的 `trackWave()`），
   探针未注入 `schedule`；此条为**读源码 + 浏览器额度证据**的推断，非直接观测。
5. `beacon-quota.spec.mjs` 里名为 “webkit” 的用例其实跑在 `--project=chromium` 下（spec 内部自己 `resolveBrowser('webkit')`），
   因此 `--grep "C07-AC-03"` 的 “6 passed / 2 failed” 里包含了一次 WebKit 取数；WebKit 的 AC-03 判定需显式
   `--project=webkit`（本次已单独跑）。
6. 变异自检仍然有效：变异体（关掉切片）下接收端 **0 片**、`retry_network=1`、判据报「信标请求数 0 < 2 / 丢失 112」→ 红，
   说明同一判据对“切片存在/不存在”敏感。

### 结论（只记数字，不给参数建议）

- `c931a73` 之后，AC-03 的 **#1、#3、#4、#5、#6、#7 全部通过**；**#2 仍不通过**：
  两个引擎都只有 3 片 / 77 条到达，稳定丢失尾部区间 `ac03-0070`–`ac03-0104`（35 条 / 26391 B），
  丢失形态为「第 4 片被浏览器拒绝且不重试」（`retry_network=1`）。默认配置与预算放宽两种情形的数字完全相同。

## 追加节（第 3 步 · 单元层）：**已改** —— 按同步回合约束 + 估算器校准 + 默认让出 + 丢失自报

- 执行：2026-10-15，**只改单元层，未跑任何 e2e / 浏览器**（浏览器复测见下一节的确切命令与判据）。
- 改动（四处，逐条对应上文四条根因；`BEACON_SLICE_BYTES` / `BEACON_INFLIGHT_BYTES`
  两个常量**未改**（32 KiB / 64 KiB），因为根因是估算器而不是片大小）：
  1. **按同步回合约束累计写入**：`sender/page-leave.ts` 新增 `turnBytes`（本回合写入的**真实正文
     体积**），再写一片就会超过 `BEACON_INFLIGHT_BYTES` 时把该片**与后续片**（保序）交给
     `schedule`，新任务里继续写；`dispose()` / `resetBudget()` 丢弃待发片一律计入 `skipped`。
  2. **估算器校准**：新增 `sender/beacon-size.ts`（数字按 `String(value).length` 计，与 JSON 逐字符
     一致）。真机载荷（`tests/e2e/probes/leave-slice-driver.js` 的 112 条）单事件 **923 B → 745 B**
     （实际 743 B），事件数组合计 103600 → **84383 B**（实际 83329 B）。于是 32 KiB 的片由
     26391 B 变成 **32323 B**，112 条由 **4 片回到 3 片**。
  3. **默认让出真的生效**：未注入 `schedule` 时缺省 `setTimeout(flush, 0)`（**新任务**；微任务不重置
     额度）。**权衡**：`send()` 仍**同步写满第一个回合**（实测被接受的额度内），只把超出额度的尾部
     让出；旧实现把尾部同步写出去换来的是浏览器拒绝 + 静默丢弃，同步性并未换来送达；让出后若页面
     已销毁，尾部计入 `skipped`（可见），不再谎报成 `sent`。
  4. **丢失自报**：被 `sendBeacon` 拒绝的**整片事件计入 `skipped`**（不再计 `sent`）并记一次
     `budgetStops`（复用 CR-008 的 `flush_skipped_due_to_budget` 出口；**未新增字段、未改指标名、
     未改 `prewrite_commit_lost` 口径**）。不变量：`sent + skipped + 待发 = 提交总数`。
- 单元层可见数字（`node` 直接跑 `packages/transport/dist`，同一 `createDelivery` 离页路径，
  非浏览器）：`syncTurnBytes=64676`（2 片 32338 B，**≤ 实测被接受的 65536 B**）→ 让出后
  **3 片 [32338, 32338, 19690]**，`leave.stats={"sent":112,"skipped":0,"bytes":84366,"requests":3,"budgetStops":0}`，
  `counters={}`（**无 `retry_network`**）。旧产物同一路径是 4 片 / `requests=4` / 第 4 片被拒。

### 下一轮（第 4 步 · 浏览器）确切命令与判据

```bash
pnpm --filter @web-report-sdk/transport run build   # 必须先 build：e2e 加载 packages/transport/dist
pnpm test:e2e --project=chromium --grep "C07-AC-03"
pnpm test:e2e --project=webkit tests/e2e/leave-slice.spec.mjs
```

- 沿用既有判据 #1–#7（≥2 个真实信标请求；重组 `event_id` 序列 = 原始 112 条、无重复无缺失；
  每片 < 60 KB；`text/plain`；令牌在 body `auth`、URL/请求头无令牌；单次 80 KB=false / 32 KB=true；
  探针读到 `leaveBudget.maxBytes=98304`），**并加一条**：
  **#8 `leave.stats` 必须能看出丢失的条数** —— 若全部被接受，则 `sent=112`、`skipped=0`、
  `budgetStops=0`、`requests=3`（不应再是 4）；**若仍有请求被拒，则 `skipped` 必须等于接收端缺失的
  条数，且 `sent + skipped = 112`**（`sent` 不得大于接收端重组到的条数）。
- 预期：`requests=3`、接收端 3 片、重组 112/112、`retry_network=0`、`leave.stats.skipped=0`。
  若第 3 片仍出现拒绝（本机额度 ∈ [65536, 73728)），它会**出现在 `skipped` 里**而不是消失。
- **需编排方按流程处理的两处契约/CR 文字（本 lane 未改 `docs/contracts/**`）**：
  1. `reason-codes.md` §4 的 `flush_skipped_due_to_budget` 语义枚举了「字节上限 / ≤200 条 / ≤4 批 /
     时间窗」四个维度，**未含**本轮新增的触发「浏览器同一同步回合的累计额度（`sendBeacon` 拒绝）」；
     本轮的复用是指令要求（丢失必须从这条出口可见），如需写进契约请走 CR-009 的兼容澄清；
  2. `CR-009` §4 第 84 行写「`schedule` 为可注入钩子，**缺省立即执行**以保持离页同步语义」——
     这正是根因③的缺陷描述，本轮已改为缺省**宏任务让出**（第一回合仍同步写满，权衡见上）。

## 追加节（第 3 步 · 浏览器实测）：3 片被切出、**第 3 片仍被浏览器拒**、`skipped=26` 与接收端缺失**相等**

- 执行：2026-10-15 16:22–16:25，独立验证 lane。**只读复测**：未改 `packages/*/src/**`、
  未改 `tests/**` 任何文件、未改任何配置、无任何 git 写操作；本 lane 的写操作只有 build 产物与本节追加。
- 被测对象：`packages/transport/dist/index.js`
  （`sha256 23d3de14404335274beb95157a3f9328b71d6fa524e238d029fd0fc48f26d46b`，113.29 KB；
  `packages/transport/dist/index.d.ts` `sha256 d07ae5ea4395860338faf0f8502dc95f12014a31d5ee0292f5912293bcee7697`），
  由 `pnpm --filter @web-report-sdk/transport run build`（tsup，118 ms）**从当前 src 现场构建**；
  仓库 `HEAD=a23b508`，`git status` 里 `packages/**` 无改动 → 本次测的就是 HEAD 的 src。
- 环境：Node v24.16.0 / pnpm 11.18.0 / 10 核；跑前 `loadavg [2.20, 1.90, 2.08]`，
  跑后 `[2.54, 2.31, 2.22]`；无残留 Chromium/WebKit 浏览器进程（残留一个 Playwright `test-server`
  pid 47909，非浏览器，不影响本次结果）。
- 命令与结果（原样）：
  1. `pnpm --filter @web-report-sdk/transport run build` → 成功（`dist/index.js 113.29 KB`）
  2. `pnpm test:e2e --project=chromium --grep "C07-AC-03"` → **8 tests，5 passed / 3 failed**（30.2 s）
  3. `pnpm test:e2e --project=webkit tests/e2e/leave-slice.spec.mjs` → **6 tests，3 passed / 3 failed**（18.6 s）
  - 上面两条各另跑一次**同一条命令 + `--reporter=json`**：只为取回本 spec 写在 annotation 里的 `leave.stats`
    与逐片数字（不改测试、不改参数、不加 `only`/`skip`）；两次数字**逐位相同**。

### 判据逐条判定（Chromium 与 WebKit 数字**完全相同**）

| # | 判据 | 实测 | 判定 |
|---|---|---|---|
| 1 | 接收端 ≥2 个真实信标请求 | 到达 **2 片**（SDK 侧尝试 **3** 次，第 3 次被浏览器拒） | ✅ 通过（≥2）；但少 1 片 |
| 2 | 重组 `event_id` = 原始 112 条，无重复无缺失（80 KB 全到） | **86 / 112**，缺失 **26** 条（`ac03-0086`–`ac03-0111`，尾部连续区间），重复 **0**，保序 | ❌ **不通过**（差 26 条） |
| 3 | 每请求 < 60 KB | 每片 **32343 B**（< 61440 B） | ✅ 通过 |
| 4 | `Content-Type: text/plain;charset=UTF-8` | 判据口径 `startsWith('text/plain')` 对**每片**都成立（不合格项里无 Content-Type 项）；线上字面量的 charset 大小写本轮未逐字打印（第 2 次追加节实测为 `text/plain;charset=utf-8`） | ✅ 通过（前缀口径） |
| 5 | 令牌在 body `auth`（URL/头无令牌） | 每片 `body.auth={"app_id":"ac03","write_token":"tok-ac03"}`、`x-write-token` 头 `null`（不合格项里无令牌项） | ✅ 通过 |
| 6 | 对照：单次 80 KB = `false`、32 KB = `true` | `80 KB accepted=false`；`32 KB accepted=true`（真的到达 1 次） | ✅ 通过 |
| 7 | 先验 `LEAVE_BUDGET.maxBytes` | `{"maxBytes":98304,"maxEvents":200,"maxBatches":4,"maxMs":50}` → **98304** | ✅ 通过 |
| 8 | `leave.stats` 能看出丢失条数 | `leave.stats={"sent":86,"skipped":26,"bytes":84381,"requests":3,"budgetStops":1}`、`counters={"retry_network":1}`；`skipped(26)` = 接收端缺失(26)，`sent+skipped = 112`，`sent(86)` = 重组到的条数(86)（**不大于**） → 走「仍有拒绝」分支 | ✅ 通过（**不是** `sent=112/skipped=0/budgetStops=0` 那支） |

- `requests` **= 3**（不再是 4）：切片确实按设计变成 3 片 —— 单事件估算校准生效
  （片正文由 26391 B 变成 32343 B / 43 事件，112 条 = 43+43+26）。
- 预算放宽（`maxBytes = 4 MB`）后 SDK 侧与接收端数字**一字不变** → 本次丢失与预算无关。

### 接收端逐请求明细（Chromium；WebKit 逐位相同）

| 序 | 方法 / 路径 | 字节 | 事件数 | `event_id` 区间 | `Content-Type` | 令牌位置 |
|---|---|---|---|---|---|---|
| #1 | POST `/beacon` | 32343 | 43 | `ac03-0000`–`ac03-0042` | `text/plain*`（判据前缀成立） | body `auth`，`x-write-token` 头 = `null` |
| #2 | POST `/beacon` | 32343 | 43 | `ac03-0043`–`ac03-0085` | `text/plain*`（判据前缀成立） | body `auth`，`x-write-token` 头 = `null` |
| — | 第 3 片（`ac03-0086`–`ac03-0111`，正文 19695 B） | **未到达** | 26 | — | — | — |

- 接收字节合计 **64686 B**（事件原文合计 63985 B）；原始事件数组 83329 B，整批序列化 83603 B。
- `leave.stats.bytes = 84381 B` = 64686 + 19695 → 该字段计**尝试写出**的体积（含被拒片）。

### 失败形态（哪一条、差多少、有没有 `retry_network`）

- 失败判据只有 **#2（全量送达）**：差 **26 条 / 约 19695 B**（尾部连续区间 `ac03-0086`–`ac03-0111`）。
- **有** `retry_network`：`counters={"retry_network":1}`，且 `requests=3` 而接收端只有 2 片
  → 第 3 片 `sendBeacon` 返回 `false`，已被第 3 步④计入 `skipped=26`（不再谎报 `sent`）。
- 拒绝原因可由数字反推（浏览器累计在途额度）：回合同步写入 32343 + 32343 = **64686 B** 被接受，
  让出后单独写 **19695 B**（≪ 65536 B）却被拒 → 该 19695 B 被拒时，前面 64686 B 仍被计入在途
  （64686 + 19695 = **84381 B** > 65536 B）。这一条是**由数字反推**，不是直接观测。
- 两次 Chromium（无/有 `--reporter`）与两次 WebKit 结果**逐位一致** → 非抖动。

### 本次观察到、但不在判据里的异常

1. **第 3 步③ 的依据（“新任务重置额度”）在特性刻画里其实没有被 `setTimeout` 验证过**：
   `tests/e2e/probes/beacon-quota-driver.js` 的 `yieldToBrowser('timeout')` 是**死代码**
   ——`plan()` 只在 `delayMs === 0 && !sync` 时调用 `yieldToBrowser('raf')`（第 58 行），
   `'timeout'` 分支从未被调用。因此 `beacon-quota` 结果里标签为 `delay0-21x4` 的那一行
   **实际走的是 rAF**（该行 annotation 自述就是「rAF,rAF,rAF,rAF」，4 步共 56 ms ≈ 13–14 ms/步），
   `delay10/25/50` 则是真的定时器。本次 3 片路径是 `setTimeout(flush, 0)`（≈1 ms）在浏览器里的
   **第一次实测**，结果是第 3 片被拒。**“新任务”与“请求是否已完成”在当前数据里无法分离**（仅报数字）。
2. **annotation 里的「单事件估算 923 B / 估算 103600 B」会误导**：探针取的是 transport 的
   **队列层** `estimateEventBytes`（未校准，923 B），而信标切片用的是新加的
   `estimateBeaconEventBytes`（校准后 ≈745 B，故 43 事件 / 32343 B）。两者是不同函数，
   923 B 已不驱动信标切片（`packages/transport/dist/index.js:195` vs `:1841`）。
3. **同一同步回合的上限是 65536 B 整**（`sync-32x32` → `[true,true]` 恰好 65536 B；
   `sync-21x21x21x21` → 3 次 `true` 后 `false`，即 3×21504 = 64512 B 通过、第 4 次被拒）：
   83603 B 的批次在任何片大小下都**必须跨 ≥2 个“额度已重置”的回合**；本次回合 1 写 64686 B（正确 ≤ 上限），
   回合 2 只写 19695 B（本身也 ≤ 上限）却被拒。
4. `budgetStops = 1` 来自**浏览器拒绝**那条出口（`write()` 里 `sendBeacon` 返回 `false` → `noteBudgetStop()`），
   与四个预算维度无关：因此“全部被接受”才会是 0。
5. 变异自检这条用例在本次运行里是**绿**的，但它的 annotation 是「接收端 **0 片**、`retry_network=1`、
   丢失 112」——由变异体把整批 83603 B 一次性发出（单次 > 上限）被拒造成，属于预期形态。
6. `--grep "C07-AC-03" --project=chromium` 会连 `beacon-quota.spec.mjs` 里名为 “webkit” 的用例一起跑
   （spec 内部自己 `resolveBrowser('webkit')`），所以那条命令是 8 个用例；WebKit 的 AC-03 判定仍需
   显式 `--project=webkit`（本轮已单独跑）。
7. **WebKit 用例结束后有 3 个孤儿 WebKit XPC 进程存活**（pid 96565/96566/96567，
   `com.apple.WebKit.{GPU,Networking,WebContent}`，`pgrep -P 1` 命中 → 父进程已是 launchd）。
   与数字无关，但 `killMatching(profilePids(dir))` 没清掉它们。（沙箱禁止 `ps`，无法进一步判定归属。）

### 产物与工作区状态（供编排方恢复）

- 本次运行**现场重生/覆写**了 3 个已跟踪产物（属 e2e 正常产物，非本 lane 手工编辑）：
  - `tests/e2e/probes/mutant-transport.js`：`3c5e4dcb…` → `5720d407…`（每次 leave-slice 运行都由 spec 从 dist 复制+一处替换重生）
  - `tests/e2e/results/beacon-quota-chromium.json`：`ca6bdeef…` → `9bad8b33…`
  - `tests/e2e/results/beacon-quota-webkit.json`：`95813273…` → `4bd75cc7…`
- 跑前工作区**已经**是脏的（非本 lane 造成，本 lane 未触碰，哈希跑前跑后一致）：`tests/compat/results/`
  两个 json、`tests/e2e/probes/{beacon-quota,durability,leave-slice,real-browser}-driver.js`
  （diff 全部是注释级「口径（#4）」补充，无功能改动）。
- **工作区不是独占的**：本 lane 的 e2e 全部在 16:22:17–16:25:05 之间跑完，之后 **16:26:14–16:26:18**
  有**另一个写入者**改了 `examples/node-import/package.json`、`examples/script-tag/package.json`
  并新建 `examples/{node-import,script-tag}/scripts/verify-build.mjs`（`build` 脚本由 `node -e "process.exit(0)"`
  改成 `node scripts/verify-build.mjs`）——不是本 lane 所为（本 lane 只跑 transport 的 build 与 e2e）。
  上述产物与数字不受影响：`packages/transport/dist/index.js` 的 mtime 仍是 16:22:17、sha256 仍是
  `23d3de14…`（= 本节被测对象），`packages/**` 无改动。

### 结论（只记数字，不给参数建议）

- `8882355` + 本次 build 之后：**#1、#3、#4、#5、#6、#7 通过；#8 以「仍有拒绝」分支通过
  （`skipped=26` 等于接收端缺失 26 条、`sent+skipped=112`、`sent=86` ≤ 重组 86）；#2 仍不通过
  （86/112，尾部 26 条丢失）**。
- 相对第 2 次追加节（4 片 / 77 条到达 / `sent=112,skipped=0`）：片数 4 → **3**、片大小 26391 → **32343 B**、
  到达 77 → **86 条**、丢 35 → **26 条**，且丢失**首次在 `leave.stats.skipped` 里可见**（不再自报全绿）。
- 残余丢失的唯一形态：**回合 1 的 64686 B 之外，让出到新任务写出的第 3 片（19695 B）被 `sendBeacon` 拒绝**
  （`retry_network=1`），Chromium 与 WebKit 逐位相同。

## 追加节（T29 尾部 · 单 lane）：WebKit 复跑（D-1 修复后）+ Firefox 补测 —— 2026-10-15

- 执行：T29 尾部 lane，**负责人已授权的非沙箱会话**；工作目录 `/Users/spirit-ai/Desktop/sdk`，直接在 `main` 上工作。
- 被测对象：`packages/transport/dist/index.js`，sha256 前缀 `23d3de1440433527`，mtime `2026-10-15T08:49:36.076Z`
  （与上一追加节同一份产物；本轮**未**改 `packages/**`，也**未**改任何 spec / 门禁 / 契约）。
- 驱动/浏览器：`playwright-core@1.60.0`（树外只读，revision 精确配对）+ 本机 webkit-2287 / firefox-1522，headless。
- **本轮未设置任何 `MOZ_*` 变量**（`env | grep -i '^MOZ'` 为空；`PW_*` / `PLAYWRIGHT_*` 也为空，全部走 `lib/browsers.mjs` 的解析）。

### 一句话结论

**9/9 不成立。** D-1 修复确实让 WebKit 从「6/9 格捕获到窗口」提升到「本轮 8/9 格对账等式成立」（3 个旧空白格中
`preflush-d0` 已完全对账、`pending-d0` 从空白变为**部分计数**、`preflush-small` **仍然空白**）；
但那 2 格是**抖动**而非稳定失败，且 Chromium 在同一 3 格上 2/2 稳定完整。**Firefox 在本会话依旧起不来**
（根因是内核拒绝嵌套 seatbelt，见下），**未取到任何 Firefox 数字**。

### 1. WebKit 复跑（`pnpm test:e2e --project=webkit`）

命令：`pnpm test:e2e --project=webkit --reporter=list` → **11 passed / 4 failed（29.7 s，4 workers）**。

D004 逐格（`tests/e2e/results/d004-webkit.json`，`generatedAt=2026-10-15T08:55:08.990Z`，sha256 `74e40e08991ff423`）：

| 格子 | 期望 | 存活 | `prewrite_commit_lost` | 窗口捕获 | 对账 | `exposureReconciles` |
|---|---|---|---|---|---|---|
| `durable` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| `pending-d0` | 1000 | 0 | **10** | **是** | ❌ | `{"survivors":0,"commitLost":10,"expected":1000}` |
| `pending-d5` | 1000 | 0 | 1000 | 是 | ✅ | `true` |
| `pending-d20` / `d60` / `d200` | 1000 | 1000 | 0 | 否 | ✅ | `true` |
| `bulk-d0` | 5000 | 0 | 5000 | 是 | ✅ | `true` |
| `preflush-d0` | 1000 | 0 | **1000** | **是** | ✅ | `true`（修复前：空白 ❌） |
| `preflush-small` | 100 | 0 | **0** | **否** | ❌ | `{"survivors":0,"commitLost":0,"expected":100}`（修复前：同样空白） |

**T32 点名的 3 格，逐格回答「现在捕获到窗口了吗」**（对照 `git show e0bd651:tests/e2e/results/d004-webkit.json`）：

| 格 | D-1 前（`e0bd651` 的 JSON） | D-1 后（本轮） | 判定 |
|---|---|---|---|
| `pending-d0` | 存活 0 / 计 **0** / `windowCaptured=false` → `{0,0,1000}` | 存活 0 / 计 **10** / `windowCaptured=true` → `{0,10,1000}` | **仍是空白，只是变成「部分计数」**；`10 ≠ 1000`，**不得计入已对账** |
| `preflush-d0` | 存活 0 / 计 **0** / `windowCaptured=false` → `{0,0,1000}` | 存活 0 / 计 **1000** / `windowCaptured=true` → `true` | **✅ 已修复**（空白 → 完全对账） |
| `preflush-small` | 存活 0 / 计 **0** / `windowCaptured=false` → `{0,0,100}` | 存活 0 / 计 **0** / `windowCaptured=false` → `{0,0,100}` | **仍未捕获窗口**（默认配置那一格依然无结论） |

### 2. 那 2 格是**抖动**，不是稳定失败（3 次独立复跑）

`node tests/e2e/lib/d004-run.mjs --browser webkit --cells pending-d0,preflush-small --out /tmp/...`（产物写到 `/tmp`，
**未覆写** T29 官方 JSON；单次约 15 s）：

| 运行 | `pending-d0` 计数 | `pending-d0` 对账 | `preflush-small` 计数 | `preflush-small` 对账 |
|---|---|---|---|---|
| 官方整轮 | 10 | ❌ | 0 | ❌ |
| 复跑 1 | 10 | ❌ | 100 | ✅ |
| 复跑 2 | 1000 | ✅ | 100 | ✅ |
| 复跑 3 | 1000 | ✅ | 0 | ❌ |

→ **同一格同一产物，计数在 `0 / 10 / 100 / 1000` 之间跳**。因此本轮**不能**说「WebKit 稳定 8/9」，
只能说「**单次运行的对账完整性不可靠**」：`pending-d0` 6 次观测里 2 次不完整，`preflush-small` 4 次观测里 2 次不完整。

**机制（有原始磁盘证据，不是推测）**：`rawDumpBeforeOpen` 直接读未经过 SDK 的 IDB，落盘 `meta` 只有 2 条，
其中 `intent:pending-d0-first` 的值是
`{"total_enqueued":10,"total_committed":0,"first_pending_at":1792054499764,"updated_at":1792054499765}`
—— 锚点是**异步**（`requestAnchor()` → `backend.putMeta()`）写入的，且写入值取自**发起那一刻**的账目：
`issue()` 同步发出 100 批的途中，第 1 次 `requestAnchor()` 以 `total_enqueued=10` 建值、其余 99 批只把
`anchorQueued` 置位；SIGKILL 在 `measuredMsAfterIssue=0 ms` 到达时，**只有那份 `=10` 的锚点落了盘**，
后续合并锚点（值本会是 1000）没来得及完成。这正是 `e2e-d004-hardkill.md` 局限第 6 条预告的
「**合并锚点的残余窗口**」，本轮**首次在 WebKit 上被实测到**，表现为计数偏小（不是数据丢失：
`reopenStats` 里没有半落盘记录，`durable` 仍 1000/1000）。

**引擎差异（同一命令，Chromium 对照）**：`--browser chromium --cells pending-d0,preflush-d0,preflush-small`
连跑 2 轮 → **6/6 格「存活 0 + 计数 == 期望」（1000/1000/100）**。即该残余窗口在 Chromium 上**测不出**、
在 WebKit 上**测得出**——与「WebKit 的 `putMeta` 往返显著慢于 Chromium」一致（同一场景 `commitLostWindowMs` 680 ms）。

### 3. Firefox 补测：**起不来，零数字**（如实记为阻塞，不记为通过）

- `node tests/e2e/lib/smoke-browsers.mjs firefox`（**不设任何 `MOZ_*`**）→ **LAUNCH-FAIL**，
  `browserType.launchPersistentContext: Timeout 45000ms exceeded`；headless 与 headed（`-foreground`）
  **同样失败**；超时放到 120 s 仍失败；`leave-slice` 的 20 s 探测性启动亦同样超时。
- **错误原文（逐字，`firefox-e2e.log` 与单次探测两次独立复现）**：
  `Sandbox error: sandbox_init() failed with error "Operation not permitted"` +
  `sandbox initialization failed: Operation not permitted`（其后是整份 seatbelt profile 转储）。
  注意浏览器**并未崩**：它还在 timeout 前打了 `Juggler listening to the pipe`，卡住的是握手（juggler），
  与 T29 记录的现象一致。
- **这根因不是 Firefox 特有，而是本会话的环境事实**：自写的 3 行 C 程序（`sandbox_init("(version 1)(allow default)", …)`）
  同样返回 `rc=-1 err=Operation not permitted`；`sandbox-exec -f` 也报 `sandbox_apply: Operation not permitted`。
  即**本会话自身跑在 seatbelt 之下，嵌套 `sandbox_init()` 被内核拒绝**（macOS 26.6.2 / arm64）。
  所以「非沙箱会话」这一授权**没有在本 lane 实际生效**——请编排方在真正非沙箱的宿主（或允许嵌套的会话）里重派 Firefox。
- `pnpm test:e2e --project=firefox tests/e2e/durability.spec.mjs tests/e2e/real-browser.spec.mjs`
  已按要求实际执行完毕（**5 m 29 s，exit 1**）：**7 failed / 0 passed / 0 skipped** ——
  D004 两条 + `real-browser.spec.mjs` 五条 A/B/C1/C2/D，**每条都因 launch 超时 `✘` 失败**（不是 `skip`），
  失败原文同上（log 在 `/tmp/t29/firefox-e2e.log`）。**Firefox 一行数字都没有**，本报告不给出任何 Firefox 结论。
- **`leave-slice.spec.mjs` 的跳过条件：已不再是写死的 `browserName` 名单**。
  `HEAD`（`e0bd651`）第 76 行是 `test.skip(({ browserName }) => browserName !== 'chromium' && browserName !== 'webkit', '本机只支持 Chromium / WebKit')`
  —— **那条确实会在 Firefox 上恒跳过**；但**工作树里已被另一 lane 改成运行时真启动探测**
  （`browserReady()` 真的 `launchPersistentContext` 起一次，起不来才带真实报错跳过）。
  本 lane **未改动该文件**（遵守「不要改它」）。**实测**（`pnpm test:e2e --project=firefox tests/e2e/leave-slice.spec.mjs`
  → **6 skipped**）：**仍然全部跳过，但理由换了** —— 旧代码是静默的引擎名单，现在是
  `⚠ 跳过 [firefox] …：firefox 在本机起不来，本用例无法执行：browserType.launchPersistentContext: Timeout 20000ms exceeded。`
  这属于另一 lane 的产出，**本 lane 不代其宣称**；本 lane 只如实报「仍是 6 条跳过、跳过理由已带真实报错」。

### 4. WebKit 其余失败项（原文，均为**既有**结论，非本轮引入）

AC-03 三条与 Chromium **逐位相同**（`rebuilt.length` 86 ≠ 112、`sendBeacon` 拒绝 1 次、`leave.skipped=26`），
即上一追加节已判定的「#2 仍不通过」；`D004-B/C` 那条由 §1 的 `pending-d0` 引起。**没有一个失败是本轮造成的**
（本轮只跑浏览器、只读源码、未改 `packages/**` 与任何 spec）。

### 5. 清理 / 残留

- 每次 `killMatching(profilePids(dir))` 生效：WebKit 全部用例结束后 `pgrep -f webkit-2287` = **0**，
  Firefox 结束后 `pgrep -f firefox-1522` = **0**。本轮结束时**无本 lane 残留的浏览器主进程**。
- **存在 3 个先于本 lane 的孤儿 WebKit XPC 进程**：pid 96565/96566/96567
  （`com.apple.WebKit.{GPU,Networking,WebContent}`）——它们**不是**本轮产生的：本轮所有浏览器进程 PID 在
  77k–84k 区间（WebKit 侧 77k–84k，Firefox 侧 85k–88k），远低于 96k，且与上一追加节记录的
  96565/96566/96567 **同 3 个 pid**（父进程已是 launchd，`profilePids()` 找不到它们的 user-data-dir）。
  本 lane **未**杀它们（不属于本 lane、也不影响数字），如实留档。
- 本轮**现场重生/覆写**的已跟踪产物（e2e 正常产物，属 `ignores`/由编排方恢复）：
  `tests/e2e/probes/mutant-transport.js`（`3c5e4dcb…` → `5720d407…`）、
  `tests/e2e/results/beacon-quota-webkit.json`（`95813273…` → `b14d1dad…`）、
  `tests/e2e/results/d004-webkit.json`（**本轮的被测产物**，新 `74e40e08991ff423`）、
  `beacon-quota-chromium.json`、`tests/e2e/probes/*-driver.js`（后两者跑前已是脏的，非本 lane 编辑）。
- **`tests/reliability/reconcile.mjs` 在本轮后被如实复跑**（读新 WebKit JSON）：第 3.0 节 WebKit 由
  3 格 ❌ 变为 **2 格 ❌**（`pending-d0` 计数 10、`preflush-small` 计数 0）；**Chromium 9/9 与上一轮完全相同**。
  该脚本**只读 JSON、不写报告**，本轮**未**用 `--write`（避免改他人结论）。

### 6. 本轮暴露、但还没被覆盖的「只有真实浏览器才暴露」的风险

1. **锚点合并残余窗口的量级没有任何护栏**：WebKit 上单次 meta 事务往返足以让「事件已产生但计数未落」的
   事件数偏小一个数量级（10 vs 1000）。单元测试用 `fake-indexeddb` 是**同步**的，结构上测不出来。
   建议（不在本 lane 权限内）：给锚点加「停止合并、强制逐次落痕」的开关，或在 `d004-run.mjs` 里对
   捕获窗口的格子做**多轮取最大值/要求连续 N 轮完整**再判定，避免单次抖动被读成通过/失败。
2. **`preflush-small`（生产默认配置）在 WebKit 上依然无结论**：默认 200 ms 定时器 + 10 批的路径，
   恰是最贴近线上的那一格，却最难捕获。
3. **Firefox 完全空白**：不只是 D004，`real-browser.spec.mjs` 的全部真实浏览器项、AC-03 默认/放宽两条路径、
   `leave-slice` 的切片形状在 Gecko 上都**从未执行过**。Gecko 与 WebKit/Blink 在 IndexedDB 事务调度、
   `sendBeacon` 额度（Chromium/WebKit 实测同为 64 KiB）上可能不同 —— 现在没有数据。
4. **驱动不是仓库锁定的 1.64.0**（webkit-2287 只有配 1.60.0 才起得来）；`Page.overrideSetting` 类差异
   可能已在不知不觉中换了被测面。1.64.0 的完整矩阵需要先 `playwright install`（需批准）。
