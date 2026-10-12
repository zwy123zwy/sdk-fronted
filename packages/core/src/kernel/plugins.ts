/**
 * 插件宿主（C02-F4）：按 id 注册 / 安装 / 卸载插件。
 * - 依赖不存在的插件不安装，计数 `plugin_dependency_missing`；
 * - 安装函数抛错时回滚已注册资源、计数 `plugin_install_failed`，不影响其他插件；
 * - 配置关闭插件时卸载，并释放它注册的全部监听、hook、处理器、定时器与能力。
 *
 * 插件通过 `PluginContext` 注册的一切资源都绑定到插件作用域，卸载时按后进先出释放。
 */
import { REASON_CODES } from './constants';
import type {
  CapabilityRegistry,
  Counters,
  Dispose,
  GlobalRegistry,
  Pipeline,
  Plugin,
  PluginActionResult,
  PluginContext,
  PluginHost,
} from './types';

export interface PluginHostServices {
  readonly counters: Counters;
  readonly pipeline: Pipeline;
  readonly registry: GlobalRegistry;
  readonly capabilities: CapabilityRegistry;
}

/** 定义插件（仅做类型收窄，便于 `registerPlugin(definePlugin({ ... }))` 获得参数提示）。 */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/** 创建插件宿主。 */
export function createPluginHost(services: PluginHostServices): PluginHost {
  const { counters, pipeline, registry, capabilities } = services;
  const plugins = new Map<string, Plugin>();
  const installed = new Map<string, Dispose[]>();
  let disposed = false;

  function runDisposers(disposers: readonly Dispose[]): void {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      const disposer = disposers[index];
      if (disposer === undefined) continue;
      try {
        disposer();
      } catch {
        counters.count(REASON_CODES.processorError);
      }
    }
  }

  function createContext(pluginId: string, disposers: Dispose[]): PluginContext {
    return {
      pluginId,
      counters,
      pipeline,
      registry,
      capabilities,
      addProcessor(stage, processor, options): Dispose {
        const dispose = pipeline.register(stage, processor, options);
        disposers.push(dispose);
        return dispose;
      },
      listen(type, handler, options): Dispose {
        const dispose = registry.listenGlobal(type, handler, options);
        disposers.push(dispose);
        return dispose;
      },
      hook(target, key, wrapper): Dispose {
        const dispose = registry.hook(target, key, wrapper);
        disposers.push(dispose);
        return dispose;
      },
      schedule(handler, delayMs): Dispose {
        const dispose = registry.schedule(handler, delayMs);
        disposers.push(dispose);
        return dispose;
      },
      scheduleRepeat(handler, intervalMs): Dispose {
        const dispose = registry.scheduleRepeat(handler, intervalMs);
        disposers.push(dispose);
        return dispose;
      },
      registerCapability(name: string, value: unknown): Dispose {
        const dispose = capabilities.register(name, value);
        disposers.push(dispose);
        return dispose;
      },
      onDispose(disposer: Dispose): void {
        disposers.push(disposer);
      },
    };
  }

  function installInternal(id: string, stack: Set<string>): PluginActionResult {
    if (disposed) {
      counters.count(REASON_CODES.destroyed);
      return { pluginId: id, status: 'unavailable' };
    }
    const plugin = plugins.get(id);
    if (plugin === undefined) return { pluginId: id, status: 'unknown_plugin' };
    if (installed.has(id)) return { pluginId: id, status: 'already_installed' };
    if (stack.has(id)) {
      counters.count(REASON_CODES.pluginDependencyMissing);
      return { pluginId: id, status: 'dependency_missing', missingDependencies: [id] };
    }

    const dependencies = plugin.dependencies ?? [];
    const missing = dependencies.filter((dependency) => !plugins.has(dependency));
    if (missing.length > 0) {
      counters.count(REASON_CODES.pluginDependencyMissing);
      return { pluginId: id, status: 'dependency_missing', missingDependencies: missing };
    }

    stack.add(id);
    for (const dependency of dependencies) {
      const result = installInternal(dependency, stack);
      if (result.status !== 'installed' && result.status !== 'already_installed') {
        stack.delete(id);
        return { pluginId: id, status: 'dependency_failed', failedDependencies: [dependency] };
      }
    }
    stack.delete(id);

    const disposers: Dispose[] = [];
    try {
      plugin.install(createContext(id, disposers));
    } catch {
      runDisposers(disposers);
      counters.count(REASON_CODES.pluginInstallFailed);
      return { pluginId: id, status: 'install_failed' };
    }
    installed.set(id, disposers);
    return { pluginId: id, status: 'installed' };
  }

  function uninstall(id: string): boolean {
    const disposers = installed.get(id);
    if (disposers === undefined) return false;
    installed.delete(id);
    runDisposers(disposers);
    return true;
  }

  return {
    register(plugin: Plugin): void {
      if (disposed) {
        counters.count(REASON_CODES.destroyed);
        return;
      }
      plugins.set(plugin.id, plugin);
    },
    install(id: string): PluginActionResult {
      return installInternal(id, new Set<string>());
    },
    uninstall,
    applyConfig(config: Readonly<Record<string, boolean>>): readonly PluginActionResult[] {
      const results: PluginActionResult[] = [];
      for (const [id, enabled] of Object.entries(config)) {
        if (enabled) {
          results.push(installInternal(id, new Set<string>()));
          continue;
        }
        const wasInstalled = installed.has(id);
        uninstall(id);
        results.push({ pluginId: id, status: wasInstalled ? 'uninstalled' : 'not_installed' });
      }
      return results;
    },
    isRegistered(id: string): boolean {
      return plugins.has(id);
    },
    isInstalled(id: string): boolean {
      return installed.has(id);
    },
    registeredIds(): readonly string[] {
      return [...plugins.keys()];
    },
    installedIds(): readonly string[] {
      return [...installed.keys()];
    },
    dispose(): void {
      for (const id of [...installed.keys()].reverse()) uninstall(id);
      installed.clear();
      plugins.clear();
      disposed = true;
    },
  };
}
