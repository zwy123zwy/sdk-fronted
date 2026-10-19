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

---

## 追加节（T29 尾部 · 护栏实测）：**连续 N 轮**捕获判定 —— Chromium 3/3 稳定，WebKit 0~2/3 通过

- 执行：T29 尾部护栏 lane，2026-10-15/16；工作目录 `/Users/spirit-ai/Desktop/sdk`，直接在 `main` 上工作，无 git 写操作。
- 被测对象：`packages/transport/dist/index.js`，`sha256 23d3de1440433527…`（与上一追加节同一份产物；未改 `packages/**`）。
- 本轮补上的是**风险 1**（§6 上一节「锚点合并残余窗口的量级没有任何护栏」）的护栏实测：
  逐轮判定 + 「连续 N 轮完整」+ 「空白 ≠ 0 丢失」。设计与判据原文、变异三要素见
  `docs/reports/e2e-d004-hardkill.md` 追加节（T29 尾部 · 护栏）。
- 驱动/浏览器同上一节：`playwright-core@1.60.0` + 本机 chromium-1223 / webkit-2287，headless。
  **Firefox 本轮仍未尝试**（上一节已实测本会话 seatbelt 下起不来；本 lane 无新证据，不代其宣称）。

### 判据（一句话）

**一轮「完整捕获」= `windowCaptured && exposureReconciles`**（即 `commitLost > 0` 且 `存活 + 计数 === 期望`，
`tests/e2e/lib/d004-run.mjs:268-277`）。捕获格必须**连续 N=3 轮完整**才算通过（最多 M=6 轮/格）；
单轮不完整**不判失败**，记为「抖动/未捕获」并继续。空白（无计数证据）与 0 丢失在输出里
用 `lostEvents: null` vs `0` + `zeroLoss` 显式区分。

### 1. 整轮复跑（Chromium + WebKit，同一命令）

```bash
pnpm test:e2e --project=chromium --project=webkit     # 26 passed / 6 failed（1.7 min）
```

- 6 个红**全部**是既有的 `leave-slice` AC-03 判定（两引擎数字与上一追加节逐位相同：#1/#2 各 32343 B / 43 事件、
  尾部 26 条 `ac03-0086`–`ac03-0111` 未达、`skipped=26`），与本护栏无关；D004-A / D004-B/C / **D004-CAP** 两引擎全绿。
- 护栏对整轮时长的影响：Chromium 的 3 个捕获格各跑满 3 轮（无抖动），`durability.spec.mjs` 单文件 **52.8 s**；
  WebKit **30.3 s**（`pending-d0` 跑满 6 轮、其余按需）。

### 2. 逐格「连续 N 轮」结果（N=3，M=6）

**Chromium**（`d004-chromium.json`，`2026-10-16T07:14:45.993Z`）：

| 捕获格 | 判定 | 通过 | 轮数 | 最长连续完整 | 抖动率 | 逐轮计数 |
|---|---|---|---|---|---|---|
| `pending-d0` | `stable-complete` | ✅ | 3 | 3/3 | 0% | 1000 / 1000 / 1000 |
| `preflush-d0` | `stable-complete` | ✅ | 3 | 3/3 | 0% | 1000 / 1000 / 1000 |
| `preflush-small` | `stable-complete` | ✅ | 3 | 3/3 | 0% | 100 / 100 / 100 |

**WebKit**（`d004-webkit.json`，`2026-10-16T07:14:51.561Z`）：

| 捕获格 | 判定 | 通过 | 轮数 | 最长连续完整 | 抖动率 | 逐轮（`verdict(计数/lostEvents)`） |
|---|---|---|---|---|---|---|
| `pending-d0` | `never-complete` | ❌ | 6 | 1/3 | **83%** | #1 blank(0/null)、#2 undercounted(10/null)、#3 undercounted(10/null)、**#4 complete(1000/1000)**、#5 undercounted(10/null)、#6 undercounted(10/null) |
| `preflush-d0` | `stable-complete` | ✅ | 3 | 3/3 | 0% | #1–#3 complete(1000/1000) |
| `preflush-small` | `complete-with-jitter` | ✅ | 6 | 3/3 | 33% | #1 undercounted(10/null)、#2 complete(100/100)、#3 undercounted(10/null)、#4–#6 complete(100/100) |

**WebKit 聚焦复跑**（同一命令 `--grep` 级聚焦，`2026-10-16T07:16:38.330Z`）：`pending-d0` `never-complete`
（6 轮，最长连续 1，83%；其中 #4 是 **blank**）、`preflush-d0` `never-complete`（6 轮，最长连续 **2**，33%）、
`preflush-small` `complete-with-jitter`（4 轮，最长连续 3，25%）。⇒ 逐格 streak **随负载大幅变化**，
这也是护栏把「未通过」做成**显式判定 + 抖动率 + KNOWN-DEVIATION 注解**、而不是逐格硬红的原因
（逐格硬红会在每次 WebKit 运行里红；见 hardkill 报告追加节 §2 末段）。

**隔离单轮 ×5（取原始单轮完整率 `p`）**：`pending-d0` `10/1000/1000/1000/1000`（4/5）、
`preflush-d0` `0(空白)/1000/1000/1000/10`（3/5）、`preflush-small` `100/100/100/10/100`（4/5）。

### 3. 沿用旧判据（单轮）会得出什么不同结论

- **旧判据**（只跑第 1 轮，两个布尔）：本轮 WebKit 第 1 轮是 **blank** → `windowCaptured=false`、
  `commitLost=0`、存活 `0/1000` → D004-B/C **不对该格断言**、只留一条 `KNOWN-DEVIATION` 注解
  （这就是 T32 那 3 个「空白格」被读成「没丢」的形态）；而同日另一次同命令复跑的第 1 轮是
  `undercounted(10)` → D004-B/C **直接红**（`存活 0 + 未提交 10 ≠ 1000`）。
  ⇒ 旧判据的结论**在「红」与「绿但空白（无结论）」之间随运行抖动**。
- **新判据**：D004-B/C 绿 —— 因为它拿到的**是被挑出来的一轮真实完整捕获**（#4：`0 + 1000 = 1000`，
  `windowCaptured=true`）；同时把不稳定性作为一等结论报出：`pending-d0` **未通过捕获判定**
  （`passed=false`、抖动 83%、6 轮里 5 轮计数不完整：4 轮少报 990 个事件、1 轮**完全没有计数证据**），
  `reconcile.mjs` §3.4 也把这两格列为「未通过捕获判定的捕获格」。
- 逐格判定与逐轮证据都写进了 `tests/e2e/results/d004-{browser}.json`
  （`capturePolicy` / `captureGates` / 每格 `captureGate`），任何读者都能复核，不需要重跑浏览器。

### 4. 变异（浏览器侧）与恢复

- `D004_CAPTURE_GUARD=off pnpm test:e2e --project=webkit tests/e2e/durability.spec.mjs` → **2 failed / 1 passed**：
  `D004-B/C` 红（`pending-d0: 窗口已捕获，存活 0 + 未提交 10 必须等于 1000`）、
  `D004-CAP` 红（`pending-d0: 必须显式声明空白≠0 丢失`）。**恢复**同一命令 → **3 passed**。
- 非浏览器侧的确定性判别（同一份变异开关）见 `node tests/e2e/lib/d004-anchor-window.mjs`：
  护栏生效 `PASS 15/15`（exit 0），关掉护栏 `FAIL 6/15`（exit 1）。

---

## 追加节（跳过可见性 lane，2026-10-15/16）：写死的跳过 → 运行时探测 + **跳过审计**；eslint 覆盖 `.mjs`

