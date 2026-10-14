/**
 * T30 矩阵汇总：把 `results/*.json` 的证据合并成一张 `results/matrix.json`，并在终端打印表格。
 *
 * 运行：`node tests/compat/scripts/summarize.mjs`
 *
 * 本脚本**只汇总已经落盘的证据**：
 * - 进程内用例（`import-matrix` / `degradation` / `apm-coexistence`）自己写出的 cells；
 * - `browser-core-path.json`（真实 Chromium）与 `vite-dev-server.json`（Vite 开发服务器）的 checks；
 * - **本机做不了的格子**（Firefox / WebKit / iOS Safari / Android Chrome / 最低版本 / webpack）
 *   在这里显式登记为 `blocked`，并写清缺什么与归属（T29）——不允许含糊带过。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

const resultsDir = fileURLToPath(new URL('../results/', import.meta.url));

function readJson(name) {
  const file = join(resultsDir, `${name}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function fromChecks(input) {
  return Object.entries(input.checks ?? {}).map(([key, value]) => ({
    id: input.id,
    requirement: input.requirement,
    dimension: input.dimension,
    engine: input.engine,
    status: value ? 'pass' : 'fail',
    command: input.command,
    evidence: input.evidence,
    notes: `${key}=${String(value)}`,
  }));
}

const cells = [];
for (const name of ['import-matrix', 'degradation', 'apm-coexistence']) {
  const data = readJson(name);
  if (data?.cells === undefined) {
    cells.push({
      id: `${name}.missing`,
      requirement: 'T30 交付完整性',
      dimension: '证据落盘',
      engine: '—',
      status: 'fail',
      command: 'pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false',
      evidence: `results/${name}.json 不存在`,
      notes: '用例没有跑或没有落盘——不得据此下任何结论。',
    });
    continue;
  }
  cells.push(...data.cells);
}

const chromiumResult = readJson('browser-core-path');
if (chromiumResult !== undefined) {
  cells.push(
    ...fromChecks({
      id: 'browser.chromium.corePath',
      requirement: 'T30 验收第 1 条：核心路径（初始化、上报、错误采集）',
      dimension: '浏览器 / Chromium（最新版本）',
      engine: `chromium ${chromiumResult.browserVersion}（chromium-1223，executablePath 指向本机缓存）`,
      command: 'node tests/compat/scripts/browser-core-path.mjs',
      evidence: 'tests/compat/results/browser-core-path.json',
      checks: chromiumResult.checks,
    }).map((cell) => ({ ...cell, id: `browser.chromium.corePath.${cell.notes.split('=')[0]}` })),
  );
} else {
  cells.push({
    id: 'browser.chromium.corePath',
    requirement: 'T30 验收第 1 条：核心路径（初始化、上报、错误采集）',
    dimension: '浏览器 / Chromium（最新版本）',
    engine: 'chromium-1223',
    status: 'fail',
    command: 'node tests/compat/scripts/browser-core-path.mjs',
    evidence: 'results/browser-core-path.json 不存在',
    notes: '脚本没跑或没落盘。',
  });
}

const viteResult = readJson('vite-dev-server');
if (viteResult !== undefined) {
  cells.push(
    ...fromChecks({
      id: 'import.vite.devServer',
      requirement: '指南 4.2：Vite 开发服务器直接导入',
      dimension: '接入方式 / Vite 开发服务器',
      engine: viteResult.engine,
      command: 'node tests/compat/scripts/vite-dev-server.mjs',
      evidence: 'tests/compat/results/vite-dev-server.json（含真实 Chromium 渲染结果）',
      checks: viteResult.checks,
    }).map((cell) => ({ ...cell, id: `import.vite.devServer.${cell.notes.split('=')[0]}` })),
  );
} else {
  cells.push({
    id: 'import.vite.devServer',
    requirement: '指南 4.2：Vite 开发服务器直接导入',
    dimension: '接入方式 / Vite 开发服务器',
    engine: 'vite',
    status: 'fail',
    command: 'node tests/compat/scripts/vite-dev-server.mjs',
    evidence: 'results/vite-dev-server.json 不存在',
    notes: '脚本没跑或没落盘。',
  });
}

/** 本机做不了的格子：缺什么、归谁，写清楚。 */
const blocked = [
  {
    id: 'browser.firefox',
    requirement: 'T30 验收第 1 条：Firefox 90+（最低与最新）',
    dimension: '浏览器 / Firefox',
    engine: 'firefox-1522（本机缓存）',
    status: 'blocked',
    command: 'node tests/compat/scripts/browser-core-path.mjs（待 T29 提供非沙箱 shell 后）',
    evidence: '无——本会话为 DSH 文件沙箱内，Firefox 主进程 sandbox_init() 无法嵌套',
    notes:
      '缺：**沙箱之外的 shell**（Firefox 必须在 DSH 文件沙箱外运行；且不得设置任何 `MOZ_*` 变量，' +
      '否则 juggler 握手失败、`launchPersistentContext` 超时）。归 T29。',
  },
  {
    id: 'browser.webkit',
    requirement: 'T30 验收第 1 条：Safari 14+（最低与最新）',
    dimension: '浏览器 / WebKit',
    engine: 'webkit-2287（本机缓存）',
    status: 'blocked',
    command: 'node tests/compat/scripts/browser-core-path.mjs（待 T29 提供非沙箱 shell 后）',
    evidence: '无——沙箱会静默阻塞 WebKit 写 ~/Library/WebKit（存储测量必失败），且 WebKit 会泄漏辅助进程',
    notes:
      '缺：**非沙箱环境** + 每个格子后的浏览器进程清理。真实 Safari 与 Playwright WebKit 也不等价，归 T29。',
  },
  {
    id: 'browser.edge',
    requirement: 'T30 验收第 1 条：Edge 90+（最低与最新）',
    dimension: '浏览器 / Edge',
    engine: '—',
    status: 'blocked',
    command: '—',
    evidence: '无——本机未安装 Microsoft Edge',
    notes: '缺：**Edge 安装**（Chromium 内核结论可作近似，但不能替代 Edge 实测）。归 T29。',
  },
  {
    id: 'browser.minVersions',
    requirement: 'T30 验收第 1 条：Chrome/Firefox 90、Safari 14 的最低版本',
    dimension: '浏览器 / 最低版本',
    engine: '—',
    status: 'blocked',
    command: '—',
    evidence: '无——本机只有 chromium-1208/1223（Chrome 148）、firefox-1522、webkit-2287',
    notes:
      '缺：**最低版本浏览器二进制**（Chrome 90 / Firefox 90 / Safari 14）。安装浏览器属新增依赖，' +
      '需负责人批准；且属于真机/受控环境工作，归 T29。',
  },
  {
    id: 'device.iosSafari',
    requirement: 'T30 验收第 1 条：iOS Safari 真机',
    dimension: '真机 / iOS Safari',
    engine: '—',
    status: 'blocked',
    command: '—',
    evidence: '无——本机无 iOS 设备与 remote debugging 通道',
    notes: '缺：**真机 + Web Inspector 通道**；也缺 iOS 上的 WKWebView 差异结论。归 T29。',
  },
  {
    id: 'device.androidChrome',
    requirement: 'T30 验收第 1 条：Android Chrome 真机',
    dimension: '真机 / Android Chrome',
    engine: '—',
    status: 'blocked',
    command: '—',
    evidence: '无——本机无 Android 设备与 adb 通道',
    notes: '缺：**真机 + adb**；含 OEM WebView/省电策略差异。归 T29。',
  },
  {
    id: 'import.webpack.production',
    requirement: '指南 4.2：webpack 生产构建',
    dimension: '接入方式 / webpack 生产构建',
    engine: '—',
    status: 'blocked',
    command: '—',
    evidence: '无——仓库未安装 webpack（`node_modules` 无 webpack；examples/ 也没有 webpack 工程）',
    notes:
      '缺：**新增 example + webpack 依赖（需负责人批准）**。当前只能给出间接判据：`exports` 的 ' +
      '`import`/`types` 条件齐全、产物是标准 ESM（webpack 5 消费 ESM 无障碍），但**这不是实测**。归 T29 或待批准后补。',
  },
  {
    id: 'import.webpack.devServer',
    requirement: '指南 4.2：webpack 开发服务器',
    dimension: '接入方式 / webpack 开发服务器',
    engine: '—',
    status: 'blocked',
    command: '—',
    evidence: '无——同上',
    notes: '缺：同 webpack 生产构建（新增 example + 依赖需批准）。归 T29 或待批准后补。',
  },
];

const all = [...cells, ...blocked];
const summary = {
  pass: all.filter((cell) => cell.status === 'pass').length,
  fail: all.filter((cell) => cell.status === 'fail').length,
  blocked: all.filter((cell) => cell.status === 'blocked').length,
  total: all.length,
};

mkdirSync(resultsDir, { recursive: true });
writeFileSync(
  join(resultsDir, 'matrix.json'),
  `${JSON.stringify({ task: 'T30', generatedAt: new Date().toISOString(), summary, cells: all }, null, 2)}\n`,
  'utf8',
);

const width = Math.max(...all.map((cell) => cell.dimension.length), 8);
for (const cell of all) {
  console.log(`${cell.status.padEnd(7)} ${cell.dimension.padEnd(width)}  ${cell.id}`);
}
console.log(`\npass=${summary.pass} fail=${summary.fail} blocked=${summary.blocked} total=${summary.total}`);
console.log('matrix: tests/compat/results/matrix.json');
process.exitCode = summary.fail > 0 ? 1 : 0;
