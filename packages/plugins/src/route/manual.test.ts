/**
 * C05-AC-09 Hash 模式与手动模式。
 *
 * 口径（`tests/acceptance/C05.md` 原文）：「Hash 变化上报；手动模式只在业务调用时上报」。
 * 裁定（T18-plan §3）：自动路由默认**开启**；关闭后 `setPage` 仍可用。
 */
import { describe, expect, it } from 'vitest';

import { createRouteCapture } from './index';

/** 收集原生监听并允许手动触发。 */
function listenHarness(): {
  listeners: Map<string, (() => void)[]>;
  listen: (type: string, handler: () => void) => () => void;
} {
  const listeners = new Map<string, (() => void)[]>();
  return {
    listeners,
    listen: (type, handler) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
      return () => undefined;
    },
  };
}

describe('C05-AC-09 Hash 变化上报 + 手动模式不自动上报', () => {
  it('hashchange 通知一次，路径取 # 之后的片段', () => {
    const harness = listenHarness();
    const changes: string[] = [];

    const capture = createRouteCapture({
      listen: harness.listen,
      currentUrl: () => ({ pathname: '/', hash: '#/task/123' }),
      now: () => 1_700_000_000_000,
      options: { mode: 'hash', templates: ['/task/:id'] },
    });
    capture.onRouteChange((change) => {
      changes.push(change.path);
    });

    for (const handler of harness.listeners.get('hashchange') ?? []) handler();

    expect(changes, 'hash 变化必须上报一次').toHaveLength(1);
    expect(changes[0]).toContain('/task/123');
  });

  it('手动模式下不安装路由监听，只有 setPage 才通知', () => {
    const harness = listenHarness();
    const changes: string[] = [];

    const capture = createRouteCapture({
      listen: harness.listen,
      currentUrl: () => ({ pathname: '/manual', hash: '' }),
      now: () => 1_700_000_000_000,
      options: { mode: 'manual' },
    });
    capture.onRouteChange((change) => {
      changes.push(change.path);
    });

    expect(harness.listeners.get('popstate'), '手动模式不得监听 popstate').toBeUndefined();
    expect(harness.listeners.get('hashchange'), '手动模式不得监听 hashchange').toBeUndefined();
    expect(changes).toHaveLength(0);

    capture.setPage('/manual/page-a');
    expect(changes, '手动模式只在业务调用时上报').toEqual(['/manual/page-a']);
  });
});
