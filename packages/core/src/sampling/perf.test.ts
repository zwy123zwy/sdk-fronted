/**
 * C03 非功能目标：单条事件采样判定耗时 —— 中位数回归护栏（M0）。
 *
 * 任务卡写「单条 P99 不超过 0.01 ms」。按仓库既定政策（`docs/tasks/board.md` 2026-10-12、
 * `docs/reports/wave3-lanes.md`）：单元门禁只保留**中位数护栏**，契约 P99 的权威验证归 T20。
 * 实现落地后按实测值回填余量（目标 ≥10× 余量）。
 */
import { describe, expect, it } from 'vitest';

import { createKernel } from '../kernel';
import type { ConfigReader, EffectiveConfig, ResolvedSampling } from '../config/types';
import { createBuiltinConfig } from '../config/defaults';
import { createSamplingProcessor } from './processor';
import { createSessionSampling } from './session';
import type { SessionStorePort } from './types';


function memoryStore(): SessionStorePort {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
  };
}

function readerWith(sampling: ResolvedSampling): ConfigReader {
  const config: EffectiveConfig = { ...createBuiltinConfig('essential_only'), sampling };
  return { current: () => config, subscribe: () => () => undefined };
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('C03 非功能：采样判定耗时护栏', () => {
  it('采样处理器确实注册（正断言）且单条判定中位数不超过 0.05 ms', () => {
    const config = readerWith({
      session_rate: 1,
      allow_users: [],
      rules: [{ match: { event_name: 'editor_*' }, rate: 1 }],
    });
    const kernel = createKernel({ target: null });
    const session = createSessionSampling({ config, random: () => 0, storage: memoryStore(), storeKey: 'perf-1' });
    createSamplingProcessor({ kernel, config, session, random: () => 0 });
    expect(kernel.pipeline.size('sample')).toBeGreaterThanOrEqual(1);

    const makeEvent = (): { event_name: string; priority: 'normal'; occurred_at: number } => ({
      event_name: 'editor_save',
      priority: 'normal',
      occurred_at: 1,
    });
    for (let index = 0; index < 1_000; index += 1) kernel.pipeline.process(makeEvent());

    const samples: number[] = [];
    for (let index = 0; index < 5_000; index += 1) {
      const start = performance.now();
      kernel.pipeline.process(makeEvent());
      samples.push(performance.now() - start);
    }
    expect(median(samples)).toBeLessThanOrEqual(0.05);
  });
});
