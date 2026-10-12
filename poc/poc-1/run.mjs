#!/usr/bin/env node
/**
 * POC-1（T02）测量入口。
 *
 * 一条命令复现报告里的全部数字：
 *   node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs --browser chromium --scenario all
 *
 * 接收端固定复用 M01（tools/mock-receiver）；浏览器固定走 127.0.0.1 本地页与本地 mock，
 * 不连接任何共享环境或真实网络。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describeDriver, resolveDriver } from './lib/driver.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { protocolProblems, startPocReceiver } from './lib/receiver.mjs';
import { resetIds } from './lib/ids.mjs';
import { scenarioKill, scenarioLeave, scenarioMultitab, scenarioOffline } from './lib/scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const PRESETS = {
  full: {
    leave: { trials: 10, perClass: 100, hideWaitMs: 500, bulkTrials: 3, bulkPerTrial: 1000 },
    kill: { trials: 5, perClass: 200 },
    offline: { trials: 10, perClass: 100, onlineWaitMs: 1500 },
    multitab: { rounds: 10, tabs: 3, perClass: 50 }
  },
  quick: {
    leave: { trials: 2, perClass: 10, hideWaitMs: 400, bulkTrials: 1, bulkPerTrial: 40 },
    kill: { trials: 1, perClass: 20 },
    offline: { trials: 1, perClass: 20, onlineWaitMs: 800 },
    multitab: { rounds: 1, tabs: 3, perClass: 10 }
  }
};

function parseArgs(argv) {
  const args = { browser: 'chromium', scenario: 'all', preset: 'full', out: path.join(HERE, 'results'), driver: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--browser') args.browser = next();
    else if (a === '--scenario') args.scenario = next();
    else if (a === '--preset') args.preset = next();
    else if (a === '--out') args.out = next();
    else if (a === '--driver') args.driver = next();
    else if (a === '--help') args.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return args;
}

function usage() {
  return [
    '用法：node --import ./poc/poc-1/lib/register.mjs poc/poc-1/run.mjs [选项]',
    '  --browser  chromium|firefox|webkit|all   （默认 chromium）',
    '  --scenario leave|kill|offline|multitab|all（默认 all）',
    '  --preset   full|quick                     （默认 full；quick 只用于冒烟）',
    '  --out      <目录>                         （默认 poc/poc-1/results）',
    '  --driver   <候选驱动 id>                  （默认按 revision 精确配对自动选择）'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const preset = PRESETS[args.preset];
  if (!preset) throw new Error(`未知 preset：${args.preset}`);

  const browsers = args.browser === 'all' ? ['chromium', 'firefox', 'webkit'] : [args.browser];
  const scenarios = args.scenario === 'all' ? ['leave', 'kill', 'offline', 'multitab'] : [args.scenario];
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(args.out, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, 'profiles');
  fs.mkdirSync(workDir, { recursive: true });

  const lines = [];
  const log = (m) => {
    console.log(m);
    lines.push(m);
  };

  const staticServer = await startStaticServer();
  const receiver = await startPocReceiver();
  log(`M01 mock 接收端：${receiver.baseUrl}（只监听 127.0.0.1）`);
  log(`本地探针页：${staticServer.url}/probe.html`);

  const run = {
    runId,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpuCount: os.cpus().length,
    preset: args.preset,
    scenarios,
    staticServer: staticServer.url,
    receiver: receiver.baseUrl,
    browsers: []
  };

  try {
    for (const browserName of browsers) {
      resetIds();
      const entry = { browser: browserName, status: 'pending', scenarios: {} };
      run.browsers.push(entry);
      let info;
      try {
        info = await resolveDriver(browserName, { preferDriver: args.driver ?? undefined });
      } catch (err) {
        entry.status = 'failed';
        entry.error = `驱动/浏览器配对失败：${String(err && err.message)}`;
        log(`[${browserName}] 跳过：${entry.error}`);
        continue;
      }
      entry.driver = {
        id: info.driverId,
        note: info.driverNote,
        revision: info.revision,
        executablePath: info.executablePath,
        notes: info.notes
      };
      log(`[${browserName}] ${describeDriver(info)}`);
      try {
        const { killStaleBrowsers } = await import('./lib/harness.mjs');
        killStaleBrowsers(info.executablePath, log);
      } catch {
        /* ignore */
      }
      for (const n of info.notes) log(`[${browserName}] 注意：${n}`);

      // 冒烟：确认浏览器能起来并报版本（残留进程偶发干扰，失败重试一次）
      const { launchProbeContext, closeQuietly, killStaleBrowsers } = await import('./lib/harness.mjs');
      let smokeAttempt = 0;
      const smokeOnce = async () => {
        const smokeDir = path.join(workDir, `${browserName}-smoke-${smokeAttempt}`);
        const ctx = await launchProbeContext(info, smokeDir);
        entry.browserVersion = ctx.browser() ? ctx.browser().version() : 'unknown';
        const page = await ctx.newPage();
        await page.goto(`${staticServer.url}/probe.html`, { waitUntil: 'load' });
        entry.userAgent = await page.evaluate(() => navigator.userAgent);
        entry.features = await page.evaluate(() => ({
          sendBeacon: typeof navigator.sendBeacon === 'function',
          fetchKeepalive: typeof Request === 'function' && 'keepalive' in Request.prototype,
          webLocks: !!(navigator.locks && navigator.locks.request),
          broadcastChannel: typeof BroadcastChannel === 'function',
          localStorage: typeof localStorage !== 'undefined'
        }));
        await closeQuietly(ctx);
      };
      try {
        smokeAttempt = 1;
        try {
          await smokeOnce();
        } catch (err) {
          log(`[${browserName}] 首次冒烟失败（${String(err && err.message).split('\n')[0]}），清理后重试`);
          killStaleBrowsers(info.executablePath, log);
          await new Promise((r) => setTimeout(r, 1500));
          smokeAttempt = 2;
          entry.browserVersion = undefined;
          entry.userAgent = undefined;
          entry.features = undefined;
          await smokeOnce();
        }
        log(
          `[${browserName}] 版本 ${entry.browserVersion}；特性 ${JSON.stringify(entry.features)}`
        );
      } catch (err) {
        entry.status = 'failed';
        entry.error = `浏览器启动/冒烟失败：${String(err && err.message).split('\n').slice(0, 3).join(' | ')}`;
        log(`[${browserName}] 跳过：${entry.error}`);
        continue;
      }

      entry.status = 'ok';
      for (const scenarioName of scenarios) {
        const params = preset[scenarioName];
        const countersBefore = receiver.counters();
        const t0 = Date.now();
        let result;
        try {
          const ctx = { info, baseUrl: staticServer.url, receiver, workDir, log, params };
          if (scenarioName === 'leave') result = await scenarioLeave(ctx);
          else if (scenarioName === 'kill') result = await scenarioKill(ctx);
          else if (scenarioName === 'offline') result = await scenarioOffline(ctx);
          else result = await scenarioMultitab(ctx);
        } catch (err) {
          result = {
            scenario: scenarioName,
            error: String(err && err.stack ? err.stack : err),
            params
          };
          log(`[${browserName}/${scenarioName}] 运行失败：${String(err && err.message)}`);
        }
        const after = receiver.counters();
        result.driver = entry.driver;
        result.browserVersion = entry.browserVersion;
        result.durationMs = Date.now() - t0;
        result.receiverCountersDelta = {};
        for (const k of Object.keys(after)) {
          const d = (after[k] || 0) - (countersBefore[k] || 0);
          if (d !== 0) result.receiverCountersDelta[k] = d;
        }
        result.protocolProblems = protocolProblems(result.receiverCountersDelta);
        if (Object.keys(result.protocolProblems).length > 0) {
          log(`[${browserName}/${scenarioName}] 警告：接收端出现被拒批次 ${JSON.stringify(result.protocolProblems)}（测量口径可能被污染）`);
        }
        entry.scenarios[scenarioName] = result;
        fs.writeFileSync(path.join(outDir, `${browserName}-${scenarioName}.json`), JSON.stringify(result, null, 2));
        log(`[${browserName}/${scenarioName}] 用时 ${(result.durationMs / 1000).toFixed(1)}s`);
      }
      // 换浏览器前清空接收端数据，避免内存膨胀；事件 id 全run唯一，不影响已算出的结果
      receiver.clearEvents();
      receiver.clearCounters();
    }

    run.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(run, null, 2));
    fs.writeFileSync(path.join(outDir, 'run.log'), lines.join('\n') + '\n');
    log(`结果目录：${outDir}`);
    printSummary(run);
    return 0;
  } finally {
    await receiver.stop();
    await staticServer.close();
  }
}