- 执行：跳过可见性 lane；工作目录 `/Users/spirit-ai/Desktop/sdk`，直接在 `main` 上工作，**无 git 写操作**。
- 触发出处：`docs/reports/t33-access-blockers.md`「本轮**额外**发现的'永远不会失败的检查点'」第 5、6 条。
- 改动面：`tests/e2e/**`（新增 3 个 lib 文件）、`eslint.config.js`、本报告、`tests/e2e/README.md`、
  t33 报告（追加"已修"标记）。**未**改 `packages/**`、`docs/contracts/**`、`docs/decisions/**`、
  `tests/acceptance/**`、`.size-limit.json`；**未**改任何既有 e2e 用例的通过标准（只加"跳过可见性"这一层）。
- 合入：代码/配置交付物已由编排方合入 `6caa761`（"合入三条 lane 的交付物：gate-selftest 扩面 /
  跳过可见化 / compat 产物幂等"）；本追加节的文字（含本行）在该次合入之后补写，数字全部来自合入前的实跑。

### 1. 先复核实际状态：HEAD 已经不是"写死的 browserName 名单"

| | t33 第 5 条的描述 | HEAD 实测（读码 + 实跑） |
|---|---|---|
| 跳过判据 | `test.skip(({ browserName }) => browserName !== 'chromium' && browserName !== 'webkit', '本机只支持 Chromium / WebKit')` | **已是运行时真启动探测**：`resolveBrowser()` → `launchPersistentContext(…, { timeout: 20_000 })`，起得来就 `ready:true` |
| Firefox 可用时 | 照样跳过、整轮仍绿 | 探测成功即执行（§4 的路径证明）；不可用才跳过，且**某浏览器上全部跳过 = 判红**（§3） |
| 用例条数 | "8 个用例" | 该文件实际 **6 条**；另外 2 条是 `beacon-quota.spec.mjs` 的同名 C07-AC-03 用例（本文注 6：`--grep C07-AC-03` 共 8 条）。那 2 条的问题**不是 skip**，见 §6 |

⇒ 本轮**没有**"把写死名单改成探测"这一步可做（另一条 lane 已于 2026-10-15 做过）。按任务要求，重心转到：
① 核实"能跑就跑"是否真的成立（**发现 3 处会误判/漏记，已修**）；② 让跳过不可能静默；③ 让 eslint 覆盖 `.mjs`。

### 2. 复核"能跑就跑"：3 处缺陷（`tests/e2e/leave-slice.spec.mjs`）

1. **`await context.close()` 原本在 `try` 里** —— 探测**已经启动成功**之后，只要关闭阶段报错，整条就被记成
   `ready:false` 而跳过：这是"能跑却判成起不来"的真洞，在 Firefox 可用的机器上同样会命中。现在启动与关闭分开，
   **启动成功即 `ready:true`**，关不上只记 `note`（打日志、不改变判定）。
2. 失败原因没有结构化保留（只有一行字符串，无 stage/驱动）。现在探测返回
   `{ready, stage, driver, reason, note}`：`stage` 区分 `resolve`（解析不出）与 `launch`（起不来），
   原因逐字进 stdout 与 HTML 报告（annotation）。
3. **探测结果没记账**（本轮第一次整轮跑自己暴露的）：能跑时 `probe` 恒为 `null`，汇总里是
   `probeReady=unknown`，于是"探测说能跑却跳了"这条自相矛盾判据**永远不可能触发**。已改成无论可用与否都 `noteProbe()`。

### 3. "跳过不可能静默"：一个入口 + 一层守卫 + run 级汇总

| 新文件（均在 `tests/e2e/lib/`） | 作用 |
|---|---|
| `skip-audit.mjs` | 唯一跳过入口 `skipUnavailableBrowser()`（带真实原因）；`afterEach` 抓**旁路跳过**；每次 `afterAll` 输出一行机器可读汇总并落 JSON |
| `skip-audit-summary.mjs` | **run 级**汇总与判定：把各段 JSON 相加（`node tests/e2e/lib/skip-audit-summary.mjs`） |
| `skip-audit-selftest.mjs` | 上面两组判据的**确定性自检**（不用浏览器；14 个夹具，红/绿两侧都钉） |

**为什么必须分两段（本轮实测教训）**：Playwright 在**每个失败用例之后丢弃整个 worker 进程、为后续用例起新 worker**，
而记账状态在进程内 ⇒ 同一 spec 一次运行会产生多份互不相干的记账。实测 `--project=chromium`（6 条、3 红）：

```
[skip-audit] … browser=chromium worker=0 pid=49533 declared=6 observed=2 executed=2 skipped=0 probeReady=true
[skip-audit] … browser=chromium worker=4 pid=49864 declared=6 observed=1 executed=1 skipped=0 probeReady=true
[skip-audit] … browser=chromium worker=7 pid=50106 declared=6 observed=1 executed=1 skipped=0 probeReady=true
[skip-audit] … browser=chromium worker=8 pid=50334 declared=6 observed=2 executed=2 skipped=0 probeReady=true
⇒ run 级（4 段相加）：executed=6 / skipped=0
```

所以判据分两层；单看一份记账**不能**回答"整轮里跑了几条"。每次调用的 JSON 落在
`test-results/skip-audit/`（文件名含 worker + pid，不会互相覆盖；该目录在 `.gitignore` 面内）。

**红线**（`auditVerdicts()` 与 `summarizeReports()`）：

| 情形 | 结果 |
|---|---|
| 用例被跳过但没经过探测登记（在 spec 里写死 `.skip`） | **红**（`afterEach` 当场红 + run 级点名） |
| 某 (spec, 浏览器) `executed=0` 且 `skipped>0`（该浏览器上一条都没跑） | **红**（措辞明确区分"环境阻塞"与"用例失败"） |
| 探测说 `ready=true` 却仍登记了跳过 | **红**（判据自相矛盾） |
| 一条都没观察到（声明级/整文件写死跳过） | **红** |
| run 级 `declared` 没跑满（有声明过的用例既没跑也没登记跳过） | **红**；`--allow-partial` 才降级为告警（只给 `--grep` 聚焦跑用） |
| worker 重启导致某一段只观察到 1~2 条 | **不红**（负对照，见自检） |

**"整 spec 在某浏览器上全部跳过"为什么选"显式失败"而不是"显式告警"**：本任务要消灭的形态就是
"用例到处都不跑、而整轮仍绿"（t33 原文）。只打一行告警，绿色的整轮照旧 ⇒ 等于把"未运行的检查"读成"通过"，
而指南第 6 节明令禁止这种读法。逐条 `test.skip` 仍然保留（"起不来"是环境事实，不该伪装成 6 条用例失败），
`afterAll` 再补一记**明确标注"这不是用例失败，是环境阻塞"**的失败 —— 于是"整轮仍绿"在结构上不可能发生，
而"红"的原因一眼可辨（见 §4 证明 ③ 的实际输出）。局部跳过、`--grep` 过滤**不判红**，避免误伤既有工作流。

### 4. 证明（三要素：改了什么 / 什么命令 / 观察到什么）

**证明 ①：故意让用例被跳过 → 新增可见性必须红**

