# `examples/webpack` —— webpack 接入示例（T30 兼容矩阵第 10/11 格）

模拟接入方：**只用 `@web-report-sdk/browser` 的公开入口**，按 webpack 的默认解析构建；
本工程里**没有任何 SDK 专属配置**（无 `resolve.alias`、无 `conditionNames` 覆盖、无 `externals`）。
这样"能不能构建、dev server 能不能起"才是对指南第 4.2 节的真实检验。

> 解析目标实测是各包的 **`dist` 产物**（`packages/browser/dist/index.js`），不是 `src`：
> webpack 默认 `conditionNames` 不含 `source`，命中 `exports["."].import`。
> **接入方第一次跑本示例前必须先构建 SDK 仓库**（`pnpm build`）。

## 目录

| 路径 | 作用 |
|---|---|
| `src/main.js` | 接入方入口：读 `SDK_VERSION` 渲染进 `#app`，并把 `createAssembly` 暴露到 `globalThis.__WEBPACK_EXAMPLE__` 供验证脚本使用 |
| `index.html` | 页面骨架（`<script src="./main.js">`，同时供 dev server 与构建产物使用） |
| `webpack.config.mjs` | 生产/dev 共用配置；`build` 脚本与 `dev-server` 脚本都读它 |
| `scripts/build-production.mjs` | 生产构建 + 产物验证（见下） |
| `scripts/dev-server.mjs` | 起 webpack-dev-server + HTTP/产物验证 |
| `scripts/lib/verify-bundle.mjs` | 两个脚本共用的 bundle 验证库（`node:vm` 沙箱 + 接收方替身） |
| `dist/` | 生产构建产物（`main.js`、`main.js.map`、`index.html`） |

## 跑法

```bash
# 前置：仓库必须先 build（本示例解析到各包 dist）
pnpm build

# 生产构建 + 验证（写 tests/compat/results/webpack-production.json）
node examples/webpack/scripts/build-production.mjs

# 开发服务器 + 验证（写 tests/compat/results/webpack-dev-server.json）
node examples/webpack/scripts/dev-server.mjs

# 或走仓库脚本（pnpm examples:build 覆盖本工程的生产构建；examples:test 覆盖 dev server）
pnpm examples:build && pnpm examples:test
```

## 验证的不是"能读到常量"

`verify-bundle.mjs` 把 bundle 源码放进 `node:vm` 沙箱执行，并断言：

1. `globalThis.__WEBPACK_EXAMPLE__.SDK_VERSION` 是字符串，且**等于 `packages/browser/package.json` 的版本**
   （不是"读到个字符串就算过"）；
2. `createAssembly` 是函数；
3. **真跑一次最小路径**：`createAssembly → init() → client.track('webpack_probe') → flush()`，
   注入传输替身，断言接收方**真的收到批次**且 `events` 里含 `webpack_probe`。

第 3 条是关键：只验证"SDK_VERSION 能读出来"无法区分"依赖真的打进来了"和"常量被内联了"。
注入 `transport` 走的是运行期工厂参数，证明 SDK 的装配与上报链路在 bundle 里是活的。

生产构建脚本还会用真实 Chromium（若本机存在 `chromium-1223`，路径与 T30 其它脚本一致）
打开 `dist/index.html` 复核一页；缺浏览器时如实记 `skipped`，**不记 pass**。

## 与 T30 矩阵的关系

| 矩阵格 | 命令 | 证据 |
|---|---|---|
| `import.webpack.production` | `node examples/webpack/scripts/build-production.mjs` | `tests/compat/results/webpack-production.json` |
| `import.webpack.devServer` | `node examples/webpack/scripts/dev-server.mjs` | `tests/compat/results/webpack-dev-server.json` |

`tests/compat/webpack-matrix.test.ts` 只**核对**上面两个证据文件（不重复跑构建），
`tests/compat/scripts/summarize.mjs` 再把它们汇总进 `tests/compat/results/matrix.json`。

## 依赖边界（硬约束）

`webpack` / `webpack-cli` / `webpack-dev-server` 只在本工程的 **`devDependencies`** 里；
SDK 自身保持**零第三方运行时依赖**，`packages/*` 的 `dependencies` 未因本示例改动。