function fmt(rate) {
  return `${(rate * 100).toFixed(3)}%`;
}

function printSummary(run) {
  const rows = [];
  for (const b of run.browsers) {
    if (b.status !== 'ok') {
      rows.push(`| ${b.browser} | — | 未测量 | ${b.error} |`);
      continue;
    }
    for (const [name, r] of Object.entries(b.scenarios)) {
      if (r.error) {
        rows.push(`| ${b.browser} | ${name} | 失败 | ${r.error.split('\n')[0]} |`);
        continue;
      }
      const cells = [...r.cells, ...(r.bulkCells || [])];
      for (const cell of cells) {
        const extra =
          name === 'multitab'
            ? ` dup=${cell.wave1.duplicateEvents}/${cell.wave1.storedEvents}`
            : name === 'kill'
              ? ` 预写存活丢=${cell.prewriteSurvival.lost}/${cell.prewriteSurvival.total}`
              : '';
        rows.push(
          `| ${b.browser} | ${name}/${cell.id} | normal 丢 ${cell.final.normal.lost}/${cell.final.normal.total} (${fmt(
            cell.final.normal.lossRate
          )}) critical 丢 ${cell.final.critical.lost}/${cell.final.critical.total} (${fmt(cell.final.critical.lossRate)})${extra} |`
        );
      }
    }
  }
  console.log('\n=== 汇总 ===');
  console.log('| 浏览器 | 场景/格子 | 丢失 |');
  console.log('|---|---|---|');
  rows.forEach((r) => console.log(r));
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
