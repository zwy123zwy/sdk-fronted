/**
 * webpack 示例的构建配置（生产构建 + 开发服务器共用）。
 *
 * **刻意不写任何 SDK 专属配置**：没有 `resolve.alias`、没有 `resolve.conditionNames` 覆盖，
 * 让 webpack 走它自己的默认解析。这样"能构建出来"才是对指南第 4.2 节的真实检验；
 * 一旦需要额外配置，本文件就会暴露出来。
 *
 * 解析目标实测为各包的 `dist` 产物（`packages/browser/dist/index.js`），而不是 `src`：
 * webpack 的默认 `conditionNames` 不含 `source`，命中 `exports["."].import`。
 * 因此**接入方跑 webpack 之前必须先构建 SDK 仓库**（`pnpm build`）。
 */
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** @param {{ mode?: string }} env @param {{ mode?: string }} argv */
export default (_env, argv) => {
  const mode = argv.mode === 'development' ? 'development' : 'production';
  return {
    mode,
    entry: fileURLToPath(new URL('./src/main.js', import.meta.url)),
    output: {
      path: fileURLToPath(new URL('./dist', import.meta.url)),
      filename: 'main.js',
      // 接入方用 `<script src>`（非模块）加载，与 examples/vite 的体验对齐：
      // 产物自执行入口（`document.querySelector('#app')` 那两句），不额外包一层 library。
      clean: true,
    },
    // 让产物里能看出裸包名被解析到了哪个真实文件（dev server 下尤其有用）。
    stats: { modules: true, reasons: false },
    devtool: mode === 'development' ? 'eval-source-map' : 'source-map',
    devServer: {
      // 静态资源目录就是 example 根目录（`index.html` 在这里，bundle 由内存中间件提供）。
      static: { directory: fileURLToPath(new URL('.', import.meta.url)) },
      host: '127.0.0.1',
      // 端口 0 = 让操作系统分配空闲端口；调用方从 `server.server.address()` 读回真实端口。
      port: 0,
      // 验证脚本要在 node 沙箱里执行这份 bundle，而 dev-server 的 client 需要真实
      // WebSocket/self 面；关掉它，bundle 就只剩 SDK 相关代码（hot/liveReload 本来也关着）。
      client: false,
      hot: false,
      liveReload: false,
    },
    performance: { hints: false },
  };
};
