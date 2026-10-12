/**
 * 内核包（C01–C04）。C02 内核（T11）见 `./kernel`，其余实现见 T12–T14。
 *
 * 说明：这里不放包级文档标签。tsup 打包入口 DTS 时会把入口自己的注释排到文件末尾，
 * API Extractor 因此报「package documentation 标签位置错误」（`pnpm api:check` 失败）。
 */

/** SDK 版本号，构建时由 package.json 注入前保持占位。 */
export const SDK_VERSION = '0.0.0';

// C02 内核：生命周期、六段处理管线、插件宿主、预启动队列与全局注册表。
// 这些内部接口供 T12–T18 使用，签名变更需要先通知 A00 冻结相关下游任务。
export {
  PIPELINE_STAGES,
  PRESTART_QUEUE_CAPACITY,
  REASON_CODES,
  createCapabilityRegistry,
  createCounters,
  createGlobalRegistry,
  createKernel,
  createLifecycle,
  createPipeline,
  createPluginHost,
  createPrestartQueue,
  definePlugin,
  stopPipeline,
} from './kernel';
export type { PipelineStage, ReasonCode } from './kernel';
export type {
  CapabilityRegistry,
  CapabilityRegistryServices,
  Counters,
  Dispose,
  EventPriority,
  GlobalRegistry,
  GlobalRegistryServices,
  GlobalRegistryStats,
  Kernel,
  KernelConfig,
  KernelEvent,
  Lifecycle,
  LifecycleServices,
  LifecycleState,
  ListenerOptions,
  Pipeline,
  PipelineServices,
  PipelineStop,
  Plugin,
  PluginActionResult,
  PluginContext,
  PluginHost,
  PluginHostServices,
  PluginStatus,
  PrestartQueue,
  PrestartQueueOptions,
  PrestartQueuePush,
  ProcessOutcome,
  Processor,
  ProcessorContext,
  ProcessorResult,
  RegisterOptions,
  StateChangeListener,
} from './kernel';

// C01 公共 API：接入方直接使用的方法、命令队列与类型化事件（T12）。
// 说明：`createClient` / `sdk` 是唯一会创建默认实例的入口；其余导出都是纯函数或类型。
export {
  API_REASON_CODES,
  COMMAND_QUEUE_CAPACITY,
  MAX_DIMENSION_VALUE_LENGTH,
  PUBLIC_METHODS,
  RESERVED_EVENT_PREFIXES,
  STATE_CAPABILITY,
  STUB_BRIDGE_CAPABILITY,
  WEB_JS_ERROR_LIMITS,
  createClient,
  createCommandQueue,
  createSdk,
  createUuid,
  defineEventDictionary,
  hasValidEventName,
  hasValidFieldKey,
  isConsentState,
  isNonEmptyString,
  isPlainRecord,
  readLocation,
  truncate,
} from './api';
export type {
  Client,
  ClientInitOptions,
  ClientOptions,
  ClientState,
  CommandQueue,
  CommandQueuePushResult,
  ConsentState,
  DiagnosticsRecord,
  DiagnosticsSink,
  DimensionFields,
  DimensionFieldsOf,
  EventDefinitionShape,
  EventDictionary,
  EventInput,
  EventRequest,
  EventRequestOf,
  EventSink,
  FieldSpec,
  FieldValue,
  LocationSource,
  LogLevel,
  MetricFields,
  MetricFieldsOf,
  OptionalFieldKeys,
  OptionalShape,
  PermissiveDictionary,
  PublicMethod,
  QueuedCommand,
  RequiredFieldKeys,
  RequiredShape,
  Sdk,
  ShapeOf,
  StubCommand,
  UserInput,
} from './api';
