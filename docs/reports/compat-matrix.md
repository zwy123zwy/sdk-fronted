# 客户端兼容矩阵（T30）

- 任务卡：`docs/tasks/T30.md`（3 人日 / A09）；依赖 T20（基准体系，已合入 main）。
- 权威口径：T30 验收用例、`docs/decisions/Q1-scale.md`（浏览器矩阵）、
  `docs/decisions/Q7-apm-coexistence.md`（与第三方 APM 共存）、指南第 4.2 节（接入方式）。
- 证据与可复跑命令：`tests/compat/`（矩阵单元逐格落盘在 `tests/compat/results/*.json`）。
- 本报告的全部结论都来自**本机实跑**；凡是本机做不了的格子，一律标 `blocked` 并写清"缺什么"。

## 0. 结论摘要

> **2026-10-14 更新（webpack 两格补测）**：负责人批准新增 `examples/webpack` 与 webpack 开发依赖后，
> 原第 26/27 格已由 `blocked` 改为**实测结论**，两格均 `pass`（证据：
> `tests/compat/results/webpack-production.json`、`results/webpack-dev-server.json`）。
> 补测期间复核到 `fail`② 已被并发修复（`packages/core/src/kernel/global-registry.ts` 的 `dispose()` 现在
> 只在"全局值仍是自己那一层"时还原），因此本节的计数与第 3/4 节已按**当前**证据同步；
> 第 2.3 节表格保留原判词，以免掩盖"它曾经是缺陷"这件事。

| 指标 | 数量 |
|---|---|
| `pass`（本机实跑通过，证据落盘） | **38** |
| `fail`（本机实跑不通过，已定位） | **1** |
| `blocked`（本机做不了，写清缺什么，归 T29） | **6** |
| 合计 | 45 |

**三条必须让负责人知道的结论**：

1. **`fail`（现存唯一）：CJS `require("@web-report-sdk/browser")` 直接失败**（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。
   `exports` 只有 `source`/`types`/`import` 条件，没有 `require`。指南 4.2 要求"Vitest、Jest 测试环境中
   直接导入，不需要额外配置"，而现有 Jest 示例实际依赖 `--experimental-vm-modules` + `.mjs`（属额外配置）。
   处置需负责人决定（加 `require` 条件 / 只支持 ESM 并在指南写明）。
   **不阻塞 webpack**：webpack 5 消费 ESM 无障碍，本次两格实测均 `pass`（它走 `import` 条件，不看 `require`）。
2. **~~`fail`②：与第三方 APM 共存时，"SDK 先装、第三方后装"顺序下 `destroy()` 会抹掉第三方的包装层~~ ——
   已修复，2026-10-14 复核通过**（本条为并发修复后的复核结论，非本次 webpack 补测的产出）。
   当前证据：`apm.order.sdkFirst`、`apm.stacked.sdkFirst` 两格 `pass`；
   独立复现脚本 `node tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs` 输出
   "结论：符合 Q7 第 4 条"、**exit 0**。
3. **真实 Chromium（Chrome for Testing 148.0.7778.96）上核心路径全部通过**：`init`→`track`→`flush`
   →接收方收到批次（`protocol_version=1`、`app_id` 正确）、`captureError`、**真实未捕获异常**、
   以及 `X-Server-Time` → C04 时钟校准（第二批 `clock_calibrated=true`）。
   webpack 生产构建与开发服务器另各做了一次 Chromium 复核（页面渲染出 `web-report-sdk 0.0.0`、无 page error）。

## 1. 环境与偏差声明（**不得省略**）

| 项 | 本报告实际 | 说明 |
|---|---|---|
| 浏览器 | 本机缓存 `~/Library/Caches/ms-playwright/chromium-1223`（Chrome for Testing **148.0.7778.96**），用 `executablePath` 指向 | 仓库锁定 `@playwright/test@1.64.0` 期望 chromium-1248，**本机没装**；不安装任何浏览器 |
| Playwright | 仓库锁定的 `@playwright/test@1.64.0` | 只借它的驱动能力，浏览器是上一条那个 |
| 接收方 | 脚本内的 node http `/ingest`（同源），收到什么写进结果 JSON | 不触外网；不伪造字节数/条数 |
| 进程内用例 | node 24.16.0（`environment: node`）；共存与页面事件用例用 `happy-dom` | 逐条在结果 JSON 里标注 engine |
| 构建工具（2026-10-14 补测） | `webpack 5.104.1` / `webpack-cli 6.0.1` / `webpack-dev-server 5.2.2`，只装在 `examples/webpack` 的 **devDependencies** | SDK 自身仍为零第三方运行时依赖；`packages/*` 的 dependencies 未动 |
| 未做 | Firefox / WebKit / Edge / 最低版本 / iOS Safari / Android Chrome | 见第 4 节，逐条写清缺什么 |