- 改动：临时新增 `tests/e2e/proof-bypass-skip.spec.mjs`（3 条；第 2 条**不登记**就 `test.skip(true, …)`），跑完删除。
- 命令与结果：
```
pnpm exec playwright test tests/e2e/proof-bypass-skip.spec.mjs --project=chromium --reporter=list
  → PLAYWRIGHT_EXIT=1
  → Error: [skip-audit] … [chromium]：用例「这一条被旁路跳过（未经探测登记）」被跳过了，
     但它没有经过环境探测登记 —— 这条跳过是旁路来的（写死的 .skip？）
  → Error: [skip-audit] …：跳过可见性判据不通过（1 条）
```
- 负对照：同形状但**没有**旁路跳过的记账 problems=0（`skip-audit-selftest.mjs` 的绿侧夹具）⇒ 判据不是"永远在报警"。

**证明 ②：在 `.mjs` 里写 `.skip` / 条件跳过 → eslint 必须红**

```
# 写死的引擎名单 + 无条件跳过，两种形态写在同一个 .mjs 用例里
pnpm exec eslint tests/e2e/proof-eslint-skip.spec.mjs
  → 3:3  error 不得跳过测试（指南第 6 节）
  → 7:3  error 不得跳过测试（指南第 6 节）            EXIT=1
# 负对照：同一个文件、合入前（`67f1cfd`）的配置 ⇒ 两个写死跳过全都看不见
git show 67f1cfd:eslint.config.js > ./eslint.config.prechange.mjs
pnpm exec eslint --config ./eslint.config.prechange.mjs tests/e2e/proof-eslint-skip.spec.mjs
  → EXIT=0
# 豁免不是"整文件放行"：把唯一放行的形状改成写死的，同一个受审计文件也必须红
perl -pi -e 's/test\.skip\(!probe\.ready, note\);/test.skip(true, note);/' tests/e2e/lib/skip-audit.mjs
pnpm exec eslint tests/e2e/lib/skip-audit.mjs
  → 199:7  error 写死的跳过：只允许 test.skip(<运行时探测结果表达式>, 原因)   EXIT=1
（改成 `test.skip(browserName !== 'chromium', note)` 同样 EXIT=1；改回 `!probe.ready` 后 EXIT=0）
```

**证明 ③：本机 Firefox 起不来 → 逐条可见跳过 + **整轮判红**（而不是绿）**

```
pnpm exec playwright test tests/e2e/leave-slice.spec.mjs \
  --project=chromium --project=webkit --project=firefox --reporter=list     # 一次整轮
  → 7 failed / 5 skipped / 6 passed
    （7 = 6 条既有 AC-03 判定红 + 1 条 skip-audit 的"环境阻塞"红；5 skipped = Firefox 的跳过）
  → [skip-audit] … browser=firefox worker=1 declared=6 observed=6 executed=0 skipped=6 probeReady=false
  → [skip-audit] Error: … [firefox]：本次观察到的 6 条全部被跳过、执行 0 条 —— 该浏览器在本机起不来，
      这批用例一条都没跑。这不是用例失败，是环境阻塞：browserType.launchPersistentContext: Timeout 20000ms exceeded。
node tests/e2e/lib/skip-audit-summary.mjs     # run 级判定 → EXIT=1，只点名 firefox
  → chromium declared=6 executed=6 skipped=0 unregistered=0 invocations=4 probeReady=[true,true,true,true]
  → webkit   declared=6 executed=6 skipped=0 unregistered=0 invocations=4 probeReady=[true,true,true,true]
  → firefox  declared=6 executed=0 skipped=6 unregistered=0 invocations=1 probeReady=[false]
```

**"探测成功即执行"这条路径的证明（不依赖 Firefox 是否可用）**：同一个 spec 在 `--project=chromium` /
`--project=webkit` 上探测 `ready=true`，run 级 `executed=6 / skipped=0`（上面的 `probeReady=[true,…]`
就是这条路径的记账）。判据里**没有任何** `browserName` 名单，Firefox 走的是**同一条路径**。

**钩子证明（强制走"能跑"分支 ⇒ 真的去起，不是跳过）**：
```
AC03_FORCE_RUN_BROWSER=firefox pnpm exec playwright test tests/e2e/leave-slice.spec.mjs \
  --project=firefox --reporter=list --grep "对照"
  → [AC03_FORCE_RUN_BROWSER] 强制按"能跑"执行 [firefox]（真实探测 ready=false，原因：…Timeout 20000ms exceeded.）
  → PLAYWRIGHT_EXIT=1；TimeoutError: browserType.launchPersistentContext: Timeout 60000ms exceeded.
      - [err] sandbox initialization failed: Operation not permitted
      - [err] Sandbox error: sandbox_init() failed with error "Operation not permitted"
```
即：写死跳过的旧代码在 Firefox 上**恒**跳过；现在判据说"能跑"就**真的去起**，起不来就**真红**。
（本轮**未**设置任何 `MOZ_*` 变量。）

### 5. eslint：把"不得跳过测试"覆盖到 `.mjs`，以及误伤处理

- 现状（合入前 `67f1cfd`）：规则只覆盖 `**/*.test.ts` / `**/*.spec.ts` / `tests/**/*.ts` ⇒ `tests/e2e/*.spec.mjs`
  里的写死跳过**不会被拦**（证明 ② 的负对照实测 EXIT=0）。
- 改法：`files` 扩到 `**/*.test.mjs` / `**/*.spec.mjs` / `tests/**/*.mjs`。该块会**替换**规则的整个数组，
  故同时把基块原有的 `ClassDeclaration` 禁令补回（否则等于放宽；`tests/**` 下实测 0 处 class，无实际影响）。
- **误伤**：扩规则后，那一处**合法**的运行时跳过（`test.skip(true, note)`）会被拦。处理办法不是"整文件豁免"，
  而是把它挪进**唯一**一个受审计文件 `tests/e2e/lib/skip-audit.mjs`，并在该文件的块里换成**更窄**的形状判据：
  - 放行：`test.skip(<非字面量表达式>, 原因)` —— 由运行时探测结果驱动、且带原因；
  - 仍然禁止：`test.skip()`（无条件）、`test.skip(true, …)`、`test.skip(browserName !== …)`（写死名单）、`.only`。
  净效果：全仓**唯一**一处 `test.skip` 也必须带运行时条件，且只在 `skipUnavailableBrowser()` 里出现。
  （备选做法"在 `.mjs` 里只禁字面量/比较条件、其余条件放行"被**否决**：它放过了 `test.skip(browserName !== …)`
  这个本案的原始形态。**注意**：这块形状判据属**门禁配置变更**，需人类负责人追认。）
- 无其他误伤：`pnpm exec eslint tests/e2e eslint.config.js` → exit 0；`pnpm exec eslint .` → exit 0。

### 6. 同源残留（本轮只报告、未改，需授权）

`tests/e2e/beacon-quota.spec.mjs:56` 的 `for (const browserName of ['chromium', 'webkit'])` 也是**写死的引擎名单**：
它不用 project 的 `browserName`，所以在 `--project=firefox` 下会**重复测 Chromium/WebKit**，
Gecko 的信标额度永远取不到数（即 t33 说的"8 个用例"里另外那 2 条）。它不是 `skip`（用例在跑，只是跑错了引擎），
本轮的"跳过不可静默"机制覆盖不到它；其产物 `results/beacon-quota-*.json` 又是既有报告引用的证据，故未擅自改。

### 7. 回归

