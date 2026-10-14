/**
 * T29 真实浏览器 E2E 的驱动辅助。
 *
 * 关键约束（handover 第 2 节 T29 已探明，这里照做）：
 *   - 用 `launchPersistentContext` + 每次全新 profile（「同一 profile 重启」的唯一正确做法）；
 *   - 强杀用真 SIGKILL（Chromium 走 browser 级 CDP 取 PID，其余按可执行文件路径 pgrep），
 *     **绝不用 `context.close()` 冒充硬杀**；
 *   - WebKit 会泄漏辅助进程，每个格子后按可执行文件路径清理；
 *   - 不给 Firefox 设任何 `MOZ_*` 变量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

/**
 * 进程匹配模式：优先用 ms-playwright 里的**构建目录**（如 .../ms-playwright/webkit-2287），
 * 而不是 executablePath 本身。
 *
 * 为什么（实测教训）：WebKit 的 executablePath 是 `.../webkit-2287/pw_run.sh`，它只是 shell 包装，
 * 真正的浏览器是 `.../webkit-2287/Playwright.app/Contents/MacOS/Playwright` 及其 XPC 辅助进程。
 * `pgrep -f .../pw_run.sh` 只能匹配到包装脚本那一个 PID，SIGKILL 它之后**浏览器仍在跑**，
 * 于是「强杀」后的事务还能提交，落盘数字全部虚高（本会话实测过一次，已重做）。
 */
export function processPattern(executablePath) {
  const match = /^(.*ms-playwright\/[^/]+)\//.exec(executablePath);
  return match === null ? executablePath : `${match[1]}/`;
}

/** 按构建目录匹配的浏览器进程 PID（沙箱里 ps 不可用，pgrep 可用）。 */
export function browserPids(executablePath) {
  try {
    const out = execFileSync('pgrep', ['-f', processPattern(executablePath)], { encoding: 'utf8' }).trim();
    if (!out) return [];
    return out
      .split('\n')
      .map((line) => Number(line))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

/** 清掉上一格残留的浏览器进程（WebKit 泄漏、超时中断都会留下）。 */
export function killStaleBrowsers(executablePath, log) {
  const pids = browserPids(executablePath);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      log?.(`  清理残留浏览器进程 pid=${pid}`);
    } catch {
      /* 已退出 */
    }
  }
  return pids.length;
}

/**
 * **只属于某个 profile 的**浏览器进程（`pgrep -f <userDataDir>`）。
 *
 * 为什么要按 profile 而不是按构建目录：并行 worker 里同时跑同一种浏览器时，
 * 按构建目录匹配会把**别的 worker** 正在用的浏览器一起杀掉（本会话实测：
 * webkit 的 durability 用例把同 worker 之外的 real-browser 浏览器杀了，报 Target closed）。
 * 每个格子/用例都有自己唯一的 user-data-dir，按它匹配不会误伤。
 *
 * 注意：WebKit 的 XPC 辅助进程命令行里没有 user-data-dir，所以这里通常只匹配到包装脚本与
 * 主浏览器进程；杀掉主进程即足以终止它（辅助进程随之退出）。
 */
export function profilePids(userDataDir) {
  try {
    const out = execFileSync('pgrep', ['-f', userDataDir], { encoding: 'utf8' }).trim();
    if (!out) return [];
    return out
      .split('\n')
      .map((line) => Number(line))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

/** 按 PID 列表 SIGKILL（只杀给定的这些）。 */
export function killMatching(pids, log) {
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
      log?.(`  清理浏览器进程 pid=${pid}`);
    } catch {
      /* 已退出 */
    }
  }
  return killed;
}

