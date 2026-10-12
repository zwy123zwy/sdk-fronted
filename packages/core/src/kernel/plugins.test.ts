/**
 * C02-F4 插件宿主验收测试（C02-AC-07、C02-AC-08、C02-AC-09）。
 */
import { describe, expect, it, vi } from 'vitest';

import { createKernel, definePlugin } from '../index';
import type { KernelEvent } from '../index';

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'test_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

function runningKernel(options: Parameters<typeof createKernel>[0] = {}): ReturnType<typeof createKernel> {
  const kernel = createKernel(options);
  kernel.init();
  kernel.start();
  kernel.markConfigReady();
  return kernel;
}

describe('C02-F4 插件宿主', () => {
  it('C02-AC-07 依赖不存在的插件不安装并计数 plugin_dependency_missing，其他插件正常安装', () => {
    const kernel = runningKernel();
    const installed: string[] = [];

    kernel.registerPlugin(
      definePlugin({
        id: 'alpha',
        install: () => {
          installed.push('alpha');
        },
      }),
    );
    kernel.registerPlugin(
      definePlugin({
        id: 'beta',
        dependencies: ['not_registered'],
        install: () => {
          installed.push('beta');
        },
      }),
    );

    kernel.applyPluginConfig({ alpha: true, beta: true });

    expect(installed).toEqual(['alpha']);
    expect(kernel.plugins.isInstalled('alpha')).toBe(true);
    expect(kernel.plugins.isInstalled('beta')).toBe(false);
    expect(kernel.plugins.installedIds()).toEqual(['alpha']);
    expect(kernel.counters.get('plugin_dependency_missing')).toBe(1);
    expect(kernel.counters.get('plugin_install_failed')).toBe(0);
  });

  it('C02-AC-08 插件安装函数抛错被计数且不影响其他插件，SDK 继续运行', () => {
    const kernel = runningKernel();
    const installed: string[] = [];
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    kernel.registerPlugin(
      definePlugin({
        id: 'boom',
        install: (ctx) => {
          ctx.addProcessor('validate', (event) => {
            installed.push('boom-processor');
            return event;
          });
          throw new Error('install boom');
        },
      }),
    );
    kernel.registerPlugin(
      definePlugin({
        id: 'safe',
        install: () => {
          installed.push('safe');
        },
      }),
    );

    expect(() => {
      kernel.applyPluginConfig({ boom: true, safe: true });
    }).not.toThrow();

    expect(kernel.counters.get('plugin_install_failed')).toBe(1);
    expect(kernel.counters.get('plugin_dependency_missing')).toBe(0);
    expect(kernel.plugins.isInstalled('boom')).toBe(false);
    expect(kernel.plugins.isInstalled('safe')).toBe(true);
    expect(installed).toEqual(['safe']);
    expect(kernel.pipeline.size('validate')).toBe(0);
    expect(kernel.state()).toBe('running');

    kernel.report(makeEvent());
    expect(delivered).toHaveLength(1);
  });

  it('C02-AC-09 配置关闭插件时卸载并释放它注册的监听与 hook', () => {
    const kernel = runningKernel({ target: window });
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const received: string[] = [];
    const host = {
      run: (value: string): string => value,
    };
    const original = host.run;

    try {
      kernel.registerPlugin(
        definePlugin({
          id: 'watch',
          install: (ctx) => {
            ctx.listen('error', () => {
              received.push('listener');
            });
            ctx.hook(host, 'run', (inner) => (value: string) => {
              received.push('hook');
              return inner(value);
            });
            ctx.schedule(() => {
              received.push('timer');
            }, 60_000);
            ctx.scheduleRepeat(() => {
              received.push('repeat');
            }, 60_000);
            ctx.addProcessor('before_send', (event) => {
              received.push('processor');
              return event;
            });
          },
        }),
      );

      kernel.applyPluginConfig({ watch: true });
      expect(kernel.plugins.isInstalled('watch')).toBe(true);
      expect(kernel.registry.stats()).toEqual({
        listeners: 1,
        nativeListeners: 1,
        hooks: 1,
        timers: 2,
      });
      expect(addSpy.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1);

      expect(() => {
        kernel.applyPluginConfig({ watch: false });
      }).not.toThrow();

      expect(kernel.plugins.isInstalled('watch')).toBe(false);
      expect(kernel.registry.stats()).toEqual({
        listeners: 0,
        nativeListeners: 0,
        hooks: 0,
        timers: 0,
      });
      expect(removeSpy.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1);
      expect(host.run).toBe(original);
      expect(kernel.pipeline.size('before_send')).toBe(0);

      window.dispatchEvent(new Event('error'));
      kernel.report(makeEvent());
      expect(received).toEqual([]);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});

describe('C02-F4 插件宿主补充单元测试', () => {
  it('已注册的依赖先于依赖方安装，重复安装幂等', () => {
    const kernel = runningKernel();
    const order: string[] = [];
    kernel.registerPlugin(
      definePlugin({
        id: 'base',
        install: () => {
          order.push('base');
        },
      }),
    );
    kernel.registerPlugin(
      definePlugin({
        id: 'feature',
        dependencies: ['base'],
        install: () => {
          order.push('feature');
        },
      }),
    );

    kernel.applyPluginConfig({ feature: true });
    expect(order).toEqual(['base', 'feature']);

    kernel.applyPluginConfig({ feature: true, base: true });
    expect(order).toEqual(['base', 'feature']);
    expect(kernel.plugins.installedIds()).toEqual(['base', 'feature']);
  });

  it('未注册插件的配置被忽略，卸载未安装插件返回 false', () => {
    const kernel = runningKernel();

    expect(() => {
      kernel.applyPluginConfig({ ghost: true, vanilla: false });
    }).not.toThrow();
    expect(kernel.plugins.isInstalled('ghost')).toBe(false);
    expect(kernel.counters.get('plugin_install_failed')).toBe(0);
    expect(kernel.counters.get('plugin_dependency_missing')).toBe(0);
    expect(kernel.plugins.uninstall('ghost')).toBe(false);
  });

  it('卸载插件释放它注册的能力，重复注册同一插件定义以最后一次为准', () => {
    const kernel = runningKernel();
    const first = definePlugin({ id: 'cap', install: () => undefined });
    const second = definePlugin({
      id: 'cap',
      install: (ctx) => {
        ctx.registerCapability('cap:value', 42);
      },
    });

    kernel.registerPlugin(first);
    kernel.registerPlugin(second);
    kernel.applyPluginConfig({ cap: true });
    expect(kernel.getCapability('cap:value')).toBe(42);

    kernel.applyPluginConfig({ cap: false });
    expect(kernel.getCapability('cap:value')).toBeUndefined();
    expect(kernel.plugins.registeredIds()).toEqual(['cap']);
  });

  it('插件注册的清理函数在卸载时按后进先出执行，抛错被隔离', () => {
    const kernel = runningKernel();
    const disposed: string[] = [];
    kernel.registerPlugin(
      definePlugin({
        id: 'cleanup',
        install: (ctx) => {
          ctx.onDispose(() => {
            disposed.push('first');
          });
          ctx.onDispose(() => {
            disposed.push('second');
            throw new Error('cleanup boom');
          });
        },
      }),
    );

    kernel.applyPluginConfig({ cleanup: true });
    expect(() => {
      kernel.applyPluginConfig({ cleanup: false });
    }).not.toThrow();

    expect(disposed).toEqual(['second', 'first']);
    expect(kernel.counters.get('processor_error')).toBe(1);
  });

  it('循环依赖被拒绝并计入 plugin_dependency_missing', () => {
    const kernel = runningKernel();
    kernel.registerPlugin(definePlugin({ id: 'loop_a', dependencies: ['loop_b'], install: () => undefined }));
    kernel.registerPlugin(definePlugin({ id: 'loop_b', dependencies: ['loop_a'], install: () => undefined }));

    kernel.applyPluginConfig({ loop_a: true });
    expect(kernel.plugins.isInstalled('loop_a')).toBe(false);
    expect(kernel.plugins.isInstalled('loop_b')).toBe(false);
    expect(kernel.counters.get('plugin_dependency_missing')).toBe(1);
  });

  it('依赖安装失败时依赖方不安装且不重复计数', () => {
    const kernel = runningKernel();
    kernel.registerPlugin(
      definePlugin({
        id: 'broken_base',
        install: () => {
          throw new Error('base boom');
        },
      }),
    );
    kernel.registerPlugin(definePlugin({ id: 'dependent', dependencies: ['broken_base'], install: () => undefined }));

    kernel.applyPluginConfig({ dependent: true });
    expect(kernel.plugins.isInstalled('dependent')).toBe(false);
    expect(kernel.plugins.isInstalled('broken_base')).toBe(false);
    expect(kernel.counters.get('plugin_install_failed')).toBe(1);
    expect(kernel.counters.get('plugin_dependency_missing')).toBe(0);
  });

  it('未注册插件定义时安装返回 unknown_plugin', () => {
    const kernel = runningKernel();
    expect(kernel.plugins.install('nowhere').status).toBe('unknown_plugin');
    expect(kernel.plugins.registeredIds()).toEqual([]);
  });

  it('插件宿主销毁后安装被计数 destroyed 并返回 unavailable', () => {
    const kernel = runningKernel();
    kernel.registerPlugin(definePlugin({ id: 'late', install: () => undefined }));
    kernel.destroy();

    expect(kernel.plugins.install('late').status).toBe('unavailable');
    expect(kernel.counters.get('destroyed')).toBeGreaterThan(0);
  });

  it('插件宿主销毁后注册插件定义被计数 destroyed 且不再保存', () => {
    const kernel = runningKernel();
    kernel.destroy();

    const before = kernel.counters.get('destroyed');
    kernel.plugins.register(definePlugin({ id: 'late', install: () => undefined }));

    expect(kernel.counters.get('destroyed')).toBe(before + 1);
    expect(kernel.plugins.registeredIds()).toEqual([]);
  });
});
