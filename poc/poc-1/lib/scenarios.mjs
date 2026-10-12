/**
 * POC-1 的四个测量场景。
 * 判定「丢失」的唯一口径：event_id 是否最终出现在 M01 的入库数据里（M01 按 app_id+event_id 去重）。
 */
import {
  beginOffline,
  browserPids,
  closeQuietly,
  drainPending,
  endOffline,
  flushOn,
  hardKill,
  killStaleBrowsers,
  launchProbeContext,
  lossOf,
  makeUserDataDir,
  openProbe,
  pocCfg,
  rate,
  readOwnStats,
  readPending,
  reconnectOn,
  readStats,
  readTrace,
  recoverOn,
  servePublicOffline,
  sleep,
  track,
  waitFor
} from './harness.mjs';
import { newEventIds } from './ids.mjs';

/**
 * 断网场景的启动参数。
 * Chromium 的 Local Network Access 检查会把「route.fulfill 出来的页面 → 另一个 loopback 端口」
 * 判成 public→loopback 而拒绝（实际报 CORS: Permission was denied for this request to access
 * the `loopback` address space）。不 fulfill 静态页时（leave 场景）没有这个问题。
 * 关掉这项检查只是让断网场景恢复和 leave 场景相同的同机 loopback 行为，与投递机制本身无关。
 */
function offlineLaunchArgs(info) {
  return info.browserName === 'chromium' ? ['--disable-features=LocalNetworkAccessChecks'] : [];
}