`pnpm exec vitest run --config tests/compat/vitest.config.ts` 的 `exit code` 是 **0**（2026-10-14 实测）：
原有两处红格中，`import.cjs.require` 是**用例有意记录的真实缺口**（它断言"确实抛
`ERR_PACKAGE_PATH_NOT_EXPORTED`"，所以这一格红不代表用例红）；`apm.order.sdkFirst` 在缺陷②
修复后已转绿。**`tests/compat/` 不在任何门禁 project 里**
（根 `vitest.config.ts` 只含 `unit`/`contract`/`security`），因此不影响 `pnpm gates`。

## 2. 矩阵结果（45 格）

### 2.1 接入方式（指南第 4.2 节）

| # | 维度 | 环境 | 结论 | 证据 / 命令 |
|---|---|---|---|---|
| 1 | ESM 导入 | node 24 | `pass` | 产物 `packages/browser/dist/index.js`：命名导出与 `SDK_VERSION` 可用 |
| 2 | 无 DOM 导入（SSR/测试环境前提） | node 24（无 window/document） | `pass` | 子进程动态 `import()` 不抛错，模块顶层无副作用 |
| 3 | `<script>` IIFE 全局 | node vm | `pass` | `pnpm examples:test`（`examples/script-tag/check.mjs` exit 0）+ 本目录 IIFE 用例 |
| 4 | `exports` 条件映射 | node 24 | `pass` | `.` = `{source,types,import}`；`./iife` = `./dist/web-report-sdk.iife.js` |
| 5 | **CJS `require`** | node 24 | **`fail`** | `ERR_PACKAGE_PATH_NOT_EXPORTED`；同一份产物按文件路径 `require` 是成功的（限制来自 exports 映射） |
| 6 | Vite 生产构建 | vite 8.3.4 | `pass` | `pnpm examples:build` exit 0（`temp/t30-examples.log`） |
| 7 | **Vite 开发服务器**（此前**零验证**） | vite 8.3.4 + Chromium | `pass` | `node tests/compat/scripts/vite-dev-server.mjs`：`/src/main.ts` 被改写为 `/@fs/…/packages/browser/dist/index.js`，该模块 HTTP 200，页面渲染出 `web-report-sdk 0.0.0`，无 page error |
| 8 | Vitest 导入 | vitest 5.0.3 | `pass` | `pnpm examples:test`（`examples/node-import` 的 vitest 用例） |
| 9 | Jest 导入 | jest 30.5.2 | `pass`（**带前提**） | `pnpm examples:test` 通过，但用的是 `--experimental-vm-modules` + `.mjs`——对"不需要额外配置"是**打折的通过**，见结论① |
| 10 | **webpack 生产构建**（2026-10-14 由 `blocked` 补测） | webpack 5.104.1 + Chromium | **`pass`** | `node examples/webpack/scripts/build-production.mjs`：`webpack --mode production` 产出 `examples/webpack/dist/main.js`（无 SDK 专属配置），沙箱实跑 `createAssembly→init→track→flush` 后接收方**收到批次**（`webpack_probe`），`SDK_VERSION=0.0.0` 与包清单一致；Chromium 打开产物页面渲染出 `web-report-sdk 0.0.0`、无 page error。证据 `tests/compat/results/webpack-production.json` |
| 11 | **webpack 开发服务器**（2026-10-14 由 `blocked` 补测） | webpack-dev-server 5.2.2 + Chromium | **`pass`** | `node examples/webpack/scripts/dev-server.mjs`：`GET /` HTTP 200、`GET /main.js` HTTP 200（804 KiB dev bundle），bundle 沙箱里同上跑通最小路径；Chromium 渲染出 `web-report-sdk 0.0.0`、无 page error。证据 `tests/compat/results/webpack-dev-server.json` |

### 2.2 不支持 API 的降级路径（T30 验收第 2 条）

每条都**真的把能力拿掉**（创建装配根前把全局置 `undefined`），并且**配了对照格**证明不是空转。

