/**
 * T20 基线的合并与多次运行方差报告。
 *
 * 输入：`tests/bench/results/*.json`（每次运行的各基准行）+ `history.jsonl`（追加式历史）。
 * 输出：`tests/bench/results/baseline.json`（合并基线）+ 终端摘要。
 *
 * 与 `T20.md` 非功能目标的对应：「基准测试可以在 CI 中复现，结果波动在 5% 以内（给出多次运行的方差）」
 * —— 本脚本按 `指标 + 统计量` 聚合历史行，报出 `波动幅度 =（最大−最小）/中位数`，
 * 并把 > 5% 的行标成 `超出 5%`（**只报告，不做门禁**：基准不是回归门禁）。
 *
 * 用法：`node tests/bench/collect.mjs`
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, 'results');

if (!existsSync(resultsDir)) {
  console.error('没有 tests/bench/results/：先跑 `pnpm exec vitest run --config tests/bench/vitest.config.ts`');
  process.exitCode = 1;
  process.exit();
}

/** 读入本次运行的全部基准结果（每次运行会覆盖同名文件）。 */
const runs = [];
for (const name of readdirSync(resultsDir).sort()) {
  if (!name.endsWith('.json') || name === 'baseline.json') continue;
  runs.push(JSON.parse(readFileSync(join(resultsDir, name), 'utf8')));
}

const rows = runs.flatMap((run) =>
  run.rows.map((row) => ({ ...row, bench: run.bench, run_id: run.run_id })),
);

const verdictOf = (row) => {
  if (row.target === undefined) return '仅记录';
  if (!Number.isFinite(row.value)) return '不达标';
  // `direction` 缺省 = at-most（延迟/体积/错误数）；吞吐这类「越大越好」的行写 at-least。
  return row.direction === 'at-least'
    ? (row.value >= row.target ? '达标' : '不达标')
    : (row.value <= row.target ? '达标' : '不达标');
};

/** 余量与 `lib/report.ts` 同口径：at-most = 目标/实测，at-least = 实测/目标。 */
const marginOf = (row) => {
  if (row.target === undefined || !Number.isFinite(row.value) || row.value <= 0) return Number.NaN;
  return row.direction === 'at-least' ? row.value / row.target : row.target / row.value;
};

/* ------------------------------------------------ 多次运行的方差（按 指标+统计量 聚合） */

const historyPath = join(resultsDir, 'history.jsonl');
/**
 * 只统计指定运行（逗号分隔的 `run_id`），例如 `BENCH_RUNS=run-1,run-3`。
 * 用途：共享机器上可能有别的进程在编译/跑门禁，把受污染的运行排除后再看方差。
 */
const onlyRuns = (process.env['BENCH_RUNS'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '');
const observations = new Map();
if (existsSync(historyPath)) {
  for (const line of readFileSync(historyPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line);
    if (onlyRuns.length > 0 && !onlyRuns.includes(entry.run_id)) continue;
    for (const row of entry.rows) {
      const key = `${entry.bench}｜${row.metric}｜${row.stat}`;
      const list = observations.get(key) ?? [];
      list.push({ run_id: entry.run_id, value: row.value });
      observations.set(key, list);
    }
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

const varianceRows = [];
for (const [key, list] of observations) {
  const byRun = new Map();
  for (const observation of list) byRun.set(observation.run_id, observation.value);
  const values = [...byRun.values()].filter((value) => Number.isFinite(value));
  if (values.length < 2) continue;
  const middle = median(values);
  const spread = middle > 0 ? (Math.max(...values) - Math.min(...values)) / middle : 0;
  varianceRows.push({ key, runs: values.length, median: middle, spread, values });
}
varianceRows.sort((left, right) => right.spread - left.spread);

/* ------------------------------------------------ 打印摘要 */

const failed = rows.filter((row) => verdictOf(row) === '不达标');
console.log('='.repeat(100));
console.log(`T20 基准摘要：${String(runs.length)} 份基准文件，${String(rows.length)} 个指标行`);
console.log('='.repeat(100));
for (const row of rows) {
  const verdict = verdictOf(row);
  // `report.ts` 写的是 `targetText`；旧行可能只有 `target_text`。两种都认，缺省回退数值。
  const targetText = row.targetText ?? row.target_text;
  const target = row.target === undefined ? '无契约目标' : `契约 ${targetText ?? String(row.target)}`;
  const marginValue = marginOf(row);
  const margin = Number.isFinite(marginValue) ? `余量 ${marginValue.toFixed(2)}×` : '—';
  console.log(
    `${verdict === '不达标' ? '✗' : verdict === '达标' ? '✓' : '·'} [${row.bench}] ${row.metric}：` +
      `${row.stat}=${Number.isFinite(row.value) ? row.value.toFixed(6) : String(row.value)} ${row.unit} ` +
      `(n=${String(row.samples)}, ${target}, ${margin}) → ${verdict}`,
  );
}

console.log('-'.repeat(100));
console.log(`不达标行：${String(failed.length)} 条`);
for (const row of failed) {
  const comparator = row.direction === 'at-least' ? '<' : '>';
  console.log(
    `  ✗ [${row.bench}] ${row.metric}：${row.value.toFixed(6)} ${comparator} ${String(row.target)}` +
      `（${row.targetText ?? row.target_text ?? ''}）`,
  );
}

console.log('-'.repeat(100));
console.log(
  `多次运行方差（${String(varianceRows[0]?.runs ?? 0)} 次运行${
    onlyRuns.length > 0 ? `，仅 ${onlyRuns.join('/')}` : ''
  }；波动 = (max-min)/中位数；>5% 只报告不作门禁）`,
);
for (const row of varianceRows.slice(0, 25)) {
  const flag = row.spread > 0.05 ? '超出 5%' : 'ok';
  console.log(
    `  ${flag === 'ok' ? ' ' : '!'} ${row.key}：中位数 ${row.median.toFixed(6)}，波动 ${(row.spread * 100).toFixed(2)}% ` +
      `(n=${String(row.runs)}；${row.values.map((value) => value.toFixed(6)).join(' / ')})`,
  );
}

const baseline = {
  generated_at: new Date().toISOString(),
  node: process.version,
  cpus: runs[0]?.cpus ?? null,
  benchmark_files: runs.map((run) => run.bench),
  rows,
  variance: varianceRows.map((row) => ({ metric: row.key, runs: row.runs, median: row.median, spread: row.spread })),
};
writeFileSync(join(resultsDir, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
console.log('-'.repeat(100));
console.log(`已写入 tests/bench/results/baseline.json（${String(rows.length)} 行指标）`);