| 命令 | 结果 |
|---|---|
| `node tests/e2e/lib/skip-audit-selftest.mjs` | **14/14 通过**，exit 0 |
| `pnpm exec eslint tests/e2e eslint.config.js` | exit 0 |
| `pnpm exec eslint .` | exit 0 |
| `pnpm exec playwright test tests/e2e/leave-slice.spec.mjs --project=chromium --project=webkit` | **6 failed / 6 passed**，与改动**前**基线**逐项相同**（同样那 3 条 × 2 引擎的既有 AC-03 判定；本层没有新增任何红或跳过） |
| 同上再加 `--project=firefox`（一次整轮） | 7 failed / 5 skipped / 6 passed：多出来的 1 红就是 §4 证明 ③ 的**环境阻塞**判定 |
| `pnpm gates` | `lint` / `build` / `typecheck` 三个阶段**通过**；`test` 阶段两次被**另一条 lane 在途的文件**打断，都没到本轮改动面上：（1）`packages/plugins/src/apm-dual-write/apm-dual-write.test.ts` 半写状态 → `ReferenceError: src is not defined`（报错位置落在一个**注释行**上），立刻单跑该文件 → **10 passed**；（2）`packages/core/src/privacy/mask-adversarial.test.ts` 的计时预算断言在负载下超预算（中位 27.85 ms > 20 ms），立刻单跑 → **7 passed**。故本轮未取得一次完整的 gates 全绿；受本次改动影响的唯一阶段（`lint`）已单独验证：`pnpm exec eslint .` → exit 0 |

**本报告不宣称的事**：Firefox 的 AC-03 判定**没有被验证过**（本机沙箱内 Firefox 起不来；§4 证明 ③ 证明的是
"该浏览器上一条都没跑会被判红"，不是"Firefox 上通过"）。若要在 Gecko 上取数，需在能起 Firefox 的机器上跑
`pnpm test:e2e --project=firefox`（**不得设置任何 `MOZ_*`**）。

---

## 追加节（e2e 基建缺陷 lane，2026-10-16）：`beacon-quota.spec.mjs` 的写死引擎名单 → 与 `leave-slice` **同一套**运行时探测 + 跳过审计

本节记录 `tests/e2e/beacon-quota.spec.mjs` 的一处基建缺陷修复。它**不是**"用例被跳过"，
而是**测错了引擎**——上一节（跳过可见性 lane §6）只报告、未改，本节是授权后的处置。

### 1. 先复核实际状态（不照抄条目的转述）

修前 `beacon-quota.spec.mjs:56` 是：

```js
for (const browserName of ['chromium', 'webkit']) {
  test(`C07-AC-03 取数：${browserName} 信标单次上限 + …`, async () => { … });
}
```

它**不用** Playwright project 的 `browserName` fixture，而是自己遍历两个字面量：于是一个 spec 文件
在**每个** project 下都声明并运行**同样两条**用例（`--list` 实测：`chromium` project 下 2 条、`firefox` 下 2 条、
`webkit` 下 2 条，标题里的引擎名是**写死**的那两个）。实测（修前基线，本 lane）：

```
$ pnpm test:e2e --project=chromium tests/e2e/beacon-quota.spec.mjs
  ✓  1 [chromium] › … › C07-AC-03 取数：chromium 信标单次上限 + …
  ✓  2 [chromium] › … › C07-AC-03 取数：webkit 信标单次上限 + …
  2 passed (37.2s)
```

即：`--project=chromium` 这一次运行**同时启动了 Chromium 与 WebKit 两个真浏览器**（在 chromium project 的
worker 里跑 webkit 的软件）。后果有两条，都不是"跳过"：

1. **Gecko 永远取不到数**：`--project=firefox` 下这两条**照样跑**，但跑的是 Chromium/WebKit；
   `tests/e2e/results/beacon-quota-firefox.json` **永远不会产生**，报告里 Gecko 的信标额度一栏永远是空的。
2. **project 与引擎错配**：`--project=firefox` 的实际内容是"起一个 Chromium + 一个 WebKit"，与 project 名字相反。

**为什么"跳过审计"覆盖不到它**：`lib/skip-audit.mjs` 的记账挂在 `afterEach`/`afterAll` 上，只看得见
**被执行的用例**；这里用例**在跑**（`executed=2`），只是跑错了引擎——既没有 `skipped`，也没有"整 spec 一条没跑"，
所以判据全绿而事实是错的。这类缺陷需要改**用例声明形状**，不是加一层跳过守卫。

### 2. 改法（与已合入的先例同一套口径，不另造第二套）

- **用例只声明一条**，浏览器来自 project 的 `browserName` fixture：`test('…', async ({ browserName }) => …)`。
- 探测/记账/理由文本的唯一实现抽到新文件 `tests/e2e/lib/browser-availability.mjs`
  （`createBrowserAvailability()`：每浏览器只**真启动探测**一次；`requireBrowser()`：探测结果无论可用与否都记账，
  起不来才登记跳过）。`leave-slice.spec.mjs` 同时改为调用它 —— 两个 spec 共用**同一条**"能不能跑"的判据，
  避免两份实现漂移。**跳过本身仍然只有唯一入口** `lib/skip-audit.mjs::skipUnavailableBrowser()`
  （`browser-availability.mjs` 里没有、也不允许有 `test.skip`，见 `eslint.config.js` 的窄规则）。
- 判据里**没有任何** `browserName` 名单（修后 `grep -n "chromium\|webkit\|firefox" tests/e2e/beacon-quota.spec.mjs`
  只命中头注释里的历史说明）。
- `declaredTests` 钉为 **1**（本 spec 的用例条数），跳过审计据此判"整 spec 在该浏览器上一条都没跑"。
- 证据 JSON 补齐可复核字段：`browser` / `project` / `driver` / `executablePath`（都是 project 决定的值，
  不再是写死遍历出来的标签）。
- 强制走"能跑"分支的钩子统一为 `E2E_FORCE_RUN_BROWSER=<name>`（旧名 `AC03_FORCE_RUN_BROWSER` 仍识别，
  避免破坏既有证明命令的记录）。

### 3. 判别性证明（三要素）

**证明 ①：修后 project 与引擎一一对应**（`--list`，不用起浏览器）

```
$ pnpm exec playwright test tests/e2e/beacon-quota.spec.mjs --list
  [chromium] › beacon-quota.spec.mjs:84:1 › C07-AC-03 取数：信标单次上限 + 累计在途额度 + 片间节流
  [firefox]  › beacon-quota.spec.mjs:84:1 › C07-AC-03 取数：信标单次上限 + 累计在途额度 + 片间节流
  [webkit]   › beacon-quota.spec.mjs:84:1 › C07-AC-03 取数：信标单次上限 + 累计在途额度 + 片间节流
  Total: 3 tests in 1 file
```

修前同一命令是 6 条（3 project × 同样的 2 条写死引擎），且 firefox project 的两条标题是 `chromium` / `webkit`。

**证明 ②（正例）：同一无名单路径在 Chromium/WebKit 上取到数**

```
$ pnpm test:e2e --project=chromium --project=webkit tests/e2e/beacon-quota.spec.mjs
[beacon-quota-probe] [webkit]  ready=true stage=launch driver=npx-cache-playwright-core-1.60.0
[beacon-quota-probe] [chromium] ready=true stage=launch driver=npx-cache-playwright-core-1.60.0
[skip-audit] spec=beacon-quota.spec.mjs browser=chromium worker=0 declared=1 observed=1 executed=1 skipped=0 unregistered=0 probeReady=true
[skip-audit] spec=beacon-quota.spec.mjs browser=webkit   worker=1 declared=1 observed=1 executed=1 skipped=0 unregistered=0 probeReady=true
  ✓  2 [webkit]   › … 取数：信标单次上限 + …
  ✓  1 [chromium] › … 取数：信标单次上限 + …
  2 passed (33.5s)
```

