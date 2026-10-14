/**
 * T29：真实浏览器 E2E 的浏览器解析。
 *
 * 背景（handover 第 2 节 T29，已探明）：
 *   仓库锁定 `@playwright/test@1.64.0`，它期望 chromium-1248 / firefox-1555 / webkit-2370，
 *   本机 ms-playwright 缓存里**没有**这三个；有的是 chromium-1208/1223、firefox-1522、webkit-2287。
 *   Playwright 的驱动与浏览器二进制必须配对，否则：
 *     - webkit-2287 + 1.64.0 驱动 → `Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled`；
 *     - firefox-1522 + 1.64.0 驱动 → `Protocol error (Browser.setDefaultViewport)`。
 *   因此这里按下面的顺序解析，并把实际用的（驱动, 二进制, 是否精确配对）写进结果 JSON：
 *     1. `PW_<NAME>_EXE` 显式指定的可执行文件（+ 仓库驱动，或 `E2E_DRIVER=exact` 时的树外驱动）；
 *     2. 树外只读 `playwright-core`（1.60.0）与已装构建 **revision 精确配对**——POC-1 的做法，只读、不安装；
 *     3. 仓库驱动 + 本机缓存里最新的构建（chromium 实测可用）。
 *
 * 本文件不安装、不下载任何东西；解析失败时抛出带「缺什么 + 补测步骤」的错误。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 浏览器目录名 → 可执行文件相对路径（macOS arm64 布局）。 */
const EXECUTABLE_RELATIVE = {
  chromium: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  firefox: 'firefox/Nightly.app/Contents/MacOS/firefox',
  webkit: 'pw_run.sh',
};

/** 本机实际安装的构建（按目录名，从新到旧）。 */
export function installedBuilds(browserName) {
  const prefix = `${browserName}-`;
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs
    .readdirSync(CACHE_DIR)
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
}

function exeFor(browserName, build) {
  const rel = EXECUTABLE_RELATIVE[browserName];
  if (!rel) return null;
  const exe = path.join(CACHE_DIR, build, rel);
  return fs.existsSync(exe) ? exe : null;
}

/** 树外只读驱动（POC-1 用过的候选）；存在才采用。其 revision 与本机已装构建一致。 */
const TREE_OUT_DRIVERS = [
  {
    id: 'npx-cache-playwright-core-1.60.0',
    dir: '/Users/spirit-ai/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core',
  },
  {
    id: 'web-components-playwright-core-1.60.0',
    dir: '/Users/spirit-ai/Desktop/web-components/fronted-components/node_modules/playwright-core',
  },
];

async function loadDriver(dir) {
  const mod = await import(path.join(dir, 'index.js'));
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

  const treeOut = [];
  for (const driver of TREE_OUT_DRIVERS) {
    if (!fs.existsSync(driver.dir)) {
      tried.push(`${driver.id}: 目录不存在`);
      continue;
    }
    try {
      const playwright = await loadDriver(driver.dir);
      let expected = null;
      try {
        expected = playwright[browserName].executablePath();
      } catch (error) {
        tried.push(`${driver.id}: executablePath() 失败 ${String(error?.message ?? error)}`);
        continue;
      }
      treeOut.push({ playwright, driverId: driver.id, expected, dir: driver.dir });
    } catch (error) {
      tried.push(`${driver.id}: 载入失败 ${String(error?.message ?? error)}`);
    }
  }

  // 1. 显式可执行文件
  if (envExe) {
    if (!fs.existsSync(envExe)) {
      tried.push(`PW_${browserName.toUpperCase()}_EXE: ${envExe} 不存在`);
    } else {
      const preferred = driverPreference === 'repo' ? repoInfo : ((treeOut[0] && { ...repoInfo, playwright: treeOut[0].playwright, driverId: treeOut[0].driverId }));
      return {
        ...(preferred ?? repoInfo),
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

  // 3. 仓库驱动 + 本机最新构建（chromium 实测可用）
  for (const build of installedBuilds(browserName)) {
    const exe = exeFor(browserName, build);
    if (!exe) continue;
    return {
      ...repoInfo,
      executablePath: exe,
      source: `ms-playwright ${build}（仓库驱动，非精确配对）`,
      exactPairing: false,
      notes: tried,
    };
  }
  tried.push(`${browserName}: ms-playwright 缓存里没有任何可用构建`);

  throw new Error(
    `${browserName}: 没有可用的浏览器 + 驱动组合。\n` +
      `缺什么：本机 ms-playwright 缓存中没有 ${browserName} 的可用构建，且没有可精确配对的树外驱动。\n` +
      `补测步骤：在有权限处运行 \`pnpm exec playwright install ${browserName}\`（会下载 1.64.0 要求的构建），` +
      `或用 PW_${browserName.toUpperCase()}_EXE=/path/to/binary 指向已装浏览器。\n` +
      `尝试过：${tried.join('；')}`,
  );
}