| # | 能力 | 做法 | 结论 | 判别力（对照格） |
|---|---|---|---|---|
| 12 | `CompressionStream` 缺失 | 删除全局 | `pass`：>4 KB 正文未压缩（`bodyBytes undefined`），批次仍送达且可按 JSON 解析 | 能力存在时同一夹具 `bodyBytes` 是 `Uint8Array` |
| 13 | `crypto.randomUUID` 缺失 | 删除 `crypto` | `pass`：事件标识退回到内置 UUID v4（正则严格匹配），批次仍送达 | — |
| 14 | Web Locks 缺失 | 删除 `navigator` | `pass`：`createDefaultLocksPort() === null`，广播端口仍可用 | node 24 原生**有** `navigator.locks`，所以必须真删 |
| 15 | 选主降级（多标签页） | 注入不同端口组合 | `pass`：`locks / broadcast / none` 三态实测（`none` = 各自补发、靠接收方去重） | 注入 `locks` 时 mode 必须是 `locks` |
| 16 | IndexedDB 缺失 | node 默认无 `indexedDB` | `pass`：离线持久化不可用，正常通道不受影响 | — |

### 2.3 与第三方 APM 共存（T30 验收第 3 条 + Q7 第 4 条）

| # | 维度 | 结论 | 说明 |
|---|---|---|---|
| 17 | 顺序 A：第三方先装、SDK 后装 | `pass` | 业务请求双方各计一次；SDK 批次送达（含 `web_http`）；`destroy()` 后第三方包装**仍在**全局上；另实测该顺序下 SDK 捕获的"原生"引用即第三方包装 |
| 18 | **顺序 B：SDK 先装、第三方后装**（缺陷②） | **`pass`**（原 `fail`） | 修复前：业务请求双方各计一次、SDK 批次送达都成立，但 `destroy()` 后第三方包装**被抹掉**（全局变回 SDK hook 前的原生引用）→ 第三方此后采集不到任何请求（根因见结论②）。修复后：`dispose()` 只在当前值仍是 SDK 自己那一层时才还原 `chain.base`，第三方包装**仍在**全局上并仍在采集 |
| 18a | 顺序 A + **两层第三方叠加** | `pass` | 两个第三方都在 SDK 之前装上；`destroy()` 后回到最外层第三方那一层（`chain.base`），业务请求仍穿过两层第三方与 SDK 层 |
| 18b | 顺序 B + **两层第三方叠加** | `pass` | SDK 先装、两层第三方依次后装；`destroy()` 后两层都被保留，两层第三方与原生都仍收到业务请求 |
| 19 | error 监听链完整 | `pass` | 派发 `error` 事件后第三方计数 1；SDK `destroy()` 后再派发计数 2（第三方监听器仍在链上） |

### 2.4 真实浏览器（Chromium，最新版本）

`node tests/compat/scripts/browser-core-path.mjs`（exit 0，11 项 checks 全 `pass`，
结果 `tests/compat/results/browser-core-path.json`）：

| 检查 | 结论 |
|---|---|
| 接收方确实收到批次 | `pass` |
| 核心路径 `assembly`/`init`/`track`/`captureError` 四步 | `pass` |
| `SDK_VERSION` 可用 | `pass` |
| `track` 的自定义事件送达 | `pass` |
| `captureError` 送达（`web_js_error`，message 含 `compat-capture-error`） | `pass` |
| **真实未捕获异常**送达（`setTimeout` 抛错；浏览器侧 `windowErrors` 自证事件确实触发） | `pass` |
| 批次头 `protocol_version === 1`、`app_id` 正确 | `pass` |
| 第二批送达 | `pass` |
| `X-Server-Time` → C04 时钟校准（第二批 `clock_calibrated === true`） | `pass` |

浏览器能力实测（同一次运行）：`CompressionStream` / `navigator.locks` / `BroadcastChannel` /
`indexedDB` / `sendBeacon` / `crypto.randomUUID` **全部存在**。

## 3. 发现（含一处方法论教训）

1. **CJS 缺口**（结论①）。`import.cjs.require` 是 `fail` 格。
2. **hook 链缺陷**（结论②）。`fail` 格；独立复现脚本 `tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs`。
   修法方向（仅供参考，**本任务不改实现**）：`dispose()` 应复用增量注销路径的判断——
   仅当 `chain.holder[chain.key] === chain.composite` 时才还原 `chain.base`。
3. **Vite dev server 解析到 `dist`，不是 `src`**：`@web-report-sdk/browser` →
   `/@fs/<仓库>/packages/browser/dist/index.js`。因此**接入方首次跑 dev server 前必须先 build SDK 仓库**
   （与门禁"build 必须先于 typecheck"同源）。指南 4.1 的 `link:` 联调方式下值得写明。
