/**
 * POC-1 追加轮：离线副本存储的落盘窗口 / 跨标签页 / 配额与写入耗时。
 *
 * 与 POC-1 完全同口径：确定性 event_id、以 M01 入库明细判丢失、`leave.trigger = none`、
 * 真 SIGKILL（Chromium 用 CDP 取 PID，Firefox/WebKit 用 pgrep），只把存储实现换掉。
 */
import {
  awaitDurable,
  beginOffline,
  browserPids,
  closeQuietly,
  drainPending,
  endOffline,
  estimateStorage,
  hardKill,
  killStaleBrowsers,
  launchProbeContext,
  lossOf,
  makeUserDataDir,
  openProbe,
  pocCfg,
  quotaFailureInjection,
  quotaProbe,
  rate,
  readPending,
  storeInfo,
  storageBench,
  track
} from './harness.mjs';
import { newEventIds } from './ids.mjs';

function delta(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

function percentiles(values) {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    min: Number(sorted[0].toFixed(2)),
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

/**
 * 场景 S-1：硬杀落盘窗口。
 * 每个「存储 × Δt」格子：2 次试验 × 500 条 critical = 1000 条样本，
 * 每次试验：预写 → 等落盘点 → 等 Δt → SIGKILL → 同一 profile 重启 → 读回离线副本。
 */
export async function scenarioStorageKill(ctx) {
  const { storages, controls, deltas, trials, perClass, durableTimeoutMs } = ctx.params;
  const cells = [];
  for (const storage of storages) {
    for (const deltaMs of deltas) cells.push({ storage, deltaMs });
  }
  for (const control of controls) {
    for (const deltaMs of control.deltas) {
      cells.push({ storage: control.storage, deltaMs, control: true, controlNote: control.note });
    }
  }

  const result = {
    scenario: 'storage',
    description: '硬杀落盘窗口：预写到达各自存储定义的「落盘点」后，等 Δt 再 SIGKILL，重启读回离线副本',
    params: { storages, controls, deltas, trials, perClass, durableTimeoutMs },
    cells: []
  };

  for (const cell of cells) {
    const tag = `${cell.storage}@${cell.deltaMs}ms`;
    ctx.log(`[storage] ${tag} trials=${trials} perClass=${perClass}`);
    killStaleBrowsers(ctx.info.executablePath, ctx.log);
    const dir = makeUserDataDir(ctx.workDir, `storage-${cell.storage}-${cell.deltaMs}`);
    const countersBefore = ctx.receiver.counters();
    const expected = [];
    let survivedTotal = 0;
    const writeInfos = [];
    let killMode = null;
    let info = null;
    let ok = 0;

    for (let trial = 0; trial < trials; trial++) {
      const critical = newEventIds(perClass);
      expected.push(...critical);
      const pidsBefore = browserPids(ctx.info.executablePath);
      const context = await launchProbeContext(ctx.info, dir);
      const { page } = await openProbe(
        context,
        ctx.baseUrl,
        pocCfg(ctx.baseUrl, ctx.receiver, {
          leader: 'none',
          autoRecover: false,
          leave: { trigger: 'none', transport: 'beacon' },
          storage: cell.storage
        })
      );
      if (!info) info = await storeInfo(page);
      await track(page, critical, 'critical');
      const durable = await awaitDurable(page, durableTimeoutMs);
      writeInfos.push(durable);
      // Δt 从「落盘点确认」之后开始计（对照组没有落盘点，则从等待超时之后计）
      if (cell.deltaMs > 0) await new Promise((r) => setTimeout(r, cell.deltaMs));
      const killed = await hardKill(context, ctx.info, { signal: 'SIGKILL', pidsBefore });
      killMode = killed.mode;

      // 同一 profile 重启，读回离线副本
      await new Promise((r) => setTimeout(r, 150));
      let context2;
      try {
        context2 = await launchProbeContext(ctx.info, dir);
      } catch (err) {
        ctx.log(`  重启失败，清理锁后重试：${String(err && err.message).split('\n')[0]}`);
        const fs = await import('node:fs');
        for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(`${dir}/${f}`, { force: true });
        await new Promise((r) => setTimeout(r, 800));
        context2 = await launchProbeContext(ctx.info, dir);
      }
      const { page: page2 } = await openProbe(
        context2,
        ctx.baseUrl,
        pocCfg(ctx.baseUrl, ctx.receiver, {
          leader: 'none',
          autoRecover: false,
          leave: { trigger: 'none', transport: 'beacon' },
          storage: cell.storage
        })
      );
      const readable = await readPending(page2);
      const expectedSet = new Set(critical);
      survivedTotal += readable.filter((id) => expectedSet.has(id)).length;
      await drainPending([page2], {});
      await closeQuietly(context2);
      ok++;
    }

    const stored = ctx.receiver.storedIdSet();
    const loss = lossOf(expected, stored);
    const deltaCounters = delta(countersBefore, ctx.receiver.counters());
    result.cells.push({
      id: tag,
      storage: cell.storage,
      deltaMs: cell.deltaMs,
      control: !!cell.control,
      controlNote: cell.controlNote || null,
      trialsRun: ok,
      killMode,
      expected: expected.length,
      survived: survivedTotal,
      survivalRate: expected.length > 0 ? survivedTotal / expected.length : 0,
      lossRate: rate(loss.lost, loss.total),
      finalLost: loss.lost,
      finalTotal: loss.total,
      writeInfo: writeInfos,
      durableResolved: writeInfos.filter((w) => w.resolved).length,
      storeInfo: info,
      receiverCountersDelta: deltaCounters
    });
    ctx.log(
      `  落盘点 ${writeInfos.filter((w) => w.resolved).length}/${writeInfos.length} 次成功；` +
        `重启后存活 ${survivedTotal}/${expected.length}（丢 ${loss.lost}）`
    );
  }
  return result;
}

/**
 * 场景 S-2：跨标签页并发写同一个离线副本。
 * 3 个标签页同时预写（不做任何跨页协调），看有多少条在「并发读改写」里被覆盖。
 */
export async function scenarioStorageMultitab(ctx) {
  const { storages, rounds, tabs, perClass } = ctx.params;
  const result = {
    scenario: 'storage-multitab',
    description: '跨标签页并发写离线副本：3 个标签页同时预写，统计被覆盖的条数与最终丢失',
    params: { storages, rounds, tabs, perClass },
    cells: []
  };

  for (const storage of storages) {
    ctx.log(`[storage-multitab] storage=${storage} rounds=${rounds} tabs=${tabs} perClass=${perClass}`);
    killStaleBrowsers(ctx.info.executablePath, ctx.log);
    const dir = makeUserDataDir(ctx.workDir, `storage-mt-${storage}`);
    const countersBefore = ctx.receiver.counters();
    const expected = [];
    const perRound = [];
    const context = await launchProbeContext(ctx.info, dir);
    let info = null;
    let ok = 0;
    try {
      for (let round = 0; round < rounds; round++) {
        const pages = [];
        const roundExpected = [];
        for (let t = 0; t < tabs; t++) {
          const { page } = await openProbe(
            context,
            ctx.baseUrl,
            pocCfg(ctx.baseUrl, ctx.receiver, {
              leader: 'none',
              autoRecover: false,
              leave: { trigger: 'none', transport: 'beacon' },
              storage
            })
          );
          if (!info) info = await storeInfo(page);
          pages.push(page);
        }
        const perTabIds = pages.map(() => newEventIds(perClass));
        perTabIds.forEach((ids) => {
          roundExpected.push(...ids);
          expected.push(...ids);
        });
        // 并发写：三个标签页同时开始
        await Promise.all(pages.map((p, i) => track(p, perTabIds[i], 'critical')));
        const durables = await Promise.all(pages.map((p) => awaitDurable(p, 4000)));
        await new Promise((r) => setTimeout(r, 200));
        const readable = new Set(await readPending(pages[0]));
        const visible = roundExpected.filter((id) => readable.has(id)).length;
        await drainPending(pages, {});
        await new Promise((r) => setTimeout(r, 100));
        perRound.push({
          round,
          expected: roundExpected.length,
          visibleInStore: visible,
          overwritten: roundExpected.length - visible,
          durables
        });
        for (const p of pages) await p.close().catch(() => null);
        ok++;
      }
    } finally {
      await closeQuietly(context);
    }
    const stored = ctx.receiver.storedIdSet();
    const loss = lossOf(expected, stored);
    const visibleTotal = perRound.reduce((a, r) => a + r.visibleInStore, 0);
    result.cells.push({
      id: storage,
      storage,
      roundsRun: ok,
      expected: expected.length,
      visibleInStore: visibleTotal,
      overwritten: expected.length - visibleTotal,
      overwriteRate: expected.length > 0 ? (expected.length - visibleTotal) / expected.length : 0,
      finalLost: loss.lost,
      finalLossRate: rate(loss.lost, loss.total),
      storeInfo: info,
      perRound,
      receiverCountersDelta: delta(countersBefore, ctx.receiver.counters())
    });
    ctx.log(
      `  离线副本可见 ${visibleTotal}/${expected.length}（被覆盖 ${expected.length - visibleTotal}）；最终丢失 ${loss.lost}`
    );
  }
  return result;
}

/**
 * 场景 S-3：写入耗时（落盘点延迟）与配额。
 */
export async function scenarioStoragePerf(ctx) {
  const { storages, benchRecords, benchBatch } = ctx.params;
  const result = {
    scenario: 'storage-perf',
    description: '写入耗时（到各自落盘点的延迟）与配额估算',
    params: { storages, benchRecords, benchBatch },
    cells: []
  };

  for (const storage of storages) {
    ctx.log(`[storage-perf] storage=${storage} bench=${benchRecords}/${benchBatch}`);
    killStaleBrowsers(ctx.info.executablePath, ctx.log);
    const dir = makeUserDataDir(ctx.workDir, `storage-perf-${storage}`);
    const context = await launchProbeContext(ctx.info, dir);
    try {
      const { page } = await openProbe(
        context,
        ctx.baseUrl,
        pocCfg(ctx.baseUrl, ctx.receiver, {
          leader: 'none',
          autoRecover: false,
          leave: { trigger: 'none', transport: 'beacon' },
          storage
        })
      );
      const info = await storeInfo(page);
      const estimate = await estimateStorage(page);
      const quota = await quotaProbe(page);
      const quotaInjection = await quotaFailureInjection(page, 10);
      let bench = [];
      let benchError = null;
      try {
        bench = await storageBench(page, benchRecords, benchBatch);
      } catch (err) {
        benchError = String(err && err.message);
      }
      const estimateAfterBench = await estimateStorage(page);
      // 单条 critical 的落盘延迟（真实路径）
      const single = [];
      for (let i = 0; i < 20; i++) {
        const ids = newEventIds(1);
        await track(page, ids, 'critical');
        const d = await awaitDurable(page, 4000);
        single.push(d.ms);
      }
      result.cells.push({
        id: storage,
        storage,
        storeInfo: info,
        estimate,
        estimateAfterBench,
        quotaProbe: quota,
        quotaInjection,
        benchBatchMs: percentiles(bench),
        benchRawMs: bench.map((x) => Number(x.toFixed(2))),
        benchError,
        singleWriteMs: percentiles(single)
      });
      ctx.log(
        `  批写 p50=${percentiles(bench).p50}ms p95=${percentiles(bench).p95}ms；单条落盘 p50=${percentiles(single).p50}ms；` +
          `quota=${estimate ? Math.round((estimate.quota || 0) / 1048576) + 'MB' : 'n/a'}`
      );
    } finally {
      await closeQuietly(context);
    }
  }
  return result;
}

export { beginOffline, endOffline };