function counterDelta(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

function triggeredStats() {
  return {
    flush_reason_visibility: 0,
    flush_reason_pagehide: 0,
    beacon_accepted: 0,
    beacon_rejected: 0,
    batch_202: 0,
    batch_other: 0,
    batch_network_error: 0,
    recover_leader: 0,
    recover_not_leader: 0,
    recover_runs: 0,
    prewrite_ok: 0,
    prewrite_failed_quota: 0,
    dropped_critical_cap: 0,
    acked_events: 0
  };
}

function filterStats(stats) {
  const wanted = triggeredStats();
  const out = {};
  for (const k of Object.keys(wanted)) out[k] = stats[k] || 0;
  out.pending = stats.pending || 0;
  out.normal_queue = stats.normal_queue || 0;
  out.pages_with_stats = stats.pages_with_stats || 0;
  return out;
}

function summarizeTrace(trace) {
  const summary = { init: 0, flush: 0, flushByReason: {}, leader: 0, leaderGot: 0 };
  for (const t of trace) {
    if (t.k === 'init') summary.init++;
    else if (t.k === 'flush') {
      summary.flush++;
      summary.flushByReason[t.r] = (summary.flushByReason[t.r] || 0) + 1;
    } else if (t.k === 'leader') {
      summary.leader++;
      if (t.got) summary.leaderGot++;
    }
  }
  return summary;
}

/**
 * 场景 1：页面离开。
 * 四个格子 = {visibilitychange, pagehide} 触发 × {sendBeacon, fetch keepalive} 传输。
 * 每次试验同时入队 normal 与 critical；normal 只进内存队列（离开时一次机会），
 * critical 预写离线副本。
 *
 * 每次试验后立刻打开一个恢复页并排空离线副本 —— 这正是真实 SDK 在「下一次页面加载」做的事。
 * 否则离线副本会跨试验累积，离开时的载荷越滚越大（beacon 有 64KB/来源队列上限），
 * 测到的就不是「一次页面离开」而是「长期不补发的积压」，口径会失真。
 * 积压情形单独用 bulk 格子测。
 *
 * 指标：leaveFirstAttempt（离开那一次真正到达的）与 final（补发之后）。
 */
export async function scenarioLeave(ctx) {
  const cells = [
    { id: 'pagehide-beacon', trigger: 'pagehide', transport: 'beacon', leave: 'navigate' },
    { id: 'pagehide-keepalive', trigger: 'pagehide', transport: 'keepalive', leave: 'navigate' },
    { id: 'visibility-beacon', trigger: 'visibilitychange', transport: 'beacon', leave: 'hide' },
    { id: 'visibility-keepalive', trigger: 'visibilitychange', transport: 'keepalive', leave: 'hide' }
  ];
  const bulkCells = [
    { id: 'bulk-pagehide-beacon', trigger: 'pagehide', transport: 'beacon', leave: 'navigate' },
    { id: 'bulk-pagehide-keepalive', trigger: 'pagehide', transport: 'keepalive', leave: 'navigate' }
  ];
  const { trials, perClass } = ctx.params;
  const result = {
    scenario: 'leave',
    description: '页面离开：normal 只有离开那一次机会；critical 预写后可在下一次页面加载补发',
    params: {
      trials,
      perClass,
      cells: cells.map((c) => c.id),
      bulkPerTrial: ctx.params.bulkPerTrial
    },
    cells: [],
    bulkCells: []
  };

  for (const cell of cells) {
    const cellResult = await runLeaveCell(ctx, cell, trials, perClass, { bulk: false });
    result.cells.push(cellResult);
  }
  for (const cell of bulkCells) {
    const cellResult = await runLeaveCell(ctx, cell, ctx.params.bulkTrials, ctx.params.bulkPerTrial, {
      bulk: true,
      normalPerTrial: 0
    });
    result.bulkCells.push(cellResult);
  }
  return result;
}

async function runLeaveCell(ctx, cell, trials, perClass, opts = {}) {
  const normalPerTrial = opts.normalPerTrial === undefined ? perClass : opts.normalPerTrial;
  const tag = opts.bulk ? 'bulk' : 'cell';
  ctx.log(`[leave] ${tag}=${cell.id} trials=${trials} normal/trial=${normalPerTrial} critical/trial=${perClass}`);
  killStaleBrowsers(ctx.info.executablePath, ctx.log);
  const dir = makeUserDataDir(ctx.workDir, `leave-${cell.id}`);
  const countersBefore = ctx.receiver.counters();
  const expected = { normal: [], critical: [] };
  const firstAttempt = { normal: 0, critical: 0 };
  const context = await launchProbeContext(ctx.info, dir);
  let ok = 0;
  try {
    for (let trial = 0; trial < trials; trial++) {
      const normal = normalPerTrial > 0 ? newEventIds(normalPerTrial) : [];
      const critical = newEventIds(perClass);
      expected.normal.push(...normal);
      expected.critical.push(...critical);
      const { page } = await openProbe(
        context,
        ctx.baseUrl,
        pocCfg(ctx.baseUrl, ctx.receiver, {
          leader: 'none',
          autoRecover: false,
          leave: { trigger: cell.trigger, transport: cell.transport }
        })
      );
      if (normal.length > 0) await track(page, normal, 'normal');
      await track(page, critical, 'critical');

      if (cell.leave === 'navigate') {
        await page.goto(`${ctx.baseUrl}/blank.html`, { waitUntil: 'commit' }).catch(() => null);
        await sleep(80);
        await page.close().catch(() => null);
      } else {
        const other = await context.newPage();
        await other.goto(`${ctx.baseUrl}/blank.html`, { waitUntil: 'load' }).catch(() => null);
        await other.bringToFront().catch(() => null);
        await sleep(ctx.params.hideWaitMs);
        await page.close().catch(() => null);
        await other.close().catch(() => null);
      }
      // 本次试验「离开那一次」的到达情况（此时还没有任何补发）
      await sleep(250);
      const storedNow = ctx.receiver.storedIdSet();
      const nNow = lossOf(normal, storedNow);
      const cNow = lossOf(critical, storedNow);
      firstAttempt.normal += nNow.total - nNow.lost;
      firstAttempt.critical += cNow.total - cNow.lost;

      // 模拟「下一次页面加载」：立刻补发并把离线副本排空
      const { page: recoveryPage } = await openProbe(
        context,
        ctx.baseUrl,
        pocCfg(ctx.baseUrl, ctx.receiver, { leader: 'none', autoRecover: false })
      );
      await drainPending([recoveryPage], { logger: opts.bulk ? ctx.log : undefined });
      await recoveryPage.close().catch(() => null);
      await sleep(60);
      ok++;
    }
    await sleep(300);
    const stored = ctx.receiver.storedIdSet();
    const normalLoss = lossOf(expected.normal, stored);
    const criticalLoss = lossOf(expected.critical, stored);
    // 离开时一次到达率（按类）
    const firstRate = {
      normal: { total: expected.normal.length, arrived: firstAttempt.normal, lossRate: rate(expected.normal.length - firstAttempt.normal, expected.normal.length) },
      critical: { total: expected.critical.length, arrived: firstAttempt.critical, lossRate: rate(expected.critical.length - firstAttempt.critical, expected.critical.length) }
    };
    const feedback = await readFeedback(context, ctx);
    const countersAfterAll = ctx.receiver.counters();
    const delta = counterDelta(countersBefore, countersAfterAll);
    const cellResult = {
      id: cell.id,
      trigger: cell.trigger,
      transport: cell.transport,
      leave: cell.leave,
      trialsRun: ok,
      perTrial: { normal: normalPerTrial, critical: perClass },
      expected: { normal: expected.normal.length, critical: expected.critical.length },
      leaveFirstAttempt: firstRate,
      final: {
        normal: { total: normalLoss.total, stored: normalLoss.stored, lost: normalLoss.lost, lossRate: rate(normalLoss.lost, normalLoss.total) },
        critical: { total: criticalLoss.total, stored: criticalLoss.stored, lost: criticalLoss.lost, lossRate: rate(criticalLoss.lost, criticalLoss.total) }
      },
      receiverCountersDelta: delta,
      duplicateEvents: delta.duplicate_events || 0,
      storedEvents: delta.stored_events || 0,
      pageStats: feedback.pageStats,
      hooksFired: {
        trigger: cell.trigger,
        flushedVisibility: feedback.stats.flush_reason_visibility || 0,
        flushedPagehide: feedback.stats.flush_reason_pagehide || 0,
        expectedOnePerTrial: trials,
        firedAllTrials:
          cell.trigger === 'pagehide'
            ? (feedback.stats.flush_reason_pagehide || 0) >= trials
            : (feedback.stats.flush_reason_visibility || 0) >= trials
      },
      traceSummary: feedback.traceSummary,
      drainPasses: feedback.drainPasses
    };
    ctx.log(
      `  离开时一次到达 normal=${firstRate.normal.arrived}/${firstRate.normal.total}（丢 ${firstRate.normal.lossRate * 100}%）；` +
        `critical=${firstRate.critical.arrived}/${firstRate.critical.total}（丢 ${firstRate.critical.lossRate * 100}%）；` +
        `最终 normal 丢 ${normalLoss.lost}/${normalLoss.total}，critical 丢 ${criticalLoss.lost}/${criticalLoss.total}；` +
        `重复 ${delta.duplicate_events || 0}`
    );
    return cellResult;
  } finally {
    await closeQuietly(context);
  }
}

/** 从最后打开的恢复页读回聚合统计与 trace。 */
async function readFeedback(context, ctx) {
  const { page } = await openProbe(
    context,
    ctx.baseUrl,
    pocCfg(ctx.baseUrl, ctx.receiver, { leader: 'none', autoRecover: false })
  );
  const stats = await readStats(page);
  const trace = await readTrace(page);
  const pendingBefore = await readPending(page);
  const drainPasses = await drainPending([page], {});
  await page.close().catch(() => null);
  return { stats, traceSummary: summarizeTrace(trace), pageStats: filterStats(stats), pendingBefore: pendingBefore.length, drainPasses };
}
/**
 * 场景 2：浏览器强杀。
 * 关闭钩子全部关掉（leave.trigger = none），隔离「预写是否真的落盘」：
 * normal 只存在内存里，强杀必丢；critical 已同步写入 localStorage，重启后应能补发。
 */
export async function scenarioKill(ctx) {
  const variants = [
    { id: 'page-close', kill: 'page', delayMs: 0 },
    { id: 'context-close', kill: 'context', delayMs: 0 },
    { id: 'browser-close', kill: 'browser', delayMs: 0 },
    { id: 'sigkill-immediate', kill: 'sigkill', delayMs: 0 },
    { id: 'sigkill-250ms', kill: 'sigkill', delayMs: 250 },
    { id: 'sigkill-1000ms', kill: 'sigkill', delayMs: 1000 },
    { id: 'sigkill-2500ms', kill: 'sigkill', delayMs: 2500 },
    { id: 'sigkill-4000ms', kill: 'sigkill', delayMs: 4000 },
    { id: 'sigkill-5000ms', kill: 'sigkill', delayMs: 5000 }
  ];
  const { trials, perClass } = ctx.params;
  const result = {
    scenario: 'kill',
    description: '浏览器强杀：不触发任何离开钩子，纯测 critical 预写的落盘存活与重启补发',
    params: { trials, perClass, variants: variants.map((v) => v.id) },
    cells: []
  };

  for (const variant of variants) {
    ctx.log(`[kill] variant=${variant.id} trials=${trials} perClass=${perClass}`);
    killStaleBrowsers(ctx.info.executablePath, ctx.log);
    const dir = makeUserDataDir(ctx.workDir, `kill-${variant.id}`);
    const countersBefore = ctx.receiver.counters();
    const expected = { normal: [], critical: [] };
    let killMode = null;
    let ok = 0;
    let survivorsTotal = 0;

    for (let trial = 0; trial < trials; trial++) {
      const normal = newEventIds(perClass);
      const critical = newEventIds(perClass);
      expected.normal.push(...normal);
      expected.critical.push(...critical);

      const pidsBefore = browserPids(ctx.info.executablePath);
      const context = await launchProbeContext(ctx.info, dir);
      const { page } = await openProbe(
        context,
        ctx.baseUrl,
        pocCfg(ctx.baseUrl, ctx.receiver, { leader: 'none', autoRecover: false })
      );
      await track(page, normal, 'normal');
      await track(page, critical, 'critical');
      if (variant.delayMs > 0) await sleep(variant.delayMs);

      if (variant.kill === 'page') {
        await page.close().catch(() => null);
        killMode = 'page.close()';
        await closeQuietly(context);
      } else if (variant.kill === 'context') {
        await closeQuietly(context);
        killMode = 'context.close()';
      } else if (variant.kill === 'browser') {
        try {
          await context.browser().close();
          killMode = 'browser.close()';
        } catch {
          killMode = 'browser.close()（抛错）';
        }
      } else {
        const killed = await hardKill(context, ctx.info, { signal: 'SIGKILL', pidsBefore });
        killMode = killed.mode;
      }

      // 重启同一 profile：先读离线副本存活数，再补发
      await sleep(150);
      let context2;
      try {
        context2 = await launchProbeContext(ctx.info, dir);
      } catch (err) {
        ctx.log(`  重启失败，清理 Singleton 锁后重试：${String(err && err.message).split('\n')[0]}`);
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          try {
            const fs = await import('node:fs');
            fs.rmSync(`${dir}/${f}`, { force: true });
          } catch {
            /* ignore */
          }
        }
        context2 = await launchProbeContext(ctx.info, dir);
      }
      const { page: page2 } = await openProbe(
        context2,
        ctx.baseUrl,
        pocCfg(ctx.baseUrl, ctx.receiver, { leader: 'none', autoRecover: false })
      );
      const pendingAfterRestart = await readPending(page2);
      const expectedSet = new Set(critical);
      survivorsTotal += pendingAfterRestart.filter((id) => expectedSet.has(id)).length;
      await drainPending([page2], { logger: ctx.log });
      await sleep(120);
      await closeQuietly(context2);
      ok++;
    }

    const stored = ctx.receiver.storedIdSet();
    const normalLoss = lossOf(expected.normal, stored);
    const criticalLoss = lossOf(expected.critical, stored);
    const countersAfter = ctx.receiver.counters();
    result.cells.push({
      id: variant.id,
      killMode,
      delayMs: variant.delayMs,
      trialsRun: ok,
      expected: { normal: expected.normal.length, critical: expected.critical.length },
      prewriteSurvival: {
        survived: survivorsTotal,
        lost: expected.critical.length - survivorsTotal,
        total: expected.critical.length,
        lossRate: rate(expected.critical.length - survivorsTotal, expected.critical.length)
      },
      final: {
        normal: { total: normalLoss.total, stored: normalLoss.stored, lost: normalLoss.lost, lossRate: rate(normalLoss.lost, normalLoss.total) },
        critical: { total: criticalLoss.total, stored: criticalLoss.stored, lost: criticalLoss.lost, lossRate: rate(criticalLoss.lost, criticalLoss.total) }
      },
      receiverCountersDelta: counterDelta(countersBefore, countersAfter)
    });
    ctx.log(
      `  预写存活 ${survivorsTotal}/${expected.critical.length}；最终 normal 丢失 ${normalLoss.lost}/${normalLoss.total}，` +
        `critical 丢失 ${criticalLoss.lost}/${criticalLoss.total}`
    );
  }
  return result;
}

