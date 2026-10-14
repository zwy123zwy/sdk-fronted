/**
 * C01-F1 / F2 / F5 / F6 公共 API 与命令队列（T12）。
 *
 * 设计要点：
 * - 每个公共方法同步返回 `undefined`、从不抛错；参数非法静默丢弃并计数原因码（C01-F6）。
 * - 销毁后调用任何公共方法都计数 `destroyed`（C01-AC-03，也是 C02-AC-14 在接入方 API 层的承接点）。
 * - 未就绪（首次 `init` 之前）的调用进入命令队列，`event_id` / `occurred_at` / `page_id` / `url`
 *   取**调用当时**的值；就绪后按调用顺序回放（C01-AC-04）。`event_id` 是去重的唯一依据，
 *   补发与重试不得改变，因此必须在入队时定下来。
 * - 产出的事件只含 `batch.schema.json` `$defs/event` 允许的键（`additionalProperties: false`）：
 *   `event_id`、`event_name`、`event_type`、`schema_version`、`occurred_at`、`priority`
 *   以及可选的 `page_id`、`url`、`level`、`dimensions`、`metrics`、`attachment`、`truncated`。
 *   `app_id` 是批次头字段，**不出现在事件体**（由 C04/C06/C07 组装批次时提供）。
 * - 模块顶层无副作用：不注册监听、不访问 `window`（位置来源首次使用时解析）。
 */
import {
  C04_LIMITS,
  createConsentFilterProcessor,
  createContextEnrichProcessor,
  createFieldConstraintsProcessor,
  createMasker,
  decideConsent,
  sanitizeUrl,
} from '../privacy';
import {
  CONTEXT_CAPABILITY,
  CONSENT_BUFFER_MAX_BYTES,
  CONSENT_BUFFER_MAX_EVENTS,
  SESSION_IDLE_MS,
  VIEW_CAPABILITY,
  createBatchHeaderProvider,
  createClockCalibration,
  createConsentManager,
  createContextStore,
  createPageTracker,
  createSessionTracker,
} from '../context';
import type {
  ConsentManager,
  ContextStoragePort,
  ContextStore,
  PageTracker,
  SessionTracker,
} from '../context';
import type { ConsentMode, Masker } from '../privacy/types';
import { SDK_VERSION } from '../version';
import { createKernel } from '../kernel';
import type { Kernel, KernelEvent } from '../kernel';
import { createCommandQueue } from './command-queue';
import type { QueuedCommand } from './command-queue';
import { NOOP_DIAGNOSTICS_SINK, createConsoleSink } from './console-sink';
import type {
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
  StubCommand,
} from './types';
import type { EventDictionary, PermissiveDictionary } from './typed-events';
import {
  API_REASON_CODES,
  MAX_DIMENSION_VALUE_LENGTH,
  WEB_JS_ERROR_LIMITS,
  createUuid,
  hasValidEventName,
  hasValidFieldKey,
  isConsentState,
  isFiniteNumber,
  isLogLevel,
  isNonEmptyString,
  isPlainRecord,
  readLocation,
  reportDiagnostics,
  truncate,
} from './values';

/** 事件类型（`event-standard.md` 第 2 节）。 */
const EVENT_TYPES = {
  custom: 'custom',
  log: 'log',
  error: 'error',
} as const;

/** 内置事件定义的版本；`web_js_error.schema.json` 要求恰好为 1。 */
const BUILTIN_SCHEMA_VERSION = 1;

/** 缺省事件定义版本（未在字典中声明时）。 */
const DEFAULT_SCHEMA_VERSION = 1;

/** 手动上报错误的 `source` 取值（R-007：`source` 为开放字符串，新增取值属兼容变更）。 */
const MANUAL_ERROR_SOURCE = 'manual';

const NO_EVENT_SINK: EventSink = () => undefined;

/** 只读状态快照的内核能力名（C02 与测试读取，不属于公共 API 方法）。 */
export const STATE_CAPABILITY = 'sdk.client_state';

/**
 * 加载桩交接能力名（C01-F3 集成点，不属于公共 API 方法）。
 * 值是 `(command: StubCommand) => void`：把加载桩缓存的命令交给主包实例回放。
 */
export const STUB_BRIDGE_CAPABILITY = 'sdk.stub_bridge';

/** 非 Error 未知值的安全字符串化：优先 JSON，失败退化为类型名；从不抛错。 */
function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value;
  }
}

/**
 * 去重指纹：由 source + 错误类型 + 归一化后的消息稳定派生（FNV-1a 32 位十六进制）。
 * 稳定且不超过 64 字符，满足 `web_js_error.schema.json` 对 `fingerprint` 的要求；
 * C05-AC-03 若需要更细的归一化（例如剥离栈里的地址），可以替换本实现。
 */
function createFingerprint(source: string, errorType: string, message: string): string {
  const normalized = message.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const input = `${source}|${errorType}|${normalized}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fp_${hash.toString(16).padStart(8, '0')}`;
}

