/**
 * 内核内部接口（C02）。这些类型从 `packages/core/src/index.ts` 导出，供 T12–T18 使用；
 * 签名一旦交付下游，修改需要先通知 A00 冻结相关任务（见 T11 任务卡）。
 */
import type { PipelineStage } from './constants';

/** 注销函数；所有注册接口都返回它，可安全重复调用。 */
export type Dispose = () => void;

/** 生命周期状态：已初始化 / 运行中 / 暂停 / 已销毁（另有初始的未初始化态）。 */
export type LifecycleState = 'uninitialized' | 'initialized' | 'running' | 'paused' | 'destroyed';

/** 事件优先级；critical 事件不会被预启动队列淘汰。 */
export type EventPriority = 'normal' | 'critical';

/**
 * 内核中的事件：只约定管线需要的三个字段，其余字段由各段处理器与插件按契约补充。
 * 处理器可以就地修改事件，也可以返回替换后的事件。
 */
export interface KernelEvent {
  readonly event_name: string;
  readonly priority: EventPriority;
  readonly occurred_at: number;
  [field: string]: unknown;
}

/** 计数器接口（C08 读取并聚合为 `sdk_health`）。 */
export interface Counters {
  /** 累加一个原因码；delta 非正数或非有限值时忽略。 */
  count(reason: string, delta?: number): void;
  /** 读取原因码当前计数，未出现过返回 0。 */
  get(reason: string): number;
  /** 返回全部非零计数的浅拷贝。 */
  snapshot(): Readonly<Record<string, number>>;
  /** 清空全部计数（C08 每个窗口聚合后调用）。 */
  reset(): void;
}

/** 生命周期状态变化监听器。 */
export type StateChangeListener = (state: LifecycleState, previous: LifecycleState) => void;

/** 生命周期状态机（C02-F1）。 */
export interface Lifecycle {
  state(): LifecycleState;
  isDestroyed(): boolean;
  /** 未初始化 → 已初始化；其他状态或已销毁时返回 false。 */
  init(): boolean;
  /** 已初始化 → 运行中。 */
  start(): boolean;
  /** 运行中 → 暂停。 */
  pause(): boolean;
  /** 暂停 → 运行中。 */
  resume(): boolean;
  /** 任意非销毁态 → 已销毁；重复销毁返回 false 并计数 destroyed。 */
  destroy(): boolean;
  /** 订阅状态变化；返回注销函数。 */
  onStateChange(listener: StateChangeListener): Dispose;
}

/** 管线处理器返回的终止信号：终止事件流转并计入原因码。 */
export interface PipelineStop {
  readonly stop: true;
  readonly reason: string;
}

/** 创建终止信号（过滤段插件最常用，例如返回 `stopPipeline(REASON_CODES.filteredByPlugin)`）。 */
export function stopPipeline(reason: string): PipelineStop {
  return { stop: true, reason };
}

/** 处理器执行上下文。 */
export interface ProcessorContext {
  readonly stage: PipelineStage;
  readonly counters: Counters;
  readonly processorId: string;
}

/**
 * 处理器返回值：事件（就地修改后返回原事件，或返回替换后的事件）或终止信号。
 * 处理器必须显式返回其中之一，避免忘记接力导致后续段拿到旧事件。
 */
export type ProcessorResult = KernelEvent | PipelineStop;

/** 处理器。 */
export type Processor = (event: KernelEvent, context: ProcessorContext) => ProcessorResult;

/** 处理器注册选项。 */
export interface RegisterOptions {
  /** 调试用处理器标识；缺省时自动生成。 */
  readonly id?: string | undefined;
}

/** 管线处理结果。 */
export interface ProcessOutcome {
  readonly status: 'processed' | 'stopped';
  readonly event: KernelEvent;
  /** status 为 stopped 时给出原因码。 */
  readonly reason?: string | undefined;
}

/** 六段处理管线（C02-F2、C02-F3）。 */
export interface Pipeline {
  /** 注册处理器；同一段内按注册顺序执行。返回注销函数。 */
  register(stage: PipelineStage, processor: Processor, options?: RegisterOptions): Dispose;
  /** 让事件依次经过六段；处理器抛错会跳过该处理器并计数 processor_error。 */
  process(event: KernelEvent): ProcessOutcome;
  /** 已注册处理器数量；不传段名时统计全部。 */
  size(stage?: PipelineStage): number;
  /** 清空全部处理器（内核销毁时调用）。 */
  dispose(): void;
}

/** 原生事件订阅选项；`capture` 参与原生监听的合并键。 */
export interface ListenerOptions {
  readonly capture?: boolean | undefined;
  readonly passive?: boolean | undefined;
}