/**
 * 场景 3：断网。
 * variant A：同一页断网入队 → 恢复网络 → 补发（normal 在内存里，critical 在离线副本里）
 * variant B：断网入队 → 断网状态下刷新页面 → 恢复网络 → 补发（normal 随页面销毁丢失）
 */
export async function scenarioOffline(ctx) {
  const variants = [
    { id: 'offline-same-page', reload: false },
    { id: 'offline-reload', reload: true }
  ];
  const { trials, perClass } = ctx.params;
  const result = {
    scenario: 'offline',
    description: '断网：context.setOffline(true) 期间入队，恢复网络后补发',
    params: { trials, perClass, variants: variants.map((v) => v.id) },
    cells: []
  };

  for (const variant of variants) {
    ctx.log(`[offline] variant=${variant.id} trials=${trials} perClass=${perClass}`);
    killStaleBrowsers(ctx.info.executablePath, ctx.log);
    const dir = makeUserDataDir(ctx.workDir, `offline-${variant.id}`);
    const countersBefore = ctx.receiver.counters();
    const expected = { normal: [], critical: [] };
    const context = await launchProbeContext(ctx.info, dir, { args: offlineLaunchArgs(ctx.info) });
    if (ctx.info.browserName === 'chromium') await servePublicOffline(context, ctx.baseUrl);
    const offlineMode = await beginOffline(context, ctx.info);
    const offlineArrived = { normal: 0, critical: 0 };
    let onlineAutoRuns = 0;
    let ok = 0;
    try {
      for (let trial = 0; trial < trials; trial++) {
        const normal = newEventIds(perClass);
        const critical = newEventIds(perClass);
        expected.normal.push(...normal);
        expected.critical.push(...critical);

        // 每一轮都要重新进入断网：endOffline 在轮末调用过，否则第 2 轮起就是在线的
        await beginOffline(context, ctx.info);
        const { page } = await openProbe(
          context,
          ctx.baseUrl,
          pocCfg(ctx.baseUrl, ctx.receiver, { leader: 'none', autoRecover: true })
        );
        await track(page, normal, 'normal');
        await track(page, critical, 'critical');
        // 断网期间走一次常规通道，必然失败（这是真实链路的行为）
        await flushOn(page, 'offline-attempt', 'fetch').catch(() => null);
        await sleep(150);
        const storedOffline = ctx.receiver.storedIdSet();
        const nOff = lossOf(normal, storedOffline);
        const cOff = lossOf(critical, storedOffline);
        offlineArrived.normal += nOff.total - nOff.lost;
        offlineArrived.critical += cOff.total - cOff.lost;

        if (variant.reload) {
          await page.reload({ waitUntil: 'load' });
          await page.waitForFunction(() => window.__pocReady === true);
          // 断网状态下重新初始化：这一步会尝试一次补发（失败）
          await page.evaluate(
            (c) => window.__poc.init(c),
            pocCfg(ctx.baseUrl, ctx.receiver, { leader: 'none', autoRecover: true })
          );
        }
        const runsBeforeOnline = (await readStats(page)).recover_runs;
        await endOffline(context, ctx.info);
        await sleep(ctx.params.onlineWaitMs);
        onlineAutoRuns += (await readStats(page)).recover_runs - runsBeforeOnline;
        // Chromium 有 online 事件会自动走一遍；这里再显式走一遍，保证两种浏览器口径一致
        await reconnectOn(page).catch(() => null);
        await sleep(120);
        await page.close().catch(() => null);
        ok++;
      }
    } finally {
      await closeQuietly(context);
    }

    const stored = ctx.receiver.storedIdSet();
    const normalLoss = lossOf(expected.normal, stored);
    const criticalLoss = lossOf(expected.critical, stored);
    result.cells.push({
      id: variant.id,
      reloadWhileOffline: variant.reload,
      trialsRun: ok,
      expected: { normal: expected.normal.length, critical: expected.critical.length },
      offlineMode,
      offlineArrived,
      onlineAutoRecoverRuns: onlineAutoRuns,
      note:
        ctx.info.browserName === 'chromium'
          ? 'Chromium 用 context.setOffline(true)，恢复时触发 online 事件；页面本身由 route fulfill 供给'
          : `${ctx.info.browserName} 用「上报端点不可达」代替 navigator.onLine=false，没有 online 事件，补发由脚本显式触发`,
      final: {
        normal: { total: normalLoss.total, stored: normalLoss.stored, lost: normalLoss.lost, lossRate: rate(normalLoss.lost, normalLoss.total) },
        critical: { total: criticalLoss.total, stored: criticalLoss.stored, lost: criticalLoss.lost, lossRate: rate(criticalLoss.lost, criticalLoss.total) }
      },
      receiverCountersDelta: counterDelta(countersBefore, ctx.receiver.counters())
    });
    ctx.log(
      `  断网期间到达 normal=${offlineArrived.normal} critical=${offlineArrived.critical}（条）；` +
        `最终 normal 丢失 ${normalLoss.lost}/${normalLoss.total}，critical 丢失 ${criticalLoss.lost}/${criticalLoss.total}`
    );
  }
  return result;
}
/**
 * 场景 4：多标签页。
 * 同一 context 下 3 个标签页在断网期间各自预写 critical（同一个 localStorage 离线副本，跨标签共享），
 * 恢复网络后 3 个标签页同时补发，比较选主方式造成的重复补发。
 */
