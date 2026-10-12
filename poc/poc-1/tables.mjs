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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = args.dirs.length > 0 ? args.dirs : [path.join(HERE, 'results')];
  // 所有根目录下的运行目录按 runId（目录名）排序，后加载的（更新的）覆盖同浏览器的旧结果
  const allRunDirs = roots.flatMap((r) => runDirsUnder(r)).sort();
  if (allRunDirs.length === 0) throw new Error(`目录里没有结果：${roots.join(', ')}`);
  const byBrowser = {};
  let run = { startedAt: '', finishedAt: '', preset: '' };
  const usedRuns = [];
  for (const dir of allRunDirs) {
    const loaded = load(dir);
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
  const scenarioNames = ['leave', 'kill', 'offline', 'multitab'];
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
  for (const s of scenarioNames) {
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

  console.log(out.join('\n'));
}

main();