/** 解析 `debug` 选项：缺省静默（C08-AC-09：非白名单用户不因 URL 参数自动开启调试）。 */
function resolveDiagnostics(debug: boolean | DiagnosticsSink | undefined): DiagnosticsSink {
  if (typeof debug === 'function') return debug;
  if (debug === true) return createConsoleSink();
  return NOOP_DIAGNOSTICS_SINK;
}

/** 批次头 provider 的能力名（T18 装配根读取后接到 C06 的 `BatchHeaderSource`）。 */
export const BATCH_HEADER_CAPABILITY = 'sdk.batch_header';

/** SDK 包名（批次头 `sdk_name`；装配根在 T18 可覆盖为 true 的包名）。 */
const SDK_NAME = '@web-report-sdk/core';

/**
 * 解析上下文/会话存储端口。
 *
 * **默认只驻留内存**（2026-10-13 经负责人裁定）：core **不自行读写 `window.localStorage`**——
 * 这与 `context/ports.ts` 的声明一致（「core 不读 `window`/`localStorage`，由装配根注入实现」），
 * 也符合 D004 的实测结论（`localStorage` 的写入不是同步持久化，硬杀窗口内会整段丢失）与
 * 「不把标识符默认写到磁盘」的隐私取向。需要跨页面持久的接入方，由装配根（T18）注入一个
 * 持久化实现（`ContextStoragePort` 本就是注入端口）。
 */
function resolveContextStorage(): ContextStoragePort {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

/** 事件体的 UTF-8 字节数（同意缓冲的容量判定；与 C04 的 16 KB 同口径）。 */
function byteLengthOf(event: KernelEvent): number {
  try {
    const text = JSON.stringify(event);
    let ascii = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) > 0x7f) return new TextEncoder().encode(text).length;
      ascii += 1;
    }
    return ascii;
  } catch {
    return 0;
  }
}

/** 事件参数的公共部分。 */
interface ReadEventInput {
  readonly dimensions: Record<string, string> | undefined;
  readonly metrics: Record<string, number> | undefined;
  readonly attachment: string | undefined;
  readonly priority: 'normal' | 'critical';
}

/** 调用当时的位置与时间快照。 */
interface EventSnapshot {
  readonly occurredAt: number;
  readonly eventId: string;
  readonly pageId: string | undefined;
  readonly viewId: string | undefined;
  readonly url: string | undefined;
}