4. **方法论教训（差点写成假缺陷）**：C05 错误插件按 **1 秒去重窗**聚合，且只在窗口到期时结算。
   本任务第一版脚本在 300 ms 就 flush，于是"真实未捕获异常未被采集"看起来像缺陷；等过一个窗口后
   同一脚本全绿（`uncaughtErrorDelivered=true`）。**凡测错误插件，flush 前必须等过 `DEFAULT_DEDUP_WINDOW_MS`（1000 ms）。**
5. **happy-dom 的坑（写下来省得重踩）**：`environment: happy-dom` 会把 `globalThis.URL` 换成自己的实现，
   `fileURLToPath(new URL(...))` 会抛 `The URL must be of scheme file`；且 happy-dom 的 `Request`
   不支持 `keepalive`，transport 会降级到 `XMLHttpRequest` 并**真去连端点**——所以进程内用例一律注入
   `transport` 端口，不依赖网络。

## 4. 做不了的格子（`blocked`，缺什么、归谁）

| # | 格子 | 缺什么 | 归属 |
|---|---|---|---|
| 20 | Firefox 90+（最低/最新） | **DSH 文件沙箱之外的 shell**：Firefox 主进程 `sandbox_init()` 无法嵌套；且**不得设置任何 `MOZ_*` 变量**（会破坏 juggler 握手，表现为 `launchPersistentContext` 超时） | T29 |
| 21 | Safari 14+ / WebKit | **非沙箱环境** + 每个格子后的辅助进程清理：沙箱会静默阻塞 WebKit 写 `~/Library/WebKit`（存储测量必失败）；WebKit 还会泄漏辅助进程。另：Playwright WebKit ≠ 真实 Safari | T29 |
| 22 | Edge 90+ | 本机未安装 Edge（Chromium 结论只能近似） | T29 |
| 23 | Chrome/Firefox 90、Safari 14 的**最低版本** | 最低版本浏览器二进制（安装浏览器属新增依赖，需负责人批准） | T29 |
| 24 | iOS Safari 真机 | 真机 + Web Inspector 通道 | T29 |
| 25 | Android Chrome 真机 | 真机 + adb（含 OEM WebView/省电策略差异） | T29 |

> 原第 26/27 行（webpack 生产构建 / 开发服务器）已于 2026-10-14 **移出 blocked**：
> 负责人批准新增 `examples/webpack` 与 webpack 开发依赖后补测，两格均 `pass`，见第 2.1 节第 10/11 格。
> 该 example 的形态与补测命令见 `examples/webpack/README.md`。

另外，T30 验收第 1 条中这些**核心路径**的维度也归 T29（需要真实浏览器/真机与环境控制）：
页面关闭送达（真实 `sendBeacon`/`visibilitychange`/`pagehide`）、断网补发（真实 IDB + 真实网络中断）、
真实 3 标签页接管、真实无 Web Locks、真实 `CompressionStream` 压缩链路。

## 5. 类型检查与 lint 复核（本任务新增文件）

| 命令 | 结果 |
|---|---|
| `pnpm exec eslint tests/compat` | **0 error / 0 warning** |
| `pnpm exec tsc -p tsconfig.json`（含 `tests/compat`） | 64 error |
| `pnpm exec tsc -p tsconfig.json`（把 `tests/compat` 移出 `tests/**` 后） | **64 error** |

结论：**`tests/compat/**` 新增 0 个类型错误**（两次都是 64，且输出里没有任何 `tests/compat` 行）。

⚠ **给负责人的旁注（不是 T30 的问题）**：那 64 个错误**全部来自 `packages/*/src`**（`idb-backend.ts` 18、
`core/src/config/cache.ts` 10、`route/plugin.ts` 5 …），是根程序把这些源码拉进来导致的 lib 冲突
（根 `tsconfig.json` 是 `lib: ["ES2022"] + types: ["node"]`，各包源码含 DOM）。**基线本来就是这个数**，
与 T30 无关；但这意味着 `pnpm typecheck` 的 root 步在 main 上是否真的绿，值得单独核一次。
T30 的用例为此专门采用「变量说明符动态 import + 结构类型」加载各包产物（`tests/compat/lib/entries.ts`），
以免自己成为新的拉入点。

## 6. 复跑清单（全部本机可跑，无需安装任何东西）

