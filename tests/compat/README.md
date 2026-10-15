# T30 兼容矩阵（`tests/compat/`）

本目录是 **T30「兼容性测试」** 的所有权目录。产物是**兼容矩阵**：每一格都必须带
**可复跑的命令**或**落盘的证据文件**，不接受"看起来应该没问题"。

权威口径：`docs/tasks/T30.md`（验收用例）、`docs/decisions/Q1-scale.md`（浏览器矩阵）、
`docs/decisions/Q7-apm-coexistence.md`（与第三方 APM 共存）、`docs/agent-development-guide.md` 第 4.2 节
（接入方式：Vite/webpack 生产构建与开发服务器、Vitest、Jest、`<script>`）。

## 1. 这是门禁（2026-10-15 起）

根 `vitest.config.ts` **有一个 `compat` project**（`include: ['tests/compat/**/*.test.ts']`，
`environment: 'node'`），所以 `pnpm test` 与 `pnpm gates` **会**运行本目录的 5 个文件 / 28 个用例。
此前本目录不在任何 project 的 include 里 → `vitest list` 收集到 **0 条**，兼容矩阵的守卫
（`webpack-matrix`、D-06 的 `receiver-contract-gate`、`import-matrix`、`apm-coexistence`、
`degradation`）全在门禁之外。新增 project 属门禁配置变更，2026-10-15 经负责人批准。

**前置**：用例读 `packages/*/dist` 与 `examples/webpack/dist` → 必须先 `pnpm build` 与
`pnpm examples:build`（`pnpm gates` 的顺序本来就是 build → test）。产物或证据缺失时用例**红**，
不跳过；`results/webpack-*.json` 缺失时 `webpack-matrix.test.ts` 直接判 `fail`（"没跑"不得写成 `pass`）。

**注意（已知副作用）**：每次运行都会重写 `results/*.json` 的 `generatedAt` → `pnpm test` 会把这几个
证据文件变成 git 修改态。这是 `lib/matrix.ts` 既有行为，本次纳入门禁后变得更显眼；若嫌脏，
后续可在写盘前做"除时间戳外无变化则不写"的比对（本轮未改）。

`tests/compat/vitest.config.ts` 保留：与根配置等价（环境/包含面一致，per-file
`// @vitest-environment` 注解优先于 project 的 `environment`），只用于单独复跑本目录时少收集其它 project。

## 2. 怎么跑

```bash
# ① 门禁路径（与 pnpm test 同一套收集；只想跑本目录时加 --project compat）
pnpm exec vitest run --project compat --coverage.enabled=false

# ② 独立配置（等价；等价性依据同上）
pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false

# ③ 真实 Chromium 的核心路径（可执行文件用 executablePath 指向本机已装版本）
node tests/compat/scripts/browser-core-path.mjs           # 结果写 results/browser-core-path.json

# ④ Vite 开发服务器（指南 4.2 要求「开发服务器」也要能直接导入）
node tests/compat/scripts/vite-dev-server.mjs             # 结果写 results/vite-dev-server.json

# ⑤ 兼容缺陷独立复现（**2026-10-13 已修复：现 exit 0 = 符合 Q7 第 4 条**；修复前 exit 1 = 复现缺陷）
node tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs

# ⑥ 汇总矩阵（把 results/*.json 与进程内用例结论合成矩阵）
node tests/compat/scripts/summarize.mjs                   # 写 results/matrix.json
```

②③（真实浏览器 / 开发服务器）**不在** `vitest` 门禁里：它们需要可执行浏览器与额外进程，
放进 `pnpm test` 会把门禁变成分钟级重活。它们是**落盘证据**，由上面的文件交叉核对（缺文件即红）。

`pnpm exec tsc -p tsconfig.json` 会把本目录纳入类型检查（根 `tsconfig.json` 的 `include` 含 `tests/**/*.ts`），
`pnpm exec eslint tests/compat` 同样覆盖本目录。

## 3. 状态取值（不许含糊）

| 状态 | 含义 |
|---|---|
| `pass` | 本机**实跑**过，且断言/证据落盘（`results/*.json` 或命令输出） |
| `fail` | 本机实跑过，**不通过**（必须写清现象） |
| `blocked` | 本机**做不了**，必须写清「缺什么」并给出归属（当前一律 **归 T29**） |

