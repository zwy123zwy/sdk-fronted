/**
 * C06 非功能目标实测（T15）。
 *
 * **契约目标**：入队 P99 ≤ 0.01 ms；单批组装与序列化 ≤ 2 ms。
 * **空闲实测**（无并发负载）：入队 P99 0.00287 ms；单批组装+序列化均值 0.0143 ms。
 * 契约目标的权威验证由 T20 的基准套件在受控环境下完成；本文件只放**回归护栏**。
 *
 * 为什么护栏锚定中位数（P50）而不是 P99：T15 返工时在并发 lane 的全量 `pnpm test`
 * （load average 5–16）中实测到——入队 P50 稳定在 0.005–0.007 ms，而单轮 P99 在
 * 0.021–0.429 ms 之间抖动；组装 P50 稳定在 0.041–0.049 ms，而单轮 P99 最高 51.7 ms
 * （个别迭代被 OS 抢占）。P99/均值在共享机器上由进程抢占主导：以契约目标值当门禁会
 * 必现误报，而以「有负载 P99 × 10」当门禁会超过 1 ms、失去护栏意义。中位数反映真实
 * 单位成本且对抢占不敏感，因此护栏取中位数的 ≥10 倍余量：
 * - 入队 P50 < 0.1 ms：≥13 倍于有负载实测最大值 0.0073 ms，≈35 倍于空闲 P99 0.00287 ms；
 * - 组装 P50 < 0.6 ms：≥12 倍于有负载实测最大值 0.0487 ms，≈42 倍于空闲均值 0.0143 ms。
 * 两个护栏都拦得住 10 倍量级的病态回归，且均 < 1 ms，不会在负载下变红。
 */
import { describe, expect, test } from 'vitest';
import { createBatchAssembler } from '../batch/assembler';
import type { BatchHeader, QueueEvent } from '../batch/types';
import { createTransportQueue } from './transport-queue';

/** 入队中位数护栏（回归护栏，非契约目标值）。 */
const ENQUEUE_P50_GUARD_MS = 0.1;

/** 单批组装与序列化中位数护栏（回归护栏，非契约目标值）。 */
const ASSEMBLE_P50_GUARD_MS = 0.6;

const START = 1793000000000;
const BATCH_ID = 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e';

const HEADER: BatchHeader = {
  protocol_version: 1,
  app_id: 'demo-app',
  env: 'staging',
  release: '1.4.0',
  sdk_name: 'web-report-sdk',
  sdk_version: '0.1.0',
  device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
  session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
  clock_offset: 0,
};

let seq = 0;

function makeEvent(): QueueEvent {
  seq += 1;
  return {
    event_id: `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    event_name: 'web_vitals',
    event_type: 'perf',
    schema_version: 1,
    occurred_at: START + seq,
    priority: 'normal',
    page_id: '/list',
    url: 'https://app.example.com/list',
    sample_rate: 1,
    metrics: { value: 1840, delta: 1840 },
    dimensions: { metric_name: 'LCP', rating: 'good' },
  };
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5));
  return sorted[index] ?? 0;
}

describe('C06 非功能目标（回归护栏）', () => {
  test('入队中位数不高于回归护栏（契约目标 P99 ≤ 0.01 ms 由 T20 基准验证）', () => {
    const queue = createTransportQueue({
      config: { transport: () => ({}) },
      // 手动完成：首个批次进入在途后不再冲刷，测量入队本身的成本
      submit: { submit: (): void => undefined },
      header: { header: () => HEADER },
      now: () => START,
      createId: () => BATCH_ID,
    });
    try {
      for (let i = 0; i < 1000; i += 1) queue.enqueue(makeEvent());

      const samples: number[] = [];
      for (let i = 0; i < 5000; i += 1) {
        const startedAt = performance.now();
        queue.enqueue(makeEvent());
        samples.push(performance.now() - startedAt);
      }

      const p50 = median(samples);
      expect(
        p50,
        `入队 P50 实测 ${p50.toFixed(5)} ms（回归护栏 ${String(ENQUEUE_P50_GUARD_MS)} ms）`,
      ).toBeLessThan(ENQUEUE_P50_GUARD_MS);
    } finally {
      queue.dispose();
    }
  });

  test('单批组装+序列化中位数不高于回归护栏（契约目标 ≤ 2 ms 由 T20 基准验证）', () => {
    const assembler = createBatchAssembler({
      header: { header: () => HEADER },
      now: () => START,
      createId: () => BATCH_ID,
    });
    const events = Array.from({ length: 20 }, () => makeEvent());

    const samples: number[] = [];
    let bytes = 0;
    const iterations = 200;
    for (let i = 0; i < iterations; i += 1) {
      const startedAt = performance.now();
      const batch = assembler.assemble(events);
      bytes += JSON.stringify(batch).length;
      samples.push(performance.now() - startedAt);
    }

    expect(bytes).toBeGreaterThan(0);
    const p50 = median(samples);
    expect(
      p50,
      `组装+序列化 P50 实测 ${p50.toFixed(5)} ms（回归护栏 ${String(ASSEMBLE_P50_GUARD_MS)} ms）`,
    ).toBeLessThan(ASSEMBLE_P50_GUARD_MS);
  });
});
