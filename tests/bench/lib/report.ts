/**
 * 基准报告收集器（T20）。
 *
 * 设计要点（对应 handover 第 2 节 T20 小节的「口径要求」）：
 * 1. **基准不是回归门禁**。这里把两类信息分开记录：
 *    ① `达标判定`——实测值相对**契约目标值**的判定（本任务要回答的问题）；
 *    ② `余量`——契约目标值 / 实测值，只作趋势与容量参考，**不设通过线**。
 * 2. **数字必须可读**。每个指标都打印统计量名、实测值、样本量、契约目标与余量。
 * 3. 测量完整性（样本量 > 0、值有限）由各基准文件自己断言；契约目标不达标**不会**让基准
 *    失败——它只进入报告与升级清单（T20.md「任一指标不达标时在报告中列出并升级」）。
 *
 * 每次运行把结构化结果写到 `tests/bench/results/<name>.json`，由 `tests/bench/collect.mjs`
 * 合并成基线文件 `tests/bench/results/baseline.json`。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 契约目标值的达标判定。 */
export type Verdict =
  /** 实测（按指定统计量）满足契约目标值。 */
  | '达标'
  /** 实测未达契约目标值——必须写进报告并升级，**不得**改测量方法来「达标」。 */
  | '不达标'
  /** 该指标没有契约目标值，只记录趋势。 */
  | '仅记录'
  /** 需要真实浏览器 / 真机才能测，归 T29。 */
  | '归 T29';

export interface BenchRow {
  /** 指标名，例如 `C01 track 单次同步耗时`。 */
  readonly metric: string;
  /** 统计量名（`min` / `p50` / `p95` / `p99`），与 `value` 对应。 */
  readonly stat: string;
  /** 实测值。 */
  readonly value: number;
  /** 单位（`ms` / `B` / `%` / `次/秒` / `KB`）。 */
  readonly unit: string;
  /** 样本量。 */
  readonly samples: number;
  /** 契约目标值（数值）；没有契约目标时不填。 */
  readonly target?: number | undefined;
  /** 契约目标值的人类可读写法，例如 `P99 ≤ 0.1 ms`。 */
  readonly targetText?: string | undefined;
  /** 契约 / 任务卡出处。 */
  readonly source?: string | undefined;
  /** 备注（口径差异、环境限制等）。 */
  readonly note?: string | undefined;
  /** 额外观测值（如同轮 P99、均值、内存上界），键值都会打印。 */
  readonly extra?: Readonly<Record<string, number>> | undefined;
}

export interface BenchReport {
  /** 记录一条指标；返回值是推导出的达标判定，便于就地打印。 */
  readonly record: (row: BenchRow) => Verdict;
  /** 打印表格并写出 `results/<name>.json`。 */
  readonly finish: () => void;
}

function resolveVerdict(row: BenchRow): Verdict {
  if (row.target === undefined) return row.note?.includes('归 T29') === true ? '归 T29' : '仅记录';
  if (!Number.isFinite(row.value)) return '不达标';
  return row.value <= row.target ? '达标' : '不达标';
}

function renderExtra(extra: Readonly<Record<string, number>> | undefined): string {
  if (extra === undefined) return '';
  return Object.entries(extra)
    .map(([key, value]) => `${key}=${Number.isFinite(value) ? value.toFixed(6) : String(value)}`)
    .join(' ');
}

/**
 * 创建一份基准报告。`name` 决定 JSON 文件名，建议用 `c01-track` 这类稳定短名。
 */
export function createBenchReport(name: string): BenchReport {
  const rows: BenchRow[] = [];
  const resultsDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'results');

  const record = (row: BenchRow): Verdict => {
    const verdict = resolveVerdict(row);
    rows.push(row);
    const margin =
      row.target !== undefined && Number.isFinite(row.value) && row.value > 0
        ? `余量 ${(row.target / row.value).toFixed(1)}×`
        : '—';
    const targetPart = row.targetText === undefined ? '无契约目标值' : `契约 ${row.targetText}`;
    const notePart = row.note === undefined ? '' : `（${row.note}）`;
    const extraPart = renderExtra(row.extra);
    console.log(
      `[${name}] ${row.metric}：${row.stat}=${Number.isFinite(row.value) ? row.value.toFixed(6) : String(row.value)} ` +
        `${row.unit}，n=${String(row.samples)}，${targetPart}，${margin} → ${verdict}${notePart}` +
        (extraPart === '' ? '' : `；${extraPart}`),
    );
    return verdict;
  };

  const finish = (): void => {
    mkdirSync(resultsDir, { recursive: true });
    const runId = process.env['BENCH_RUN_ID'] ?? `run-${new Date().toISOString()}`;
    const path = join(resultsDir, `${name}.json`);
    const payload = {
      bench: name,
      run_id: runId,
      generated_at: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: (process.env['BENCH_CPU'] ?? '').trim(),
      cpus: cpus().length,
      rows,
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    // 追加式历史：供 collect.mjs 计算多次运行之间的方差（T20 非功能目标：波动 ≤ 5%）
    appendFileSync(
      join(resultsDir, 'history.jsonl'),
      `${JSON.stringify({ bench: name, run_id: runId, generated_at: payload.generated_at, rows })}\n`,
      'utf8',
    );
  };

  return { record, finish };
}