```bash
# ① 进程内矩阵（import / 降级 / 共存 / webpack 证据核对）
pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false

# ② 真实 Chromium 核心路径（executablePath 指向本机 chromium-1223）
node tests/compat/scripts/browser-core-path.mjs

# ③ Vite 开发服务器（含真实 Chromium 渲染断言）
node tests/compat/scripts/vite-dev-server.mjs

# ④ 兼容缺陷独立复现（缺陷②修复后 exit 0；原口径 exit 1 = 复现成功）
node tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs

# ⑤ 汇总成一张矩阵
node tests/compat/scripts/summarize.mjs

# ⑥ 接入方式的仓库脚本（Vite/webpack 生产构建、Vite/webpack dev、IIFE、Vitest、Jest）
pnpm examples:build && pnpm examples:test

# ⑦ webpack 两格的单独复跑（证据分别写 results/webpack-*.json）
node examples/webpack/scripts/build-production.mjs   # 生产构建 + 沙箱最小路径 + Chromium 复核
node examples/webpack/scripts/dev-server.mjs         # dev server HTTP 200 + bundle 可执行
```

## 7. 证据文件索引

| 文件 | 内容 |
|---|---|
| `tests/compat/README.md` | 本目录的口径、状态取值与运行方式 |
| `tests/compat/vitest.config.ts` | 本目录独立 vitest 配置（**不在任何门禁 project 里**） |
| `tests/compat/lib/entries.ts` | 各包 **dist 产物**的加载层（变量说明符动态 import + 结构类型，见第 5 节） |
| `tests/compat/lib/matrix.ts` | 矩阵单元登记与 `results/*.json` 落盘（状态由实测探针推导） |
| `tests/compat/import-matrix.test.ts` | 接入方式 6 格（ESM / 无 DOM / IIFE / exports / CJS / Vite 生产构建） |
| `tests/compat/webpack-matrix.test.ts` | webpack 生产构建与开发服务器 2 格（核对 `results/webpack-*.json` 的证据形状与结论） |
| `tests/compat/degradation.test.ts` | 降级路径 7 格（含对照格） |
| `tests/compat/apm-coexistence.test.ts` | 共存 5 格（含两层第三方叠加；顺序 B 修复后为 `pass`） |
| `tests/compat/scripts/browser-core-path.mjs` | 真实 Chromium：核心路径 + 11 项 checks |
| `tests/compat/scripts/vite-dev-server.mjs` | Vite 开发服务器：8 项 checks（含真实 Chromium 渲染） |
| `examples/webpack/scripts/build-production.mjs` | webpack 生产构建：产物 + 沙箱最小路径 + Chromium 复核 |
| `examples/webpack/scripts/dev-server.mjs` | webpack 开发服务器：HTTP 200 + bundle 沙箱最小路径 + Chromium 复核 |
| `examples/webpack/scripts/lib/verify-bundle.mjs` | 两个 webpack 脚本共用的 bundle 验证库（vm 沙箱 + 接收方替身） |
| `tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs` | 缺陷②的独立复现（修复后 exit 0） |
| `tests/compat/scripts/summarize.mjs` | 汇总 `results/*.json` → `results/matrix.json` |
| `tests/compat/results/matrix.json` | 45 格汇总（本报告的机器可读版本） |
| `tests/compat/results/import-matrix.json` | 接入方式 6 格 |
| `tests/compat/results/degradation.json` | 降级路径 7 格（含 2 个对照格） |
| `tests/compat/results/apm-coexistence.json` | 共存 5 格 |
| `tests/compat/results/browser-core-path.json` | 真实 Chromium：11 项 checks、批次摘要、能力探测、页面错误 |
| `tests/compat/results/vite-dev-server.json` | Vite dev：8 项 checks、解析到的 URL、DOM 文本 |
| `tests/compat/results/webpack-production.json` | webpack 生产构建：构建统计、12 项沙箱 checks、Chromium 复核 |
| `tests/compat/results/webpack-dev-server.json` | webpack dev server：7 项 HTTP/沙箱 checks、Chromium 复核 |
| `temp/t30-examples.log` | `pnpm examples:build` / `examples:test` 的原始输出（会话内产物，不入库） |

## 8. 交付物与状态

- 交付物：本报告 + 兼容矩阵结果表（`tests/compat/results/matrix.json`）+ 可复跑脚本与用例。
- **本报告的 `fail` 与 `blocked` 都是结论，不是待办**：当前 `fail` **1** 条（CJS `require`）已定位到
  `exports` 映射；`blocked` **6** 条已写明缺什么并归 T29。
- 需负责人决定：① CJS `require` 是否支持；② ~~缺陷②由谁修~~ **已修复并复核通过**（2026-10-14）；
  ③ ~~是否为 webpack 新增 example 与依赖~~ **已批准并补测，两格 `pass`**（2026-10-14）。
