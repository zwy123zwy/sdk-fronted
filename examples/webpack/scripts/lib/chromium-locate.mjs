/**
 * 跨平台的 Chromium 定位（`examples/webpack` 的浏览器复核用）。
 *
 * 修的是什么（2026-10-15 复核，本 lane）：两个 webpack 脚本此前都写死一条 **macOS 专属**路径
 *
 *     join(process.env.HOME ?? '',
 *          'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64',
 *          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
 *
 * —— 这条路径把「本机装的是哪一个 Chromium 构建（`chromium-1223`）」「哪一个平台目录
 * （`chrome-mac-arm64`）」「哪一个操作系统（`Library/Caches`、`.app` 包）」三件事同时钉死。
 * 后果：在 **Linux CI**（`~/.cache/ms-playwright/...`、`chrome-linux/`）与 **Windows**
 * （`%LOCALAPPDATA%\ms-playwright\...`、`chrome-win\`）上这条路径**必然不存在**，
 * 于是"真实浏览器复核"在 CI 上**从来没跑过**，只留下一句 `skipped`（`docs/reports/handover.md`
 * 的交接表第 3 行、`docs/reports/t33-access-blockers.md` 的"额外发现"第 3 条）。
 *
 * 为什么不再自己拼路径：**Playwright 已经知道答案**。`chromium.executablePath()` 返回的就是
 * "这个 `@playwright/test` 版本在当前 平台/架构/`PLAYWRIGHT_BROWSERS_PATH` 下期望的二进制"，
 * 拼接规则（`chrome-mac-arm64` / `chrome-linux` / `chrome-win`、`.app` 包、`.exe` 后缀）
 * 全由它算，本模块不复制任何平台清单。定位顺序：
 *
 *   1. `PW_CHROMIUM_EXE`（显式指定，与 `tests/e2e/lib/browsers.mjs` 同名约定）；
 *   2. `chromium.executablePath()`（Playwright 官方的期望路径）；
 *   3. 本机 ms-playwright 缓存里**按 revision 从新到旧**的已装 `chromium-*` 构建（从
 *      `executablePath()` 反推缓存目录，另加各平台默认缓存目录；只认 Chrome for Testing
 *      的目录布局，不猜可执行文件名）。
 *
 * 关键点：候选**存在**不算数，**真的启动成功**才算数（`launch()` 抛错就换下一个）。
 * 这样"能不能跑"是实测事实，不是路径字符串比对；一个存在但起不来的二进制（缺依赖、架构不符、
 * 损坏）不会被误判成可用。
 *
 * 定位不到时**绝不假装有**：调用方（`browserCheck`）把这台机器上**试过的全部路径与真实报错**
 * 一起写进证据 JSON 的 `browser.attempts` / `reason`，并让 `classifyBrowserEvidence()` 显式记账
 * ——它**不是** pass。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Playwright 的默认缓存根目录（与 `playwright-core` 的 `computeDefaultCacheDirectory()` 同口径）。 */
function defaultCacheRoot() {
  if (process.platform === 'linux') {
    return process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches');
  }
  if (process.platform === 'win32') {
    return process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
  }
  return null;
}

/** 从 Playwright 给的路径里反推出缓存目录（`<cache>/ms-playwright/<name>-<rev>/…`）。 */
function cacheRootFromPlaywrightPath(exePath) {
  const parts = path.normalize(exePath).split(path.sep);
  const index = parts.findIndex((part) => part.endsWith('ms-playwright'));
  return index > 0 ? parts.slice(0, index).join(path.sep) : null;
}

/**
 * 所有可能是 ms-playwright 缓存目录的候选项（去重、保留顺序）。
 * 注意 `PLAYWRIGHT_BROWSERS_PATH` 的语义在这里**不需要**特判：`executablePath()` 已经把它算进
 * 返回值，而我们从返回值反推出的目录正是那个根。
 */
function cacheRoots(playwrightPath) {
  const roots = [];
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate.length > 0 && !roots.includes(candidate)) {
      roots.push(candidate);
    }
  };
  if (process.env['PLAYWRIGHT_BROWSERS_PATH'] !== undefined && process.env['PLAYWRIGHT_BROWSERS_PATH'] !== '') {
    push(process.env['PLAYWRIGHT_BROWSERS_PATH']);
  }
  push(cacheRootFromPlaywrightPath(playwrightPath));
  const standard = defaultCacheRoot();
  if (standard !== null) push(path.join(standard, 'ms-playwright'));
  return roots;
}

/**
 * 一个 `chromium-*` 构建目录里的 Chrome for Testing 可执行文件。
 * 只认 Playwright 自己用的那套目录布局（macOS 的 `.app` 包 / `chrome-linux*` / `chrome-win*`），
 * **不猜**可执行文件名；目录名不在候选里就返回 null（宁可报"没找到"也不瞎指一条路径）。
 */