/** 起一个全新的持久化 profile 目录。 */
export function freshProfile(baseDir, name) {
  const dir = path.join(baseDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeRunDir(name) {
  const dir = path.join(os.tmpdir(), `t29-e2e-${name}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 启动持久化 context（显式 executablePath，绝不依赖默认下载的浏览器）。 */
export async function launchPersistent(info, userDataDir, extra = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const type = info.playwright[info.browserName];
  return await type.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: info.executablePath,
    viewport: { width: 900, height: 600 },
    timeout: 60_000,
    ...extra,
  });
}

/** 打开探针页并等驱动就绪。 */
export async function openProbe(context, url, readyFlag = '__d004Ready') {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction((flag) => globalThis.window[flag] === true, readyFlag, { timeout: 30_000 });
  return page;
}

/**
 * 真·SIGKILL 浏览器进程。
 * Chromium：browser 级 CDP 的 `SystemInfo.getProcessInfo` 取浏览器主进程 PID。
 * 其他：按可执行文件路径 pgrep（用启动前记录的 PID 集合取新增的）。
 * @returns {{mode: string, pid: number|null, killAt: number}}
 */
export async function hardKill(context, info, options = {}) {
  const signal = options.signal ?? 'SIGKILL';
  const before = options.pidsBefore ?? [];
  const killAt = Date.now();
  if (info.browserName === 'chromium') {
    try {
      const browser = context.browser();
      const cdp = await browser.newBrowserCDPSession();
      const resp = await cdp.send('SystemInfo.getProcessInfo');
      const proc = (resp.processInfo ?? []).find((item) => item.type === 'browser');
      if (proc?.id) {
        process.kill(proc.id, signal);
        return { mode: `SIGKILL via CDP SystemInfo pid=${proc.id}`, pid: proc.id, killAt };
      }
    } catch {
      /* 落到 pgrep */
    }
  }
  // 非 Chromium：只杀这个 profile 的进程（不按构建目录扫，避免误杀并行 worker 的浏览器）。
  // 优先用**启动后立刻记下的 PID**（不再 pgrep），把「发出 → 强杀」的延迟压到最低 ——
  // 并行负载下 pgrep 的开销足以让 WebKit 的事务先提交完，导致窗口捕获率不稳定。
  const known = options.targetPids ?? [];
  if (known.length > 0) {
    for (const pid of known) {
      try {
        process.kill(pid, signal);
      } catch {
        /* 已退出 */
      }
    }
    await sleep(30);
    const left = options.userDataDir === undefined ? [] : profilePids(options.userDataDir);
    for (const pid of left) {
      try {
        process.kill(pid, signal);
      } catch {
        /* 已退出 */
      }
    }
    return { mode: `SIGKILL via launch-pids=${known.join(',')}`, pid: known[0], killAt };
  }
  const scoped = options.userDataDir === undefined ? [] : profilePids(options.userDataDir);
  const after = browserPids(info.executablePath);
  const fresh = after.filter((pid) => !before.includes(pid));
  const targets = scoped.length > 0 ? scoped : fresh.length > 0 ? fresh : after;
  if (targets.length === 0) throw new Error('无法强杀：拿不到浏览器进程 PID');
  for (let round = 0; round < 3; round += 1) {
    const live =
      options.userDataDir === undefined
        ? browserPids(info.executablePath).filter((pid) => !before.includes(pid))
        : profilePids(options.userDataDir);
    if (live.length === 0) break;
    for (const pid of live) {
      try {
        process.kill(pid, signal);
      } catch {
        /* 已退出 */
      }
    }
    await sleep(50);
  }
  return {
    mode: `SIGKILL via ${options.userDataDir === undefined ? `pgrep pattern=${processPattern(info.executablePath)}` : `pgrep profile=${options.userDataDir}`} pids=${targets.join(',')}`,
    pid: targets[0],
    killAt,
  };
}

/** 等浏览器进程真正消失（否则同一 profile 上重启会撞到锁）。 */
export async function waitForExit(executablePath, { timeoutMs = 15_000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browserPids(executablePath).length === 0) return true;
    await sleep(pollMs);
  }
  return false;
}

/** 关掉 context 但吞掉「已被强杀」的异常（只用于清理，不代表优雅关闭）。 */
export async function closeQuietly(context) {
  try {
    await context.close();
  } catch {
    /* 已被强杀 */
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
