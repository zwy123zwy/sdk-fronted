/**
 * T29：真实浏览器 E2E 的浏览器解析（**跨平台**）。
 *
 * 背景（handover 第 2 节 T29，已探明）：
 *   仓库锁定 `@playwright/test@1.64.0`，它期望 chromium-1248 / firefox-1555 / webkit-2370，
 *   本机 ms-playwright 缓存里**没有**这三个；有的是 chromium-1208/1223、firefox-1522、webkit-2287。
 *   Playwright 的驱动与浏览器二进制必须配对，否则：
 *     - webkit-2287 + 1.64.0 驱动 → `Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled`；
 *     - firefox-1522 + 1.64.0 驱动 → `Protocol error (Browser.setDefaultViewport)`。
 *   因此这里按下面的顺序解析，并把实际用的（驱动, 二进制, 是否精确配对）写进结果 JSON：
 *     1. `PW_<NAME>_EXE` 显式指定的可执行文件（+ 仓库驱动，或 `E2E_DRIVER=exact` 时的树外驱动）；
 *     2. 树外只读 `playwright-core`（1.60.0 那类）与已装构建 **revision 精确配对**——POC-1 的做法，只读、不安装；
 *     3. **仓库驱动自己的 `executablePath()`**（= 这个 `@playwright/test` 在当前平台/架构下期望的二进制）。
 *        CI 的 e2e job 会 `playwright install`，装出来的正是这一个；
 *     4. 仓库驱动 + 本机缓存里最新的已装构建（chromium 实测可用）——**布局从 `executablePath()` 推导**，
 *        不写死任何平台的目录名。
 *
 * 可移植性（本轮修的就是这里）：此前
 *   - `CACHE_DIR` 写死 `~/Library/Caches/ms-playwright`（**只对 macOS 成立**）；
 *   - `EXECUTABLE_RELATIVE` 写死 macOS arm64 布局（`chrome-mac-arm64/…app`、`firefox/Nightly.app`、`pw_run.sh`）；
 *   - `TREE_OUT_DRIVERS` 写死两条用户主目录下的绝对路径。
 * 后果：在 **Linux CI**（`.github/workflows/ci.yml` 的 e2e job，`~/.cache/ms-playwright/…`）上，
 * 即使 `playwright install` 已经把浏览器装好，分支 3 找不到（缓存根错、布局错），分支 2 的绝对路径也不存在，
 * 于是三个 project 全部以"没有可用的浏览器 + 驱动组合"报错 —— 红的原因是**路径**，不是 SDK。
 * 现在：缓存根按平台算（`~/.cache` / `Library/Caches` / `%LOCALAPPDATA%`，并尊重
 * `PLAYWRIGHT_BROWSERS_PATH`），布局由 Playwright 的 `executablePath()` 推导（只把 `<name>-<revision>`
 * 换成已装构建），树外驱动改为"环境变量 + npm npx 缓存自动发现"。
 *
 * 本文件不安装、不下载任何东西；解析失败时抛出带「缺什么 + 补测步骤 + 试过的每个候选」的错误。
 * **解析成功 ≠ 能跑**：能不能跑只由 `lib/browser-availability.mjs` 的真启动探测回答。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 某平台的 ms-playwright 默认缓存根目录（与 `playwright-core` 的 `computeDefaultCacheDirectory()`
 * 同口径）。平台是**注入参数**，因此 Linux/Windows 的分支可以被确定性自检钉住
 * （`node tests/e2e/lib/browser-locate-selftest.mjs`），不必真的在 Linux 上跑。
 *
 * @param {string} platform `process.platform` 的取值
 * @param {Record<string, string|undefined>} env
 * @param {string} home 家目录
 * @returns {string|null} 未知平台返回 null
 */
export function cacheRootForPlatform(platform, env, home) {
  if (platform === 'linux') {
    const xdg = env['XDG_CACHE_HOME'];
    const cacheHome = typeof xdg === 'string' && xdg !== '' ? xdg : path.join(home, '.cache');
    return path.join(cacheHome, 'ms-playwright');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'ms-playwright');
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    const base =
      typeof localAppData === 'string' && localAppData !== ''
        ? localAppData
        : path.join(home, 'AppData', 'Local');
    return path.join(base, 'ms-playwright');
  }
  return null;
}

