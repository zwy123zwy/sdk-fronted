/** 场景共用的驱动辅助：持久化 context、探针页、统计读取、强杀、补发排空。 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sleep, waitFor } from './receiver.mjs';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function launchProbeContext(info, userDataDir, extra = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const type = info.playwright[info.browserName];
  const context = await type.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: info.executablePath,
    viewport: { width: 900, height: 600 },
    timeout: 60000,
    ...extra
  });
  return context;
}

/**
 * 断网期间让探针页仍然可加载：把静态资源在 route 层直接从磁盘 fulfill。
 * `context.setOffline(true)` 会阻断一切网络（含 127.0.0.1），
 * 所以要测「断网期间入队 / 断网刷新」必须先让页面本身能打开。
 * 只拦截本地静态页，上报端点不受影响，仍是真断网。
 */
export async function servePublicOffline(context, baseUrl) {
  await context.route(`${baseUrl}/**`, async (route) => {
    const u = new URL(route.request().url());
    const file = path.join(PUBLIC_DIR, path.normalize(u.pathname).replace(/^([/\\])+/, ''));
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file)) {
      await route.fulfill({
        status: 200,
        contentType: file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        body: fs.readFileSync(file)
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * 进入/退出「断网」。
 * Chromium：context.setOffline(true)（navigator.onLine=false，恢复时触发 online 事件）；
 *   页面本身用 route fulfill 从磁盘供给（见 servePublicOffline）。
 * WebKit / Firefox：不改 navigator.onLine，只把上报端点 abort 掉（页面的上网能力仍在）。
 *   WebKit 是因为 Playwright 的 WebKit 在 offline 下无法 goto（实测报
 *   "WebKit encountered an internal error"）；Firefox 采用同一口径以保证一次跑通。
 *   实际口径写进结果 JSON 的 offlineMode 字段。
 */
export async function beginOffline(context, info) {
  if (info.browserName !== 'chromium') {
    await context.route('**/v1/batch', (route) => route.abort('internetdisconnected'));
    return `route-abort-endpoint(${info.browserName})`;
  }
  await context.setOffline(true);
  return 'context.setOffline';
}

export async function endOffline(context, info) {
  if (info.browserName !== 'chromium') {
    await context.unroute('**/v1/batch');
    return;
  }
  await context.setOffline(false);
}

/** 按可执行文件路径匹配的进程 PID（从旧到新）。沙箱里 ps 不可用，pgrep 可用。 */
export function browserPids(executablePath) {
  try {
    const out = execFileSync('pgrep', ['-f', executablePath], { encoding: 'utf8' }).trim();
    if (!out) return [];
    return out.split('\n').map((x) => Number(x)).filter((x) => Number.isFinite(x));
  } catch {
    return [];
  }
}

/** 跑之前清掉上次残留的浏览器进程（超时中断会留下）。 */
export function killStaleBrowsers(executablePath, log) {
  const pids = browserPids(executablePath);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      if (log) log(`  清理残留浏览器进程 pid=${pid}`);
    } catch {
      /* ignore */
    }
  }
  return pids.length;
}


export async function openProbe(context, baseUrl, cfg) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/probe.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__pocReady === true);
  const info = await page.evaluate((c) => window.__poc.init(c), cfg);
  return { page, info };
}

export function pocCfg(baseUrl, receiver, extra = {}) {
  return {
    endpoint: receiver.endpoint,
    appId: 'poc-app',
    token: 'placeholder-write-token-0000',
    leader: 'none',
    autoRecover: false,
    leave: { trigger: 'none', transport: 'beacon' },
    ...extra
  };
}

export async function track(page, ids, cls) {
  return await page.evaluate((a) => window.__poc.track(a.ids, a.cls), { ids, cls });
}

export async function readStats(page) {
  return await page.evaluate(() => window.__poc.stats());
}

/** 只读该页面自己的计数（多标签页场景用于区分哪个标签页当选主）。 */
export async function readOwnStats(page) {
  return await page.evaluate(() => window.__poc.statsOwn());
}

export async function readPending(page) {
  // pendingIdsAsync 在 local 模式下等价于同步版本，在可切换存储模式下是异步读
  return await page.evaluate(() => window.__poc.pendingIdsAsync());
}

export async function readTrace(page) {
  return await page.evaluate(() => window.__poc.trace());
}

