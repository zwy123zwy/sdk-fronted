# 客户端兼容矩阵（T30）

- 任务卡：`docs/tasks/T30.md`（3 人日 / A09）；依赖 T20（基准体系，已合入 main）。
- 权威口径：T30 验收用例、`docs/decisions/Q1-scale.md`（浏览器矩阵）、
  `docs/decisions/Q7-apm-coexistence.md`（与第三方 APM 共存）、指南第 4.2 节（接入方式）。
- 证据与可复跑命令：`tests/compat/`（矩阵单元逐格落盘在 `tests/compat/results/*.json`）。
- 本报告的全部结论都来自**本机实跑**；凡是本机做不了的格子，一律标 `blocked` 并写清"缺什么"。

## 0. 结论摘要

| 指标 | 数量 |
|---|---|
| `pass`（本机实跑通过，证据落盘） | **33** |
| `fail`（本机实跑不通过，已定位） | **2** |
| `blocked`（本机做不了，写清缺什么，归 T29） | **8** |
| 合计 | 43 |

**三条必须让负责人知道的结论**：

1. **`fail`①：CJS `require("@web-report-sdk/browser")` 直接失败**（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。
   `exports` 只有 `source`/`types`/`import` 条件，没有 `require`。指南 4.2 要求"Vitest、Jest 测试环境中
   直接导入，不需要额外配置"，而现有 Jest 示例实际依赖 `--experimental-vm-modules` + `.mjs`（属额外配置）。
   处置需负责人决定（加 `require` 条件 / 只支持 ESM 并在指南写明）。
2. **`fail`②：与第三方 APM 共存时，"SDK 先装、第三方后装"顺序下 `destroy()` 会抹掉第三方的包装层**
   （`packages/core/src/kernel/global-registry.ts` 的 `dispose()` 对每条 hook 链**无条件**
   `chain.holder[chain.key] = chain.base`），违反 Q7 第 4 条"卸载时只还原自己装上的那一层"。
   一条命令可复现：`node tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs`（exit 1）。
3. **真实 Chromium（Chrome for Testing 148.0.7778.96）上核心路径全部通过**：`init`→`track`→`flush`
   →接收方收到批次（`protocol_version=1`、`app_id` 正确）、`captureError`、**真实未捕获异常**、
   以及 `X-Server-Time` → C04 时钟校准（第二批 `clock_calibrated=true`）。

## 1. 环境与偏差声明（**不得省略**）

| 项 | 本报告实际 | 说明 |
|---|---|---|
| 浏览器 | 本机缓存 `~/Library/Caches/ms-playwright/chromium-1223`（Chrome for Testing **148.0.7778.96**），用 `executablePath` 指向 | 仓库锁定 `@playwright/test@1.64.0` 期望 chromium-1248，**本机没装**；不安装任何浏览器 |
| Playwright | 仓库锁定的 `@playwright/test@1.64.0` | 只借它的驱动能力，浏览器是上一条那个 |
| 接收方 | 脚本内的 node http `/ingest`（同源），收到什么写进结果 JSON | 不触外网；不伪造字节数/条数 |
| 进程内用例 | node 24.16.0（`environment: node`）；共存与页面事件用例用 `happy-dom` | 逐条在结果 JSON 里标注 engine |
| 未做 | Firefox / WebKit / Edge / 最低版本 / iOS Safari / Android Chrome / webpack | 见第 4 节，逐条写清缺什么 |

`pnpm exec vitest run --config tests/compat/vitest.config.ts` 的 `exit code` 是 **1**：
因为 `apm.order.sdkFirst` 如实记录了缺陷②，用例就该是红的。**`tests/compat/` 不在任何门禁 project 里**
（根 `vitest.config.ts` 只含 `unit`/`contract`/`security`），因此不影响 `pnpm gates`。