/**
 * 当前进程的默认缓存根目录。
 *
 * `PLAYWRIGHT_BROWSERS_PATH` 优先：它是 Playwright 自己的"浏览器装在哪"开关
 * （CI 与自检都靠它把缓存指到临时目录）。`PLAYWRIGHT_BROWSERS_PATH=0` 表示"装进包的 node_modules"，
 * 那种情况下没有单一的缓存根，这里退回平台默认值（分支 3 仍会按 `executablePath()` 命中）。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [platform]
 * @param {string} [home]
 */
export function defaultCacheRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const override = env['PLAYWRIGHT_BROWSERS_PATH'];
  if (typeof override === 'string' && override !== '' && override !== '0') return override;
  return cacheRootForPlatform(platform, env, home) ?? path.join(home, 'ms-playwright');
}

/** 本进程的默认缓存根目录（导出供诊断/自检用）。 */
export const CACHE_DIR = defaultCacheRoot();

/** 一个构建目录名（`chromium-1223` / `firefox-1522` / `webkit-2287` / `chromium_headless_shell-1223`）。 */
const BUILD_DIR_PATTERN = /^(chromium|chromium_headless_shell|firefox|webkit)-\d+$/u;

/**
 * 从 Playwright 给的某条路径里反推出缓存根（`<root>/<name>-<revision>/…`）。
 * 这是"**不写死平台缓存路径**"的关键：根目录由 Playwright 的返回值决定，本文件只做切分。
 *
 * @param {string|null|undefined} browserPath
 * @returns {string|null}
 */
export function cacheRootFromBrowserPath(browserPath) {
  if (typeof browserPath !== 'string' || browserPath === '') return null;
  const parts = path.normalize(browserPath).split(path.sep);
  const index = parts.findIndex((part) => BUILD_DIR_PATTERN.test(part));
  return index > 0 ? parts.slice(0, index).join(path.sep) : null;
}

/**
 * 可执行文件在构建目录内的相对路径 —— **从 Playwright 自己的 `executablePath()` 推导**，
 * 不维护任何平台布局表。macOS 的 `chrome-mac-arm64/…app/Contents/MacOS/…`、
 * Linux 的 `chrome-linux/chrome`、Windows 的 `chrome-win/chrome.exe`、WebKit 的 `pw_run.sh`、
 * Firefox 的 `firefox/Nightly.app/…` 全部由这一条规则覆盖，因为布局是 Playwright 算出来的。
 *
 * @param {string} browserName
 * @param {string|null|undefined} expectedPath `playwright[browserName].executablePath()`
 * @returns {string|null} 相对路径（以分隔符连接）；推导不出时 null
 */
export function executableTail(browserName, expectedPath) {
  if (typeof expectedPath !== 'string' || expectedPath === '') return null;
  const parts = path.normalize(expectedPath).split(path.sep);
  const index = parts.findIndex((part) => new RegExp(`^${browserName}-\\d+$`, 'u').test(part));
  if (index < 0 || index + 1 >= parts.length) return null;
  return parts.slice(index + 1).join(path.sep);
}

/**
 * 某个已装构建目录里的可执行文件：把上述相对路径搬过来，**只换掉 `<name>-<revision>` 那段**。
 * 不在预期位置就返回 null —— 宁可报"没找到"，也不瞎指一条不存在的路径。
 *
 * @param {string} browserName
 * @param {string} buildDir 已装构建目录（绝对路径）
 * @param {string|null|undefined} expectedPath
 * @returns {string|null}
 */
export function executableInBuild(browserName, buildDir, expectedPath) {
  const tail = executableTail(browserName, expectedPath);
  if (tail === null) return null;
  const exe = path.join(buildDir, tail);
  return fs.existsSync(exe) ? exe : null;
}

/**
 * 所有可能是 ms-playwright 缓存目录的候选项（去重、保留顺序）：
 * 1. 从 `executablePath()` 反推出来的那个根（自动尊重 `PLAYWRIGHT_BROWSERS_PATH`）；
 * 2. 平台默认根（`CACHE_DIR`）。
 */
function cacheRoots(expectedPath = null) {
  const roots = [];
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate.length > 0 && !roots.includes(candidate)) {
      roots.push(candidate);
    }
  };
  push(cacheRootFromBrowserPath(expectedPath));
  push(CACHE_DIR);
  return roots;
}

/**
 * 缓存里已装的构建目录（按 revision 从新到旧）。
 * @param {string} browserName
 * @param {string[]} [roots]
 * @returns {{ build: string, dir: string, revision: number }[]}
 */
