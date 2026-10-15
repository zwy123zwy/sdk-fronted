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
