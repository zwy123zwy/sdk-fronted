/**
 * C08-F2 的耗时采样用例：
 * - 1% 会话判定（注入 `random`，确定性）；
 * - nearest-rank P99 聚合（确定性、无墙钟）；
 * - 未命中采样时 `record` 无副作用、`take` 返回空（因此不产生耗时字段）。
 */
import { describe, expect, test } from 'vitest';
import { createLatencyWindow, createSessionSampler, nearestRankPercentile } from './latency';

describe('nearestRankPercentile', () => {
  test('空样本返回 null', () => {
    expect(nearestRankPercentile([], 0.99)).toBeNull();
  });

  test('单样本返回该样本', () => {
    expect(nearestRankPercentile([7], 0.99)).toBe(7);
  });

  test('n=100 时 P99 为升序第 99 个', () => {
    const values = Array.from({ length: 100 }, (_item, index) => index + 1);
    expect(nearestRankPercentile([...values].reverse(), 0.99)).toBe(99);
  });

  test('样本数小于 100 时 P99 等于最大值', () => {
    for (let count = 1; count <= 40; count += 1) {
      const values = Array.from({ length: count }, (_item, index) => index * 3);
      expect(nearestRankPercentile(values, 0.99), `n=${String(count)}`).toBe((count - 1) * 3);
    }
  });

  test('输入不被就地排序', () => {
    const values = [3, 1, 2];
    nearestRankPercentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('createSessionSampler（1% 会话）', () => {
  test('random 小于 rate 时命中', () => {
    const sampler = createSessionSampler({ random: () => 0.005, rate: 0.01 });
    expect(sampler.sampled()).toBe(true);
    expect(sampler.rate()).toBe(0.01);
  });

  test('random 不小于 rate 时未命中', () => {
    const sampler = createSessionSampler({ random: () => 0.5, rate: 0.01 });
    expect(sampler.sampled()).toBe(false);
  });

  test('判定只在首次调用时做一次（会话级，不逐事件抖动）', () => {
    let calls = 0;
    const sampler = createSessionSampler({
      random: () => {
        calls += 1;
        return calls === 1 ? 0.001 : 0.9;
      },
      rate: 0.01,
    });
    expect(sampler.sampled()).toBe(true);
    expect(sampler.sampled()).toBe(true);
    expect(calls).toBe(1);
  });

  test('缺省采样率为 1%，非法采样率被规整到 [0,1]', () => {
    expect(createSessionSampler({ random: () => 0 }).rate()).toBe(0.01);
    expect(createSessionSampler({ rate: -1, random: () => 0 }).sampled()).toBe(false);
    expect(createSessionSampler({ rate: Number.NaN, random: () => 0 }).sampled()).toBe(false);
    expect(createSessionSampler({ rate: 5, random: () => 0.9 }).sampled()).toBe(true);
  });
});

describe('createLatencyWindow', () => {
  test('未命中采样：record 无副作用，take 返回空对象', () => {
    const window = createLatencyWindow({ sampled: false });
    window.record('track', 12);
    expect(window.p99('track')).toBeNull();
    expect(window.take()).toEqual({});
    expect(window.sampled).toBe(false);
  });

  test('命中采样：按阶段给出 P99，take 后清零', () => {
    const window = createLatencyWindow({ sampled: true });
    for (let index = 1; index <= 100; index += 1) {
      window.record('track', index);
      window.record('pipeline', index * 2);
    }
    window.record('serialize', 5);
    expect(window.p99('track')).toBe(99);
    expect(window.p99('pipeline')).toBe(198);
    expect(window.p99('serialize')).toBe(5);
    const taken = window.take();
    expect(taken).toEqual({ track: 99, pipeline: 198, serialize: 5 });
    expect(window.take()).toEqual({});
    expect(window.p99('track')).toBeNull();
  });

  test('非法耗时（NaN / Infinity / 负数）被忽略', () => {
    const window = createLatencyWindow({ sampled: true });
    window.record('track', Number.NaN);
    window.record('track', Number.POSITIVE_INFINITY);
    window.record('track', -1);
    window.record('track', 4);
    expect(window.take()).toEqual({ track: 4 });
  });

  test('容量上限只保留最近 N 个样本', () => {
    const window = createLatencyWindow({ sampled: true, capacity: 5 });
    for (const value of [1, 2, 3, 4, 5, 6, 7]) {
      window.record('track', value);
    }
    expect(window.p99('track')).toBe(7);
  });

  test('reset 清空全部阶段', () => {
    const window = createLatencyWindow({ sampled: true });
    window.record('track', 1);
    window.reset();
    expect(window.take()).toEqual({});
  });
});