export function installedBuildDirs(browserName, roots = cacheRoots()) {
  const prefix = `${browserName}-`;
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const revisionText = name.slice(prefix.length);
      if (!/^\d+$/u.test(revisionText)) continue;
      const dir = path.join(root, name);
      // 构建目录可能是指向另一个 revision 的**符号链接**（本机 `chromium-1208 -> chromium-1223`）。
      // 用 `statSync`（跟随链接）而不是 `Dirent.isDirectory()`，否则这类构建会被静默漏掉。
      if (!isDirectoryFollowingLinks(dir)) continue;
      if (found.some((item) => item.dir === dir)) continue;
      found.push({ build: name, dir, revision: Number(revisionText) });
    }
  }
  return found.sort((left, right) => right.revision - left.revision);
}

/** `statSync`（跟随符号链接）判断是否目录；不存在/无权限一律 false。 */
function isDirectoryFollowingLinks(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 缓存里已装的构建名（按 revision 从新到旧）—— 保留原有导出供诊断脚本使用。
 * @param {string} browserName
 * @param {string[]} [roots]
 * @returns {string[]}
 */
export function installedBuilds(browserName, roots = cacheRoots()) {
  return installedBuildDirs(browserName, roots).map((item) => item.build);
}

/**
 * 树外只读 `playwright-core` 的候选目录：**环境变量 + 自动发现**，不再写死用户主目录下的绝对路径。
 *
 * - `E2E_TREE_OUT_DRIVERS`：`path.delimiter` 分隔的 `playwright-core` 目录清单（显式指定）；
 * - `~/.npm/_npx/*`：npx 缓存里那些装了 `playwright-core` 的目录（POC-1 用的 1.60.0 就在这里）。
 *   版本不配对也没关系：后面只有"`executablePath()` 指向的构建确实存在"才会采用它。
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [home]
 * @returns {string[]}
 */
export function treeOutDriverDirs(env = process.env, home = os.homedir()) {
  const dirs = [];
  const push = (candidate) => {
    if (typeof candidate === 'string' && candidate.length > 0 && !dirs.includes(candidate)) {
      dirs.push(candidate);
    }
  };
  const configured = env['E2E_TREE_OUT_DRIVERS'];
  if (typeof configured === 'string' && configured !== '') {
    for (const item of configured.split(path.delimiter)) push(item);
  }
  const npxRoot = path.join(home, '.npm', '_npx');
  if (fs.existsSync(npxRoot)) {
    let entries;
    try {
      entries = fs.readdirSync(npxRoot);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      push(path.join(npxRoot, entry, 'node_modules', 'playwright-core'));
    }
  }
  return dirs.filter((dir) => fs.existsSync(dir));
}

/** 读 `<dir>/package.json` 的 version（读不到就 null）；只用于给驱动起一个可审计的 id。 */
function treeOutDriverVersion(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

async function loadDriver(dir) {
  const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href);
  return mod.default ?? mod;
}

export async function loadRepoPlaywright() {
  return await import('@playwright/test');
}

function repoDriverVersion(playwright) {
  try {
    return playwright.chromium._playwrightVersion ?? null;
  } catch {
    return null;
  }
}

/** `playwright[browserName].executablePath()`（Playwright 在当前平台/架构下的期望路径）；取不到则 null。 */
function expectedExecutablePath(playwright, browserName) {
  try {
    const type = playwright[browserName];
    if (type === undefined || typeof type.executablePath !== 'function') return null;
    const value = type.executablePath();
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 解析一个浏览器到可用于 launch 的 { playwright, executablePath, driverId, exactPairing, ... }。
 * @param {'chromium'|'firefox'|'webkit'} browserName
 */
export async function resolveBrowser(browserName, options = {}) {
  const tried = [];
  const envExe = process.env[`PW_${browserName.toUpperCase()}_EXE`];
  const driverPreference = options.driver ?? process.env['E2E_DRIVER'] ?? 'exact';
  const repo = await loadRepoPlaywright();
  const repoInfo = {
    browserName,
    playwright: repo,
    driverId: `repo-@playwright/test@${repoDriverVersion(repo) ?? '1.64.0'}`,
    repoRoot: REPO_ROOT,
  };
  /** Playwright 自己算出来的期望路径：分支 3 直接用它，分支 4 用它推导构建内布局。 */
  const repoExpected = expectedExecutablePath(repo, browserName);

  const treeOut = [];
  for (const dir of treeOutDriverDirs()) {
    const version = treeOutDriverVersion(dir);
    const driverId = version === null ? `tree-out:${dir}` : `npx-cache-playwright-core-${version}`;
    try {
      const playwright = await loadDriver(dir);
      let expected = null;
      try {
        expected = playwright[browserName].executablePath();
      } catch (error) {
        tried.push(`${driverId}: executablePath() 失败 ${String(error?.message ?? error)}`);
        continue;
      }
      treeOut.push({ playwright, driverId, expected, dir });
    } catch (error) {
      tried.push(`${driverId}: 载入失败 ${String(error?.message ?? error)}`);
    }
  }

  // 1. 显式可执行文件
  if (envExe) {
    if (!fs.existsSync(envExe)) {
      tried.push(`PW_${browserName.toUpperCase()}_EXE: ${envExe} 不存在`);
    } else {
      const preferred =
        driverPreference === 'repo'
          ? repoInfo
          : treeOut[0] !== undefined
            ? { ...repoInfo, playwright: treeOut[0].playwright, driverId: treeOut[0].driverId }
            : repoInfo;
      return {
        ...preferred,
        executablePath: envExe,
        source: `env PW_${browserName.toUpperCase()}_EXE`,
        exactPairing: driverPreference !== 'repo',
        notes: tried,
      };
    }
  }

  // 2. 精确配对：树外驱动的 executablePath() 正好是本机已装构建
  if (driverPreference !== 'repo') {
    for (const candidate of treeOut) {
      if (!fs.existsSync(candidate.expected)) {
        tried.push(`${candidate.driverId}: 期望 ${candidate.expected}，未安装`);
        continue;
      }
      return {
        browserName,
        playwright: candidate.playwright,
        driverId: candidate.driverId,
        executablePath: candidate.expected,
        source: `${candidate.driverId}（revision 精确配对）`,
        exactPairing: true,
        repoRoot: REPO_ROOT,
        notes: tried,
      };
    }
  }

  // 3. 仓库驱动的期望路径（**CI 走的就是这条**：`playwright install` 装的就是它）
  if (repoExpected === null) {
    tried.push(`${browserName}: 仓库驱动没有给出 executablePath()`);
  } else if (fs.existsSync(repoExpected)) {
    return {
      ...repoInfo,
      executablePath: repoExpected,
      source: 'repo driver executablePath()（当前平台/架构的期望路径）',
      exactPairing: true,
      notes: tried,
    };
  } else {
    tried.push(`repo driver 期望 ${repoExpected}，未安装`);
  }

  // 4. 仓库驱动 + 本机缓存里最新的构建（布局由分支 3 的期望路径推导，只换 revision 目录）
  const roots = cacheRoots(repoExpected);
  const builds = installedBuildDirs(browserName, roots);
  if (builds.length === 0) {
    tried.push(
      `ms-playwright 缓存里没有 ${browserName}-* 构建（找过：${roots.join('、') || '（无候选根）'}）`,
    );
  }
  for (const build of builds) {
    const exe = executableInBuild(browserName, build.dir, repoExpected);
    if (exe === null) {
      tried.push(`${build.build}: 构建内没有期望的相对路径（期望 ${expectedTailText(browserName, repoExpected)}）`);
      continue;
    }
    return {
      ...repoInfo,
      executablePath: exe,
      source: `ms-playwright ${build.build}（仓库驱动，非精确配对）`,
      exactPairing: false,
      notes: tried,
    };
  }

  throw new Error(
    `${browserName}: 没有可用的浏览器 + 驱动组合。\n` +
      `缺什么：本机 ms-playwright 缓存中没有 ${browserName} 的可用构建，仓库驱动期望的二进制也不存在，` +
      `且没有可精确配对的树外驱动。\n` +
      `补测步骤：运行 \`pnpm exec playwright install ${browserName}\`（会下载当前 @playwright/test 期望的构建），` +
      `或用 PW_${browserName.toUpperCase()}_EXE=/path/to/binary 指向已装浏览器；` +
      `缓存不在默认位置时用 PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright 指定。\n` +
      `找过的缓存根：${roots.join('、') || '（无候选根）'}\n` +
      `尝试过：${tried.join('；')}`,
  );
}

/** 错误信息里用的"期望相对路径"文本（推导不出时给一句实话）。 */
function expectedTailText(browserName, expectedPath) {
  const tail = executableTail(browserName, expectedPath);
  return tail ?? '推导失败（仓库驱动的 executablePath() 不含 <name>-<revision> 段）';
}