两条用例标题里**没有**引擎名，实际跑的引擎由 project 决定（`results/beacon-quota-{chromium,webkit}.json`
的 `project`/`browser` 字段一致，`userAgent` 分别是 Blink 与 WebKit 的）。跳过数为 **0**。

**证明 ③（钩子·负对照）：强制走"能跑"分支 ⇒ **真的去起 Firefox** ⇒ 红，不是跳过**

```
$ E2E_FORCE_RUN_BROWSER=firefox pnpm test:e2e --project=firefox tests/e2e/beacon-quota.spec.mjs
[E2E_FORCE_RUN_BROWSER] 强制按"能跑"执行 [firefox]（真实探测 ready=false，
    原因：browserType.launchPersistentContext: Timeout 20000ms exceeded.）
[beacon-quota-probe] [firefox] ready=true stage=launch driver=npx-cache-playwright-core-1.60.0
[skip-audit] spec=beacon-quota.spec.mjs browser=firefox worker=0 declared=1 observed=1 executed=1 skipped=0 unregistered=0 probeReady=true
    TimeoutError: browserType.launchPersistentContext: Timeout 60000ms exceeded.
      - [pid=59064][err] sandbox initialization failed: Operation not permitted
      - [pid=59064][err] Sandbox error: sandbox_init() failed with error "Operation not permitted"
  1 failed
PLAYWRIGHT_EXIT=1
```

写死名单的旧代码在 `--project=firefox` 下**根本不会去起 Firefox**（它起的是 Chromium/WebKit）；现在判据说
"能跑"就**真的去起**，起不来就**真红**。这就是"这条跳过/执行是环境判据、不是引擎名单"的判别性证据。

**证明 ④（钩子·正对照）：Firefox 的**真实**探测路径登记跳过并让整轮判红**（不设钩子）

```
$ pnpm test:e2e --project=firefox tests/e2e/beacon-quota.spec.mjs
[beacon-quota-probe] [firefox] ready=false stage=launch driver=npx-cache-playwright-core-1.60.0
    reason=browserType.launchPersistentContext: Timeout 20000ms exceeded.
[skip-audit] spec=beacon-quota.spec.mjs browser=firefox declared=1 observed=1 executed=0 skipped=1 unregistered=0 probeReady=false
[skip-audit] Error: … [firefox]：本次观察到的 1 条**全部被跳过、执行 0 条** —— 该浏览器在本机起不来，
    这批用例一条都没跑。这不是用例失败，是环境阻塞：…
→ 1 skipped + 1 failed（afterAll 的环境阻塞判定） / EXIT=1
```

本条**未**设置任何 `MOZ_*` 变量。

### 4. 回归

| 命令 | 结果 |
|---|---|
| `pnpm test:e2e --project=chromium --project=webkit tests/e2e/beacon-quota.spec.mjs` | **2 passed**，`executed=1/skipped=0` 每浏览器（证明 ②） |
| `pnpm exec playwright test tests/e2e/beacon-quota.spec.mjs --list` | 3 project × 1 条（证明 ①） |
| `node tests/e2e/lib/skip-audit-selftest.mjs` | **14/14 通过**，exit 0 |
| `pnpm exec eslint tests/e2e` | exit 0（新文件 `lib/browser-availability.mjs` 无 lint 违规） |
| `pnpm examples:build` / `pnpm examples:test` | **exit 0**（见下节；webpack 的跨平台改动） |

**本报告不宣称的事**：**Firefox（Gecko）的信标额度没有被验证过**。本机沙箱内 Firefox 起不来
（`sandbox_init()` EPERM），证明 ③ 证明的是"判据说能跑就真去起、起不来真红"，证明 ④ 证明的是
"起不来时逐条登记跳过 + 整轮判红"，**都不是**"Firefox 上通过"。要在 Gecko 上取数，需在能起 Firefox 的
机器上跑 `pnpm test:e2e --project=firefox`（**不得设置任何 `MOZ_*`**）。

### 5. 同源残留（**只报告，未改**）：`tests/e2e/**` / `examples/**` 下其余的写死引擎名 / 平台路径

| 位置 | 写死了什么 | 性质 |
|---|---|---|
| `tests/e2e/lib/browsers.mjs:26-30` | `EXECUTABLE_RELATIVE` 是 **macOS arm64** 布局（`chrome-mac-arm64/…app`、`firefox/Nightly.app`、`pw_run.sh`） | **启动探测的最后一个回退分支**（顺序 1 `PW_<NAME>_EXE` → 2 树外驱动 `executablePath()` 精确配对 → 3 本机缓存 + 这张表）。1/2 都跨平台；表本身只影响"没有树外驱动"的机器。本机实测用的正是分支 2（`driver=npx-cache-playwright-core-1.60.0`），**没有踩到**。建议后续用 `browserType.executablePath()` 的实例推导替换这张表 |
| `tests/e2e/lib/d004-anchor-window.mjs:480` | `for (const browser of ['chromium','webkit'])` 读 `results/d004-<browser>.json` | 该文件**末尾**的信息性汇总（`dumpRealArtifacts()`，只打印产物时间与 sha256）。Firefox 的 d004 产物**今天还不存在**（`lib/d004-run.mjs` 的 CLI 默认 `--browser chromium`，可显式传别的），所以现在不漏读；将来若有 `d004-firefox.json` 会被静默忽略。**不是**门禁判据 |
| `tests/e2e/lib/d004-run.mjs:105,343` | 默认参数 `--browser chromium` | CLI 默认值（可覆盖），与"写死名单"不同性质 |
| `tests/e2e/lib/smoke-browsers.mjs:11` | `['chromium','firefox','webkit']` | CLI 参数 `all` 的**取值词汇表**（`node … smoke-browsers.mjs all`），不是判据 |
| `examples/webpack/README.md:52` | 文字描述"若本机存在 `chromium-1223`" | 文档，已随本轮改动失去事实依据，建议下一轮随代码同步（`examples/**` 在本次可写范围内，但 README 不是判据，未改） |

**另有 2 处同类（本轮**未**改，属别 lane 范围，按派工口径只报告）**：
`tests/compat/scripts/vite-dev-server.mjs:31` 与 `tests/compat/scripts/browser-core-path.mjs:38,43`
仍写死 `Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64`（与 `examples/webpack` 修前**同型**）。
`tests/compat/**` 不在本 lane 可写范围；另注：`tests/compat/**/*.test.ts` 目前**不在** `vitest.config.ts`
的任何 project 里，所以这些脚本的产物即使缺失也进不了门禁。

### 6. 编排方裁定后的收尾（2026-10-16，同一 lane）

派工对本节 §5 的残留表做了裁定，其中 3 项落在本 lane 可写范围内，逐项处置如下。

**① `examples/webpack` 的"必须有浏览器" opt-in（编排方裁定 (2)：批准）**

口径：**默认不假装，声明即承担**——与"跳过不可静默"是同一条原则的两面。

- 默认（不设变量）语义**不变**：定位不到即 `skipped`（带理由的合法豁免，**不计入 pass**，不是失败）。
  默认值必须服务"CI 的 gates job 不装浏览器"这个事实，否则会把门禁在 CI 上弄红、且红因是环境而不是 SDK。
- 设 `EXAMPLES_REQUIRE_BROWSER=1` 时，定位不到返回新状态 `unavailable`（**不是**白名单里的 `skipped`）
  ⇒ `classifyBrowserEvidence()` 返回 `accounted: false` ⇒ 整体 `status: fail`、`exit 1`。
