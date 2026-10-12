/**
 * C02-F1 / C02-F6 销毁契约、能力注册与计数接口验收测试（C02-AC-14）。
 */
import { describe, expect, it, vi } from 'vitest';

import { createCounters, createKernel, definePlugin } from '../index';
import type { KernelEvent } from '../index';

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'test_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

describe('C02-F1 / C02-F6 销毁契约', () => {
  it('C02-AC-14 销毁后无残留监听、定时器、hook，且调用任何公共方法都计数 destroyed', () => {
    vi.useFakeTimers();
    try {
      const kernel = createKernel({ target: window });
      kernel.init();
      kernel.start();
      kernel.markConfigReady();

      const host = { run: (): string => 'native' };
      const onError = vi.fn();
      kernel.registry.listen(window, 'error', onError);
      kernel.registry.hook(host, 'run', (original) => () => `sdk(${original()})`);
      kernel.registry.schedule(() => undefined, 1_000);
      kernel.registry.scheduleRepeat(() => undefined, 1_000);
      expect(kernel.registry.stats()).toEqual({
        listeners: 1,
        nativeListeners: 1,
        hooks: 1,
        timers: 2,
      });
      expect(host.run()).toBe('sdk(native)');
      expect(vi.getTimerCount()).toBe(2);

      kernel.destroy();

      expect(kernel.registry.stats()).toEqual({
        listeners: 0,
        nativeListeners: 0,
        hooks: 0,
        timers: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(host.run()).toBe('native');
      window.dispatchEvent(new Event('error'));
      expect(onError).not.toHaveBeenCalled();

      const before = kernel.counters.get('destroyed');
      kernel.init();
      kernel.start();
      kernel.pause('consent_denied');
      kernel.resume();
      kernel.report(makeEvent());
      kernel.markConfigReady();
      kernel.registerProcessor('validate', (event) => event);
      kernel.registerPlugin(definePlugin({ id: 'late', install: () => undefined }));
      kernel.applyPluginConfig({ late: true });
      kernel.registerCapability('late', 1);
      kernel.setOutput(() => undefined);
      kernel.destroy();

      expect(kernel.counters.get('destroyed')).toBe(before + 12);
      expect(kernel.counters.get('consent_denied')).toBe(0);
      expect(kernel.state()).toBe('destroyed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('销毁后释放的能力与输出回调不再生效', () => {
    const kernel = createKernel();
    kernel.init();
    kernel.start();
    kernel.markConfigReady();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });
    kernel.registerCapability('transport', 'original');

    kernel.destroy();

    expect(kernel.getCapability('transport')).toBeUndefined();
    expect(kernel.capabilities.names()).toEqual([]);
    expect(kernel.configReady()).toBe(false);
    expect(delivered).toHaveLength(0);
  });
});

describe('C02 能力注册与计数接口', () => {
  it('能力注册以后注册者为准，注销仅在自己仍是当前值时移除', () => {
    const kernel = createKernel();
    const offFirst = kernel.registerCapability('transport', { send: 'first' });
    expect(kernel.getCapability('transport')).toEqual({ send: 'first' });
    expect(kernel.capabilities.has('transport')).toBe(true);
    expect(kernel.capabilities.names()).toEqual(['transport']);

    const offSecond = kernel.registerCapability('transport', { send: 'second' });
    expect(kernel.getCapability('transport')).toEqual({ send: 'second' });

    offFirst();
    expect(kernel.getCapability('transport')).toEqual({ send: 'second' });

    offSecond();
    expect(kernel.getCapability('transport')).toBeUndefined();
    expect(kernel.capabilities.has('transport')).toBe(false);
    expect(kernel.capabilities.names()).toEqual([]);
  });

  it('计数器累计、快照与重置', () => {
    const counters = createCounters();

    expect(counters.get('unknown')).toBe(0);
    counters.count('processor_error');
    counters.count('processor_error', 4);
    counters.count('destroyed', 0);
    counters.count('destroyed', -1);
    expect(counters.get('processor_error')).toBe(5);
    expect(counters.get('destroyed')).toBe(0);
    expect(counters.snapshot()).toEqual({ processor_error: 5 });

    counters.reset();
    expect(counters.snapshot()).toEqual({});
    expect(counters.get('processor_error')).toBe(0);
  });

  it('重复注册同一插件定义时以最后一次为准', () => {
    const kernel = createKernel();
    kernel.init();
    kernel.start();
    const seen: string[] = [];
    kernel.registerPlugin(definePlugin({ id: 'dup', install: () => { seen.push('first'); } }));
    kernel.registerPlugin(definePlugin({ id: 'dup', install: () => { seen.push('second'); } }));

    kernel.applyPluginConfig({ dup: true });
    expect(seen).toEqual(['second']);
    expect(kernel.plugins.registeredIds()).toEqual(['dup']);
    expect(kernel.plugins.isRegistered('dup')).toBe(true);
    expect(kernel.plugins.isRegistered('ghost')).toBe(false);
  });

  it('内核未初始化时上报事件被忽略且不计数', () => {
    const kernel = createKernel();
    kernel.report(makeEvent());

    expect(kernel.prestartQueue.size()).toBe(0);
    expect(kernel.counters.snapshot()).toEqual({});
    expect(kernel.configReady()).toBe(false);
  });

  it('调试用只读访问器可在销毁前后安全调用且不计数 destroyed', () => {
    const kernel = createKernel();
    kernel.init();
    expect(kernel.state()).toBe('initialized');
    expect(kernel.pipeline.size()).toBe(0);
    expect(kernel.plugins.installedIds()).toEqual([]);
    expect(kernel.prestartQueue.capacity()).toBe(500);

    kernel.destroy();
    expect(kernel.state()).toBe('destroyed');
    expect(kernel.plugins.installedIds()).toEqual([]);
    expect(kernel.counters.get('destroyed')).toBe(0);
  });

  it('输出回调抛错被隔离并计数 processor_error，注销后可重设', () => {
    const kernel = createKernel();
    kernel.init();
    kernel.start();
    kernel.markConfigReady();

    const off = kernel.setOutput(() => {
      throw new Error('sink boom');
    });
    expect(() => {
      kernel.report(makeEvent());
    }).not.toThrow();
    expect(kernel.counters.get('processor_error')).toBe(1);

    off();
    off();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });
    kernel.report(makeEvent());
    expect(delivered).toHaveLength(1);
  });

  it('暂停期间标记配置就绪时，回放的事件按暂停原因计数且不发送', () => {
    const kernel = createKernel();
    kernel.init();
    kernel.start();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    kernel.report(makeEvent());
    expect(kernel.prestartQueue.size()).toBe(1);

    kernel.pause('consent_denied');
    kernel.markConfigReady();

    expect(kernel.configReady()).toBe(true);
    expect(kernel.prestartQueue.size()).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(kernel.counters.get('consent_denied')).toBe(1);
  });

  it('直接使用能力注册表时，销毁后注册被计数 destroyed', () => {
    const kernel = createKernel();
    kernel.capabilities.register('direct', 1);
    expect(kernel.capabilities.get('direct')).toBe(1);
    expect(kernel.capabilities.has('direct')).toBe(true);

    kernel.destroy();

    const off = kernel.capabilities.register('late', 2);
    expect(() => {
      off();
    }).not.toThrow();
    expect(kernel.counters.get('destroyed')).toBe(1);
    expect(kernel.capabilities.names()).toEqual([]);
  });
});
