/**
 * 内核组合根（C02-F1 至 C02-F6）：把计数器、生命周期、六段管线、插件宿主、
 * 预启动队列与全局注册表组装成一个可独立测试的内核。
 *
 * 公共方法同步返回、从不抛错；销毁后调用任何会改变状态的方法都计数 `destroyed`。
 */
import { createCapabilityRegistry } from './capabilities';
import { REASON_CODES } from './constants';
import { createCounters } from './counters';
import { createGlobalRegistry } from './global-registry';
import { createLifecycle } from './lifecycle';
import { createPipeline } from './pipeline';
import { createPluginHost } from './plugins';
import { createPrestartQueue } from './prestart-queue';
import type { Dispose, Kernel, KernelConfig, KernelEvent } from './types';

const NOOP_DISPOSE: Dispose = () => undefined;

/**
 * 创建内核。模块顶层不访问 window；`config.target` 缺省时在首次订阅原生事件时解析。
 * `config.registry` 可注入共享的全局注册表（C01-AC-10），缺省自建。
 */
export function createKernel(config: KernelConfig = {}): Kernel {
  const counters = createCounters();
  const lifecycle = createLifecycle({ counters });
  const pipeline = createPipeline({ counters });
  // 共享注册表可注入（C01-AC-10）：多个内核共享原生监听，但各自持有独立计数器。
  const registry = config.registry ?? createGlobalRegistry({ counters, target: config.target });
  const capabilities = createCapabilityRegistry({ counters });
  const plugins = createPluginHost({ counters, pipeline, registry, capabilities });
  const prestartQueue = createPrestartQueue();

  let ready = false;
  let pauseReason: string | undefined;
  let output: ((event: KernelEvent) => void) | undefined;

  /** 销毁后调用公共方法：计数 destroyed 并忽略。 */
  function guardDestroyed(): boolean {
    if (!lifecycle.isDestroyed()) return false;
    counters.count(REASON_CODES.destroyed);
    return true;
  }

  function deliver(event: KernelEvent): void {
    const outcome = pipeline.process(event);
    if (outcome.status !== 'processed') return;
    const sink = output;
    if (sink === undefined) return;
    try {
      sink(outcome.event);
    } catch {
      counters.count(REASON_CODES.processorError);
    }
  }

  function countPaused(): boolean {
    if (lifecycle.state() !== 'paused') return false;
    if (pauseReason !== undefined) counters.count(pauseReason);
    return true;
  }

  return {
    counters,
    lifecycle,
    pipeline,
    plugins,
    registry,
    prestartQueue,
    capabilities,

    state: () => lifecycle.state(),
    configReady: () => ready,

    init(): void {
      if (guardDestroyed()) return;
      lifecycle.init();
    },
    start(): void {
      if (guardDestroyed()) return;
      lifecycle.start();
    },
    pause(reason?: string): void {
      if (guardDestroyed()) return;
      if (lifecycle.pause()) pauseReason = reason;
    },
    resume(): void {
      if (guardDestroyed()) return;
      if (lifecycle.resume()) pauseReason = undefined;
    },
    destroy(): void {
      if (guardDestroyed()) return;
      lifecycle.destroy();
      plugins.dispose();
      pipeline.dispose();
      registry.dispose();
      capabilities.dispose();
      prestartQueue.clear();
      output = undefined;
      ready = false;
      pauseReason = undefined;
    },

    markConfigReady(): void {
      if (guardDestroyed()) return;
      if (ready) return;
      ready = true;
      for (const event of prestartQueue.drain()) {
        if (lifecycle.isDestroyed()) return;
        if (countPaused()) continue;
        deliver(event);
      }
    },

    report(event: KernelEvent): void {
      if (guardDestroyed()) return;
      const state = lifecycle.state();
      if (state === 'uninitialized') return;
      if (countPaused()) return;
      if (!ready) {
        const result = prestartQueue.push(event);
        if (result.status !== 'queued') counters.count(REASON_CODES.prestartQueueOverflow);
        return;
      }
      deliver(event);
    },

    setOutput(sink: (event: KernelEvent) => void): Dispose {
      if (guardDestroyed()) return NOOP_DISPOSE;
      output = sink;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (output === sink) output = undefined;
      };
    },

    registerProcessor(stage, processor, options): Dispose {
      if (guardDestroyed()) return NOOP_DISPOSE;
      return pipeline.register(stage, processor, options);
    },
    registerPlugin(plugin): void {
      if (guardDestroyed()) return;
      plugins.register(plugin);
    },
    applyPluginConfig(config): void {
      if (guardDestroyed()) return;
      plugins.applyConfig(config);
    },

    registerCapability(name: string, value: unknown): Dispose {
      if (guardDestroyed()) return NOOP_DISPOSE;
      return capabilities.register(name, value);
    },
    getCapability(name: string): unknown {
      return capabilities.get(name);
    },
  };
}
