/**
 * C05-F1 错误插件的边界与接线用例（补齐内核上下文路径与分支）。
 *
 * 覆盖：监听驱动（`error` / `unhandledrejection` 事件对象）、资源加载错误（可选）、
 * `reportRepeats`、`globalContext` 合并、面包屑的元素标识分支、去重器的窗口排序与重置。
 */
import { describe, expect, it } from 'vitest';

import {
  BREADCRUMB_CAPACITY,
  BREADCRUMB_CONTEXT_PREFIX,
  ERROR_PLUGIN_ID,
  createBreadcrumbBuffer,
  createDeduplicator,
  createErrorPlugin,
  decodeBreadcrumbs,
  describeElement,
  encodeBreadcrumbs,
} from './index';
import type { JsErrorEvent } from './index';

/** 记录型上下文（含 counters），返回监听表。 */
function createContext(): {
  context: Record<string, unknown>;
  listeners: Map<string, ((event: Event) => void)[]>;
  counts: Map<string, number>;
} {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const counts = new Map<string, number>();
  return {
    listeners,
    counts,
    context: {
      pluginId: ERROR_PLUGIN_ID,
      counters: {
        count: (reason: string, delta = 1): void => {
          counts.set(reason, (counts.get(reason) ?? 0) + delta);
        },
        get: () => 0,
        snapshot: () => ({}),
        reset: () => undefined,
      },
      pipeline: { register: () => () => undefined, process: () => ({}), size: () => 0, dispose: () => undefined },
      registry: {
        listen: () => () => undefined,
        listenGlobal: () => () => undefined,
        hook: () => () => undefined,
        schedule: () => () => undefined,
        scheduleRepeat: () => () => undefined,
        stats: () => ({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 }),
        dispose: () => undefined,
      },
      capabilities: {
        register: () => () => undefined,
        has: () => false,
        get: () => undefined,
        names: () => [],
        dispose: () => undefined,
      },
      addProcessor: () => () => undefined,
      listen: (type: string, handler: (event: Event) => void): (() => void) => {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
        return () => undefined;
      },
      hook: () => () => undefined,
      schedule: () => () => undefined,
      scheduleRepeat: () => () => undefined,
      registerCapability: () => () => undefined,
      onDispose: () => undefined,
    },
  };
}

describe('C05-F1 监听驱动路径', () => {
  it('error 事件对象（message/lineno/colno/error）被归一化；unhandledrejection 走 reason', () => {
    const events: JsErrorEvent[] = [];
    const harness = createContext();
    const plugin = createErrorPlugin((event) => events.push(event));
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);

    const errorEvent = {
      type: 'error',
      message: 'Uncaught TypeError: from listener',
      lineno: 7,
      colno: 9,
      error: new TypeError('from listener'),
    } as unknown as Event;
    for (const handler of harness.listeners.get('error') ?? []) handler(errorEvent);

    const rejectionEvent = { type: 'unhandledrejection', reason: 'string reason' } as unknown as Event;
    for (const handler of harness.listeners.get('unhandledrejection') ?? []) handler(rejectionEvent);

    plugin.capture.flush();
    expect(events).toHaveLength(2);
    expect(events[0]?.dimensions.error_type).toBe('TypeError');
    expect(events[0]?.metrics.line).toBe(7);
    expect(events[0]?.metrics.column).toBe(9);
    expect(events[1]?.dimensions.source).toBe('unhandled_rejection');
  });

  it('captureResourceErrors 开启时资源元素上的 error 事件记为 resource_error', () => {
    const events: JsErrorEvent[] = [];
    const harness = createContext();
    const plugin = createErrorPlugin((event) => events.push(event), { captureResourceErrors: true });
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);

    const img = document.createElement('img');
    const resourceEvent = { type: 'error', target: img } as unknown as Event;
    for (const handler of harness.listeners.get('error') ?? []) handler(resourceEvent);

    plugin.capture.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.dimensions.error_type).toBe('resource_error');
    expect(events[0]?.dimensions.message).toContain('img');
  });

  it('默认（不开启）时资源元素上的 error 事件仍按未捕获异常处理，不会误记为资源错误', () => {
    const events: JsErrorEvent[] = [];
    const harness = createContext();
    const plugin = createErrorPlugin((event) => events.push(event));
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);

    const img = document.createElement('img');
    for (const handler of harness.listeners.get('error') ?? []) {
      handler({ type: 'error', target: img, message: 'load failed' } as unknown as Event);
    }
    plugin.capture.flush();
    expect(events[0]?.dimensions.error_type).not.toBe('resource_error');
  });

  it('click 面包屑由监听驱动，且输入框只记标签', () => {
    const harness = createContext();
    const plugin = createErrorPlugin(() => undefined);
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);

    const input = document.createElement('input');
    input.value = 'user-typed-secret-9999';
    const button = document.createElement('button');
    button.setAttribute('data-testid', 'go');
    for (const handler of harness.listeners.get('click') ?? []) {
      handler({ type: 'click', target: input } as unknown as Event);
      handler({ type: 'click', target: button } as unknown as Event);
      // 没有 tagName 的 target（如 window）必须被忽略而不是抛错
      handler({ type: 'click', target: null } as unknown as Event);
    }
    const crumbs = plugin.capture.breadcrumbs().snapshot();
    expect(crumbs).toHaveLength(2);
    expect(JSON.stringify(crumbs)).not.toContain('user-typed-secret-9999');
    expect(crumbs[1]?.target).toBe('button#go');
  });
});

