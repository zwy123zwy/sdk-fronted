/**
 * 交接产物：最小「回声插件」测试样例，演示插件安装与卸载（T11 交接给 T12–T18）。
 */
import { describe, expect, it } from 'vitest';

import { createKernel, definePlugin } from '../index';
import type { KernelEvent } from '../index';

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'echo_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

/**
 * 最小「回声插件」：把发送前段的事件回显到传入的数组，并把该数组注册成能力供其他模块读取。
 * 它只使用插件上下文里自动回收的注册接口，卸载时不会留下任何监听、hook 或处理器。
 */
function createEchoPlugin(echoes: string[]) {
  return definePlugin({
    id: 'echo',
    install: (context) => {
      context.registerCapability('echo.events', echoes);
      const stop = context.addProcessor('before_send', (event) => {
        echoes.push(event.event_name);
        return event;
      });
      context.onDispose(stop);
    },
  });
}

describe('回声插件样例', () => {
  it('安装后回显经过管线的事件，卸载后停止回显并释放能力', () => {
    const kernel = createKernel();
    kernel.init();
    kernel.start();
    kernel.markConfigReady();
    const echoes: string[] = [];

    kernel.registerPlugin(createEchoPlugin(echoes));
    kernel.applyPluginConfig({ echo: true });

    expect(kernel.plugins.isInstalled('echo')).toBe(true);
    expect(kernel.getCapability('echo.events')).toBe(echoes);

    kernel.report(makeEvent({ event_name: 'first_event' }));
    kernel.report(makeEvent({ event_name: 'second_event' }));
    expect(echoes).toEqual(['first_event', 'second_event']);

    kernel.applyPluginConfig({ echo: false });

    expect(kernel.plugins.isInstalled('echo')).toBe(false);
    expect(kernel.getCapability('echo.events')).toBeUndefined();
    expect(kernel.pipeline.size('before_send')).toBe(0);

    kernel.report(makeEvent({ event_name: 'third_event' }));
    expect(echoes).toEqual(['first_event', 'second_event']);
  });

  it('内核销毁时回声插件被卸载', () => {
    const kernel = createKernel();
    kernel.init();
    kernel.start();
    kernel.markConfigReady();
    const echoes: string[] = [];

    kernel.registerPlugin(createEchoPlugin(echoes));
    kernel.applyPluginConfig({ echo: true });
    kernel.report(makeEvent({ event_name: 'before_destroy' }));

    kernel.destroy();

    expect(kernel.plugins.installedIds()).toEqual([]);
    expect(kernel.getCapability('echo.events')).toBeUndefined();
    expect(echoes).toEqual(['before_destroy']);
  });
});