function chromeForTestingPath(buildDir) {
  const candidates = [
    // macOS（Intel 与 arm64 布局同名）。
    path.join(buildDir, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(
      buildDir,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    path.join(
      buildDir,
      'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ),
    // Linux。
    path.join(buildDir, 'chrome-linux64', 'chrome'),
    path.join(buildDir, 'chrome-linux', 'chrome'),
    // Windows。
    path.join(buildDir, 'chrome-win64', 'chrome.exe'),
    path.join(buildDir, 'chrome-win', 'chrome.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** 缓存目录里已装的 Chromium 构建，按 revision 从新到旧。 */
function installedChromiumExecutables(roots) {
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('chromium-')) continue;
      const revision = Number(entry.name.slice('chromium-'.length));
      if (!Number.isInteger(revision)) continue;
      const exe = chromeForTestingPath(path.join(root, entry.name));
      if (exe !== null && !found.some((item) => item.path === exe)) {
        found.push({ path: exe, source: `ms-playwright ${entry.name}`, revision });
      }
    }
  }
  return found.sort((left, right) => right.revision - left.revision).map(({ path: exe, source }) => ({ path: exe, source }));
}

/**
 * 跨平台定位"能启动的" Chromium。返回的 `attempts` 记录**试过的每一个候选与真实报错**，
 * 定位不到时它是唯一的可审计证据（不是一句"没找到"）。
 *
 * @param {{ launch: (options: { executablePath: string }) => Promise<object> }} options.launch
 *   实际启动函数（注入以便自检；生产路径传 `chromium.launch`）。
 * @param {string} [options.playwrightPath] `chromium.executablePath()` 的结果。
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ browser: object|null, executablePath: string|null, source: string|null,
 *   attempts: Array<{ path: string, source: string, error: string|null }> }>}
 */
export async function resolveLaunchableChromium(options) {
  const log = options.log ?? (() => {});
  const playwrightPath = options.playwrightPath ?? '';
  const attempts = [];
  const candidates = [];
  const push = (candidatePath, source) => {
    if (typeof candidatePath !== 'string' || candidatePath.length === 0) return;
    if (candidates.some((item) => item.path === candidatePath)) return;
    candidates.push({ path: candidatePath, source });
  };

  const envExe = process.env['PW_CHROMIUM_EXE'];
  if (envExe !== undefined && envExe !== '') push(envExe, 'env PW_CHROMIUM_EXE');
  if (playwrightPath !== '') push(playwrightPath, 'chromium.executablePath()');
  for (const item of installedChromiumExecutables(cacheRoots(playwrightPath))) {
    push(item.path, item.source);
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) {
      attempts.push({ ...candidate, error: '文件不存在' });
      log(`[chromium-locate] 跳过 ${candidate.source}：${candidate.path} 不存在`);
      continue;
    }
    try {
      const browser = await options.launch({ executablePath: candidate.path });
      attempts.push({ ...candidate, error: null });
      log(`[chromium-locate] 可用：${candidate.source} → ${candidate.path}`);
      return { browser, executablePath: candidate.path, source: candidate.source, attempts };
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0].slice(0, 300);
      attempts.push({ ...candidate, error: message });
      log(`[chromium-locate] 启动失败 ${candidate.source}：${message}`);
    }
  }

  return { browser: null, executablePath: null, source: null, attempts };
}

/** 把 `attempts` 压成一行可读的理由（"为什么这台机器上没有可用的 Chromium"）。 */
export function unavailableReason(attempts) {
  if (attempts.length === 0) {
    return '没有找到任何候选 Chromium：PW_CHROMIUM_EXE 未设置、chromium.executablePath() 为空、缓存里没有已装的 chromium-*';
  }
  return attempts
    .map((item) => `${item.source}=${item.path}（${item.error ?? '可用'}）`)
    .join('；');
}

/**
 * `EXAMPLES_REQUIRE_BROWSER=1`：**显式声明"这次运行必须有真实浏览器"**。
 *
 * 默认（未设置）语义保持不变：定位不到就记账成 `skipped`（**不计入 pass**，但不是失败）——
 * 默认值必须服务于"CI 的 gates job 不装浏览器"这个事实（`.github/workflows/ci.yml`），
 * 否则会把门禁在 CI 上弄红、且红的原因是环境而不是 SDK。
 *
 * 但"我不知道这台机器上有没有浏览器"与"我要求它必须有"是两件事。设置这个变量表示后者：
 * 定位不到就不再是 `skipped`（合法豁免）而是 `unavailable`——`classifyBrowserEvidence()` 对它
 * 返回 `accounted: false`，调用方据此让整体结论**转红并 exit 1**。
 *
 * 与本仓"跳过不可静默"是同一条原则的两面：**默认不假装，声明即承担**。
 */
export const REQUIRE_BROWSER_ENV = 'EXAMPLES_REQUIRE_BROWSER';

/** 是否声明了"必须有浏览器"（`0` / `false` / 空串视为未声明）。 */
export function browserRequired() {
  const raw = process.env[REQUIRE_BROWSER_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

/**
 * 定位不到浏览器时的状态：默认 `skipped`（带理由的合法豁免），
 * 声明了 `EXAMPLES_REQUIRE_BROWSER` 时是 `unavailable`（调用方必须判红）。
 * @returns {'skipped'|'unavailable'}
 */
export function unavailableStatus() {
  return browserRequired() ? 'unavailable' : 'skipped';
}

/** 给 `unavailable` 状态补一句"为什么它是失败"（进 stdout / 证据 JSON）。 */
export function requiredBrowserHint() {
  return (
    `${REQUIRE_BROWSER_ENV} 已声明"必须有浏览器"：定位不到可启动的 Chromium ` +
    `不再算合法豁免，本次结论判红。若这台机器本就不打算跑浏览器复核，不要设置该变量。`
  );
}
