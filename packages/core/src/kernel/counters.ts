/**
 * 计数器（C08 读取并聚合）。
 */
import type { Counters } from './types';

/** 创建计数器实例。内核与各模块共享同一个实例。 */
export function createCounters(): Counters {
  const values = new Map<string, number>();

  return {
    count(reason: string, delta = 1): void {
      if (!Number.isFinite(delta) || delta <= 0) return;
      values.set(reason, (values.get(reason) ?? 0) + delta);
    },
    get(reason: string): number {
      return values.get(reason) ?? 0;
    },
    snapshot(): Readonly<Record<string, number>> {
      return Object.fromEntries(values);
    },
    reset(): void {
      values.clear();
    },
  };
}