**禁止**把"没跑"写成 `pass`；`blocked` 的格子必须在报告里给出可执行的补测步骤。

## 4. 文件

| 文件 | 作用 |
|---|---|
| `vitest.config.ts` | 本目录独立配置（与根 `compat` project 等价）：`environment: node`、`include: tests/compat/**/*.test.ts` |
| `lib/entries.ts` | 各包 **dist 产物**的加载层：变量说明符动态 import + 结构类型（避免把包源码拉进根 `tsconfig` 程序；详见 `tests/bench/lib/entries.ts` 的同一理由） |
| `lib/matrix.ts` | 矩阵单元登记器 + `results/matrix.json` 写出（每格：需求、状态、命令、证据、备注） |
| `import-matrix.test.ts` | 接入方式（指南 4.2）：ESM 导入、IIFE 全局、CJS `require` 的实际行为、子路径导出、导入期无 DOM 依赖 |
| `degradation.test.ts` | 不支持 API 的降级路径：`CompressionStream`、Web Locks、`crypto.randomUUID`、IndexedDB（均带对照格） |
| `apm-coexistence.test.ts` | Q7 第 4 条：与第三方 APM 的 hook 链，先后初始化顺序各一次，卸载后链完整 |
| `scripts/browser-core-path.mjs` | 真实 Chromium（`executablePath`）：`init`→`track`→`flush`→接收方收到批次 |
| `scripts/vite-dev-server.mjs` | 以 `examples/vite` 为接入方，程序化起 Vite dev server 并取回转换后的模块 |
| `scripts/repro-destroy-overwrites-wrapper.mjs` | 缺陷②的独立复现（`destroy()` 抹掉第三方包装）。**2026-10-13 已修复：现 exit 0 = 符合 Q7 第 4 条**；修复前 exit 1 = 复现缺陷 |
| `scripts/summarize.mjs` | 汇总 `results/*.json` → `results/matrix.json` |
| `results/` | 证据落盘（JSON；由脚本写出） |

## 5. 口径红线

1. **真实浏览器结论只能来自真实浏览器**：本机装了 `chromium-1223`（`~/Library/Caches/ms-playwright`），
   Chromium 的格子必须实跑；Firefox/WebKit/iOS/Android 的格子一律 `blocked` 并写明原因（见报告）。
2. **不伪造数字**：任何来自别处的数字都要标注来源；本目录只记录本机实跑结果。
3. **不改实现、不改门禁配置、不改 `tests/bench/**` 的断言**。
4. **降级用例必须真的把能力拿掉**：在创建装配根前删除/替换对应全局，而不是断言"实现里有 if"。
5. **测错误插件前必须等过 1 秒去重窗**：C05 错误插件按 `DEFAULT_DEDUP_WINDOW_MS = 1000` 聚合、
   窗口到期才结算。在 300 ms 就 flush，会把"还没到结算时刻"误判成"没采集到"——
   本任务第一版脚本正是这么差点写出一条假缺陷（真实 Chromium 复核后全绿）。
6. **happy-dom 的坑（2026-10-15 更正根因）**：① `fileURLToPath(new URL(...))` 会抛
   `The URL must be of scheme file`。**真正的分界线是"是否经过 `new URL(...)`"**：在被依赖的模块里
   （如 `lib/matrix.ts`，唯一出现在 `apm-coexistence.test.ts` 依赖图里的路径解析点），happy-dom 沙箱会把
   `new URL('.', import.meta.url)` 的 href 改写成 `http://localhost:3000/…`（`import.meta.url` 本身
   仍是 `file:`，已实测）；而**同一时刻**把 `import.meta.url` 的**字符串**直接交给 `fileURLToPath`
   是正常的（`lib/matrix.ts` / `lib/batch-contract.mjs` 因此都用字符串形态）。
   旧注释写成"happy-dom 替换了全局 `URL`"只说对一半：显式 `import { URL } from 'node:url'` 也照样中招，
   `apm-coexistence` 会因此**整个文件收集失败**（0 test）。
   ② 它的 `Request` 不支持 `keepalive`，transport 会降级到 `XMLHttpRequest` 并**真去连端点**，
   所以进程内用例一律注入 `transport` 端口，不依赖网络。
