/**
 * C06 非功能目标：入队 P99 ≤ 0.01 ms，单批组装与序列化 ≤ 2 ms。
 * 说明：入队微基准使用真实计时器（假定时器不会推进 performance.now），
 * 并在首个批次进入在途后测量，避免冲刷本身干扰样本。
 */
import { describe, expect, test } from 'vitest';
import { createBatchAssembler } from '../batch/assembler';
import type { BatchHeader, QueueEvent } from '../batch/types';
import { createTransportQueue } from './transport-queue';

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

function percentile(samples: readonly number[], ratio: number): number {
  const index = Math.min(samples.length - 1, Math.floor(samples.length * ratio));
  const value = samples[index];
  return value ?? 0;
}

describe('C06 非功能目标', () => {
  test('入队 P99 不超过 0.01 ms（5000 条，队列达到 500 条上限后持续淘汰）', () => {
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

      samples.sort((left, right) => left - right);
      expect(percentile(samples, 0.99)).toBeLessThan(0.01);
    } finally {
      queue.dispose();
    }
  });

  test('单批组装与序列化不超过 2 ms（20 条事件，200 次取均值）', () => {
    const assembler = createBatchAssembler({
      header: { header: () => HEADER },
      now: () => START,
      createId: () => BATCH_ID,
    });
    const events = Array.from({ length: 20 }, () => makeEvent());

    let elapsed = 0;
    let bytes = 0;
    const iterations = 200;
    for (let i = 0; i < iterations; i += 1) {
      const startedAt = performance.now();
      const batch = assembler.assemble(events);
      bytes += JSON.stringify(batch).length;
      elapsed += performance.now() - startedAt;
    }

    expect(bytes).toBeGreaterThan(0);
    expect(elapsed / iterations).toBeLessThan(2);
  });
});
