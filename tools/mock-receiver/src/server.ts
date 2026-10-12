/**
 * M01 本地 mock 接收服务（M01-F1 至 M01-F6）。
 *
 * 只监听 127.0.0.1，只用 Node 内置模块，不实现真实鉴权（令牌为固定占位值比对）。
 * 不得用于生产。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { readBody } from './body.js';
import {
  createConfigStore,
  etagMatches,
  isConfigEnvelope,
  type ConfigEnvelope,
} from './config-host.js';
import {
  createCounters,
  type CounterSnapshot,
  type Counters,
  type InjectionCode,
} from './counters.js';
import {
  createInjectionController,
  normalizeSequence,
  type FaultKind,
  type InjectionConfig,
} from './injection.js';
import {
  DEFAULT_CONFIG_APP_ID,
  DEFAULT_CONFIG_ENV,
  loadDefaultEnvelope,
  loadEnvelopeFromFile,
} from './library-defaults.js';
import { createLogger, TOKEN_PLACEHOLDER, type LogEntry, type Logger } from './logger.js';
import {
  headerValue,
  originOf,
  sendEmpty,
  sendError,
  sendJson,
  sendPreflight,
  type ResponseContext,
} from './responses.js';
import { createStore, type StoredEvent } from './store.js';
import type { RejectCode } from './counters.js';
import {
  MAX_EVENTS_PER_BATCH,
  countEvents,
  validateBatch,
  type ValidationError,
} from './validate.js';

/** 只允许的监听地址（M01-AC-15）。 */
export const LISTEN_HOST = '127.0.0.1';
/** 默认端口（未指定端口时自动分配空闲端口，见 M01-AC-13）。 */
export const DEFAULT_PORT = 8787;
/** 注入超时故障时保持连接不响应的时长。 */
export const INJECTION_TIMEOUT_MS = 150;

const BATCH_PATH = '/v1/batch';
const ADMIN_PREFIX = '/__mock/';
const CONFIG_PREFIX = '/v1/config/';
const DEFAULT_TOKEN = TOKEN_PLACEHOLDER;

/** 启动/参数校验失败（CLI 对应非零退出码）。 */
export interface ReceiverStartError extends Error {
  readonly name: 'ReceiverStartError';
}

/** 创建启动错误（不用 class，见指南第 11 节）。 */
export function receiverStartError(message: string): ReceiverStartError {
  const error = new Error(message) as Error & { name: 'ReceiverStartError' };
  error.name = 'ReceiverStartError';
  return error;
}

/** 类型守卫：判断是否为启动错误。 */
export function isReceiverStartError(value: unknown): value is ReceiverStartError {
  return value instanceof Error && value.name === 'ReceiverStartError';
}

export interface ReceiverOptions {
  port?: number;
  host?: string;
  /** 占位令牌；默认与契约样例一致。 */
  writeToken?: string;
  /** 返回 true 表示该令牌已吊销。 */
  isTokenRevoked?: (token: string) => boolean;
  /** 启动时直接注入存储失败（M01-AC-05）。 */
  storageFail?: boolean;
  /** 启动时加载的配置发布物文件（I-02 envelope）。 */
  configFile?: string;
  logger?: Logger;
}

export interface CountersApi {
  snapshot: () => CounterSnapshot;
  clear: () => void;
}

export interface EventsApi {
  list: (appId?: string) => StoredEvent[];
  size: (appId?: string) => number;
  clear: () => void;
}

export interface LogsApi {
  entries: () => LogEntry[];
  text: () => string;
  clear: () => void;
}

export interface InjectionApi {
  setSequence: (sequence: readonly string[]) => InjectionConfig;
  setRatio: (kind: InjectionCode, rate: number) => InjectionConfig;
  setStorageFail: (enabled: boolean) => InjectionConfig;
  clear: () => InjectionConfig;
  config: () => InjectionConfig;
}

export interface ConfigApi {
  publish: (appId: string, env: string, envelope: ConfigEnvelope) => string;
  get: (appId: string, env: string) => ConfigEnvelope | null;
  list: () => { app_id: string; env: string }[];
}

export interface InspectApi {
  /** 最近一次请求累计解压出的字节数（M01-AC-04 断言解压中止位置）。 */
  readonly lastDecompressedBytes: number;
  readonly writeToken: string;
  readonly boundAt: number;
}