- 实现：`examples/webpack/scripts/lib/chromium-locate.mjs` 的 `browserRequired()` / `unavailableStatus()` /
  `requiredBrowserHint()`；两个脚本的 `browserCheck()` 在 `located.browser === null` 分支改用
  `unavailableStatus()`，并在该状态下把 `requiredBrowserHint()` 打进 stderr。

判别性证明（三要素，本机实跑；证据文件运行前后均按 sha256 还原）：

| 场景 | 命令 | 观察到 |
|---|---|---|
| opt-in + **无**可用浏览器 | `HOME=/tmp/proof-home PLAYWRIGHT_BROWSERS_PATH=/tmp/proof-browsers PW_CHROMIUM_EXE=/tmp/broken-chromium EXAMPLES_REQUIRE_BROWSER=1 node examples/webpack/scripts/build-production.mjs` | `✗ 浏览器复核失败：…` + hint；`browser.status="unavailable"`、`status="fail"`、**EXIT=1**（同一环境**不设**变量时是 `skipped` / `status=pass` / EXIT=0——上表 §3 证明 ② 已记录） |
| opt-in + **有**可用浏览器 | `EXAMPLES_REQUIRE_BROWSER=1 node examples/webpack/scripts/build-production.mjs` | `browser.status=pass`、`accounted=true`、`status=pass`、EXIT=0（opt-in 不误伤能跑的场景） |
| opt-in + 无浏览器（dev-server） | 同上环境 `node examples/webpack/scripts/dev-server.mjs` | `checks.browserEvidenceAccounted=false`、`browser.status=unavailable`、`status=fail`、**EXIT=1** |
| 默认 + 无浏览器（dev-server，负对照） | 去掉 `EXAMPLES_REQUIRE_BROWSER` | `⚠ 浏览器复核已跳过…`、`browserEvidenceAccounted=true`、`browser.status=skipped`、`status=pass`、EXIT=0 |

**② `tests/e2e/lib/d004-anchor-window.mjs` 的静默忽略 → 加一行可见告警（编排方要求，各一行即可）**

`dumpRealArtifacts()` 只列 `chromium` / `webkit`；别的 `d004-<x>.json`（如将来在能起 Gecko 的机器上跑出的
`d004-firefox.json`）此前**不会被读到、也不会吭声**。现在扫描 `tests/e2e/results/`，对清单外的名字打一行
`⚠ 以下 d004 产物存在但**未被本清单读取**…`。**判据/断言一字未动**（该函数只在 `--dump` 下打印）。

判别性证明：植入一份 `tests/e2e/results/d004-firefox.json` 后 `node tests/e2e/lib/d004-anchor-window.mjs --dump`
→ 告警出现、`d004-firefox.json` 被点名、EXIT=0；**删除植入文件后**同一命令告警计数为 **0**（负对照），
`node tests/e2e/lib/d004-anchor-window.mjs` 仍 **EXIT=0**。

**③ `examples/webpack/README.md:52` 的过期文字 → 改掉**

原文"若本机存在 `chromium-1223`，路径与 T30 其它脚本一致"已失去事实依据（本轮起是跨平台运行时定位）。
改为描述真实定位链（`PW_CHROMIUM_EXE` → `chromium.executablePath()` → 本机 `chromium-*` 缓存，
**真的启动成功**才算可用）、"定位不到记 `skipped` 且带逐条尝试与真实报错、不记 pass"、
以及 `EXAMPLES_REQUIRE_BROWSER=1` 的 opt-in 语义。

**未处置（按裁定属别 lane / 不在本 lane 范围）**：`tests/compat/scripts/{vite-dev-server.mjs:31,
browser-core-path.mjs:38,43}` 的同类写死路径——编排方**已批准另派**，本 lane 不动手；
`tests/e2e/probes/mutant-transport.js` 的"派生却被跟踪"由编排方处置（`git rm --cached` + `.gitignore`），
本 lane 不再回退它。

### 7. CI 上"到底哪个 job 会跑到 examples"（只报告，不改 `.github/workflows/`）

派工要求的前置清单。`find .github -name '*.yml' -o -name '*.yaml'` 实测**只有 `ci.yml` 一个 workflow**
（内容为全文逐行核对，非推测）：

| job | runner | 装浏览器？ | 跑 examples？ | 依据（行号） |
|---|---|---|---|---|
| `gates` | `ubuntu-latest` | **否**（无任何 `playwright install`） | **是**：`pnpm examples:build`、`pnpm examples:test` | `ci.yml:12-31`（`pnpm install` 见 `:22`，两条 examples 见 `:30`、`:31`） |
| `e2e` | `ubuntu-latest`，`needs: gates` | **是**：`pnpm exec playwright install --with-deps` | **否**（只有 `pnpm build` + `pnpm test:e2e`） | `ci.yml:33-47`（装浏览器 `:45`，`test:e2e` `:47`） |

**结论**：两个 job 的交集是**空集**——装浏览器的 job 不跑 examples，跑 examples 的 job 不装浏览器。
因此 webpack 的浏览器复核（`examples/webpack/scripts/*.mjs` 的 `browserCheck`）**今天在任何 CI job 上都不会执行**，
只会走到 `skipped`。`grep -rn "playwright install\|examples:build\|examples:test\|test:e2e" .github/`
只有上面这四行命中，没有第三个 job、也没有别的 workflow 兜底。

**最自然的接法（供裁定 (1) 使用，本 lane 不改）**：把 `examples:build` / `examples:test` 加到 **`e2e` job**
（它已经装了浏览器），或给 `gates` job 加一步 `playwright install chromium`（更省时间但要多下载）。
两者都属 `.github/workflows/ci.yml`（**门禁配置，需负责人追认**）。

---

## 追加节（2026-10-19）：浏览器**定位/名单**的三处收口 + 全仓残留清单（只报告）

> lane：可移植性收口；可写范围 `tests/e2e/lib/**`、`tests/compat/scripts/**`、`tests/e2e/README.md` 与
> 本报告/`compat-matrix.md`/`t33-access-blockers.md` 的追加节。**未跑 `pnpm gates`**（另一条 lane 在改
> `tools/mock-receiver/**`，在途改动会让门禁结果不可信）；未做任何 git 写操作；**本机 Firefox 依旧起不来**
> （`sandbox_init()` EPERM，**未设置任何 `MOZ_*`**），本节不声称任何 Firefox 结论。

### 1. 修前实情（`tests/e2e/lib/browsers.mjs`）

| 位置（修前） | 写死了什么 | 在 Linux CI 上会怎样 |
|---|---|---|
| `browsers.mjs:22` | `CACHE_DIR = join(os.homedir(), 'Library', 'Caches', 'ms-playwright')` | Linux 的缓存根是 `~/.cache/ms-playwright`（或 `$XDG_CACHE_HOME/ms-playwright`），**这个根不存在** |
| `browsers.mjs:26-30` | `EXECUTABLE_RELATIVE`：`chrome-mac-arm64/…app`、`firefox/Nightly.app/…`、`pw_run.sh` | Linux 布局是 `chrome-linux/chrome`、`firefox/firefox`、`webkit/pw_run.sh`；即便根对了，**每个引擎都拼不出可执行文件** |
| `browsers.mjs:50-59` | `TREE_OUT_DRIVERS` 两条 `/Users/spirit-ai/…` 绝对路径（含一个**别的仓库**） | 两条都不存在 ⇒ 分支 2 恒跳过 |

