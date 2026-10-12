/**
 * 内核内部接口汇总（C02）。只从 `packages/core/src/index.ts` 对外暴露。
 */
export { PIPELINE_STAGES, PRESTART_QUEUE_CAPACITY, REASON_CODES } from './constants';
export type { PipelineStage, ReasonCode } from './constants';
export { createCapabilityRegistry } from './capabilities';
export type { CapabilityRegistryServices } from './capabilities';
export { createCounters } from './counters';
export { createGlobalRegistry } from './global-registry';
export type { GlobalRegistryServices } from './global-registry';
export { createKernel } from './kernel';
export { createLifecycle } from './lifecycle';
export type { LifecycleServices } from './lifecycle';
export { createPipeline } from './pipeline';
export type { PipelineServices } from './pipeline';
export { createPluginHost, definePlugin } from './plugins';
export type { PluginHostServices } from './plugins';
export { createPrestartQueue } from './prestart-queue';
export type { PrestartQueueOptions } from './prestart-queue';
export { stopPipeline } from './types';
export type {
  CapabilityRegistry,
  Counters,
  Dispose,
  EventPriority,
  GlobalRegistry,
  GlobalRegistryStats,
  Kernel,
  KernelConfig,
  KernelEvent,
  Lifecycle,
  LifecycleState,
  ListenerOptions,
  Pipeline,
  PipelineStop,
  Plugin,
  PluginActionResult,
  PluginContext,
  PluginHost,
  PluginStatus,
  PrestartQueue,
  PrestartQueuePush,
  ProcessOutcome,
  Processor,
  ProcessorContext,
  ProcessorResult,
  RegisterOptions,
  StateChangeListener,
} from './types';