describe('C05-F1 配置分支', () => {
  it('reportRepeats 开启时窗口内每条都上报，count 为累计值', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event), { reportRepeats: true });
    plugin.install(createContext().context as unknown as Parameters<typeof plugin.install>[0]);
    for (let index = 0; index < 3; index += 1) {
      plugin.capture.handleWindowError('Uncaught Error: repeated', 1, 2, new Error('repeated'));
    }
    plugin.capture.flush();
    // 开启时**不再折叠**：窗口内的 3 次出现各上报一条，第 i 条 count=i（最后一条即总次数）。
    expect(events.map((event) => event.metrics.count)).toEqual([1, 2, 3]);
    // 开启时没有任何重复被过滤，故不得计 `filtered_by_plugin`，也不得计入 collapsed。
    expect(plugin.capture.stats()).toEqual({ reported: 3, collapsed: 0 });
  });

  it('对照：reportRepeats 关闭（缺省）时同一输入只上报一条、count 为总次数', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event));
    plugin.install(createContext().context as unknown as Parameters<typeof plugin.install>[0]);
    for (let index = 0; index < 3; index += 1) {
      plugin.capture.handleWindowError('Uncaught Error: repeated', 1, 2, new Error('repeated'));
    }
    plugin.capture.flush();
    expect(events.map((event) => event.metrics.count)).toEqual([3]);
    expect(plugin.capture.stats()).toEqual({ reported: 1, collapsed: 2 });
  });

  it('sources 白名单：不在清单里的采集源既不归一化也不上报', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event), {
      sources: ['window_error'],
    });
    const harness = createContext();
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);
    plugin.capture.handleWindowError('Uncaught Error: kept', 1, 2, new Error('kept'));
    plugin.capture.handleRejection(new Error('dropped by sources'));
    plugin.capture.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.dimensions.source).toBe('window_error');
  });

  it('sources 为空数组时不采集任何源（含自动监听路径）', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event), { sources: [] });
    const harness = createContext();
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);
    for (const handler of harness.listeners.get('error') ?? []) {
      handler({ type: 'error', message: 'from listener', error: new Error('from listener') } as unknown as Event);
    }
    plugin.capture.capture(new Error('manual'));
    plugin.capture.flush();
    expect(events).toHaveLength(0);
  });

  it('sources 未配置时全部内置源都参与（window_error 与 unhandled_rejection）', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event));
    plugin.install(createContext().context as unknown as Parameters<typeof plugin.install>[0]);
    plugin.capture.handleWindowError('Uncaught Error: a', 1, 2, new Error('a'));
    plugin.capture.handleRejection(new Error('b'));
    plugin.capture.flush();
    expect(events.map((event) => event.dimensions.source).sort()).toEqual([
      'unhandled_rejection',
      'window_error',
    ]);
  });

  it('globalContext 注入的全局上下文与面包屑合并在同一 context 上（不丢任一方）', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event), {
      globalContext: () => ({ tenant: 'acme' }),
    });
    plugin.install(createContext().context as unknown as Parameters<typeof plugin.install>[0]);
    plugin.capture.breadcrumbs().push(document.createElement('button'), 'click');
    plugin.capture.handleWindowError('Uncaught Error: with context', 1, 2, new Error('ctx'));
    plugin.capture.flush();

    const context = events[0]?.context ?? {};
    expect(context['tenant']).toBe('acme');
    expect(Object.keys(context).filter((key) => key.startsWith(BREADCRUMB_CONTEXT_PREFIX))).toHaveLength(1);
  });

  it('无 globalContext、无面包屑时不写 context 键（避免空对象占位）', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event));
    plugin.install(createContext().context as unknown as Parameters<typeof plugin.install>[0]);
    plugin.capture.handleWindowError('Uncaught Error: bare', 1, 2, new Error('bare'));
    plugin.capture.flush();
    expect(events[0]?.context).toBeUndefined();
  });

  it('卸载时先结算未到期窗口，并把监听注销掉', () => {
    const events: JsErrorEvent[] = [];
    const plugin = createErrorPlugin((event) => events.push(event));
    const harness = createContext();
    plugin.install(harness.context as unknown as Parameters<typeof plugin.install>[0]);
    plugin.capture.handleWindowError('Uncaught Error: uninstall settle', 1, 2, new Error('x'));
    expect(events).toHaveLength(0);
    plugin.capture.uninstall();
    expect(events).toHaveLength(1);
    // 幂等
    expect(() => {
      plugin.capture.uninstall();
    }).not.toThrow();
  });
});

