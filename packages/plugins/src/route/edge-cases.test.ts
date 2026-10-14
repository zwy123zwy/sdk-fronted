/**
 * C05-F3 路由插件的边界与降级用例（补齐模板匹配、无监听降级、手动模式与引用捕获）。
 */
import { describe, expect, it } from 'vitest';

import { createInlineHooker } from '../internal/hooker';
import {
  ROUTE_PLUGIN_ID,
  captureNativeHistoryRefs,
  createMatcher,
  createRouteCapture,
  createRoutePlugin,
  matchTemplate,
  stripQuery,
} from './index';
import type { HistoryPort } from './index';

/** 可编程的伪造 history。 */
function createHistory(): {
  history: HistoryPort;
  calls: string[];
  original: (data: unknown, unused: string, url?: string | URL | null) => void;
} {
  const calls: string[] = [];
  const original = (): void => {
    calls.push('original');
  };
  return { history: { pushState: original, replaceState: original }, calls, original };
}

describe('C05-AC-08/09 模板匹配的边界', () => {
  it('stripQuery 同时去掉查询参数与 hash，且对无参数路径原样返回', () => {
    expect(stripQuery('/a/b?x=1#h')).toBe('/a/b');
    expect(stripQuery('/a/b#h')).toBe('/a/b');
    expect(stripQuery('/a/b')).toBe('/a/b');
  });

  it('matchTemplate：命中首个模板、未命中回落去参路径、正则特殊字符按字面量处理', () => {
    expect(matchTemplate('/task/123', ['/task/:id'])).toBe('/task/:id');
    expect(matchTemplate('/task/123/detail', ['/task/:id', '/task/:id/detail'])).toBe('/task/:id/detail');
    expect(matchTemplate('/unknown/9', ['/task/:id'])).toBe('/unknown/9');
    expect(matchTemplate('/a.b/1', ['/a.b/:id'])).toBe('/a.b/:id');
    expect(matchTemplate('/a/1?token=fake-token', [])).toBe('/a/1');
    // `:param` 只匹配单段，不跨 `/`
    expect(matchTemplate('/task/1/2', ['/task/:id'])).toBe('/task/1/2');
    const matcher = createMatcher(['/task/:id']);
    expect(matcher('/task/9')).toBe('/task/:id');
  });
});

describe('C05-AC-08/09 降级与手动路径', () => {
  it('没有注入 listen 时不监听（不抛错），popstate 变化不会上报', () => {
    const fake = createHistory();
    const changes: string[] = [];
    const capture = createRouteCapture({
      history: fake.history,
      hooker: createInlineHooker(),
      now: () => 1_700_000_000_000,
      options: { mode: 'history' },
    });
    capture.onRouteChange((change) => changes.push(change.via));
    // 包装仍然生效（pushState 变化可通知）
    fake.history.pushState({}, '', '/a');
    expect(changes).toEqual(['push']);
    capture.uninstall();
    expect(fake.history.pushState).toBe(fake.original);
  });

  it('未注入 history/hooker 时用内存实现降级包装，卸载幂等', () => {
    const fake = createHistory();
    const capture = createRouteCapture({ history: fake.history, options: { mode: 'history' } });
    const patched = fake.history.pushState;
    expect(patched).not.toBe(fake.original);
    capture.uninstall();
    expect(fake.history.pushState).toBe(fake.original);
    expect(() => {
      capture.uninstall();
    }).not.toThrow();
  });

  it('hash 模式使用 location.hash 片段并去掉查询参数；注销监听后不再通知', () => {
    const handlers: (() => void)[] = [];
    const changes: string[] = [];
    const capture = createRouteCapture({
      listen: (type, handler) => {
        expect(type).toBe('hashchange');
        handlers.push(handler);
        return () => undefined;
      },
      currentUrl: () => ({ pathname: '/app', hash: '#/task/5?token=fake-token-abcdef' }),
      now: () => 1,
      options: { mode: 'hash', templates: ['/task/:id'] },
    });
    const off = capture.onRouteChange((change) => changes.push(change.template));
    for (const handler of handlers) handler();
    expect(changes).toEqual(['/task/:id']);
    off();
    for (const handler of handlers) handler();
    expect(changes).toHaveLength(1);
  });

  it('手动模式不包装 history、不注册监听，只由 setPage 通知（并去掉查询参数）', () => {
    const fake = createHistory();
    const handlers: string[] = [];
    const changes: string[] = [];
    const capture = createRouteCapture({
      history: fake.history,
      listen: (type) => {
        handlers.push(type);
        return () => undefined;
      },
      now: () => 1,
      options: { mode: 'manual' },
    });
    capture.onRouteChange((change) => changes.push(`${change.via}|${change.path}`));
    expect(fake.history.pushState, '手动模式不得包装 pushState').toBe(fake.original);
    expect(handlers).toEqual([]);
    capture.setPage('/page/a?token=fake-token-abcdef#h');
    capture.setPage('/page/b');
    expect(changes).toEqual(['manual|/page/a', 'manual|/page/b']);
    expect(capture.stats().changes).toBe(2);
    expect(capture.stats().bySource.manual).toBe(2);
    expect(capture.mode).toBe('manual');
  });

  it('createRoutePlugin 的 id 与插件形状；install 后手动路径可用', () => {
    const changes: string[] = [];
    const plugin = createRoutePlugin({ now: () => 1, options: { mode: 'manual' } });
    plugin.install(undefined as never);
    plugin.capture.onRouteChange((change) => changes.push(change.path));
    plugin.capture.setPage('/x');
    expect(plugin.id).toBe(ROUTE_PLUGIN_ID);
    expect(changes).toEqual(['/x']);
  });

  it('captureNativeHistoryRefs 返回冻结的 history 容器（宿主有 history 时）', () => {
    const surface = captureNativeHistoryRefs();
    if (surface === undefined) {
      expect(typeof history).toBe('undefined');
      return;
    }
    expect(Object.isFrozen(surface)).toBe(true);
    expect(typeof surface.history.pushState).toBe('function');
  });
});
