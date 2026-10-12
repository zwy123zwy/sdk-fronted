/**
 * Playwright 驱动与浏览器二进制的配对解析。
 *
 * 背景：本仓库锁定 playwright 1.64.0，但本机 ms-playwright 缓存里装的是
 * 1.58.2 / 1.60.0 时代的浏览器构建（见 POC-1 报告「环境」一节）。
 * Playwright 的浏览器 revision 必须与驱动严格配对，否则 launch 会失败或挂起。
 *
 * 这里对每个候选驱动问 `browserType.executablePath()`（驱动自己算出来的期望路径，
 * 含 revision），只在文件真实存在时才采用，做到「精确配对才用」。
 * 不安装、不下载任何东西。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');

/** 候选驱动。path 为 null 表示用仓库内声明的 @playwright/test。 */
export const DRIVER_CANDIDATES = [
  { id: 'repo-playwright-test', path: null, note: '仓库 package.json 锁定的 @playwright/test（1.64.0）' },
  {
    id: 'npx-cache-playwright-core-1.60.0',
    path: '/Users/spirit-ai/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core',
    note: '树外只读缓存；其 revision 与本机已装浏览器一致'
  },
  {
    id: 'web-components-playwright-core-1.60.0',
    path: '/Users/spirit-ai/Desktop/web-components/fronted-components/node_modules/playwright-core',
    note: '树外只读依赖；其 revision 与本机已装浏览器一致'
  }
];

async function importDriver(candidate) {
  if (!candidate.path) return await import('@playwright/test');
  const mod = await import(path.join(candidate.path, 'index.js'));
  return mod.default ?? mod;
}

function revisionOf(executablePath) {
  const m = /ms-playwright[\\/]([a-z-]+?)-(\d+)[\\/]/.exec(executablePath);
  return m ? { name: m[1], revision: m[2] } : null;
}

/**
 * 选出 (驱动, 浏览器二进制) 精确配对的组合。
 * @param {string} browserName chromium | firefox | webkit
 * @param {{cacheDir?: string, preferDriver?: string}} [options]
 */
export async function resolveDriver(browserName, options = {}) {
  const notes = [];
  const order = options.preferDriver
    ? DRIVER_CANDIDATES.filter((c) => c.id === options.preferDriver).concat(
        DRIVER_CANDIDATES.filter((c) => c.id !== options.preferDriver)
      )
    : DRIVER_CANDIDATES;

  const tried = [];
  for (const candidate of order) {
    if (candidate.path && !fs.existsSync(candidate.path)) {
      tried.push(`${candidate.id}: 路径不存在`);
      continue;
    }
    let playwright;
    try {
      playwright = await importDriver(candidate);
    } catch (err) {
      tried.push(`${candidate.id}: 载入失败 ${String(err && err.message)}`);
      continue;
    }
    let expectedPath;
    try {
      expectedPath = playwright[browserName].executablePath();
    } catch (err) {
      tried.push(`${candidate.id}: executablePath() 失败 ${String(err && err.message)}`);
      continue;
    }
    const parsed = revisionOf(expectedPath);
    if (!fs.existsSync(expectedPath)) {
      tried.push(`${candidate.id}: 期望 ${parsed ? parsed.name + '-' + parsed.revision : expectedPath}，该目录未安装`);
      continue;
    }
    if (tried.length > 0) notes.push(`优先候选不可用（${tried.join('；')}），改用 ${candidate.id}`);
    return {
      playwright,
      browserName,
      executablePath: expectedPath,
      driverId: candidate.id,
      driverNote: candidate.note,
      revision: parsed ? parsed.revision : null,
      exactMatch: true,
      notes
    };
  }
  throw new Error(
    `${browserName}: 没有任何候选驱动与其浏览器构建精确配对。尝试过：${tried.join('；')}`
  );
}

/** 打印配对信息，便于复现与排查。 */
export function describeDriver(info) {
  return `${info.browserName}: driver=${info.driverId} + ${info.browserName}-${info.revision} → ${info.executablePath}`;
}
