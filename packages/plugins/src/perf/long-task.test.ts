/**
 * C05-AC-06 长任务用例：页面上制造一个 120 ms 的长任务 → 上报 `web_long_task`，
 * `duration_ms` 约为 120（容差 90–150 ms，见 T18-plan §8）。
 *
 * 注意：`web_long_task` 的 `dimensions` 是空对象 schema，**不得塞任何字段**。
 */
import { describe, expect, it } from 'vitest';

import { LONG_TASK_EVENT_NAME, createPerfCapture } from './index';
import type { LongTaskEvent, PerfObserverCallback, PerfObserverLike } from './index';

describe('C05-AC-06 长任务上报 duration_ms', () => {
  it('120 ms 的长任务产出 web_long_task，duration_ms 落在 90–150 容差内且 dimensions 为空', () => {
    const longTasks: LongTaskEvent[] = [];
    const observed: string[] = [];
    let callback: PerfObserverCallback | undefined;

    createPerfCapture(
      {
        vitals: () => undefined,
        longTask: (event) => {
          longTasks.push(event);
        },
      },
      {
        createObserver: (cb): PerfObserverLike => {
          callback = cb;
          return {
            observe(options): void {
              observed.push(options.type);
            },
            disconnect(): void {
              // 本用例不关心断开
            },
          };
        },
        now: () => 1_700_000_000_000,
      },
    );

    expect(observed, '必须观察 longtask 条目').toContain('longtask');
    expect(callback, '必须把回调交给注入的观察者').toBeDefined();
    callback?.({
      getEntries: () => [{ entryType: 'longtask', name: 'self', startTime: 340, duration: 120 }],
    });

    expect(longTasks, '应上报一条 web_long_task').toHaveLength(1);
    const event = longTasks[0];
    expect(event?.event_name).toBe(LONG_TASK_EVENT_NAME);
    expect(event?.metrics.duration_ms).toBeGreaterThanOrEqual(90);
    expect(event?.metrics.duration_ms).toBeLessThanOrEqual(150);
    expect(event?.dimensions, 'dimensions 必须是空对象').toEqual({});
  });
});

/**
 * 覆盖缺口（T33 §11.8 第 3 处）：`web_long_task.occurred_at` 必须来自注入的 `now` 端口。
 *
 * 判别口径：注入**不可能自然出现**的 `4102444800000`（2100-01-01T00:00:00Z），
 * 断言产出的 `occurred_at` **等于该注入值**。既有用例只断言条数 /
 * `duration_ms`（取自条目）/ 空 `dimensions`，因此插件面接线错误不会变红。
 */
describe('C05-AC-06 web_long_task.occurred_at 必须来自注入的 now', () => {
  it('长任务事件的 occurred_at 等于注入值 4102444800000', () => {
    const injectedNow = 4_102_444_800_000;
    const longTasks: LongTaskEvent[] = [];
    let callback: PerfObserverCallback | undefined;

    createPerfCapture(
      {
        vitals: () => undefined,
        longTask: (event) => {
          longTasks.push(event);
        },
      },
      {
        createObserver: (cb): PerfObserverLike => {
          callback = cb;
          return {
            observe: () => undefined,
            disconnect: () => undefined,
          };
        },
        now: () => injectedNow,
      },
    );

    callback?.({
      getEntries: () => [{ entryType: 'longtask', name: 'self', startTime: 340, duration: 120 }],
    });

    expect(longTasks, '应上报一条 web_long_task').toHaveLength(1);
    expect(
      longTasks[0]?.occurred_at,
      `occurred_at 必须是注入 now 的返回值 ${String(injectedNow)}（Date.now 或丢弃返回值都会在此变红）`,
    ).toBe(injectedNow);
  });
});