export interface MockReceiver {
  readonly port: number;
  readonly host: string;
  readonly listening: boolean;
  readonly counters: CountersApi;
  readonly events: EventsApi;
  readonly logs: LogsApi;
  readonly injection: InjectionApi;
  readonly config: ConfigApi;
  readonly inspect: InspectApi;
  revokeToken: (token?: string) => void;
  /** 停止监听并释放端口；可重复调用。 */
  stop: () => Promise<void>;
}

/** 校验监听地址：只允许 127.0.0.1。 */
export function assertListenHost(host: string): void {
  if (host !== LISTEN_HOST) {
    throw receiverStartError(
      `M01 只允许监听 ${LISTEN_HOST}（请求的是 ${host}）；它只用于本地测试，不得用于生产。`,
    );
  }
}

interface ServerState {
  options: ReceiverOptions;
  token: string;
  counters: Counters;
  store: ReturnType<typeof createStore>;
  logger: Logger;
  injection: ReturnType<typeof createInjectionController>;
  configStore: ReturnType<typeof createConfigStore>;
  revoked: Set<string>;
  lastDecompressedBytes: number;
}

interface Runtime {
  server: Server | null;
  listening: boolean;
  port: number;
  boundAt: number;
}

/** createReceiver 与 startReceiver 之间共享的可变句柄。 */
const RUNTIME = Symbol('mock-receiver-runtime');
const STATE = Symbol('mock-receiver-state');

interface InternalReceiver extends MockReceiver {
  [RUNTIME]: Runtime;
  [STATE]: ServerState;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function contextOf(request: IncomingMessage, origin: string): ResponseContext {
  const provided = headerValue(request.headers['x-request-id']);
  return {
    origin,
    requestId: provided !== undefined && provided.length > 0 ? provided : randomUUID(),
    serverTime: Date.now(),
  };
}

function rejectCodeOf(error: ValidationError): RejectCode {
  switch (error) {
    case 'invalid_json':
      return 'invalid_json';
    case 'unsupported_protocol':
      return 'unsupported_protocol';
    case 'unsupported_encoding':
      return 'unsupported_encoding';
    case 'app_id_mismatch':
      return 'app_id_mismatch';
    case 'payload_too_large':
      return 'payload_too_large';
    case 'too_many_events':
      return 'too_many_events';
    case 'invalid_structure':
      return 'invalid_structure';
  }
}

function injectionCodeOf(kind: FaultKind): InjectionCode | null {
  switch (kind) {
    case '429':
    case '503':
    case '413':
    case '401':
    case 'timeout':
    case 'reset':
      return kind;
    case 'none':
      return null;
  }
}

async function applyFault(
  state: ServerState,
  response: ServerResponse,
  context: ResponseContext,
): Promise<boolean> {
  const decision = state.injection.decide();
  if (decision.kind === 'none') return false;
  const code = injectionCodeOf(decision.kind);
  if (code !== null) state.counters.onInjected(code);

  if (decision.kind === 'timeout') {
    state.logger.log({ level: 'warn', event: 'injected_fault', kind: 'timeout' }, 'injected timeout');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INJECTION_TIMEOUT_MS);
    });
    response.socket?.destroy();
    return true;
  }
  if (decision.kind === 'reset') {
    state.logger.log({ level: 'warn', event: 'injected_fault', kind: 'reset' }, 'injected reset');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    response.socket?.destroy(new Error('injected connection reset'));
    return true;
  }

  const status = decision.status ?? 503;
  const error = decision.error ?? 'internal_error';
  state.logger.log(
    { level: 'warn', event: 'injected_fault', kind: decision.kind, status, error },
    'fault injected',
  );
  sendError(response, context, status, error, `injected fault: ${decision.kind}`, {
    ...(decision.retryAfter === null ? {} : { retryAfter: decision.retryAfter }),
  });
  return true;
}

type ChannelResult =
  | { ok: true; appId: string; isBeacon: boolean }
  | { ok: false; status: 400 | 401; error: string; code: RejectCode; message: string };

