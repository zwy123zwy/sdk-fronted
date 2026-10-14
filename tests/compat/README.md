# T30 兼容矩阵（`tests/compat/`）

本目录是 **T30「兼容性测试」** 的所有权目录。产物是**兼容矩阵**：每一格都必须带
**可复跑的命令**或**落盘的证据文件**，不接受"看起来应该没问题"。

权威口径：`docs/tasks/T30.md`（验收用例）、`docs/decisions/Q1-scale.md`（浏览器矩阵）、
`docs/decisions/Q7-apm-coexistence.md`（与第三方 APM 共存）、`docs/agent-development-guide.md` 第 4.2 节
（接入方式：Vite/webpack 生产构建与开发服务器、Vitest、Jest、`<script>`）。

## 1. 这不是门禁

根 `vitest.config.ts` 的三个 project（`unit` / `contract` / `security`）**不包含** `tests/compat/**`，
因此 `pnpm test` 与 `pnpm gates` **不会**运行本目录。与 `tests/bench/` 同理：本目录给出的是
**兼容性结论与证据**，不是回归门禁；新增 vitest project 属门禁配置变更，需负责人批准。

## 2. 怎么跑

```bash
# ① 进程内兼容用例（node 环境，import 的是构建产物 packages/*/dist）
#    注意：共存用例「顺序 B」（SDK 先装、第三方后装）曾是**已知缺陷**（destroy 抹掉第三方包装），
#    **已于 2026-10-13 修复**（`a3c9ae5`：`dispose()` 与增量注销统一为 `restoreChainIfOwned`），该套件现全绿。
pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false

# ② 真实 Chromium 的核心路径（可执行文件用 executablePath 指向本机已装版本）
node tests/compat/scripts/browser-core-path.mjs           # 结果写 results/browser-core-path.json

# ③ Vite 开发服务器（指南 4.2 要求「开发服务器」也要能直接导入）
node tests/compat/scripts/vite-dev-server.mjs             # 结果写 results/vite-dev-server.json

# ④ 兼容缺陷独立复现（**2026-10-13 已修复：现 exit 0 = 符合 Q7 第 4 条**；修复前 exit 1 = 复现缺陷）
node tests/compat/scripts/repro-destroy-overwrites-wrapper.mjs

# ⑤ 汇总矩阵（把 results/*.json 与进程内用例结论合成矩阵）
node tests/compat/scripts/summarize.mjs                   # 写 results/matrix.json
```

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
| `vitest.config.ts` | 本目录独立配置：`environment: node`、`include: tests/compat/**/*.test.ts` |
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
6. **happy-dom 的两个坑**：① 它替换 `globalThis.URL`，`fileURLToPath(new URL(...))` 会抛
   `The URL must be of scheme file`（`lib/matrix.ts` 因此只用 `import.meta.url` 的字符串形态）；
   ② 它的 `Request` 不支持 `keepalive`，transport 会降级到 `XMLHttpRequest` 并**真去连端点**，
   所以进程内用例一律注入 `transport` 端口，不依赖网络。