/** 全局注册表统计，用于销毁自检与调试。 */
export interface GlobalRegistryStats {
  /** 订阅处理器总数。 */
  readonly listeners: number;
  /** 实际安装的原生监听数量（同一事件多订阅者只算一次）。 */
  readonly nativeListeners: number;
  /** 生效的 hook 层数。 */
  readonly hooks: number;
  /** 生效的定时器数量。 */
  readonly timers: number;
}

/** 全局注册表（C02-F6）：原生监听去重安装、hook 只包装不替换、定时器统一回收。 */
export interface GlobalRegistry {
  /** 订阅指定目标上的原生事件。 */
  listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: ListenerOptions,
  ): Dispose;
  /** 订阅默认目标（注入的 target，缺省为 globalThis）上的原生事件；无原生目标时静默降级。 */
  listenGlobal(type: string, handler: (event: Event) => void, options?: ListenerOptions): Dispose;
  /**
   * 包装 `target[key]`：包装函数收到包装前的函数，返回替代实现；注销时恢复包装前的函数。
   * 工厂函数可能在重建包装链时被多次调用，必须是纯函数。
   */
  hook<T extends object, K extends keyof T>(
    target: T,
    key: K,
    wrapper: (original: T[K]) => T[K],
  ): Dispose;
  /** 注册一次性定时器；注销或销毁时清除。 */
  schedule(handler: () => void, delayMs: number): Dispose;
  /** 注册重复定时器；注销或销毁时清除。 */
  scheduleRepeat(handler: () => void, intervalMs: number): Dispose;
  /** 当前统计。 */
  stats(): GlobalRegistryStats;
  /** 释放全部监听、hook 与定时器（内核销毁时调用）。 */
  dispose(): void;
}

/** 预启动队列入队结果。 */
export interface PrestartQueuePush {
  /** queued：直接入队；evicted：入队成功并淘汰了最早的 normal；rejected：新事件被丢弃。 */
  readonly status: 'queued' | 'evicted' | 'rejected';
  /** 本次上报的事件。 */
  readonly event: KernelEvent;
  /** status 为 evicted 时被淘汰的事件。 */
  readonly evicted?: KernelEvent | undefined;
}

/** 预启动队列（C02-F5）：配置就绪前缓存事件，条数与体积两个上限同时生效，溢出淘汰最早的 normal。 */
export interface PrestartQueue {
  push(event: KernelEvent): PrestartQueuePush;
  /** 按原顺序取出全部事件并清空队列。 */
  drain(): readonly KernelEvent[];
  size(): number;
  capacity(): number;
  /** 当前队列内事件的估算体积（JSON 码元数；口径见 `measureEventBytes`）。 */
  bytes(): number;
  /** 体积上限（缺省 `PRESTART_QUEUE_MAX_BYTES`）。 */
  maxBytes(): number;
  clear(): void;
}

/**
 * 能力注册表：内核与各模块之间的弱耦合扩展点。
 * 值类型的约定由注册方与读取方自行承担，读取方用类型断言取回具体类型
 * （例如 `kernel.getCapability('transport') as TransportPort | undefined`）。
 */
export interface CapabilityRegistry {
  /** 注册能力；同名以后注册者为准。返回注销函数（仅在自己仍是当前值时移除）。 */
  register(name: string, value: unknown): Dispose;
  has(name: string): boolean;
  /** 读取能力；未注册时返回 undefined。 */
  get(name: string): unknown;
  names(): readonly string[];
  /** 清空全部能力（内核销毁时调用）。 */
  dispose(): void;
}

/** 插件安装上下文：所有注册接口都自动绑定到插件，卸载时统一释放。 */
export interface PluginContext {
  readonly pluginId: string;
  readonly counters: Counters;
  readonly pipeline: Pipeline;
  readonly registry: GlobalRegistry;
  readonly capabilities: CapabilityRegistry;
  /** 注册处理器；卸载插件时自动注销。 */
  addProcessor(stage: PipelineStage, processor: Processor, options?: RegisterOptions): Dispose;
  /** 订阅默认原生目标上的事件；卸载插件时自动移除。 */
  listen(type: string, handler: (event: Event) => void, options?: ListenerOptions): Dispose;
  /** 包装原生方法；卸载插件时自动恢复。 */
  hook<T extends object, K extends keyof T>(
    target: T,
    key: K,
    wrapper: (original: T[K]) => T[K],
  ): Dispose;
  /** 一次性定时器；卸载插件时自动清除。 */
  schedule(handler: () => void, delayMs: number): Dispose;
  /** 重复定时器；卸载插件时自动清除。 */
  scheduleRepeat(handler: () => void, intervalMs: number): Dispose;
  /** 注册能力；卸载插件时自动移除。 */
  registerCapability(name: string, value: unknown): Dispose;
  /** 注册额外的清理函数；卸载插件时按后进先出执行。 */
  onDispose(disposer: Dispose): void;
}