/** 追加轮：等待「落盘点」并返回 {resolved, ms, mode, records}。 */
export async function awaitDurable(page, timeoutMs = 400) {
  return await page.evaluate((ms) => window.__poc.awaitDurable(ms), timeoutMs);
}

export async function storeInfo(page) {
  return await page.evaluate(() => window.__poc.storeInfo());
}

export async function estimateStorage(page) {
  return await page.evaluate(() => window.__poc.estimateStorage());
}

export async function storageBench(page, n, batchSize) {
  return await page.evaluate((a) => window.__poc.storageBench(a.n, a.batchSize), { n, batchSize });
}

export async function quotaProbe(page) {
  return await page.evaluate(() => window.__poc.quotaProbe());
}

export async function quotaFailureInjection(page, n = 10) {
  return await page.evaluate((count) => window.__poc.quotaFailureInjection(count), n);
}

export async function recoverOn(page) {
  return await page.evaluate(() => window.__poc.recover());
}

/** 重连处理：先冲刷内存 normal 队列，再补发离线副本（与 SDK 的 online 处理一致）。 */
export async function reconnectOn(page) {
  return await page.evaluate(() =>
    Promise.all([window.__poc.flush('reconnect', 'fetch', { includeCritical: false }), window.__poc.recover()])
  );
}

export async function flushOn(page, reason, transport, opts = {}) {
  return await page.evaluate((a) => window.__poc.flush(a.reason, a.transport, a.opts), { reason, transport, opts });
}

export async function closeQuietly(context) {
  try {
    await context.close();
  } catch {
    /* 已被强杀 */
  }
}

/**
 * 真·强杀浏览器进程（SIGKILL）。
 * Chromium：用 browser 级 CDP 的 SystemInfo.getProcessInfo 拿浏览器进程 PID。
 * WebKit/Firefox：用 pgrep 按可执行文件路径匹配（先记录启动前的 PID 集合，取新增的那个）。
 * 返回实际使用的方式，写进结果 JSON，避免把「优雅关闭」当成强杀。
 */
export async function hardKill(context, info, options = {}) {
  const signal = options.signal || 'SIGKILL';
  const before = options.pidsBefore || [];
  const { browserName, executablePath } = info;

  if (browserName === 'chromium') {
    try {
      const browser = context.browser();
      const cdp = await browser.newBrowserCDPSession();
      const resp = await cdp.send('SystemInfo.getProcessInfo');
      const proc = (resp.processInfo || []).find((p) => p.type === 'browser');
      if (proc && proc.id) {
        process.kill(proc.id, signal);
        return { mode: `SIGKILL via CDP SystemInfo pid=${proc.id}` };
      }
    } catch (err) {
      /* 落到 pgrep */
    }
  }
  const after = browserPids(executablePath);
  const fresh = after.filter((pid) => !before.includes(pid));
  const pid = (fresh.length > 0 ? fresh : after).slice(-1)[0];
  if (pid) {
    process.kill(pid, signal);
    return { mode: `SIGKILL via pgrep pid=${pid}` };
  }
  throw new Error('无法强杀：既拿不到浏览器进程 PID，也没有可用的 CDP 通道');
}

/** 排空离线副本：按页逐个 recover，直到 pending 为空或没有进展。 */
export async function drainPending(pages, { maxPasses = 4, logger } = {}) {
  const passes = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    const before = await readPending(pages[0]);
    if (before.length === 0) break;
    for (const page of pages) {
      await recoverOn(page).catch(() => null);
    }
    const after = await readPending(pages[0]);
    passes.push({ pass, before: before.length, after: after.length });
    if (logger) logger(`  排空 pass=${pass} pending ${before.length} → ${after.length}`);
    if (after.length >= before.length) break;
  }
  return passes;
}

/** 判定丢失：以 event_id 是否最终入库为准。 */
export function lossOf(expectedIds, storedSet) {
  const lost = [];
  for (const id of expectedIds) if (!storedSet.has(id)) lost.push(id);
  return { total: expectedIds.length, stored: expectedIds.length - lost.length, lost: lost.length, lostIds: lost };
}

export function rate(lost, total) {
  if (total === 0) return 0;
  return lost / total;
}

export function pct(x) {
  return `${(x * 100).toFixed(3)}%`;
}

export function makeUserDataDir(baseDir, name) {
  const dir = `${baseDir}/${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { sleep, waitFor };
