/**
 * C05-AC-14 关闭开关用例：远程配置关闭性能插件 → **性能观察器断开**，之后不再上报性能事件。
 *
 * 与 C03 的一致性：运行期**只能关不能开**；关闭动作由装配根翻译成对采集端口的卸载。
 */
import { describe, expect, it } from 'vitest';

import { createPerfCapture } from './index';
import type { PerfEntryLike, PerfObserverCallback, PerfObserverLike } from './index';

describe('C05-AC-14 关闭后 observer 断开且不再上报', () => {
  it('卸载后 disconnect 被调用，再投递条目也不产出事件', () => {
    const disconnects: number[] = [];
    const vitals: number[] = [];
    let callback: PerfObserverCallback | undefined;

    const capture = createPerfCapture(
      {
        vitals: () => {
          vitals.push(1);
        },
        longTask: () => {
          vitals.push(1);
        },
      },
      {
        createObserver: (cb): PerfObserverLike => {
          callback = cb;
          const index = disconnects.length;
          disconnects.push(0);
          return {
            observe(): void {
              // 记录条目类型
            },
            disconnect(): void {
              disconnects[index] = (disconnects[index] ?? 0) + 1;
            },
          };
        },
        now: () => 1_700_000_000_000,
      },
    );

    const entries: readonly PerfEntryLike[] = [
      { entryType: 'largest-contentful-paint', name: '', startTime: 100, duration: 0 },
    ];
    callback?.({ getEntries: () => entries });
    const before = vitals.length;

    // 远程配置关闭 perf：装配根调用采集端口的卸载
    capture.uninstall();

    expect(disconnects.some((count) => count > 0), 'observer.disconnect 必须被调用').toBe(true);
    callback?.({ getEntries: () => entries });
    expect(vitals.length, '关闭后不得再产出性能事件').toBe(before);

    // 重复卸载幂等
    expect(() => {
      capture.uninstall();
    }).not.toThrow();
  });
});