describe('C05-F1 面包屑与指纹的边界', () => {
  it('describeElement 覆盖 data-track / data-testid / id / 仅标签四种形态', () => {
    const track = document.createElement('button');
    track.setAttribute('data-track', 'submit');
    expect(describeElement(track)).toBe('button[submit]');

    const testId = document.createElement('button');
    testId.setAttribute('data-testid', 'go');
    expect(describeElement(testId)).toBe('button#go');

    const withId = document.createElement('div');
    withId.setAttribute('id', 'panel');
    expect(describeElement(withId)).toBe('div#panel');

    expect(describeElement(document.createElement('span'))).toBe('span');
  });

  it('容量环绕：超过 20 条后只保留最近 20 条且顺序正确', () => {
    let tick = 0;
    const buffer = createBreadcrumbBuffer(() => {
      tick += 1;
      return tick;
    });
    const button = document.createElement('button');
    for (let index = 0; index < 25; index += 1) buffer.push(button, `action-${String(index)}`);
    const crumbs = buffer.snapshot();
    expect(crumbs).toHaveLength(BREADCRUMB_CAPACITY);
    expect(crumbs[0]?.type).toBe('action-5');
    expect(crumbs[19]?.type).toBe('action-24');
    expect(crumbs[19]?.at).toBe(25);

    buffer.clear();
    expect(buffer.snapshot()).toHaveLength(0);
    buffer.pushBreadcrumb({ type: 'custom', target: 'x', at: 1 });
    expect(buffer.snapshot()).toHaveLength(1);
  });

  it('pushRoute 去掉查询参数与 hash；encode/decode 往返一致', () => {
    const buffer = createBreadcrumbBuffer(() => 1);
    buffer.pushRoute('/task/42?token=fake-token-abcdef#section');
    const crumbs = buffer.snapshot();
    expect(crumbs[0]?.target).toBe('/task/42');
    expect(crumbs[0]?.type).toBe('route');

    const encoded = encodeBreadcrumbs(crumbs);
    expect(decodeBreadcrumbs(encoded)).toEqual(['route|/task/42']);
    expect(decodeBreadcrumbs(undefined)).toEqual([]);
  });

  it('去重器：due 按首次出现时间排序、takeAll 清空、reset 生效', () => {
    const dedup = createDeduplicator<string>({ windowMs: 10 });
    dedup.observe('b', 'second', 200);
    dedup.observe('a', 'first', 100);
    dedup.observe('c', 'third', 300);
    expect(dedup.due(310)).toEqual(['a', 'b', 'c']);
    expect(dedup.size()).toBe(3);
    const settled = dedup.takeAll();
    expect(settled.map((entry) => entry.fingerprint)).toEqual(['a', 'b', 'c']);
    expect(dedup.size()).toBe(0);

    dedup.observe('x', 'v', 1);
    dedup.reset();
    expect(dedup.size()).toBe(0);
    expect(dedup.take('x')).toBeUndefined();
  });
});