function resolveChannel(
  state: ServerState,
  request: IncomingMessage,
  body: Record<string, unknown>,
  isBeacon: boolean,
): ChannelResult {
  const revoked = (token: string): boolean =>
    state.revoked.has(hashToken(token)) || (state.options.isTokenRevoked?.(token) ?? false);

  if (isBeacon) {
    const rawAuth = body['auth'];
    if (typeof rawAuth !== 'object' || rawAuth === null || Array.isArray(rawAuth)) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_token',
        code: 'invalid_token',
        message: 'beacon request requires auth in the body',
      };
    }
    const auth = rawAuth as Record<string, unknown>;
    const token = typeof auth['write_token'] === 'string' ? auth['write_token'] : '';
    const authAppId = typeof auth['app_id'] === 'string' ? auth['app_id'] : '';
    if (token !== state.token) {
      return { ok: false, status: 401, error: 'invalid_token', code: 'invalid_token', message: 'invalid write token' };
    }
    if (revoked(token)) {
      return { ok: false, status: 401, error: 'token_revoked', code: 'token_revoked', message: 'write token revoked' };
    }
    const bodyAppId = typeof body['app_id'] === 'string' ? body['app_id'] : '';
    if (authAppId !== bodyAppId) {
      return {
        ok: false,
        status: 400,
        error: 'app_id_mismatch',
        code: 'app_id_mismatch',
        message: 'auth.app_id does not match batch app_id',
      };
    }
    return { ok: true, appId: bodyAppId, isBeacon: true };
  }

  const headerToken = headerValue(request.headers['x-write-token']) ?? '';
  const headerAppId = headerValue(request.headers['x-app-id']) ?? '';
  if (headerToken !== state.token) {
    return { ok: false, status: 401, error: 'invalid_token', code: 'invalid_token', message: 'invalid write token' };
  }
  if (revoked(headerToken)) {
    return { ok: false, status: 401, error: 'token_revoked', code: 'token_revoked', message: 'write token revoked' };
  }
  if (headerAppId.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_structure',
      code: 'invalid_structure',
      message: 'missing X-App-Id',
    };
  }
  const bodyAppId = typeof body['app_id'] === 'string' ? body['app_id'] : headerAppId;
  if (headerAppId !== bodyAppId) {
    return {
      ok: false,
      status: 400,
      error: 'app_id_mismatch',
      code: 'app_id_mismatch',
      message: 'X-App-Id does not match batch app_id',
    };
  }
  return { ok: true, appId: headerAppId, isBeacon: false };
}

async function handleIngest(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
  context: ResponseContext,
): Promise<void> {
  if (await applyFault(state, response, context)) return;

  const contentType = (headerValue(request.headers['content-type']) ?? '').toLowerCase();
  const isBeacon = contentType.includes('text/plain');
  const acceptable = contentType.length === 0 || contentType.includes('application/json') || isBeacon;
  if (!acceptable) {
    state.counters.onRejected('invalid_structure');
    sendError(response, context, 400, 'invalid_structure', `unsupported Content-Type: ${contentType}`);
    return;
  }

  const decoded = await readBody(request, headerValue(request.headers['content-encoding']), {
    onDecompressed: (bytes) => {
      state.lastDecompressedBytes = bytes;
    },
  });
  if (!decoded.ok) {
    if (decoded.error === 'unsupported_encoding') state.counters.onRejected('unsupported_encoding');
    else if (decoded.status === 413) state.counters.onRejected('payload_too_large');
    else state.counters.onRejected('invalid_json');
    state.logger.log(
      { level: 'warn', event: 'request_rejected', status: decoded.status, error: decoded.error },
      'request body rejected',
    );
    sendError(response, context, decoded.status, decoded.error, decoded.message);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.text) as unknown;
  } catch {
    state.counters.onRejected('invalid_json');
    sendError(response, context, 400, 'invalid_json', 'request body is not valid JSON');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    state.counters.onRejected('invalid_structure');
    sendError(response, context, 400, 'invalid_structure', 'batch must be a JSON object');
    return;
  }
  const body = parsed as Record<string, unknown>;

  // 事件数上限先判：与结构无关，501 条（含缺失字段的批次）都按 413 处理。
  const eventCount = countEvents(body);
  if (eventCount > MAX_EVENTS_PER_BATCH) {
    state.counters.onBatchReceived(eventCount);
    state.counters.onRejected('too_many_events');
    state.logger.log(
      { level: 'warn', event: 'request_rejected', status: 413, error: 'too_many_events', events: eventCount },
      'batch exceeds event limit',
    );
    sendError(
      response,
      context,
      413,
      'too_many_events',
      `batch exceeds ${String(MAX_EVENTS_PER_BATCH)} events`,
    );
    return;
  }

  state.counters.onBatchReceived(eventCount);

  const channel = resolveChannel(state, request, body, isBeacon);
  if (!channel.ok) {
    state.counters.onRejected(channel.code);
    state.logger.log(
      { level: 'warn', event: 'request_rejected', status: channel.status, error: channel.error },
      channel.message,
    );
    sendError(response, context, channel.status, channel.error, channel.message);
    return;
  }

  state.logger.log(
    {
      level: 'info',
      event: 'batch_received',
      app_id: channel.appId,
      channel: channel.isBeacon ? 'beacon' : 'json',
      events: eventCount,
    },
    'batch received',
  );

  const validation = validateBatch(body);
  if (!validation.ok) {
    state.counters.onRejected(rejectCodeOf(validation.error));
    state.logger.log(
      { level: 'warn', event: 'request_rejected', status: 400, error: validation.error },
      validation.message,
    );
    sendError(response, context, 400, validation.error, validation.message);
    return;
  }

  if (state.injection.config().storageFail) {
    state.counters.onStorageFailure();
    state.logger.log(
      { level: 'error', event: 'storage_failed', error: 'storage_unavailable' },
      'storage failure injected',
    );
    sendError(response, context, 503, 'storage_unavailable', 'storage failure injected', {
      retryAfter: 1,
    });
    return;
  }

  const result = state.store.storeBatch(channel.appId, validation.batch);
  state.counters.onEventsStored(result.stored);
  if (result.duplicate > 0) state.counters.onDuplicate(result.duplicate);
  for (let index = 0; index < result.oversized; index += 1) state.counters.onEventTooLarge();

  state.logger.log(
    {
      level: 'info',
      event: 'batch_stored',
      app_id: channel.appId,
      stored: result.stored,
      duplicate: result.duplicate,
      oversized: result.oversized,
    },
    'batch stored',
  );
  sendJson(response, context, 202, undefined);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const decoded = await readBody(request, headerValue(request.headers['content-encoding']), {
    maxCompressedBytes: 256 * 1024,
  });
  if (!decoded.ok) return undefined;
  try {
    return JSON.parse(decoded.text) as unknown;
  } catch {
    return undefined;
  }
}

