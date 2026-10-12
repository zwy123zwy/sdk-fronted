/**
 * @packageDocumentation
 * M01 本地 mock 接收服务（T09）。
 *
 * 实现 `docs/contracts/receiver-requirements.md` 的全部“必须”条目，供 POC、单元集成、
 * E2E 与可靠性对账使用。只监听 `127.0.0.1`，令牌只做固定占位值比对，**不得用于生产**。
 *
 * 逻辑都在独立模块里（`server.ts`、`store.ts`、`validate.ts`、`injection.ts`、
 * `config-host.ts`、`logger.ts`、`counters.ts`），本文件只做导出。
 */

/** 工具标识。 */
export const TOOL_ID = 'M01';

export {
  DEFAULT_PORT,
  INJECTION_TIMEOUT_MS,
  LISTEN_HOST,
  assertListenHost,
  createReceiver,
  isReceiverStartError,
  receiverStartError,
  startReceiver,
} from './server.js';
export type {
  ConfigApi,
  CountersApi,
  EventsApi,
  InjectionApi,
  InspectApi,
  LogsApi,
  MockReceiver,
  ReceiverOptions,
  ReceiverStartError,
} from './server.js';

export {
  MAX_BEACON_BYTES,
  MAX_COMPRESSED_BYTES,
  MAX_DECOMPRESSED_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENT_BYTES,
  countEvents,
  validateBatch,
} from './validate.js';
export type { ValidationError, ValidationResult } from './validate.js';

export { createStore, mergeEvent } from './store.js';
export type { BatchLike, Store, StoreBatchResult, StoredEvent } from './store.js';

export { createCounters } from './counters.js';
export type {
  CounterSnapshot,
  Counters,
  InjectionCode,
  RejectCode,
} from './counters.js';

export {
  DEFAULT_INJECTION_SEED,
  createInjectionController,
  createSeededRandom,
  normalizeSequence,
} from './injection.js';
export type {
  FaultKind,
  InjectionConfig,
  InjectionController,
  InjectionDecision,
  InjectionKind,
} from './injection.js';

export {
  computeEtag,
  createConfigStore,
  etagMatches,
  isConfigEnvelope,
} from './config-host.js';
export type { ConfigEnvelope, ConfigEntry, ConfigStore } from './config-host.js';

export {
  TOKEN_PLACEHOLDER,
  createLogger,
  maskIp,
  redactText,
  stripSecrets,
} from './logger.js';
export type { LogEntry, LogFields, LogLevel, Logger, LoggerOptions } from './logger.js';

export { readBody } from './body.js';
export type { ReadBodyFailure, ReadBodyOptions, ReadBodyResult } from './body.js';

export { ALLOWED_HEADERS } from './responses.js';

export { argsToOptions, main, runCli } from './cli.js';
export type { MainIo, RunCliOptions } from './cli.js';
export { USAGE, parseCliArgs } from './cli-args.js';
export type { CliArgs } from './cli-args.js';

export {
  DEFAULT_CONFIG_APP_ID,
  DEFAULT_CONFIG_ENV,
  PLACEHOLDER_ENVELOPE,
  loadDefaultEnvelope,
  loadEnvelopeFromFile,
} from './library-defaults.js';