具体后果：CI 的 `e2e` job（`.github/workflows/ci.yml:33-58`）**先 `playwright install` 再 `pnpm test:e2e`**，
也就是说 Linux 上浏览器是装好的（`~/.cache/ms-playwright/chromium-1248/...`）。但解析链是三段全落空：
分支 1（`PW_<NAME>_EXE`）未设置 → 分支 2 的绝对路径不存在 → 分支 3 扫错根 + 用错布局 ⇒
`resolveBrowser()` 对 chromium/firefox/webkit **一律抛错**"没有可用的浏览器 + 驱动组合"。
于是三个 project 全红，**红的原因是路径，不是 SDK**；而"浏览器其实装着"这件事被埋在报错里。

### 2. 改法（`tests/e2e/lib/browsers.mjs`，不写任何平台布局表）

1. **缓存根按平台算**（`cacheRootForPlatform(platform, env, home)`，纯函数、平台是注入参数）：
   Linux `$XDG_CACHE_HOME` 或 `~/.cache`、Windows `%LOCALAPPDATA%`（无则 `%USERPROFILE%\AppData\Local`）、
   macOS `~/Library/Caches`；未知平台返回 `null`（不猜）。`defaultCacheRoot()` 优先
   `PLAYWRIGHT_BROWSERS_PATH`（`=0` 例外，退回平台默认）。
2. **构建内布局从 `executablePath()` 推导**：`executableTail(browserName, expectedPath)` 取期望路径里
   `<name>-<revision>` 之后的部分，`executableInBuild()` 把它搬到已装构建目录 —— **只换 revision**。
   macOS 的 `.app` 包、Linux 的 `chrome-linux/chrome`、Windows 的 `chrome-win/chrome.exe`、WebKit 的
   `pw_run.sh`、Firefox 的 `Nightly.app` 全部由这一条覆盖（布局是 Playwright 算出来的，不是我们维护的）。
3. **新增分支 3**：仓库驱动自己的 `executablePath()` 存在就直接用（`exactPairing: true`）——
   **CI 的 `playwright install` 走的就是这条**。
4. **树外驱动不写死用户名**：`E2E_TREE_OUT_DRIVERS`（`path.delimiter` 分隔）+ 自动发现
   `~/.npm/_npx/*/node_modules/playwright-core`（本机命中的仍是 1.60.0 那个，`driverId` 不变）。
5. 构建目录**允许符号链接**（本机 `chromium-1208 -> chromium-1223` 就是链接；用 `statSync` 而不是
   `Dirent.isDirectory()`，否则这类构建会被静默漏掉）。
6. 判据自检：`tests/e2e/lib/browser-locate-selftest.mjs`（25 项，确定性、不用浏览器、不用 Linux）。

### 3. `lib/d004-run.mjs` 默认 `--browser chromium`：**是静默覆盖缺口**，已改

事实：`durability.spec.mjs` 一直显式传 `browserName`（每个 project 各测各的），所以**Playwright 路径不受影响**；
缺口在 **CLI 路径**：`node tests/e2e/lib/d004-run.mjs`（不带 `--browser`）只测 chromium、只写
`results/d004-chromium.json`、**exit 0**、输出里完全不提另外两个引擎。证据是"按引擎一份文件"，
消费方（`tests/reliability/reconcile.mjs`、`lib/d004-anchor-window.mjs`）读不到就是"没数据"——
但**没有任何信号告诉人"你少跑了两个引擎"**。这正是 t33 记的"未运行的检查被读成通过"形态。

改法（两条一起）：
- CLI 默认 `--browser all`：枚举 `lib/browser-names.mjs` 里**声明的全部**浏览器；
- 每个引擎**先真启动探测**（复用 `lib/browser-availability.mjs` 的 `probeBrowser`），起不来的显式打印
  `⛔ [d004] [firefox] …本次没有产出任何 firefox 证据——这是**证据覆盖缺口**，不是"通过"，也不是产品失败`
  （裁定 (d) 要求这句话保留、别简化）+ 真实报错，末尾再打一张
  "证据产出记账"表并有**任一引擎缺证据 ⇒ exit 1**（直接点名"整轮不得被读成全引擎已验证"）；
- `runD004({ browser })` **不再有默认值**（漏传直接抛错，理由写在错误里）——消除"悄悄只跑一个"的可能；
- `--out` 只允许单引擎（多引擎用新的 `--out-dir`，每个引擎各写 `d004-<browser>.json`）。

**README 口径（裁定 (d)/(f)）**：`tests/e2e/README.md` 已写明"**在 Firefox 起不来的机器上，默认命令会红
是预期行为、不是回归**，收窄用 `--browser chromium`"，并新增"**自己诊断'为什么它找不到浏览器'**"一节
（找过的缓存根 / 期望的二进制 / 试过的每个候选 / `PW_<NAME>_EXE` 强制指定 / 自检命令），
照它就能自己判断卡在哪一层，不用读代码。

### 4. `lib/smoke-browsers.mjs` 的取值词汇表：与真实探测口径**不一致**，已改

修前：`const names = which === 'all' ? ['chromium','firefox','webkit'] : [which];`
—— ① 手写名单，与 Playwright 实际导出的引擎是两份东西；② `which` 不做校验，`chrome` / 带空格的
`firefox ` 会被当成浏览器名继续往下传，最后得到一条"本机没有可用组合"的**误导性**错误；
③ 无论 `OK` 还是 `LAUNCH-FAIL` 都 **exit 0**（打完红字仍是绿的）。

改后：名字来自 `lib/browser-names.mjs` 的 `declaredBrowsers()` —— **从 `@playwright/test` 的导出里取**
（判据 = 带 `launchPersistentContext` 的非私有导出），也就是 `lib/browsers.mjs` 解析、
`lib/browser-availability.mjs` 探测、`lib/harness.mjs` launch 用的**同一批对象**，不可能漂移成两份名单；
非法名字 ⇒ 报错并列出 `all|chromium|firefox|webkit`、exit 2；逐个浏览器打一行结局 + 汇总，
**任一没起来 ⇒ exit 1**。（当前与 `playwright.config.ts` 的三个 project 同名；配置是 `.ts`，
从 `.mjs` 脚本安全读取它需要额外 loader，故未解析配置——配置增删 project 时需同步本文件说明。）

### 5. 判别性证明（都在本机实跑；变异恢复后 sha256 与基线逐字节一致）

| 处 | 改坏/改前的观察 | 改后的观察 |
|---|---|---|
| `browsers.mjs` 平台根 | 变异：`cacheRootForPlatform` 恢复成"linux 也返回 `~/Library/Caches`" → `browser-locate-selftest` **22/25、exit 1**（3 条 Linux/XDG 判据红） | 恢复后 **25/25、exit 0** |
| `browsers.mjs` 分支 3 | 变异：停用"仓库驱动 `executablePath()`"分支 → 自检 **24/25、exit 1**（端到端分支 3 判据红：改走 9999 且 `exactPairing=false`） | 恢复后 25/25 |
| `d004-run.mjs` 默认引擎 | 还原成修前文件：`--cells preflush-small --no-gate --out /tmp/…` → 只测 chromium、**exit 0**、全文不出现 firefox/webkit | 新默认：`… --out-dir /tmp/d004-all` → chromium ✓ / webkit ✓ / firefox ✗（真实报错 `Timeout 20000ms exceeded`）、末尾记账表、**exit 1** |
| `smoke-browsers.mjs` 退出码 | 还原成修前文件 + `PW_CHROMIUM_EXE=<不可执行文件>` → `LAUNCH-FAIL` 但 **exit 0** | 改后同命令 → `LAUNCH-FAIL` + 汇总 + 告警，**exit 1**；`chrome` → 报错列合法取值、**exit 2** |
| 变异恢复 | 三个文件按 `/tmp` 备份逐字节还原 | `shasum -a 256` 与改动后基线一致（`browsers.mjs b48e89fb…`、`d004-run f96bf0fe…`〔证明时刻；此后按裁定 (d) 又改了 unavailable 文案，最终 sha 见 §8〕、`smoke-browsers 63f75c4f…`） |

