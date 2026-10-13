/**
 * C03 非功能目标：三级合并同步耗时 —— 中位数回归护栏（M0）。
 *
 * 按仓库既定政策（`docs/tasks/board.md` 2026-10-12 结论、`docs/reports/wave3-lanes.md`）：
 * 单元门禁**不断言微秒级墙钟目标值**；这里只保留带文档化余量的中位数护栏，契约目标的
 * 权威验证归 T20 的 `tests/bench/`。实现落地后需按实测值回填余量。
 */
import { describe, expect, it } from 'vitest';

import { createBuiltinConfig } from './defaults';
import { mergeConfig } from './merge';

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('C03 非功能：合并耗时护栏', () => {
  it('mergeConfig 应用远程层（正断言）且同步中位数不超过 0.05 ms', () => {
    const builtin = createBuiltinConfig('essential_only');
    const input = {
      builtin,
      remote: {
        format_version: 1,
        app_id: 'demo-app',
        env: 'production',
        config_version: 42,
        published_at: 1_793_000_000_000,
        transport: { max_batch_events: 20 },
        sampling: { session_rate: 0.3 },
      },
      runtime: { transport: { max_batch_events: 5 } },
      configVersion: 42,
      publishedAt: 1_793_000_000_000,
      source: 'remote' as const,
      consentMode: undefined,
      sessionRandom: 0.5,
      sdkVersion: '1.0.0',
    };

    // 正断言：证明测的是真实合并，而不是空跑
    expect(mergeConfig(input).config.config_version).toBe(42);

    const samples: number[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      const start = performance.now();
      mergeConfig(input);
      samples.push(performance.now() - start);
    }
    expect(median(samples)).toBeLessThanOrEqual(0.05);
  });
});