export async function scenarioMultitab(ctx) {
  const variants = [
    { id: 'weblocks', leader: 'locks', bcSettleMs: 0 },
    { id: 'broadcastchannel-150ms', leader: 'bc', bcSettleMs: 150 },
    { id: 'broadcastchannel-10ms', leader: 'bc', bcSettleMs: 10 },
    { id: 'broadcastchannel-0ms', leader: 'bc', bcSettleMs: 0 },
    { id: 'no-election', leader: 'none', bcSettleMs: 0 }
  ];
  const { rounds, perClass, tabs } = ctx.params;
  const result = {
    scenario: 'multitab',
    description: '多标签页：3 个标签页共享离线副本，同时补发',
    params: { rounds, perClass, tabs, variants: variants.map((v) => v.id) },
    cells: []
  };

  for (const variant of variants) {
    ctx.log(`[multitab] variant=${variant.id} rounds=${rounds} tabs=${tabs} perClass=${perClass}`);
    killStaleBrowsers(ctx.info.executablePath, ctx.log);
    const dir = makeUserDataDir(ctx.workDir, `multitab-${variant.id}`);
    const countersBefore = ctx.receiver.counters();
    const expected = { normal: [], critical: [] };
    const context = await launchProbeContext(ctx.info, dir, { args: offlineLaunchArgs(ctx.info) });
    if (ctx.info.browserName === 'chromium') await servePublicOffline(context, ctx.baseUrl);
    const offlineMode = await beginOffline(context, ctx.info);
    const perRound = [];
    let ok = 0;
    try {
      for (let round = 0; round < rounds; round++) {
        // 每一轮重新进入断网（上一轮 endOffline 已经恢复了）
        await beginOffline(context, ctx.info);
        const pages = [];
        const roundExpected = { normal: [], critical: [] };
        for (let t = 0; t < tabs; t++) {
          const { page } = await openProbe(
            context,
            ctx.baseUrl,
            pocCfg(ctx.baseUrl, ctx.receiver, {
              leader: variant.leader,
              bcSettleMs: variant.bcSettleMs,
              autoRecover: false
            })
          );
          const normal = newEventIds(perClass);
          const critical = newEventIds(perClass);
          roundExpected.normal.push(...normal);
          roundExpected.critical.push(...critical);
          expected.normal.push(...normal);
          expected.critical.push(...critical);
          await track(page, normal, 'normal');
          await track(page, critical, 'critical');
          pages.push(page);
        }
        const countersWave1Before = ctx.receiver.counters();
        await endOffline(context, ctx.info);
        const recoverResults = await Promise.all(
          pages.map((p) =>
            p
              .evaluate(() =>
                Promise.all([
                  // online 冲刷只发本标签页内存里的 normal；离线副本由选主后的 recover 负责，
                  // 否则 flush 本身就会重复发送离线副本，测不出选主的作用。
                  window.__poc.flush('online', 'fetch', { includeCritical: false }),
                  window.__poc.recover()
                ])
              )
              .catch((err) => ({ error: String(err && err.message) }))
          )
        );
        await sleep(250);
        const countersWave1After = ctx.receiver.counters();
        const drain = await drainPending(pages, { logger: ctx.log });
        await sleep(120);
        const leaders = await Promise.all(
          pages.map((p) =>
            readOwnStats(p).then((s) => ({
              tabId: s.tab_id,
              runs: s.recover_runs,
              leader: s.recover_leader,
              notLeader: s.recover_not_leader,
              pending: s.pending
            }))
          )
        );
        perRound.push({
          round,
          wave1Duplicates: (countersWave1After.duplicate_events || 0) - (countersWave1Before.duplicate_events || 0),
          wave1Stored: (countersWave1After.stored_events || 0) - (countersWave1Before.stored_events || 0),
          expected: { normal: roundExpected.normal.length, critical: roundExpected.critical.length },
          leaders,
          drain
        });
        for (const p of pages) await p.close().catch(() => null);
        ok++;
      }
    } finally {
      await closeQuietly(context);
    }
    const countersAfter = ctx.receiver.counters();
    const delta = counterDelta(countersBefore, countersAfter);
    const stored = ctx.receiver.storedIdSet();
    const normalLoss = lossOf(expected.normal, stored);
    const criticalLoss = lossOf(expected.critical, stored);
    const wave1Dup = perRound.reduce((a, r) => a + r.wave1Duplicates, 0);
    const wave1Stored = perRound.reduce((a, r) => a + r.wave1Stored, 0);
    result.cells.push({
      id: variant.id,
      leader: variant.leader,
      bcSettleMs: variant.bcSettleMs,
      roundsRun: ok,
      expected: { normal: expected.normal.length, critical: expected.critical.length },
      wave1: { duplicateEvents: wave1Dup, storedEvents: wave1Stored },
      totalDuplicates: delta.duplicate_events || 0,
      totalStored: delta.stored_events || 0,
      duplicateRateWave1: wave1Stored > 0 ? wave1Dup / wave1Stored : 0,
      duplicateRatePerCritical: expected.critical.length > 0 ? wave1Dup / expected.critical.length : 0,
      leadersWave1: perRound.reduce(
        (a, r) => ({
          leaders: a.leaders + r.leaders.filter((l) => l.leader > 0).length,
          notLeaders: a.notLeaders + r.leaders.filter((l) => l.notLeader > 0).length
        }),
        { leaders: 0, notLeaders: 0 }
      ),
      duplicateRateTotal:
        (delta.stored_events || 0) + (delta.duplicate_events || 0) > 0
          ? (delta.duplicate_events || 0) / ((delta.stored_events || 0) + (delta.duplicate_events || 0))
          : 0,
      final: {
        normal: { total: normalLoss.total, stored: normalLoss.stored, lost: normalLoss.lost, lossRate: rate(normalLoss.lost, normalLoss.total) },
        critical: { total: criticalLoss.total, stored: criticalLoss.stored, lost: criticalLoss.lost, lossRate: rate(criticalLoss.lost, criticalLoss.total) }
      },
      receiverCountersDelta: delta,
      perRound
    });
    ctx.log(
      `  首轮并发重复 ${wave1Dup} / 入库 ${wave1Stored}；critical 丢失 ${criticalLoss.lost}/${criticalLoss.total}，` +
        `normal 丢失 ${normalLoss.lost}/${normalLoss.total}`
    );
  }
  return result;
}

export { waitFor };
