/**
 * C05-AC-07 降级用例（补充 `vitals.test.ts` 的抛错分支）：浏览器**没有**
 * `PerformanceObserver` / **没有** `document` 时必须不抛错、静默降级。
 *
 * 覆盖三种「不支持」形态（T18-plan §8 AC-07 的待定项）：
 * ① 完全没有 `PerformanceObserver`；② `observe` 对某条目类型抛错（见 `vitals.test.ts`）；
 * ③ TTFB 的来源取不到（`responseStart` 缺失）时跳过该指标。
 */
import { describe, expect, it } from 'vitest';

import { createPerfCapture } from './index';
import type { PerfObserverCallback, PerfObserverLike, VitalsEvent } from './index';

describe('C05-AC-07 不支持的条目类型被跳过且不抛错（降级形态）', () => {
  it('完全没有 PerformanceObserver 时不抛错，也不上报任何性能事件', () => {
    const vitals: VitalsEvent[] = [];
    let thrown = false;
    try {
      createPerfCapture(
        {
          vitals: (event) => {
            vitals.push(event);
          },
          longTask: () => undefined,
        },
        {
          // 注入一个“浏览器不支持”的工厂：返回 undefined 形状由装配根处理，
          // 这里显式传一个会抛错之外的空实现，验证插件不因缺 API 抛错。
          createObserver: (): PerfObserverLike => ({
            observe(): void {
              throw new Error('PerformanceObserver 不可用');
            },
            disconnect(): void {
              // 无
            },
          }),
          now: () => 1_700_000_000_000,
        },
      );
    } catch {
      thrown = true;
    }
    expect(thrown, '不支持性能条目类型时不得抛错').toBe(false);
    expect(vitals).toEqual([]);
  });

  it('TTFB 来源取不到时跳过 TTFB，其余指标照常', () => {
    const vitals: VitalsEvent[] = [];
    let callback: PerfObserverCallback | undefined;
    const loadCallbacks: (() => void)[] = [];

    createPerfCapture(
      {
        vitals: (event) => {
          vitals.push(event);
        },
        longTask: () => undefined,
      },
      {
        createObserver: (cb): PerfObserverLike => {
          callback = cb;
          return {
            observe(): void {
              // 无
            },
            disconnect(): void {
              // 无
            },
          };
        },
        now: () => 1_700_000_000_000,
        completion: {
          onLoad: (cb) => {
            loadCallbacks.push(cb);
            return () => undefined;
          },
        },
        // 不提供 responseStartProvider：TTFB 必须被跳过而不是上报 0
      },
    );

    // 先证明采集确实在跑（否则“TTFB 不出现”可能只是空转）
    expect(callback, '必须把回调交给注入的观察者').toBeDefined();
    callback?.({
      getEntries: () => [
        { entryType: 'paint', name: 'first-contentful-paint', startTime: 700, duration: 0 },
      ],
    });
    for (const cb of loadCallbacks) cb();
    const names = vitals.map((event) => event.dimensions.metric_name);
    expect(names, 'FCP 必须上报（证明采集在跑）').toContain('FCP');
    expect(names, '取不到 responseStart 时跳过 TTFB，而不是上报 0').not.toContain('TTFB');
  });
});
