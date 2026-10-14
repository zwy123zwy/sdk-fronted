/**
 * C05-AC-09 Hash 模式：`hashchange` 上报一次 `web_pageview`。
 *
 * 覆盖 Hash 模式的 `page_id` 取值口径：取 `#` 之后的片段再匹配模板。
 */
import { describe, expect, it } from 'vitest';

import { createRouteCapture } from './index';
import type { RouteChange } from './index';

describe('C05-AC-09 Hash 变化上报', () => {
  it('hashchange 触发一次通知，模板匹配作用在 hash 片段上', () => {
    const handlers: (() => void)[] = [];
    const changes: RouteChange[] = [];

    const capture = createRouteCapture({
      listen: (type, handler) => {
        expect(type).toBe('hashchange');
        handlers.push(handler);
        return () => undefined;
      },
      currentUrl: () => ({ pathname: '/app', hash: '#/task/42' }),
      now: () => 1_700_000_000_000,
      options: { mode: 'hash', templates: ['/task/:id'] },
    });
    capture.onRouteChange((change) => {
      changes.push(change);
    });

    expect(handlers, 'hash 模式必须监听 hashchange').toHaveLength(1);
    for (const handler of handlers) handler();

    expect(changes).toHaveLength(1);
    expect(changes[0]?.template).toBe('/task/:id');
    expect(changes[0]?.via).toBe('hash');
  });

  it('注销监听后不再通知', () => {
    const handlers: (() => void)[] = [];
    const changes: number[] = [];
    const capture = createRouteCapture({
      listen: (_type, handler) => {
        handlers.push(handler);
        return () => undefined;
      },
      currentUrl: () => ({ pathname: '/app', hash: '#/a' }),
      options: { mode: 'hash' },
    });
    const off = capture.onRouteChange(() => {
      changes.push(1);
    });
    off();
    for (const handler of handlers) handler();
    expect(changes, '注销后不得再收到通知').toHaveLength(0);
  });
});
