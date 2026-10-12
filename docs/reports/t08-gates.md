# T08 交付报告：仓库、CI、门禁

- 日期：2026-10-10
- 执行：A13（由主会话代为执行）；批准：wenye.zhang 授权代行架构负责人

## 已实现

- pnpm workspace：`packages/{core,transport,plugins,browser}`、`tools/{event-registry,config-signer,mock-receiver}`、`examples/{vite,script-tag,node-import}`。包名见指南第 3 节。
- 所有 SDK 包声明 `"sideEffects": false`、ESM 导出与类型声明；browser 另产出 IIFE。
- 门禁脚本与 CI（`.github/workflows/ci.yml`），命令见指南第 6 节。
- 公共 API 基线：`packages/*/etc/*.api.md`。

## 门禁结果（本地，macOS，Node 24.16.0，pnpm 11.18.0）

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 通过（契约 12 条；空包没有可统计代码，覆盖率阈值在 T11 起生效） |
| `pnpm build` | 通过 |
| `pnpm size` | 通过：browser 126 B、core 138 B、plugins 139 B、transport 138 B（brotli） |
| `pnpm api:check` | 通过 |
| `pnpm test:contract` | 通过（12 条） |
| `pnpm examples:build` | 通过（Vite 8.3.4） |
| `pnpm examples:test` | 通过：IIFE 暴露 `WebReportSDK.SDK_VERSION`；Vitest 与 Jest（原生 ESM）都能导入 |
| `pnpm gates:selftest` | 通过：`any`、`eslint-disable`、`class`、类型错误、超出体积预算、未登记导出 6 个违规样例都被拦截 |
| `pnpm test:e2e` | 未执行：还没有 E2E 用例，Playwright 浏览器未安装；由 T29 启用 |
| CI | 未执行：需要推送到 GitHub 后观察首次运行 |

## 偏离与说明

- Q4 写“Node.js 20+”。Vitest 5 要求 Node ≥ 22.12，所以工具链锁定 Node 24（`.nvmrc`）。接入方运行时不受影响（SDK 产物是浏览器 ES2020）。
- TypeScript 锁定 5.9.3 而不是最新的 7.x：typescript-eslint 8.71.1 只支持到 6.0，API Extractor 7.59.4 内置 5.9.3。
- `pnpm-workspace.yaml` 只允许 esbuild 运行安装脚本，`@parcel/watcher`、`unrs-resolver` 的安装脚本被禁用。
- 覆盖率统计排除 `index.ts`（只做重新导出）和工具的 `cli.ts`（只做参数转发）。
- 指南第 11 节“模块顶层不访问 `window`”尚未做成 lint 规则，由 T11 补充。

## 新增依赖

全部为开发依赖，版本锁定，见根 `package.json` 与 `pnpm-lock.yaml`。SDK 运行时依赖为零。

## 对接入方的影响

无。所有包仍为 private，尚未发布。
