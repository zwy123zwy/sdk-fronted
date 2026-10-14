/**
 * @packageDocumentation
 * 接入方安装的汇总入口包：重新导出 core 的公共 API（C01）、传输与默认插件（T15–T19）。
 *
 * 本模块顶层不产生副作用：不注册原生监听、不访问 `window`、不自动 `init`。
 * 非构建环境（`<script>` 引入）请先内联 `loading-stub`，再加载本包的 IIFE 产物；
 * 加载桩缓存的调用通过 `client.acceptCommand` 回放。
 */

export {
  API_REASON_CODES,
  COMMAND_QUEUE_CAPACITY,
  MAX_DIMENSION_VALUE_LENGTH,
  PUBLIC_METHODS,
  RESERVED_EVENT_PREFIXES,
  SDK_VERSION,
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
} from '@web-report-sdk/core';
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
} from '@web-report-sdk/core';

// T18 装配根：把 C01–C08 接起来，让事件真的发得出去。
// 归属见 `docs/tasks/T18.md` 的「文件所有权」（2026-10-13 负责人批准的所有权扩展）。
export { createAssembly } from './assembly';
export type {
  Assembly,
  AssemblyOptions,
  CollectorHandles,
  CredentialsLike,
} from './assembly';
