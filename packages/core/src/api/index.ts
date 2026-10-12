/**
 * C01 公共 API 汇总（T12）。只从 `packages/core/src/index.ts` 对外暴露。
 * 模块顶层无副作用，可被 SSR 与 Vitest 直接导入。
 */
export { createClient, STATE_CAPABILITY, STUB_BRIDGE_CAPABILITY } from './client';
export { createCommandQueue } from './command-queue';
export type { CommandQueue, CommandQueuePushResult, QueuedCommand } from './command-queue';
export { createSdk } from './sdk';
export type { Sdk } from './sdk';
export {
  API_REASON_CODES,
  COMMAND_QUEUE_CAPACITY,
  MAX_DIMENSION_VALUE_LENGTH,
  RESERVED_EVENT_PREFIXES,
  WEB_JS_ERROR_LIMITS,
  createLocationSource,
  createUuid,
  hasValidEventName,
  hasValidFieldKey,
  isConsentState,
  isNonEmptyString,
  isPlainRecord,
  readLocation,
  truncate,
} from './values';
export { defineEventDictionary } from './typed-events';
export type {
  DimensionFields,
  DimensionFieldsOf,
  EventDefinitionShape,
  EventDictionary,
  EventRequest,
  EventRequestOf,
  FieldSpec,
  FieldValue,
  MetricFields,
  MetricFieldsOf,
  OptionalFieldKeys,
  OptionalShape,
  PermissiveDictionary,
  RequiredFieldKeys,
  RequiredShape,
  ShapeOf,
} from './typed-events';
export type {
  Client,
  ClientInitOptions,
  ClientOptions,
  ClientState,
  ConsentState,
  DiagnosticsRecord,
  DiagnosticsSink,
  EventInput,
  EventSink,
  LocationSource,
  LogLevel,
  PublicMethod,
  StubCommand,
  UserInput,
} from './types';
export { PUBLIC_METHODS } from './types';
