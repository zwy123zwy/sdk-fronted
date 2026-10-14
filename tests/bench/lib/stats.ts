/**
 * 基准统计量（T20）。
 *
 * **口径（handover 第 2 节 T20 小节、`docs/tasks/T20.md`）**：不使用「总耗时」这类统计量——
 * vitest 并行跑测试文件时总耗时会被 GC / 调度抖动灌满（本会话已因此连红两次）。
 * 这里只产出**对离群值稳健**的统计量：最小值、中位数（P50）、P95、P99，以及从中位数推出的
 * 吞吐（`1000 / p50`，单位 次/秒）。
 *
 * 所有函数都不修改入参数组。
 */

/** 一次测量的汇总统计量（单位由调用方决定，基准里是毫秒）。 */
export interface Summary {
  /** 样本量。 */
  readonly samples: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

/** 最近秩（nearest-rank）分位数；入参必须是**已升序排序**的数组。 */
export function quantileSorted(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? Number.NaN;
}

/** 汇总一组样本（内部排序一次，不改入参）。 */
export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) {
    return { samples: 0, min: Number.NaN, p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, max: Number.NaN, mean: Number.NaN };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  let total = 0;
  for (const value of sorted) total += value;
  return {
    samples: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: quantileSorted(sorted, 0.5),
    p95: quantileSorted(sorted, 0.95),
    p99: quantileSorted(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    mean: total / sorted.length,
  };
}

/** 计时执行 `run` 一次（毫秒）。 */
export function timeOnce(run: () => void): number {
  const startedAt = performance.now();
  run();
  return performance.now() - startedAt;
}

/** 预热 `times` 次（不计时），让 JIT 与内部缓存进入稳态。 */
export function warmup(times: number, run: () => void): void {
  for (let index = 0; index < times; index += 1) run();
}

/** 逐次计时 `iterations` 次，返回原始样本（毫秒）。 */
export function timedIterations(iterations: number, run: (index: number) => void): number[] {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    run(index);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

/**
 * 分轮计时：每轮 `iterationsPerRound` 次，取每轮的**中位数**，再对轮中位数取中位数。
 *
 * 用途：跨轮漂移（GC、同机其它进程）只影响个别轮，轮中位数抑制它；返回的仍是稳健统计量。
 */
export function timedRounds(
  rounds: number,
  iterationsPerRound: number,
  run: (index: number) => void,
): { readonly samples: number[]; readonly roundMedians: number[]; readonly summary: Summary } {
  const samples: number[] = [];
  const roundMedians: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const roundSamples = timedIterations(iterationsPerRound, run);
    samples.push(...roundSamples);
    roundMedians.push(summarize(roundSamples).p50);
  }
  return { samples, roundMedians, summary: summarize(roundMedians) };
}

/** 格式化为固定 6 位小数（毫秒级指标可读性）。 */
export function formatMs(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : 'NaN';
}

/** 由中位数推出的单线程吞吐（次/秒）。 */
export function throughputPerSecond(p50Ms: number): number {
  return p50Ms > 0 ? 1000 / p50Ms : Number.POSITIVE_INFINITY;
}