/** 创建公共 API 客户端（C01-F5 多实例入口，也是全局 `sdk` 的实现）。 */
export function createClient<TDictionary extends EventDictionary = PermissiveDictionary>(
  options: ClientOptions = {},
): Client<TDictionary> {
  // 共享注册表（C01-AC-10）：多实例共用同一份原生监听；计数器仍各实例独立。
  const kernel: Kernel = createKernel({ target: options.target, registry: options.registry });
  const counters = kernel.counters;

  let eventSink: EventSink = options.onEvent ?? NO_EVENT_SINK;
  let diagnosticsSink: DiagnosticsSink = resolveDiagnostics(options.debug);
  let locationSource: LocationSource | undefined = options.location;
  let dictionary: EventDictionary | undefined = options.dictionary;
  let ready = false;
  let initialized = false;
  let finished = false;
  let appId: string | undefined;
  let currentPageId: string | undefined;
  // Q5 一致性修正（2026-10-13 负责人签字）：初始同意态为 `unknown`，不是 `granted`。
  // 默认「已授权」意味着未经同意即采集（合规问题）；`unknown` 下是否采集/持久化由 `consent_mode` 决定。
  let consent: ConsentState = 'unknown';
  // 旧的 `contexts` Map 仅用于 C01 的阅读路径（`state().contexts` 现在由 C04 store 提供），
  // 保留它只为兼容既有 C01 测试的读取口径；写入以 C04 store 为准。
  const contexts = new Map<string, string>();
  const queue = createCommandQueue();

  // ---- C04（T14）：脱敏、字段约束、上下文、同意与时钟 ----
  let consentMode: ConsentMode = options.consent_mode ?? 'essential_only';
  // 查询参数白名单与追加脱敏规则：来自初始化参数或 C03 的生效配置（装配根注入）；
  // 未装配时白名单为空 = 默认删除全部查询参数（比规则匹配更强的兜底）。
  const urlQueryAllowlist: string[] = [...(options.url_query_allowlist ?? [])];
  const masker: Masker = createMasker(options.extra_mask_rules ?? []);
  const storage = resolveContextStorage();
  const sessionTracker: SessionTracker = createSessionTracker({
    createId: createUuid,
    now: () => Date.now(),
    state: consent,
    mode: consentMode,
    persistentStorage: storage,
    sessionStorage: storage,
    limits: { sessionIdleMs: SESSION_IDLE_MS },
  });
  const pageTracker: PageTracker = createPageTracker({
    createId: createUuid,
    ...(options.pageId === undefined ? {} : { pageId: options.pageId }),
    ...(options.location?.href === undefined ? {} : { url: options.location.href }),
  });
  const consentManager: ConsentManager = createConsentManager({
    mode: consentMode,
    state: consent,
    count: (reason, delta) => { counters.count(reason, delta); },
    // 补发的缓冲事件直接交给管线出口（与正常路径同一个 sink）。
    emit: (event) => { kernel.report(event); },
    sizeOf: (event) => byteLengthOf(event),
    limits: { maxEvents: CONSENT_BUFFER_MAX_EVENTS, maxBytes: CONSENT_BUFFER_MAX_BYTES },
  });
  const contextStore: ContextStore = createContextStore({
    page: pageTracker,
    consent: consentManager,
    consentMode,
    ...(options.context === undefined ? {} : { initialContext: options.context }),
  });
  // 批次头 provider：装配根在 T18 通过 `headerProvider()` 接到 C06 的 `BatchHeaderSource`。
  // 这里把它注册为能力，保证接线前就有单一来源，且不会被 tree-shaking 掉。
  /**
   * 脱敏 URL：查询参数白名单之外的参数一律删除（白名单为空时删除全部）、
   * 路径与保留的参数值过脱敏规则、结果不超过 2048。
   *
   * 白名单来源是 C03 的生效配置（`privacy.url_query_allowlist`）；未装配配置运行时时为空数组
   * （即「默认删除全部查询参数」，比规则匹配更强的兜底）。
   */
  function maskUrl(url: string | undefined): string | undefined {
    if (url === undefined) return undefined;
    return sanitizeUrl(url, urlQueryAllowlist, masker);
  }

  const clock = createClockCalibration();
  const headerProvider = createBatchHeaderProvider({
    appId: '',
    sdkName: SDK_NAME,
    sdkVersion: SDK_VERSION,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.release === undefined ? {} : { release: options.release }),
    session: () => sessionTracker.current(),
    user: () => contextStore.user(),
    consent: () => consentManager.headerConsent(),
    clock: () => clock.current(),
  });

  // 只读状态快照通过内核能力暴露（C02 与测试用，不占用公共 API 方法位）。
  kernel.registerCapability(STATE_CAPABILITY, (): ClientState => snapshotState());
  // 管线输出接到本实例的事件出口；C06 传输层就绪后通过 `onEvent` 替换。
  kernel.setOutput((event: KernelEvent): void => {
    emit(event);
  });

  /** 提供 URL / page_id 调用当时的快照；SSR 环境返回全 undefined。 */
  function resolveLocation(): LocationSource {
    if (locationSource !== undefined) return locationSource;
    return readLocation();
  }

  function drop(record: DiagnosticsRecord): void {
    reportDiagnostics(counters, diagnosticsSink, record);
  }

  /** 只读状态快照（供内核能力 `STATE_CAPABILITY` 与测试读取）。 */
  function snapshotState(): ClientState {
    const contextState = contextStore.state();
    return {
      app_id: appId,
      initialized,
      destroyed: finished,
      consent,
      user: contextState.user === undefined ? undefined : { ...contextState.user },
      pageId: contextState.pageId,
      contexts: contextState.contexts,
      viewId: contextState.viewId,
      consentMode,
      bufferSize: contextState.bufferSize,
      bufferEvicted: contextState.bufferEvicted,
      contextKeysBeyondLimit: contextState.contextKeysBeyondLimit,
    };
  }

  /** 销毁后调用公共方法：计数 `destroyed` 并忽略；返回 true 表示调用方应立即返回。 */
  function isFinished(): boolean {
    if (!finished) return false;
    counters.count(API_REASON_CODES.destroyed);
    return true;
  }

  /**
   * 采集前的同意判定（C04-F5 的客户端侧入口）。
   *
   * 为什么要在这里判一次（而不是只靠管线的同意门）：内核的 `Processor` 只有
   * 「继续 / stopPipeline(reason)」两种返回值，而缓冲态需要「停止但**不**计原因码」。
   * 因此客户端在入队前完成判定：
   * - `emit` → `kernel.report`（管线里仍保留同意门作为旁路兜底）；
   * - `buffer` → 进内存缓冲，不进入内核（因此也不会有网络请求、不会计入丢弃码）；
   * - `deny` → 计数 `consent_denied`。
   */
  function submitToPipeline(event: KernelEvent): void {
    const decision = decideConsent(consent, consentMode, event);
    if (decision.action === 'emit') {
      kernel.report(event);
      return;
    }
    if (decision.action === 'buffer') {
      consentManager.buffer(event);
      return;
    }
    counters.count(decision.reason ?? 'consent_denied');
  }

  /** 事件出口；sink 抛错只计数 `processor_error`，不影响业务。 */
  function emit(event: KernelEvent): void {
    try {
      eventSink(event);
    } catch {
      counters.count(API_REASON_CODES.processorError);
    }
  }

  /** 调用当时的位置与标识快照：优先使用命令携带的快照，否则解析当前值。 */
  function captureSnapshot(command: QueuedCommand): EventSnapshot {
    const resolved = resolveLocation();
    return {
      occurredAt: command.occurredAt,
      eventId: command.eventId,
      pageId: command.pageId ?? currentPageId ?? resolved.pageId,
      viewId: command.viewId ?? contextStore.snapshot().view_id,
      url: command.url ?? resolved.href,
    };
  }

  /** 组装事件体：只放 `$defs/event` 允许的键（不含批次头字段 `app_id`）。 */
  function makeEvent(
    eventName: string,
    eventType: string,
    snapshot: EventSnapshot,
    priority: 'normal' | 'critical',
    schemaVersion: number,
  ): KernelEvent {
    const event: KernelEvent = {
      event_id: snapshot.eventId,
      event_name: eventName,
      event_type: eventType,
      schema_version: schemaVersion,
      priority,
      occurred_at: snapshot.occurredAt,
    };
    if (snapshot.pageId !== undefined) event['page_id'] = snapshot.pageId;
    if (snapshot.viewId !== undefined) event['view_id'] = snapshot.viewId;
    if (snapshot.url !== undefined) event['url'] = snapshot.url;
    return event;
  }

  /** 读取某个事件在运行期字典里的定义（用于 `schema_version` 与默认 `priority`）。 */
  function definitionOf(eventName: string): EventDictionary[string] | undefined {
    return dictionary?.[eventName];
  }

  /** 事件定义的版本：字典声明优先，缺省 1（未登记事件同样取 1）。 */
  function schemaVersionOf(eventName: string, fallback: number = DEFAULT_SCHEMA_VERSION): number {
    const declared = definitionOf(eventName)?.schema_version;
    return typeof declared === 'number' && Number.isInteger(declared) && declared >= 1 ? declared : fallback;
  }

  /** 维度的最小校验：非对象整体丢弃该字段；非字符串值单独计数并丢弃。 */
  function safeDimensions(value: unknown, eventName: string): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainRecord(value)) {
      counters.count(API_REASON_CODES.invalidArgs);
      drop({
        reason_code: API_REASON_CODES.invalidArgs,
        kind: 'track',
        event_name: eventName,
        dropped: 'field',
        field: 'dimensions',
      });
      return undefined;
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') result[key] = entry;
      else counters.count(API_REASON_CODES.invalidArgs);
    }
    return result;
  }

  /** 指标的最小校验：`NaN` / `Infinity` 无法被 JSON 表示，丢弃该字段并计数。 */
  function safeMetrics(value: unknown, eventName: string): Record<string, number> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainRecord(value)) {
      counters.count(API_REASON_CODES.invalidArgs);
      return undefined;
    }
    const metrics: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isFiniteNumber(entry)) {
        metrics[key] = entry;
        continue;
      }
      counters.count(API_REASON_CODES.nonFiniteMetric);
      drop({
        reason_code: API_REASON_CODES.nonFiniteMetric,
        kind: 'track',
        event_name: eventName,
        dropped: 'field',
        field: `metrics.${key}`,
      });
    }
    return metrics;
  }

  /** 读取事件参数对象；输入非法时计数并忽略。 */
  function readEventInput(input: unknown, eventName: string): ReadEventInput {
    if (input !== undefined && !isPlainRecord(input)) {
      counters.count(API_REASON_CODES.invalidArgs);
      drop({ reason_code: API_REASON_CODES.invalidArgs, kind: 'track', event_name: eventName, dropped: 'field', field: 'args' });
    }
    const record = isPlainRecord(input) ? input : {};
    return {
      dimensions: safeDimensions(record['dimensions'], eventName),
      metrics: safeMetrics(record['metrics'], eventName),
      attachment: typeof record['attachment'] === 'string' ? record['attachment'] : undefined,
      priority: record['priority'] === 'critical' ? 'critical' : 'normal',
    };
  }

  /**
   * 按 Schema 上限截断并记录路径（`event-standard.md` 第 4 节；正式实现由 C04 接管）。
   *
   * **顺序：先脱敏、再截断**（与 C04 的 `clampAttachment` / `clampUrl` 一致）：截断在前会把
   * 敏感值从中间切开，切断后的片段不再匹配任何规则，会以残片形式原样上线（实测跨界手机号
   * 残留 `138001`）。掩码用的是**同一个** `masker` 实例（含 `extra_mask_rules`），不是第二套规则。
   *
   * 只在**需要截断**时才在这里脱敏：未超长的值原样进入管线，仍由隐私处理器脱敏一次
   * （避免对追加规则重复施加）；超长值必须在这里收口，否则原始大字段会先进入同意缓冲 ——
   * 那里按字节淘汰（`CONSENT_BUFFER_MAX_BYTES`），超大事件会被**整条丢弃**而不是截断保留。
   *
   * dimensions（`message`/`error_type`/`source`/`fingerprint`）与 `attachment` 共用本函数：
   * 「截断早于脱敏」是同一个根因，不留两套路径。
   */
  function clampAndTrack(value: string, maxLength: number, path: string, truncatedPaths: string[]): string {
    if (value.length <= maxLength) return value;
    counters.count(API_REASON_CODES.truncatedDimension);
    if (!truncatedPaths.includes(path)) truncatedPaths.push(path);
    return truncate(masker.apply(value), maxLength);
  }

  function performTrack(command: QueuedCommand): void {
    const requestedName = command.name;
    if (typeof requestedName !== 'string' || !hasValidEventName(requestedName)) {
      counters.count(API_REASON_CODES.invalidEventName);
      drop({
        reason_code: API_REASON_CODES.invalidEventName,
        kind: 'track',
        event_name: typeof requestedName === 'string' ? requestedName : undefined,
        dropped: 'event',
      });
      return;
    }
    const name = requestedName;
    const snapshot = captureSnapshot(command);
    const input = readEventInput(command.args?.[0], name);
    const declaredPriority = definitionOf(name)?.priority ?? 'normal';
    const explicitPriority = isPlainRecord(command.args?.[0]) && command.args[0]['priority'] !== undefined;
    const priority = explicitPriority ? input.priority : declaredPriority;
    const event = makeEvent(name, EVENT_TYPES.custom, snapshot, priority, schemaVersionOf(name));
    if (input.dimensions !== undefined) event['dimensions'] = input.dimensions;
    if (input.metrics !== undefined) event['metrics'] = input.metrics;
    if (input.attachment !== undefined) event['attachment'] = input.attachment;
    submitToPipeline(event);
  }

  function performLog(command: QueuedCommand): void {
    const args = command.args ?? [];
    const level = isLogLevel(args[0]) ? args[0] : 'info';
    if (args[0] !== undefined && !isLogLevel(args[0])) counters.count(API_REASON_CODES.invalidArgs);
    const message = typeof args[1] === 'string' ? args[1] : '';
    const input = readEventInput(args[2], 'sdk_log');
    const truncatedPaths: string[] = [];
    // 事件体没有顶层 `message` 字段：正文放进 `dimensions.message`（与内置 web_js_error 一致）。
    const dimensions: Record<string, string> = { ...input.dimensions };
    dimensions['message'] = clampAndTrack(message, MAX_DIMENSION_VALUE_LENGTH, 'dimensions.message', truncatedPaths);
    const event = makeEvent('sdk_log', EVENT_TYPES.log, captureSnapshot(command), input.priority, BUILTIN_SCHEMA_VERSION);
    event['level'] = level;
    event['dimensions'] = dimensions;
    if (input.metrics !== undefined) event['metrics'] = input.metrics;
    if (input.attachment !== undefined) {
      event['attachment'] = clampAndTrack(input.attachment, WEB_JS_ERROR_LIMITS.attachment, 'attachment', truncatedPaths);
    }
    if (truncatedPaths.length > 0) event['truncated'] = truncatedPaths;
    submitToPipeline(event);
  }

  /**
   * 手动上报错误（`web_js_error`）。
   * `dimensions` 只允许 4 个内置键（`web_js_error.schema.json` 为 `additionalProperties: false`）：
   * `error_type`、`message`、`source`、`fingerprint`；`metrics.count` 缺省 1。
   */
  function performCaptureError(command: QueuedCommand): void {
    const args = command.args ?? [];
    const input = readEventInput(args[1], 'web_js_error');
    const error = args[0];

    let errorType = 'UnknownError';
    let message: string | undefined;
    let attachment = input.attachment;
    if (error instanceof Error) {
      errorType = error.name.length > 0 ? error.name : 'Error';
      message = error.message;
      attachment ??= error.stack;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error !== undefined && error !== null) {
      message = stringifyUnknown(error);
    } else {
      counters.count(API_REASON_CODES.invalidArgs);
      return;
    }

    // 只挑出内置维度键；其余键丢弃并计数（Schema 不接受额外维度）
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.dimensions ?? {})) {
      if (key === 'error_type' || key === 'message' || key === 'source' || key === 'fingerprint') {
        overrides[key] = value;
      } else {
        counters.count(API_REASON_CODES.invalidArgs);
      }
    }

    const truncatedPaths: string[] = [];
    const source = overrides['source'] ?? MANUAL_ERROR_SOURCE;
    const overrideMessage = overrides['message'];
    const resolvedMessage = overrideMessage !== undefined ? overrideMessage : message;
    const dimensions: Record<string, string> = {
      error_type: clampAndTrack(
        overrides['error_type'] ?? errorType,
        WEB_JS_ERROR_LIMITS.errorType,
        'dimensions.error_type',
        truncatedPaths,
      ),
      message: clampAndTrack(resolvedMessage, WEB_JS_ERROR_LIMITS.message, 'dimensions.message', truncatedPaths),
      source: clampAndTrack(source, WEB_JS_ERROR_LIMITS.source, 'dimensions.source', truncatedPaths),
      fingerprint: clampAndTrack(
        overrides['fingerprint'] ?? createFingerprint(source, errorType, resolvedMessage),
        WEB_JS_ERROR_LIMITS.fingerprint,
        'dimensions.fingerprint',
        truncatedPaths,
      ),
    };

    const metrics: Record<string, number> = { count: 1 };
    for (const [key, value] of Object.entries(input.metrics ?? {})) {
      if (key === 'count' && isFiniteNumber(value) && Number.isInteger(value) && value >= 1) metrics['count'] = value;
      else if ((key === 'line' || key === 'column') && isFiniteNumber(value) && Number.isInteger(value) && value >= 0) {
        metrics[key] = value;
      } else counters.count(API_REASON_CODES.invalidArgs);
    }
    // 内置事件的 priority 固定为 normal（Q3 结论第 4 条，Schema 为 const）
    if (input.priority === 'critical') counters.count(API_REASON_CODES.invalidArgs);

    const event = makeEvent(
      'web_js_error',
      EVENT_TYPES.error,
      captureSnapshot(command),
      'normal',
      BUILTIN_SCHEMA_VERSION,
    );
    event['dimensions'] = dimensions;
    event['metrics'] = metrics;
    if (attachment !== undefined) {
      event['attachment'] = clampAndTrack(attachment, WEB_JS_ERROR_LIMITS.attachment, 'attachment', truncatedPaths);
    }
    if (truncatedPaths.length > 0) event['truncated'] = truncatedPaths;
    submitToPipeline(event);
  }

  /**
   * `setUser`：只进批次头（`user_id`/`user_id_hashed`），绝不进事件体。
   * 超过 128 字符（批次 Schema 上限）时**丢弃整个字段**并计 `invalid_args`（不截断 ——
   * 截断后的哈希值是无意义的错误标识）。参数合法性归 C01（`invalid_args`）。
   */
  function performSetUser(command: QueuedCommand): void {
    const args = command.args ?? [];
    const id = args[0];
    if (!isNonEmptyString(id)) {
      counters.count(API_REASON_CODES.invalidArgs);
      return;
    }
    const hashed = isPlainRecord(args[1]) && args[1]['hashed'] === true;
    contextStore.setUser(id, { hashed });
  }

  function performSetContext(command: QueuedCommand): void {
    const args = command.args ?? [];
    const key = args[0];
    const value = args[1];
    if (typeof value !== 'string') {
      // 值类型非法属 C01 的参数校验（`invalid_args`）；键名格式非法属 C04（`invalid_field_key`）。
      counters.count(API_REASON_CODES.invalidArgs);
      return;
    }
    if (!hasValidFieldKey(key)) {
      counters.count('invalid_field_key');
      return;
    }
    contexts.set(key, value);
    contextStore.setContext(key, value);
  }

  function performRemoveContext(command: QueuedCommand): void {
    const key = (command.args ?? [])[0];
    if (typeof key !== 'string') return;
    contexts.delete(key);
    contextStore.removeContext(key);
  }

  function performSetPage(command: QueuedCommand): void {
    const pageId = (command.args ?? [])[0];
    if (!isNonEmptyString(pageId)) {
      counters.count(API_REASON_CODES.invalidArgs);
      return;
    }
    currentPageId = pageId;
    contextStore.setPage(pageId);
  }

  function performSetConsent(command: QueuedCommand): void {
    const state = (command.args ?? [])[0];
    if (!isConsentState(state)) {
      counters.count(API_REASON_CODES.invalidArgs);
      return;
    }
    consent = state;
    consentManager.setState(state);
    sessionTracker.onConsentChange(state, consentMode);
    // `denied`：清除持久化/内存中的设备标识（离线数据与会话随机数由清理端口通知，见 ErasePort）。
    if (state === 'denied') sessionTracker.purge();
  }

  /** `configureView`：导航通知（路由变化时轮换 `view_id`，并更新 `url`）。 */
  function performConfigureView(command: QueuedCommand): void {
    const viewOptions = (command.args ?? [])[0];
    if (viewOptions === undefined) return;
    if (!isPlainRecord(viewOptions)) {
      counters.count(API_REASON_CODES.invalidArgs);
      return;
    }
    const url = typeof viewOptions['url'] === 'string' ? viewOptions['url'] : undefined;
    const viewId = typeof viewOptions['view_id'] === 'string' ? viewOptions['view_id'] : undefined;
    contextStore.configureView({
      ...(url === undefined ? {} : { url }),
      ...(viewId === undefined ? {} : { view_id: viewId }),
    });
  }

  function performInit(command: QueuedCommand): void {
    const raw = (command.args ?? [])[0];
    const initOptions: ClientInitOptions = isPlainRecord(raw) ? raw : {};
    if (!isNonEmptyString(initOptions.appId)) {
      counters.count(API_REASON_CODES.invalidArgs);
      return;
    }
    if (initialized) return;
    appId = initOptions.appId;
    const previousConsent = consent;
    if (isConsentState(initOptions.consent)) consent = initOptions.consent;
    if (isNonEmptyString(initOptions.pageId)) currentPageId = initOptions.pageId;
    if (initOptions.debug !== undefined) diagnosticsSink = resolveDiagnostics(initOptions.debug);
    if (initOptions.onEvent !== undefined) eventSink = initOptions.onEvent;
    if (initOptions.location !== undefined) {
      locationSource = initOptions.location;
      if (initOptions.location.href !== undefined && command.url === undefined) {
        // 只有「新初始化的直接调用」才用 init 的 location 更新追踪器；
        // 从命令队列回放的任务带着自己的入队快照，不能被当前页面覆盖。
        pageTracker.noteLocation(initOptions.location.href);
      }
    }
    if (initOptions.dictionary !== undefined) dictionary = initOptions.dictionary;
    if (initOptions.consent_mode !== undefined) {
      consentMode = initOptions.consent_mode;
      consentManager.setMode(consentMode);
      contextStore.setConsentMode(consentMode);
    }
    if (initOptions.url_query_allowlist !== undefined) {
      urlQueryAllowlist.splice(0, urlQueryAllowlist.length, ...initOptions.url_query_allowlist);
    }
    if (initOptions.pageId !== undefined && command.url === undefined) pageTracker.setPage(initOptions.pageId);
    if (initOptions.context !== undefined) contextStore.setInitialContext(initOptions.context);
    // 同意状态在初始化参数里显式给出时，同步到状态机与会话追踪器（缺省保持 `unknown`）。
    // 注意：上面对 `consent` 的赋值会覆盖旧值，因此这里必须与**赋值前**的值比较。
    if (consent !== previousConsent) {
      consentManager.setState(consent);
      sessionTracker.onConsentChange(consent, consentMode);
    }
    // C04 的管线处理器：validate（字段约束 + 16 KB）→ enrich（上下文）→ filter（同意门）。
    kernel.registerProcessor(
      'validate',
      createFieldConstraintsProcessor({ limits: C04_LIMITS, masker, count: (reason, delta) => { counters.count(reason, delta); } }),
      { id: 'c04_field_constraints' },
    );
    kernel.registerProcessor('enrich', createContextEnrichProcessor(contextStore), { id: 'c04_context_enrich' });
    kernel.registerProcessor('filter', createConsentFilterProcessor(consentManager), { id: 'c04_consent_gate' });
    kernel.init();
    kernel.start();
    initialized = true;
    ready = true;
    kernel.markConfigReady();
    flushQueue();
  }

  function performDestroy(): void {
    if (finished) return;
    finished = true;
    initialized = false;
    ready = false;
    queue.clear();
    contexts.clear();
    currentPageId = undefined;
    eventSink = NO_EVENT_SINK;
    diagnosticsSink = NOOP_DIAGNOSTICS_SINK;
    contextStore.destroy();
    sessionTracker.purge();
    kernel.destroy();
  }

  /** 回放一条命令；命令携带的 `eventId` / `pageId` / `url` / `occurredAt` 是调用当时的快照。 */
  function replay(command: QueuedCommand): void {
    switch (command.kind) {
      case 'init':
        performInit(command);
        return;
      case 'track':
        performTrack(command);
        return;
      case 'log':
        performLog(command);
        return;
      case 'captureError':
        performCaptureError(command);
        return;
      case 'setUser':
        performSetUser(command);
        return;
      case 'clearUser':
        contextStore.clearUser();
        return;
      case 'setContext':
        performSetContext(command);
        return;
      case 'removeContext':
        performRemoveContext(command);
        return;
      case 'setPage':
        performSetPage(command);
        return;
      case 'setConsent':
        performSetConsent(command);
        return;
      case 'configureView':
        performConfigureView(command);
        return;
      case 'flush':
        return;
      case 'destroy':
        performDestroy();
        return;
      default:
        return;
    }
  }

  function enqueue(command: QueuedCommand): void {
    const result = queue.push(command);
    if (result.status === 'rejected') counters.count(API_REASON_CODES.commandQueueOverflow);
  }

  /** 派发一条命令：就绪时立即执行，未就绪时入队。 */
  function dispatch(command: QueuedCommand): void {
    if (ready && !finished) replay(command);
    else enqueue(command);
  }

  /** 按调用顺序回放命令队列；回放期间新到的命令继续追加到队尾。 */
  function flushQueue(): void {
    while (!finished) {
      const next = queue.shift();
      if (next === undefined) return;
      try {
        replay(next);
      } catch {
        counters.count(API_REASON_CODES.processorError);
      }
    }
  }

  /** 公共方法入口：销毁后计数并忽略，否则生成命令并派发。 */
  function submit(kind: string, submitArgs: readonly unknown[]): void {
    if (isFinished()) return;
    const location = resolveLocation();
    // 先把追踪器同步到**调用当时**的位置，再取快照 —— 顺序反了就会把上一次的 URL 写进命令。
    if (location.href !== undefined) contextStore.configureView({ url: location.href });
    // 入队当时的页面归属快照（AC-03 的唯一落点）：page_id/view_id/url 在此定下来。
    const context = contextStore.snapshot();
    const command: QueuedCommand = {
      kind,
      eventId: createUuid(),
      occurredAt: Date.now(),
      pageId: context.page_id ?? location.pageId,
      url: maskUrl(context.url ?? location.href),
      ...(context.view_id === undefined ? {} : { viewId: context.view_id }),
    };
    if (kind === 'track') {
      const name = submitArgs[0];
      const args = submitArgs.slice(1);
      dispatch({ ...command, name: typeof name === 'string' ? name : undefined, args });
      return;
    }
    dispatch({ ...command, args: submitArgs });
  }

  /** 加载桩交接：按缓存顺序立即回放（内部集成点，见 `STUB_BRIDGE_CAPABILITY`）。 */
  function acceptStubCommand(command: StubCommand): void {
    if (isFinished()) return;
    const snapshot = resolveLocation();
    try {
      replay({
        kind: command.kind,
        name: command.name,
        args: command.args,
        eventId: command.eventId ?? createUuid(),
        occurredAt: command.occurredAt ?? Date.now(),
        pageId: command.pageId ?? currentPageId ?? snapshot.pageId,
        url: command.url ?? snapshot.href,
      });
    } catch {
      counters.count(API_REASON_CODES.processorError);
    }
  }

  kernel.registerCapability(STUB_BRIDGE_CAPABILITY, acceptStubCommand);
  // C04 的对外句柄（供 T18 装配根与测试读取；不属于公共 API 方法）。
  kernel.registerCapability(CONTEXT_CAPABILITY, contextStore);
  kernel.registerCapability(BATCH_HEADER_CAPABILITY, headerProvider);
  kernel.registerCapability(VIEW_CAPABILITY, (viewOptions?: { readonly url?: string | undefined; readonly view_id?: string | undefined }): void => {
    contextStore.configureView(viewOptions ?? {});
  });

  const implementation = {
    kernel,

    onEvent(sink: EventSink): () => void {
      eventSink = sink;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (eventSink === sink) eventSink = NO_EVENT_SINK;
      };
    },

    onDiagnostics(sink: DiagnosticsSink): () => void {
      diagnosticsSink = sink;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (diagnosticsSink === sink) diagnosticsSink = NOOP_DIAGNOSTICS_SINK;
      };
    },

    init(initOptions?: ClientInitOptions): undefined {
      // init 必须立即生效：它决定后续调用进入执行还是入队。
      if (isFinished()) return undefined;
      performInit({ kind: 'init', eventId: createUuid(), occurredAt: Date.now(), args: [initOptions] });
      flushQueue();
      return undefined;
    },
    track(name: string, input?: unknown): undefined {
      submit('track', [name, input]);
      return undefined;
    },
    log(level: LogLevel, message: string, input?: EventInput): undefined {
      submit('log', [level, message, input]);
      return undefined;
    },
    captureError(error: unknown, input?: EventInput): undefined {
      submit('captureError', [error, input]);
      return undefined;
    },
    setUser(id: string, userOptions?: { readonly hashed?: boolean | undefined }): undefined {
      submit('setUser', [id, userOptions]);
      return undefined;
    },
    clearUser(): undefined {
      submit('clearUser', []);
      return undefined;
    },
    setContext(key: string, value: string): undefined {
      submit('setContext', [key, value]);
      return undefined;
    },
    removeContext(key: string): undefined {
      submit('removeContext', [key]);
      return undefined;
    },
    setPage(pageId: string): undefined {
      submit('setPage', [pageId]);
      return undefined;
    },
    setConsent(state: ConsentState): undefined {
      submit('setConsent', [state]);
      return undefined;
    },
    configureView(viewOptions?: { readonly url?: string | undefined; readonly view_id?: string | undefined }): undefined {
      submit('configureView', [viewOptions]);
      return undefined;
    },
    flush(): undefined {
      if (isFinished()) return undefined;
      if (ready) flushQueue();
      return undefined;
    },
    destroy(): undefined {
      // 销毁必须立即生效（未就绪时也清空命令队列），不进入队列等待回放。
      if (isFinished()) return undefined;
      performDestroy();
      return undefined;
    },
  };

  return implementation as Client<TDictionary>;
}
