/**
 * C02-F6 全局注册表验收测试（C02-AC-12、C02-AC-13）。
 */
import { describe, expect, it, vi } from 'vitest';

import { createCounters, createGlobalRegistry, createKernel, definePlugin } from '../index';

type PushState = History['pushState'];

/** 读取自有属性值：避免直接引用方法本身（门禁禁止未绑定的方法引用）。 */
function ownValue(target: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

describe('C02-F6 全局注册表', () => {
  it('C02-AC-12 两个插件订阅同一原生事件时只安装一次监听且都收到事件', () => {
    const kernel = createKernel({ target: window });
    const addSpy = vi.spyOn(window, 'addEventListener');
    const received: string[] = [];

    try {
      kernel.registerPlugin(
        definePlugin({
          id: 'plugin_one',
          install: (ctx) => {
            ctx.listen('error', () => {
              received.push('plugin_one');
            });
          },
        }),
      );
      kernel.registerPlugin(
        definePlugin({
          id: 'plugin_two',
          install: (ctx) => {
            ctx.listen('error', () => {
              received.push('plugin_two');
            });
          },
        }),
      );

      kernel.init();
      kernel.start();
      kernel.applyPluginConfig({ plugin_one: true, plugin_two: true });

      expect(addSpy.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1);

      window.dispatchEvent(new Event('error'));
      expect(received).toEqual(['plugin_one', 'plugin_two']);
    } finally {
      addSpy.mockRestore();
    }
  });

  it('C02-AC-13 SDK 销毁后 hook 恢复为业务的包装函数而不是原生函数', () => {
    const kernel = createKernel({ target: window });
    const nativePush = ownValue(History.prototype, 'pushState') as PushState;
    const calls: string[] = [];
    const businessWrapper = function (
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      calls.push('business');
      nativePush.call(this, data, unused, url ?? null);
    };
    window.history.pushState = businessWrapper;

    try {
      kernel.init();
      kernel.start();

      kernel.registry.hook(window.history, 'pushState', (original) => {
        return function (this: History, data: unknown, unused: string, url?: string | URL | null): void {
          calls.push('sdk');
          original.call(this, data, unused, url ?? null);
        };
      });

      expect(ownValue(window.history, 'pushState')).not.toBe(businessWrapper);
      expect(ownValue(window.history, 'pushState')).not.toBe(nativePush);

      window.history.pushState(null, '', '/sdk-hook-check');
      expect(calls).toEqual(['sdk', 'business']);

      kernel.destroy();

      expect(ownValue(window.history, 'pushState')).toBe(businessWrapper);
      expect(ownValue(window.history, 'pushState')).not.toBe(nativePush);

      // 行为验证：销毁后仍是业务包装函数在生效，而不是原生函数。
      window.history.pushState(null, '', '/after-destroy');
      expect(calls).toEqual(['sdk', 'business', 'business']);
    } finally {
      window.history.pushState = nativePush;
    }
  });
});

describe('C02-F6 全局注册表补充单元测试', () => {
  it('订阅处理器抛错被隔离并计数 processor_error，其他订阅者仍收到事件', () => {
    const kernel = createKernel({ target: window });
    const windowErrorSpy = vi.fn();
    const target = new EventTarget();
    const received: string[] = [];
    window.addEventListener('error', windowErrorSpy);

    try {
      kernel.registry.listen(target, 'error', () => {
        throw new Error('listener boom');
      });
      kernel.registry.listen(target, 'error', () => {
        received.push('second');
      });

      expect(() => {
        target.dispatchEvent(new Event('error'));
      }).not.toThrow();
      expect(received).toEqual(['second']);
      expect(kernel.counters.get('processor_error')).toBe(1);
      expect(windowErrorSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', windowErrorSpy);
    }
  });

  it('注销一个订阅者时保留原生监听，全部注销后移除原生监听', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: window });
    const offFirst = registry.listen(window, 'custom_event', () => undefined);
    const offSecond = registry.listen(window, 'custom_event', () => undefined);

    expect(registry.stats().nativeListeners).toBe(1);
    offFirst();
    offFirst();
    expect(registry.stats().listeners).toBe(1);
    expect(registry.stats().nativeListeners).toBe(1);

    offSecond();
    expect(registry.stats()).toEqual({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 });

    const offUnknown = registry.listen(window, 'custom_event', () => undefined, { capture: true });
    expect(registry.stats().nativeListeners).toBe(1);
    offUnknown();
  });

  it('没有可用原生目标时 listenGlobal 安全降级，销毁后注册计数 destroyed', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });

    const off = registry.listenGlobal('error', () => undefined);
    expect(() => {
      off();
    }).not.toThrow();
    expect(registry.stats()).toEqual({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 });

    registry.dispose();
    const afterDispose = registry.listenGlobal('error', () => undefined);
    expect(() => {
      afterDispose();
    }).not.toThrow();
    expect(counters.get('destroyed')).toBe(1);
  });

  it('hook 非函数属性与包装失败时回退，计数 processor_error', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host: { run: () => string; value?: string } = { run: () => 'original' };

    const offMissing = registry.hook(host, 'value', (original) => original);
    expect(host.value).toBeUndefined();
    expect(registry.stats().hooks).toBe(0);

    const offBadWrapper = registry.hook(host, 'run', () => {
      throw new Error('wrapper boom');
    });
    expect(host.run()).toBe('original');

    expect(() => {
      offMissing();
      offBadWrapper();
    }).not.toThrow();
    expect(counters.get('processor_error')).toBe(2);
  });

  it('hook 包装函数抛错时回退原函数并计数 processor_error', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host: { run: (value: string) => string } = { run: (value) => `native:${value}` };

    registry.hook(host, 'run', () => () => {
      throw new Error('wrapped boom');
    });

    expect(host.run('a')).toBe('native:a');
    expect(counters.get('processor_error')).toBe(1);
  });

  it('同一属性多次 hook 按后进先出恢复，非后进先出卸载会重建包装链', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host = { run: (): string => 'native' };
    const native = host.run;

    const offInner = registry.hook(host, 'run', (original) => () => `inner(${original()})`);
    const offOuter = registry.hook(host, 'run', (original) => () => `outer(${original()})`);
    expect(host.run()).toBe('outer(inner(native))');
    expect(registry.stats().hooks).toBe(2);

    offInner();
    offInner();
    expect(host.run()).toBe('outer(native)');
    expect(registry.stats().hooks).toBe(1);

    offOuter();
    expect(host.run).toBe(native);
    expect(registry.stats().hooks).toBe(0);
  });

  it('外部在 SDK 之上再包装时，SDK 卸载不覆盖外部包装函数', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host = { run: (): string => 'native' };

    const offSdk = registry.hook(host, 'run', (original) => () => `sdk(${original()})`);
    const sdkWrapper = host.run;
    const businessWrapper = (): string => `business(${sdkWrapper()})`;
    host.run = businessWrapper;

    offSdk();
    expect(host.run).toBe(businessWrapper);
    expect(registry.stats().hooks).toBe(0);
  });

  it('dispose 时全局值已被外部叠加包装：只撤销自己的记录，不动外部那一层', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host = { run: (): string => 'native' };

    registry.hook(host, 'run', (original) => () => `sdk(${original()})`);
    const sdkComposite = host.run;
    // 第三方 APM 在 SDK 之上再包一层（"SDK 先装、第三方后装"）。
    const apmWrapper = (): string => `apm(${sdkComposite()})`;
    host.run = apmWrapper;

    registry.dispose();

    // Q7 第 4 条：销毁只撤销自己的逻辑，外部包装层必须原样保留且仍能穿过 SDK 层。
    expect(host.run).toBe(apmWrapper);
    expect(host.run()).toBe('apm(sdk(native))');
    expect(registry.stats().hooks).toBe(0);
    expect(counters.get('processor_error')).toBe(0);
  });

  it('dispose 时 SDK 仍是最后一层：还原到 hook 前的基线（第三方先装的顺序）', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host = { run: (): string => 'native' };

    // 第三方 APM 先装：SDK 的 chain.base 就是第三方那一层。
    const apmBase = host.run;
    const apmWrapper = (): string => `apm(${apmBase()})`;
    host.run = apmWrapper;

    registry.hook(host, 'run', (original) => () => `sdk(${original()})`);
    registry.dispose();

    expect(host.run).toBe(apmWrapper);
    expect(host.run()).toBe('apm(native)');
    expect(registry.stats().hooks).toBe(0);
  });

  it('dispose 时第三方叠加了多层：一层都不动', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host = { run: (): string => 'native' };

    registry.hook(host, 'run', (original) => () => `sdk(${original()})`);
    const sdkComposite = host.run;
    const apmOne = (): string => `apm1(${sdkComposite()})`;
    host.run = apmOne;
    const apmTwo = (): string => `apm2(${apmOne()})`;
    host.run = apmTwo;

    registry.dispose();

    expect(host.run).toBe(apmTwo);
    expect(host.run()).toBe('apm2(apm1(sdk(native)))');
    expect(registry.stats().hooks).toBe(0);
  });

  it('dispose 时多条 SDK 记录叠加在外部包装之下：外部包装与其下的 SDK 层都保留', () => {
    const counters = createCounters();
    const registry = createGlobalRegistry({ counters, target: null });
    const host = { run: (): string => 'native' };

    registry.hook(host, 'run', (original) => () => `sdk1(${original()})`);
    registry.hook(host, 'run', (original) => () => `sdk2(${original()})`);
    const sdkComposite = host.run;
    expect(sdkComposite()).toBe('sdk2(sdk1(native))');
    const apmWrapper = (): string => `apm(${sdkComposite()})`;
    host.run = apmWrapper;

    registry.dispose();

    expect(host.run).toBe(apmWrapper);
    expect(host.run()).toBe('apm(sdk2(sdk1(native)))');
    expect(registry.stats().hooks).toBe(0);
    expect(counters.get('processor_error')).toBe(0);
  });

  it('定时器可注销，注册表销毁后清空全部定时器', () => {
    vi.useFakeTimers();
    try {
      const counters = createCounters();
      const registry = createGlobalRegistry({ counters, target: null });
      const ticks: string[] = [];

      const offTimeout = registry.schedule(() => {
        ticks.push('timeout');
      }, 10);
      registry.scheduleRepeat(() => {
        ticks.push('interval');
      }, 10);
      expect(registry.stats().timers).toBe(2);

      vi.advanceTimersByTime(10);
      expect(ticks).toEqual(['timeout', 'interval']);

      vi.advanceTimersByTime(10);
      expect(ticks).toEqual(['timeout', 'interval', 'interval']);

      offTimeout();
      offTimeout();
      expect(registry.stats().timers).toBe(1);

      registry.dispose();
      expect(registry.stats().timers).toBe(0);
      vi.advanceTimersByTime(50);
      expect(ticks).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('重复定时器注销走 clearInterval，销毁后注册定时器与监听被计数 destroyed', () => {
    vi.useFakeTimers();
    try {
      const counters = createCounters();
      const registry = createGlobalRegistry({ counters, target: null });
      const ticks: string[] = [];

      const offRepeat = registry.scheduleRepeat(() => {
        ticks.push('tick');
      }, 5);
      offRepeat();
      expect(registry.stats().timers).toBe(0);
      vi.advanceTimersByTime(20);
      expect(ticks).toEqual([]);

      registry.dispose();
      const offTimeout = registry.schedule(() => undefined, 1);
      const offAgain = registry.scheduleRepeat(() => undefined, 1);
      const offListen = registry.listenGlobal('error', () => undefined);
      const offHook = registry.hook({ run: (): string => 'x' }, 'run', (original) => original);
      expect(() => {
        offTimeout();
        offAgain();
        offListen();
        offHook();
      }).not.toThrow();
      expect(counters.get('destroyed')).toBe(4);
      expect(registry.stats()).toEqual({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('定时器回调抛错被隔离并计数 processor_error', () => {
    vi.useFakeTimers();
    try {
      const counters = createCounters();
      const registry = createGlobalRegistry({ counters, target: null });
      registry.schedule(() => {
        throw new Error('timer boom');
      }, 1);

      expect(() => {
        vi.advanceTimersByTime(1);
      }).not.toThrow();
      expect(counters.get('processor_error')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('不同事件类型与捕获标志各自安装一次原生监听，销毁时全部移除', () => {
    const counters = createCounters();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const registry = createGlobalRegistry({ counters, target: window });

    try {
      registry.listen(window, 'resize', () => undefined);
      registry.listen(window, 'resize', () => undefined, { capture: true });
      registry.listen(window, 'scroll', () => undefined);
      expect(registry.stats().nativeListeners).toBe(3);
      expect(registry.stats().listeners).toBe(3);

      registry.dispose();
      expect(removeSpy.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(2);
      expect(removeSpy.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(1);
      expect(registry.stats()).toEqual({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 });
    } finally {
      removeSpy.mockRestore();
    }
  });
});
