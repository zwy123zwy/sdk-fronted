#!/usr/bin/env node
/**
 * 从结果目录生成报告用的 markdown 表格（报告里的每个数字都来自这些 JSON）。
 * 可以传多个 --dir（例如 Chromium/WebKit 在 results，Firefox 在 results-firefox）；
 * 同一个浏览器出现在多个目录时取 runId 更新的那次。
 * 用法：node poc/poc-1/tables.mjs --dir poc/poc-1/results --dir poc/poc-1/results-firefox
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dirs.push(argv[++i]);
  }
  return args;
}

function pct(x, digits = 3) {
  return `${(x * 100).toFixed(digits)}%`;
}

function pctCell(stored, total) {
  const loss = total - stored;
  return `${loss}/${total}（${pct(total > 0 ? loss / total : 0)}）`;
}

/** 存活口径：good/total（比例）。 */
function survivalCell(good, total) {
  return `${good}/${total}（${pct(total > 0 ? good / total : 0)}）`;
}

function load(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'run.json');
  const byBrowser = {};
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const browser = f.split('-')[0];
    byBrowser[browser] = byBrowser[browser] || {};
    byBrowser[browser][d.scenario] = d;
  }
  return { byBrowser };
}

/** 列出某个根目录下所有含结果 JSON 的运行目录。 */
function runDirsUnder(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((sub) => {
      if (!fs.statSync(sub).isDirectory()) return false;
      // 只算真正有场景结果的运行目录（run.json / run.log 不算）
      return fs.readdirSync(sub).some((f) => f.endsWith('.json') && f !== 'run.json');
    })
    .sort();
}

/** 追加轮：存储落盘窗口 / 跨标签页 / 写入耗时。 */
function renderStorageSections(out, browsers, byBrowser, cellIds) {
  const roundSuffix = (runDir) => {
    const m = /-run(\d+)$/.exec(runDir);
    return m ? `第 ${m[1]} 次` : '';
  };
  if (cellIds.storage) {
    out.push('## 追加轮：硬杀落盘窗口（每个「存储 × Δt」格子 1000 条样本；同一命令重复 3 次独立运行）');
    out.push('');
    for (const b of browsers) {
      const runs = storeRuns(b, 'storage');
      if (runs.length === 0) continue;
      // Δt 顺序
      const deltas = [];
      for (const r of runs) {
        for (const c of r.data.cells) if (!deltas.includes(c.deltaMs)) deltas.push(c.deltaMs);
      }
      deltas.sort((a, b2) => a - b2);
      out.push(`### ${b}`);
      out.push('');
      out.push('| 存储 | 类型 | ' + deltas.map((d) => `Δt=${d}ms`).join(' | ') + ' |');
      out.push('|---|--|' + deltas.map(() => '--|').join(''));
      const storages = [];
      for (const r of runs) for (const c of r.data.cells) if (!storages.includes(c.storage)) storages.push(c.storage);
      const order = ['local', 'idb', 'idb-strict', 'opfs', 'idb-pending', 'opfs-pending', 'opfs-noclose'];
      storages.sort((a, b2) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b2);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      for (const st of storages) {
        const cells = runs.map((r) => r.data.cells.find((c) => c.storage === st));
        if (cells.every((c) => !c)) continue;
        const kind = cells.find((c) => c)?.control ? '对照' : '主';
        const row = deltas.map((d) => {
          const parts = [];
          for (let i = 0; i < runs.length; i++) {
            const c = cells[i] ? cells[i] && runs[i].data.cells.find((x) => x.storage === st && x.deltaMs === d) : null;
            if (!c) continue;
            parts.push(`${c.survived}/${c.expected}`);
          }
          return parts.length > 0 ? parts.join(' / ') : '—';
        });
        out.push(`| ${st} | ${kind} | ${row.join(' | ')} |`);
      }
      out.push('');
      out.push('（每格三个数字 = 三次独立运行的存活条数/总数；`存活/1000` 表示落盘在强杀后仍可读回。主格 Δt 从「落盘点确认」之后开始计；对照格没有落盘点，从等待上限之后开始计。）');
      out.push('');
    }
  }

  if (cellIds['storage-multitab']) {
    out.push('## 追加轮：跨标签页并发写');
    out.push('');
    out.push('| 存储 | ' + browsers.map((b) => `${b} 可见/应有（被覆盖）`).join(' | ') + ' |');
    out.push('|---|' + browsers.map(() => '--|').join(''));
    const storages = [];
    for (const b of browsers) {
      const runs = storeRuns(b, 'storage-multitab');
      for (const r of runs) for (const c of r.data.cells) if (!storages.includes(c.storage)) storages.push(c.storage);
    }
    for (const st of storages) {
      const cols = browsers.map((b) => {
        const runs = storeRuns(b, 'storage-multitab');
        if (runs.length === 0) return '未测量';
        return runs
          .map((r) => {
            const c = r.data.cells.find((x) => x.storage === st);
            return c ? `${c.visibleInStore}/${c.expected}（${c.overwritten}）` : '—';
          })
          .join(' / ');
      });
      out.push(`| ${st} | ${cols.join(' | ')} |`);
    }
    out.push('');
  }

  if (cellIds['storage-perf']) {
    out.push('## 追加轮：写入耗时与配额');
    out.push('');
    out.push('| 存储 | ' + browsers.map((b) => `${b} 批写 p50/p95 ms`).join(' | ') + ' |');
    out.push('|---|' + browsers.map(() => '--|').join(''));
    const storages = [];
    for (const b of browsers) {
      const runs = storeRuns(b, 'storage-perf');
      for (const r of runs) for (const c of r.data.cells) if (!storages.includes(c.storage)) storages.push(c.storage);
    }
    for (const st of storages) {
      const cols = browsers.map((b) => {
        const runs = storeRuns(b, 'storage-perf');
        if (runs.length === 0) return '未测量';
        return runs
          .map((r) => {
            const c = r.data.cells.find((x) => x.storage === st);
            return c ? `${c.benchBatchMs.p50} / ${c.benchBatchMs.p95}` : '—';
          })
          .join(' / ');
      });
      out.push(`| ${st} | ${cols.join(' | ')} |`);
    }
    out.push('');
  }
}