## 2. 矩阵结果（43 格）

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
| 10 | webpack 生产构建 / 11. webpack 开发服务器 | — | **`blocked`** | 仓库未装 webpack、没有 webpack example。见第 4 节 |

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
| 18 | **顺序 B：SDK 先装、第三方后装** | **`fail`** | 业务请求双方各计一次、SDK 批次送达都成立；但 `destroy()` 后第三方包装**被抹掉**（全局变回 SDK hook 前的原生引用）→ 第三方此后采集不到任何请求。根因见结论② |
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
| 26 | webpack 生产构建 | 新增 webpack example + webpack 依赖（**需负责人批准**）；当前只有间接判据（产物是标准 ESM、`exports` 的 `import`/`types` 齐全），**不算实测** | 待批准后补，否则 T29 |
| 27 | webpack 开发服务器 | 同上 | 同上 |

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
# ① 进程内矩阵（import / 降级 / 共存）。注意：共存顺序 B 是**已知缺陷**，会红。
pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false

# ② 真实 Chromium 核心路径（executablePath 指向本机 chromium-1223）
node tests/compat/scripts/browser-core-path.mjs

# ③ Vite 开发服务器（含真实 Chromium 渲染断言）
node tests/compat/scripts/vite-dev-server.mjs

# ④ 兼容缺陷独立复现（exit 1 即复现成功）
node tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs

# ⑤ 汇总成一张矩阵
node tests/compat/scripts/summarize.mjs

# ⑥ 接入方式的两条仓库脚本（Vite 生产构建 / IIFE / Vitest / Jest）
pnpm examples:build && pnpm examples:test
```

## 7. 证据文件索引

| 文件 | 内容 |
|---|---|
| `tests/compat/README.md` | 本目录的口径、状态取值与运行方式 |
| `tests/compat/vitest.config.ts` | 本目录独立 vitest 配置（**不在任何门禁 project 里**） |
| `tests/compat/lib/entries.ts` | 各包 **dist 产物**的加载层（变量说明符动态 import + 结构类型，见第 5 节） |
| `tests/compat/lib/matrix.ts` | 矩阵单元登记与 `results/*.json` 落盘（状态由实测探针推导） |
| `tests/compat/import-matrix.test.ts` | 接入方式 6 格 |
| `tests/compat/degradation.test.ts` | 降级路径 7 格（含对照格） |
| `tests/compat/apm-coexistence.test.ts` | 共存 3 格（顺序 B 即缺陷②，用例如实为红） |
| `tests/compat/scripts/browser-core-path.mjs` | 真实 Chromium：核心路径 + 11 项 checks |
| `tests/compat/scripts/vite-dev-server.mjs` | Vite 开发服务器：8 项 checks（含真实 Chromium 渲染） |
| `tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs` | 缺陷②的独立复现（exit 1 即复现成功） |
| `tests/compat/scripts/summarize.mjs` | 汇总 `results/*.json` → `results/matrix.json` |
| `tests/compat/results/matrix.json` | 43 格汇总（本报告的机器可读版本） |
| `tests/compat/results/import-matrix.json` | 接入方式 6 格 |
| `tests/compat/results/degradation.json` | 降级路径 7 格（含 2 个对照格） |
| `tests/compat/results/apm-coexistence.json` | 共存 3 格 |
| `tests/compat/results/browser-core-path.json` | 真实 Chromium：11 项 checks、批次摘要、能力探测、页面错误 |
| `tests/compat/results/vite-dev-server.json` | Vite dev：8 项 checks、解析到的 URL、DOM 文本 |
| `temp/t30-examples.log` | `pnpm examples:build` / `examples:test` 的原始输出（会话内产物，不入库） |

## 8. 交付物与状态

- 交付物：本报告 + 兼容矩阵结果表（`tests/compat/results/matrix.json`）+ 可复跑脚本与用例。
- **本报告的 `fail` 与 `blocked` 都是结论，不是待办**：`fail` 两条已定位到文件与行、
  有一条可独立复现；`blocked` 八条已写明缺什么并归 T29。
- 需负责人决定：① CJS `require` 是否支持；② 缺陷②由谁修（`packages/core`，不属 T30 所有权）；
  ③ 是否为 webpack 新增 example 与依赖。