### 6. 回归（只跑相关最小命令）

| 命令 | 结果 |
|---|---|
| `node tests/e2e/lib/browser-locate-selftest.mjs` | **25/25 通过，exit 0** |
| `node tests/e2e/lib/skip-audit-selftest.mjs` | **14/14 通过，exit 0**（该文件未被本 lane 改动；用于确认"跳过不可静默"判据未被本轮改坏） |
| `node tests/e2e/lib/browsers.mjs` 的解析（`node -e`） | chromium/firefox/webkit 均**仍走分支 2**（`npx-cache-playwright-core-1.60.0`，`exactPairing=true`），`driverId`/`source` 字符串与修前一致 |
| `node tests/e2e/lib/smoke-browsers.mjs chromium` / `… all` | chromium OK；`all` 汇总 `ok=2 failed=1`（firefox 真实超时）、**exit 1** |
| `node tests/e2e/lib/d004-run.mjs --cells preflush-small --no-gate --out-dir /tmp/d004-all` | chromium/webkit 各产出 1 格、firefox 显式未产出、exit 1（产物写 `/tmp`，**未覆写** `tests/e2e/results/**`） |
| `pnpm exec eslint tests/e2e tests/compat` | **exit 0** |

**未验证**：Linux（本机 macOS/arm64，未在 Linux 上实跑；跨平台性由注入平台的确定性自检证明，
不声称已验证）；Firefox 任何数字（起不来）；`pnpm gates`（并发 lane，未跑）。

### 7. 全仓残留（**只报告，未改**）

| 位置 | 写死了什么 | 在 Linux CI 上的影响 |
|---|---|---|
| `tests/e2e/lib/harness.mjs:28` | `processPattern()` 的正则要求 `/` 分隔（`ms-playwright/<build>/`） | Linux 上正常；**Windows** 上退回 executablePath（仍可用）。另 `pgrep`（`:35,73`）Windows 无此命令 ⇒ PID 列表恒空、`hardKill` 会抛"无法强杀"——Windows 目前不在 CI 矩阵内 |
| `tests/e2e/lib/d004-anchor-window.mjs:480` | `for (const browser of ['chromium','webkit'])` 读 `results/d004-<b>.json` | 信息性汇总（`--dump` 才打印）。firefox 产物若出现，上一轮已加"未被本清单读取"告警；**判据未用** |
| `tests/reliability/reconcile.mjs:99` | `browsers = ['chromium','webkit']` 默认值 | 读不到 `d004-firefox.json`（今天也不存在）。该文件**不在本 lane 可写范围** |
| `poc/poc-1/lib/driver.mjs:16` | `DEFAULT_CACHE_DIR = ~/Library/Caches/ms-playwright` | POC 脚本，不在任何门禁/CI |
| `examples/webpack/scripts/lib/chromium-locate.mjs:87-113` | Chromium 的 `chrome-mac[-arm64|-x64] / chrome-linux[64] / chrome-win[64]` 布局候选表 | **不是缺陷**：跨平台、且每个候选都真启动验证；这也是本轮复用的那份实现（`examples/**` 本轮不可写） |
| `tests/compat/README.md:85` | 文字"本机装了 `chromium-1223`（`~/Library/Caches/ms-playwright`）" | 文档措辞（macOS 专属）；该文件不在本 lane 可写范围，建议下一轮随代码同步 |
| `tests/e2e/results/*.json`、`tests/compat/results/*.json`、`tests/reliability/results/*.json` | 证据产物里的 `executablePath` 是**绝对路径**（含用户名） | **待办（裁定：本轮不改，属产物格式变更、需单独评估）：证据产物应记录相对路径或脱敏**——现在会把 `/Users/<user>` 永久写进仓库（功能上无害，但泄漏本机用户名） |
| `tests/e2e/README.md`（本轮已改） | 修前写着 `/Users/spirit-ai/.npm/_npx/...` | 已替换为"npx 缓存自动发现"的措辞 |

### 8. 最终字节与裁定落点（2026-10-19，同一 lane）

裁定 (c)(d)(f) 落实后的**最终 sha256**（`shasum -a 256`）：

| 文件 | sha256 |
|---|---|
| `tests/compat/scripts/lib/chromium-launch.mjs` | `ee253ec27c3a4f5aa895ad9d0487f0f9cdc99d342f1ea90a8309fa78065f5ee0`（含旧变量 `T30_CHROMIUM_PATH` 保留 + 弃用告警） |
| `tests/compat/scripts/browser-core-path.mjs` | `7848b5d05b225056031ae3406cfa95916ec3d629da5cf1b73bcf500e8ecf2dea` |
| `tests/compat/scripts/vite-dev-server.mjs` | `54a66ae52aa23718736abb5ed82bc99904f9dc77323643b563e7aa764e94f3e0` |
| `tests/e2e/lib/browsers.mjs` | `b48e89fbac93016e385a99d39ce0ebf6ac6100fc74a352f4975b88856046b9b0` |
| `tests/e2e/lib/browser-names.mjs` | `96edecb2f3fa86b1a76fcde9c5c5c12a2c2db0bb7fb68ae39f756ef0be3e6499` |
| `tests/e2e/lib/browser-locate-selftest.mjs` | `919bfddeb9d57e5fbf810fb92f04c2b58fb0c48d2ee16ee5e6ba02780f74a32b` |
| `tests/e2e/lib/d004-run.mjs` | `f8097fd75076aacf3351a7b9e9b09d50434aa4aee765ca92d78574cd45be27fb` |
| `tests/e2e/lib/smoke-browsers.mjs` | `63f75c4fc8cfb0894b56e2e502a191c2d5fa67edf2af563b61f8e166733f56ac` |

- **(c) 旧变量保留**：`T30_CHROMIUM_PATH` 仍识别（每进程一次弃用告警、新名 `PW_CHROMIUM_EXE` 优先）；
  四组实测（旧名真路径 / 旧名坏路径 / 新旧同设 / 旧名 + 无缓存）见 `docs/reports/compat-matrix.md` §9.3。
- **(d) 文案**：`⛔ …本次没有产出任何 X 证据——这是**证据覆盖缺口**，不是"通过"，也不是产品失败`；
  末尾 `⚠ 证据覆盖缺口：… 整轮不得被读成"全引擎已验证"，也不是产品失败`（实跑复核：firefox ✗、exit 1）。
- **(f) README**：`tests/e2e/README.md` 的"一条命令"下补了"**默认命令在某个引擎起不来的机器上会红是
  预期行为**、收窄用 `--browser chromium`"，并新增"**自己诊断'为什么它找不到浏览器'**"一节（四处按序看）。
- **待办（本轮不改，已按裁定登记）**：证据产物里的绝对路径含 `/Users/<user>`（泄漏本机用户名）——
  **证据产物应记录相对路径或脱敏**，属产物格式变更，需单独评估。
- **(a)(e) 由编排方执行**：重生成并提交 compat 两份证据 JSON（旧 `status:pass` 是陈旧结论，需在提交
  信息里写明）；把 compat 两个浏览器脚本接进 CI 的 e2e job（门禁配置变更、经负责人追认）。本 lane 未做。