/** 收集某个浏览器、某个场景在各次 run 里的结果（按 runId 排序）。 */
function storeRuns(browser, scenario) {
  const globalRuns = globalThis.__POC_RUNS__ || [];
  const out = [];
  for (const r of globalRuns) {
    const data = r.byBrowser[browser] && r.byBrowser[browser][scenario];
    if (data && !data.error) out.push({ runDir: r.runDir, data });
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = args.dirs.length > 0 ? args.dirs : [path.join(HERE, 'results')];
  // 所有根目录下的运行目录按 runId（目录名）排序，后加载的（更新的）覆盖同浏览器的旧结果
  const allRunDirs = roots.flatMap((r) => runDirsUnder(r)).sort();
  if (allRunDirs.length === 0) throw new Error(`目录里没有结果：${roots.join(', ')}`);
  const byBrowser = {};
  let run = { startedAt: '', finishedAt: '', preset: '' };
  const usedRuns = [];
  globalThis.__POC_RUNS__ = [];
  for (const dir of allRunDirs) {
    const loaded = load(dir);
    globalThis.__POC_RUNS__.push({ runDir: dir, byBrowser: loaded.byBrowser });
    for (const [browser, scenarios] of Object.entries(loaded.byBrowser)) {
      byBrowser[browser] = scenarios;
    }
    usedRuns.push(dir);
    const runPath = path.join(dir, 'run.json');
    if (fs.existsSync(runPath)) run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  }
  const runDir = usedRuns.join(' + ');
  // 固定浏览器列顺序，便于和报告对齐
  const ORDER = ['chromium', 'firefox', 'webkit'];
  const browsers = Object.keys(byBrowser).sort(
    (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)
  );
  const out = [];
  out.push(`# 结果目录：${runDir}`);
  out.push('');
  out.push(
    `数据来源（按 runId 顺序，同一浏览器取最新的那次）：${usedRuns.map((d) => d.split('/').slice(-2).join('/')).join(' + ')}`
  );
  out.push(``);
  out.push(`最近一次运行：${run.startedAt} → ${run.finishedAt}；preset=${run.preset}`);
  out.push('');

  // 1. 测量矩阵
  out.push('## 测量矩阵（每格样本数：normal / critical）');
  out.push('');
  out.push('| 场景 | 格子 | ' + browsers.map((b) => `${b} 样本量(n/c)`).join(' | ') + ' |');
  out.push('|---|--|' + browsers.map(() => '--|').join(''));
  const scenarioNames = ['leave', 'kill', 'offline', 'multitab', 'storage', 'storage-multitab', 'storage-perf'];
  const cellIds = {};
  for (const s of scenarioNames) {
    const ids = new Set();
    for (const b of browsers) {
      const r = byBrowser[b][s];
      if (!r) continue;
      for (const c of [...(r.cells || []), ...(r.bulkCells || [])]) ids.add(c.id);
    }
    cellIds[s] = [...ids];
  }
  const matrixScenarios = ['leave', 'kill', 'offline', 'multitab'];
  for (const s of matrixScenarios) {
    for (const id of cellIds[s]) {
      const cells = browsers.map((b) => {
        const r = byBrowser[b] && byBrowser[b][s];
        if (!r) return '未测量';
        const c = [...(r.cells || []), ...(r.bulkCells || [])].find((x) => x.id === id);
        if (!c) return '未测量';
        return `${c.expected.normal} / ${c.expected.critical}`;
      });
      out.push(`| ${s} | ${id} | ${cells.join(' | ')} |`);
    }
  }
  out.push('');

  // 2. leave 对比
  out.push('## 场景 1 页面离开：四条冲刷路径');
  out.push('');
  out.push(
    '| 格子 | ' +
      browsers
        .map((b) => `${b} 离开时 normal 丢失 | ${b} 离开时 critical 丢失 | ${b} 最终 normal 丢失 | ${b} 最终 critical 丢失 | ${b} 重复事件`)
        .join(' | ') +
      ' |'
  );
  out.push('|---|' + browsers.map(() => '--|--|--|--|--|').join(''));
  for (const id of cellIds.leave) {
    const cols = browsers.map((b) => {
      const r = byBrowser[b] && byBrowser[b].leave;
      if (!r) return ['未测量', '', '', '', ''];
      const c = [...(r.cells || []), ...(r.bulkCells || [])].find((x) => x.id === id);
      if (!c) return ['未测量', '', '', '', ''];
      return [
        pctCell(c.leaveFirstAttempt.normal.arrived, c.leaveFirstAttempt.normal.total),
        pctCell(c.leaveFirstAttempt.critical.arrived, c.leaveFirstAttempt.critical.total),
        pctCell(c.final.normal.stored, c.final.normal.total),
        pctCell(c.final.critical.stored, c.final.critical.total),
        String(c.duplicateEvents)
      ];
    });
    out.push(`| ${id} | ${cols.map((c) => c.join(' | ')).join(' | ')} |`);
  }
  out.push('');

  // 3. kill
  out.push('## 场景 2 浏览器强杀');
  out.push('');
  out.push(
    '| 变体 | ' +
      browsers
        .map((b) => `${b} 强杀方式 | ${b} 预写存活（存活/应有） | ${b} normal 丢失 | ${b} critical 丢失`)
        .join(' | ') +
      ' |'
  );
  out.push('|---|' + browsers.map(() => '--|--|--|--|').join(''));
  for (const id of cellIds.kill) {
    const cols = browsers.map((b) => {
      const r = byBrowser[b] && byBrowser[b].kill;
      if (!r) return ['未测量', '', '', ''];
      const c = (r.cells || []).find((x) => x.id === id);
      if (!c) return ['未测量', '', '', ''];
      return [
        c.killMode || '',
        survivalCell(c.prewriteSurvival.survived, c.prewriteSurvival.total),
        pctCell(c.final.normal.stored, c.final.normal.total),
        pctCell(c.final.critical.stored, c.final.critical.total)
      ];
    });
    out.push(`| ${id} | ${cols.map((c) => c.join(' | ')).join(' | ')} |`);
  }
  out.push('');

  // 4. offline
  out.push('## 场景 3 断网');
  out.push('');
  out.push('| 变体 | ' + browsers.map((b) => `${b} normal 丢失 | ${b} critical 丢失`).join(' | ') + ' |');
  out.push('|---|' + browsers.map(() => '--|--|').join(''));
  for (const id of cellIds.offline) {
    const cols = browsers.map((b) => {
      const r = byBrowser[b] && byBrowser[b].offline;
      if (!r) return ['未测量', ''];
      const c = (r.cells || []).find((x) => x.id === id);
      if (!c) return ['未测量', ''];
      return [pctCell(c.final.normal.stored, c.final.normal.total), pctCell(c.final.critical.stored, c.final.critical.total)];
    });
    out.push(`| ${id} | ${cols.map((c) => c.join(' | ')).join(' | ')} |`);
  }
  out.push('');

  // 5. multitab
  out.push('## 场景 4 多标签页重复补发');
  out.push('');
  out.push(
    '| 选主方式 | ' +
      browsers.map((b) => `${b} 首轮并发重复 | ${b} 重复/入库 | ${b} 重复/离线副本 | ${b} 当选主标签页数 | ${b} critical 丢失`).join(' | ') +
      ' |'
  );
  out.push('|---|' + browsers.map(() => '--|--|--|--|--|').join(''));
  for (const id of cellIds.multitab) {
    const cols = browsers.map((b) => {
      const r = byBrowser[b] && byBrowser[b].multitab;
      if (!r) return ['未测量', '', '', '', ''];
      const c = (r.cells || []).find((x) => x.id === id);
      if (!c) return ['未测量', '', '', '', ''];
      return [
        String(c.wave1.duplicateEvents),
        pct(c.duplicateRateWave1, 1),
        pct(c.duplicateRatePerCritical, 1),
        `${c.leadersWave1.leaders}/${r.params.rounds * r.params.tabs}`,
        pctCell(c.final.critical.stored, c.final.critical.total)
      ];
    });
    out.push(`| ${id} | ${cols.map((c) => c.join(' | ')).join(' | ')} |`);
  }
  out.push('');
  out.push('（重复补发率按两种口径给出：重复事件 / 入库事件（含 normal 与 critical）、重复事件 / 该场景的离线副本事件数（critical）。「当选主标签页数」= 全部轮次里首轮并发中 `recover_leader` 计数 > 0 的「标签页 × 轮次」数 / 总「标签页 × 轮次」数。）');
  out.push('');

  // 6. 存储落盘窗口（追加轮）
  if (cellIds.storage || cellIds['storage-multitab'] || cellIds['storage-perf']) {
    renderStorageSections(out, browsers, byBrowser, cellIds);
  }

  console.log(out.join('\n'));
}

main();