function fieldOf(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

function stringFieldOf(body: unknown, key: string): string | null {
  const value = fieldOf(body, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function handleAdmin(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
  context: ResponseContext,
  pathname: string,
): Promise<void> {
  const route = pathname.slice(ADMIN_PREFIX.length);
  const method = request.method ?? 'GET';

  if (route === 'health' && method === 'GET') {
    sendJson(response, context, 200, {
      tool: 'M01',
      status: 'ok',
      host: LISTEN_HOST,
      tokens_revoked: state.revoked.size,
      features: ['ingest', 'dedupe', 'fault-injection', 'counters', 'config-host'],
      warning: '只用于本地测试，不得用于生产',
    });
    return;
  }
  if ((route === 'counters' || route === 'stats') && method === 'GET') {
    sendJson(response, context, 200, state.counters.snapshot());
    return;
  }
  if ((route === 'counters/reset' || route === 'stats/reset') && (method === 'POST' || method === 'DELETE')) {
    state.counters.clear();
    sendJson(response, context, 200, state.counters.snapshot());
    return;
  }
  if (route === 'events' && method === 'GET') {
    const appId = headerValue(request.headers['x-app-id']);
    sendJson(response, context, 200, { app_id: appId ?? null, events: state.store.list(appId) });
    return;
  }
  if (route === 'events' && method === 'DELETE') {
    state.store.clear();
    sendJson(response, context, 200, { cleared: true });
    return;
  }
  if (route === 'logs' && method === 'GET') {
    sendJson(response, context, 200, { entries: state.logger.entries() });
    return;
  }
  if (route === 'logs/reset' && method === 'POST') {
    state.logger.clear();
    sendJson(response, context, 200, { cleared: true });
    return;
  }
  if (route === 'injection' && method === 'GET') {
    sendJson(response, context, 200, state.injection.config());
    return;
  }
  if (route === 'injection' && method === 'POST') {
    const body = await readJsonBody(request);
    const sequence = fieldOf(body, 'sequence');
    if (Array.isArray(sequence)) {
      state.injection.setSequence(sequence.map((item) => String(item)));
    }
    if (fieldOf(body, 'mode') === 'ratio' && typeof fieldOf(body, 'kind') === 'string') {
      state.injection.setRatio(
        fieldOf(body, 'kind') as InjectionCode,
        Number(fieldOf(body, 'rate') ?? 0),
      );
    }
    const storageFail = fieldOf(body, 'storageFail');
    if (typeof storageFail === 'boolean') state.injection.setStorageFail(storageFail);
    if (fieldOf(body, 'clear') === true) state.injection.clear();
    sendJson(response, context, 200, state.injection.config());
    return;
  }
  if (route === 'revoke' && method === 'POST') {
    const body = await readJsonBody(request);
    const token = stringFieldOf(body, 'write_token') ?? state.token;
    state.revoked.add(hashToken(token));
    state.logger.log({ level: 'warn', event: 'token_revoked' }, 'write token revoked');
    sendJson(response, context, 200, { revoked: state.revoked.size });
    return;
  }
  if (route === 'config' && method === 'POST') {
    const body = await readJsonBody(request);
    const envelope = fieldOf(body, 'envelope');
    if (!isConfigEnvelope(envelope)) {
      sendError(response, context, 400, 'invalid_structure', 'envelope must satisfy I-02');
      return;
    }
    const appId = stringFieldOf(body, 'app_id') ?? DEFAULT_CONFIG_APP_ID;
    const env = stringFieldOf(body, 'env') ?? DEFAULT_CONFIG_ENV;
    const etag = state.configStore.publish(appId, env, envelope);
    sendJson(response, context, 200, { app_id: appId, env, etag });
    return;
  }
  sendError(response, context, 404, 'not_found', `unknown admin route: ${pathname}`);
}

function handleConfig(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
  context: ResponseContext,
  pathname: string,
): void {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    sendError(response, context, 405, 'method_not_allowed', 'config hosting only supports GET');
    return;
  }
  const rest = pathname.slice(CONFIG_PREFIX.length);
  const slash = rest.lastIndexOf('/');
  if (slash < 0) {
    sendError(response, context, 404, 'not_found', 'config path must be /v1/config/{app_id}/{env}.json');
    return;
  }
  const appId = rest.slice(0, slash);
  const file = rest.slice(slash + 1);
  if (!file.endsWith('.json')) {
    sendError(response, context, 404, 'not_found', 'config path must end with .json');
    return;
  }
  const env = file.slice(0, -'.json'.length);
  const entry = state.configStore.get(appId, env);
  const etag = state.configStore.etagFor(appId, env);
  if (entry === null || etag === null) {
    sendError(response, context, 404, 'not_found', 'config not published');
    return;
  }
  if (etagMatches(headerValue(request.headers['if-none-match']), etag)) {
    sendEmpty(response, context, 304, { headers: { ETag: etag } });
    return;
  }
  sendJson(response, context, 200, entry.envelope, {
    headers: { ETag: etag, 'Cache-Control': 'max-age=300' },
  });
}

async function handleRequest(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const origin = originOf(request.headers['origin']);
  const context = contextOf(request, origin);
  const url = request.url ?? '/';
  const questionMark = url.indexOf('?');
  const pathname = questionMark < 0 ? url : url.slice(0, questionMark);
  const method = request.method ?? 'GET';

  const remoteAddress = request.socket.remoteAddress;
  state.logger.log(
    {
      level: 'debug',
      event: 'request',
      method,
      path: pathname,
      ...(remoteAddress === undefined ? {} : { ip: remoteAddress }),
    },
    `${method} ${pathname}`,
  );

  if (method === 'OPTIONS') {
    sendPreflight(response, context);
    return;
  }
  if (pathname === BATCH_PATH) {
    if (method !== 'POST') {
      sendError(response, context, 405, 'method_not_allowed', 'only POST is supported on /v1/batch');
      return;
    }
    await handleIngest(state, request, response, context);
    return;
  }
  if (pathname.startsWith(CONFIG_PREFIX)) {
    handleConfig(state, request, response, context, pathname);
    return;
  }
  if (pathname.startsWith(ADMIN_PREFIX)) {
    await handleAdmin(state, request, response, context, pathname);
    return;
  }
  sendError(response, context, 404, 'not_found', `unknown path: ${pathname}`);
}

/** 创建接收服务（尚未监听）。 */
export function createReceiver(options: ReceiverOptions = {}): MockReceiver {
  const host = options.host ?? LISTEN_HOST;
  assertListenHost(host);

  const token = options.writeToken ?? DEFAULT_TOKEN;
  const state: ServerState = {
    options,
    token,
    counters: createCounters(),
    store: createStore(),
    logger: options.logger ?? createLogger(),
    injection: createInjectionController(),
    configStore: createConfigStore(),
    revoked: new Set<string>(),
    lastDecompressedBytes: 0,
  };
  if (options.storageFail === true) state.injection.setStorageFail(true);

  const envelope = options.configFile === undefined
    ? loadDefaultEnvelope()
    : loadEnvelopeFromFile(options.configFile);
  state.configStore.register(DEFAULT_CONFIG_APP_ID, DEFAULT_CONFIG_ENV, envelope);

  const runtime: Runtime = { server: null, listening: false, port: 0, boundAt: 0 };

  const receiver: MockReceiver = {
    get port(): number {
      return runtime.port;
    },
    get host(): string {
      return LISTEN_HOST;
    },
    get listening(): boolean {
      return runtime.listening;
    },
    counters: {
      snapshot: () => state.counters.snapshot(),
      clear: () => {
        state.counters.clear();
      },
    },
    events: {
      list: (appId?: string) => state.store.list(appId),
      size: (appId?: string) => state.store.size(appId),
      clear: () => {
        state.store.clear();
      },
    },
    logs: {
      entries: () => state.logger.entries(),
      text: () => state.logger.text(),
      clear: () => {
        state.logger.clear();
      },
    },
    injection: {
      setSequence: (sequence: readonly string[]) => state.injection.setSequence(normalizeSequence(sequence)),
      setRatio: (kind: InjectionCode, rate: number) => state.injection.setRatio(kind, rate),
      setStorageFail: (enabled: boolean) => state.injection.setStorageFail(enabled),
      clear: () => state.injection.clear(),
      config: () => state.injection.config(),
    },
    config: {
      publish: (appId: string, env: string, value: ConfigEnvelope) =>
        state.configStore.publish(appId, env, value),
      get: (appId: string, env: string) => state.configStore.get(appId, env)?.envelope ?? null,
      list: () => state.configStore.list().map((entry) => ({ app_id: entry.app_id, env: entry.env })),
    },
    inspect: {
      get lastDecompressedBytes(): number {
        return state.lastDecompressedBytes;
      },
      get writeToken(): string {
        return token;
      },
      get boundAt(): number {
        return runtime.boundAt;
      },
    },
    revokeToken: (value?: string) => {
      state.revoked.add(hashToken(value ?? token));
    },
    stop: async (): Promise<void> => {
      const current = runtime.server;
      if (current === null || !runtime.listening) return;
      runtime.listening = false;
      await new Promise<void>((resolve) => {
        current.close(() => {
          resolve();
        });
        // 清理注入超时留下的悬挂连接，避免 close 永久等待。
        current.closeAllConnections();
      });
      runtime.server = null;
    },
  };

  (receiver as InternalReceiver)[RUNTIME] = runtime;
  (receiver as InternalReceiver)[STATE] = state;
  return receiver;
}

/** 启动接收服务并返回其编程式句柄（M01-F6）。非法地址或监听失败时 Promise 被 reject。 */
export function startReceiver(options: ReceiverOptions = {}): Promise<MockReceiver> {
  const host = options.host ?? LISTEN_HOST;
  const port = options.port ?? DEFAULT_PORT;

  return new Promise<MockReceiver>((resolve, reject) => {
    let receiver: InternalReceiver;
    try {
      assertListenHost(host);
      receiver = createReceiver(options) as InternalReceiver;
    } catch (error) {
      reject(isReceiverStartError(error) ? error : receiverStartError(String(error)));
      return;
    }
    const runtime = receiver[RUNTIME];
    const state = receiver[STATE];

    const server = createServer((request, response) => {
      handleRequest(state, request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'application/json;charset=UTF-8' });
        }
        response.end();
      });
    });

    const onError = (error: Error): void => {
      server.removeListener('error', onError);
      runtime.server = null;
      runtime.listening = false;
      reject(isReceiverStartError(error) ? error : receiverStartError(error.message));
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address() as AddressInfo | null;
      runtime.server = server;
      runtime.listening = true;
      runtime.port = address === null ? port : address.port;
      runtime.boundAt = Date.now();
      resolve(receiver);
    });
  });
}
