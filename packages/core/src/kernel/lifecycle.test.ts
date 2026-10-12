/**
 * C02-F1 生命周期状态机验收测试（C02-AC-01、C02-AC-02、C02-AC-03）。
 */
import { describe, expect, it } from 'vitest';

import { createCounters, createKernel, createLifecycle } from '../index';
import type { KernelEvent, LifecycleState } from '../index';

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'test_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

function runningKernel(): ReturnType<typeof createKernel> {
  const kernel = createKernel();
  kernel.init();
  kernel.start();
  kernel.markConfigReady();
  return kernel;
}

describe('C02-F1 生命周期状态机', () => {
  it('C02-AC-01 生命周期状态依次为已初始化、运行中、已销毁', () => {
    const kernel = createKernel();

    expect(kernel.state()).toBe('uninitialized');

    kernel.init();
    expect(kernel.state()).toBe('initialized');

    kernel.start();
    expect(kernel.state()).toBe('running');

    kernel.destroy();
    expect(kernel.state()).toBe('destroyed');
  });

  it('C02-AC-02 未初始化时启动被忽略，已销毁后初始化被忽略，都不抛错', () => {
    const kernel = createKernel();

    expect(() => {
      kernel.start();
    }).not.toThrow();
    expect(kernel.state()).toBe('uninitialized');

    kernel.init();
    kernel.start();
    kernel.destroy();

    expect(() => {
      kernel.init();
    }).not.toThrow();
    expect(kernel.state()).toBe('destroyed');
  });

  it('C02-AC-03 暂停期间按原因不采集不发送，恢复后回到运行中', () => {
    const kernel = runningKernel();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    kernel.pause('consent_denied');
    expect(kernel.state()).toBe('paused');

    kernel.report(makeEvent());
    expect(delivered).toHaveLength(0);
    expect(kernel.counters.get('consent_denied')).toBe(1);

    kernel.resume();
    expect(kernel.state()).toBe('running');

    kernel.report(makeEvent());
    expect(delivered).toHaveLength(1);
    expect(kernel.counters.get('consent_denied')).toBe(1);
  });
});

describe('C02-F1 生命周期工厂补充单元测试', () => {
  it('合法转换返回 true，重复与非法转换返回 false', () => {
    const counters = createCounters();
    const lifecycle = createLifecycle({ counters });

    expect(lifecycle.resume()).toBe(false);
    expect(lifecycle.pause()).toBe(false);
    expect(lifecycle.state()).toBe('uninitialized');

    expect(lifecycle.init()).toBe(true);
    expect(lifecycle.init()).toBe(false);
    expect(lifecycle.start()).toBe(true);
    expect(lifecycle.pause()).toBe(true);
    expect(lifecycle.start()).toBe(false);
    expect(lifecycle.resume()).toBe(true);

    expect(lifecycle.destroy()).toBe(true);
    expect(lifecycle.isDestroyed()).toBe(true);
    expect(lifecycle.destroy()).toBe(false);
    expect(lifecycle.init()).toBe(false);
    expect(lifecycle.state()).toBe('destroyed');
    expect(counters.get('destroyed')).toBe(2);
    expect(counters.get('processor_error')).toBe(0);
  });

  it('状态变化监听收到新旧状态，注销后不再收到', () => {
    const counters = createCounters();
    const lifecycle = createLifecycle({ counters });
    const seen: string[] = [];

    const off = lifecycle.onStateChange((state, previous) => {
      seen.push(`${previous}->${state}`);
    });
    lifecycle.init();
    lifecycle.start();
    off();
    off();
    lifecycle.destroy();

    expect(seen).toEqual(['uninitialized->initialized', 'initialized->running']);
  });

  it('状态变化监听抛错被隔离并计入 processor_error', () => {
    const counters = createCounters();
    const lifecycle = createLifecycle({ counters });
    const seen: LifecycleState[] = [];

    lifecycle.onStateChange(() => {
      throw new Error('listener boom');
    });
    lifecycle.onStateChange((state) => {
      seen.push(state);
    });
    expect(() => {
      lifecycle.init();
    }).not.toThrow();

    expect(seen).toEqual(['initialized']);
    expect(counters.get('processor_error')).toBe(1);
  });

  it('销毁后注册状态监听被忽略并计数 destroyed', () => {
    const counters = createCounters();
    const lifecycle = createLifecycle({ counters });
    lifecycle.destroy();
    const off = lifecycle.onStateChange(() => undefined);

    expect(() => {
      off();
    }).not.toThrow();
    expect(counters.get('destroyed')).toBe(1);
  });

  it('内核初始化与启动幂等，暂停时重复暂停被忽略', () => {
    const kernel = createKernel();

    kernel.init();
    kernel.init();
    expect(kernel.state()).toBe('initialized');

    kernel.start();
    kernel.start();
    expect(kernel.state()).toBe('running');

    kernel.pause();
    kernel.pause();
    expect(kernel.state()).toBe('paused');

    kernel.resume();
    expect(kernel.state()).toBe('running');
  });
});