/** 插件定义。 */
export interface Plugin {
  readonly id: string;
  /** 依赖的插件 id；依赖不存在时不安装并计数 plugin_dependency_missing。 */
  readonly dependencies?: readonly string[] | undefined;
  /** 安装函数；抛错时计数 plugin_install_failed 并回滚已注册的资源。清理逻辑用 `context.onDispose` 注册。 */
  readonly install: (context: PluginContext) => void;
}

/** 插件操作结果状态。 */
export type PluginStatus =
  | 'installed'
  | 'already_installed'
  | 'uninstalled'
  | 'not_installed'
  | 'unknown_plugin'
  | 'dependency_missing'
  | 'dependency_failed'
  | 'install_failed'
  | 'unavailable';

/** 插件操作结果。 */
export interface PluginActionResult {
  readonly pluginId: string;
  readonly status: PluginStatus;
  /** status 为 dependency_missing 时缺失的依赖。 */
  readonly missingDependencies?: readonly string[] | undefined;
  /** status 为 dependency_failed 时安装失败的依赖。 */
  readonly failedDependencies?: readonly string[] | undefined;
}

/** 插件宿主（C02-F4）。 */
export interface PluginHost {
  /** 注册插件定义；同一 id 重复注册以最后一次为准。 */
  register(plugin: Plugin): void;
  install(id: string): PluginActionResult;
  uninstall(id: string): boolean;
  /** 按配置启停插件：true 安装（含依赖），false 卸载。 */
  applyConfig(config: Readonly<Record<string, boolean>>): readonly PluginActionResult[];
  isRegistered(id: string): boolean;
  isInstalled(id: string): boolean;
  registeredIds(): readonly string[];
  installedIds(): readonly string[];
  /** 卸载全部插件并清空定义（内核销毁时调用）。 */
  dispose(): void;
}

/** 内核配置。 */
export interface KernelConfig {
  /**
   * 原生事件目标。不传时在首次使用时解析 `globalThis`；
   * 传 `null` 表示没有原生目标（SSR、Node 测试环境），此时原生订阅静默降级。
   */
  readonly target?: EventTarget | null | undefined;
  /**
   * 可选的共享全局注册表（C01-AC-10 多实例）。
   *
   * 传入后多个内核共享同一份原生监听：同一 `(target, type, capture)` 只 `addEventListener` 一次，
   * 每个实例的订阅者都收到事件；缺省仍为每个内核自建一个注册表（保持原有行为）。
   *
   * 注意：**计数器不共享**。注册表自身的原因码（如 hook/handler 抛错的 `processor_error`）
   * 记在创建该注册表时传入的 `Counters` 上；各内核仍持有各自的 `counters`，
   * 两个 `app_id` 的计数不会串。
   * 当前实现为兼容变更，由 T12 在 A02 扩权下追加。
   */
  readonly registry?: GlobalRegistry | undefined;
}

/** 内核（C02-F1 至 C02-F6）。 */
export interface Kernel {
  readonly counters: Counters;
  readonly lifecycle: Lifecycle;
  readonly pipeline: Pipeline;
  readonly plugins: PluginHost;
  readonly registry: GlobalRegistry;
  readonly prestartQueue: PrestartQueue;
  readonly capabilities: CapabilityRegistry;

  state(): LifecycleState;
  /** 初始化：未初始化 → 已初始化；其他状态忽略。 */
  init(): void;
  /** 启动：已初始化 → 运行中；其他状态忽略。 */
  start(): void;
  /** 暂停：运行中 → 暂停；`reason` 为暂停期间丢弃事件使用的原因码（例如 `consent_denied`）。 */
  pause(reason?: string): void;
  resume(): void;
  destroy(): void;

  /** 配置是否已就绪；就绪前的上报进入预启动队列。 */
  configReady(): boolean;
  /** 标记配置就绪并按原顺序回放预启动队列。 */
  markConfigReady(): void;

  /** 上报一条事件：未初始化忽略，暂停按原因计数，配置未就绪进队列，否则走管线。 */
  report(event: KernelEvent): void;
  /** 设置管线输出回调（发送前段结束后调用），返回注销函数。 */
  setOutput(sink: (event: KernelEvent) => void): Dispose;

  registerProcessor(stage: PipelineStage, processor: Processor, options?: RegisterOptions): Dispose;
  registerPlugin(plugin: Plugin): void;
  applyPluginConfig(config: Readonly<Record<string, boolean>>): void;

  /** 注册内核能力（供下游模块互相发现）。 */
  registerCapability(name: string, value: unknown): Dispose;
  /** 读取内核能力；未注册时返回 undefined。 */
  getCapability(name: string): unknown;
}
