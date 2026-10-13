/**
 * C08-F2 的耗时采样：1% 会话判定 + nearest-rank P99 聚合。
 *
 * 全部逻辑确定性、无墙钟阈值：
 * - 会话判定用注入的 `random()`（缺省 `Math.random`），只判定一次；
 * - P99 用 nearest-rank（升序第 `ceil(0.99 * n)` 个），样本为空返回 `null`；
 * - 只有命中采样的窗口才保留样本，未命中时 `record` 为空操作、`take` 返回空
 *   （因此 `sdk_health` 不带三个 p99，AC-03）。
 *
 * `track` / `pipeline` / `serialize` 的耗时由 `instrument.ts` 的装饰器注入，
 * 装配根接线归 T18。
 */
import {
  LATENCY_STAGES,
} from './types';
import type { LatencyP99, LatencyStage, LatencyWindowPort } from './types';

/** 缺省会话采样率（C08-F2：1%）。 */
export const DEFAULT_SESSION_SAMPLE_RATE = 0.01;

/** 缺省每阶段保留的样本数上界，避免长窗口无界增长。 */
export const DEFAULT_LATENCY_CAPACITY = 512;

export interface SessionSamplerOptions {
  readonly random?: (() => number) | undefined;
  /** 采样率；非法值规整到 [0, 1]，缺省 0.01。 */
  readonly rate?: number | undefined;
}

export interface SessionSampler {
  /** 本会话是否命中耗时采样；首次调用后结果固定。 */
  sampled(): boolean;
  /** 生效采样率。 */
  rate(): number;
}

function normalizeRate(rate: number | undefined): number {
  if (rate === undefined) return DEFAULT_SESSION_SAMPLE_RATE;
  // 显式传入的非法值（NaN/Infinity/非正数）保守地关闭采样，不回退到缺省 1%。
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (rate >= 1) return 1;
  return rate;
}

/** 创建 1% 会话采样器（确定性：注入 `random` 即可复现）。 */
export function createSessionSampler(options: SessionSamplerOptions = {}): SessionSampler {
  const random = options.random ?? ((): number => Math.random());
  const rate = normalizeRate(options.rate);
  let decided: boolean | null = null;
  return {
    sampled(): boolean {
      if (decided === null) decided = random() < rate;
      return decided;
    },
    rate: (): number => rate,
  };
}

/** nearest-rank 百分位；样本为空返回 `null`，不就地排序。 */
export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const clamped = Number.isFinite(percentile) ? Math.min(1, Math.max(0, percentile)) : 0;
  const rank = Math.ceil(clamped * values.length);
  const index = Math.min(values.length - 1, Math.max(0, rank - 1));
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[index] ?? null;
}

export interface LatencyWindowOptions {
  /** 会话是否命中采样；缺省 `false`（不采样时一切都为空操作）。 */
  readonly sampled?: boolean | undefined;
  /** 每阶段保留的样本数上界；缺省 512。 */
  readonly capacity?: number | undefined;
}

/** 采样窗口：记录三个阶段的耗时样本，`take()` 返回本窗口 P99 并清零。 */
export interface LatencyWindow extends LatencyWindowPort {
  readonly sampled: boolean;
  record(stage: LatencyStage, durationMs: number): void;
  p99(stage: LatencyStage): number | null;
  reset(): void;
}

function normalizeCapacity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LATENCY_CAPACITY;
  return Math.max(1, Math.floor(value));
}

export function createLatencyWindow(options: LatencyWindowOptions = {}): LatencyWindow {
  const sampled = options.sampled ?? false;
  const capacity = normalizeCapacity(options.capacity);
  const samples = new Map<LatencyStage, number[]>();
  for (const stage of LATENCY_STAGES) samples.set(stage, []);

  function p99(stage: LatencyStage): number | null {
    const list = samples.get(stage);
    if (list === undefined || list.length === 0) return null;
    return nearestRankPercentile(list, 0.99);
  }

  function reset(): void {
    for (const list of samples.values()) list.length = 0;
  }

  return {
    sampled,
    record(stage: LatencyStage, durationMs: number): void {
      if (!sampled || !Number.isFinite(durationMs) || durationMs < 0) return;
      const list = samples.get(stage);
      if (list === undefined) return;
      list.push(durationMs);
      if (list.length > capacity) list.splice(0, list.length - capacity);
    },
    p99,
    reset,
    take(): LatencyP99 {
      if (!sampled) return {};
      const taken: LatencyP99 = {};
      for (const stage of LATENCY_STAGES) {
        const value = p99(stage);
        if (value !== null) taken[stage] = value;
      }
      reset();
      return taken;
    },
  };
}
