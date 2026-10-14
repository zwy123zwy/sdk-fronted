/**
 * 装配根（T18）：把 C01–C08 接起来，让事件**真的发得出去**。
 *
 * 归属依据：`docs/tasks/T18.md` 的「文件所有权」（2026-10-13 经负责人批准的所有权扩展：
 * `packages/browser/src/**`）。本模块只做接线，不重新实现任何模块。
 *
 * 接线义务（`docs/reports/handover.md` 第 1 节）在代码中的落点：
 * 1. `captureNativeHttpRefs()`：`createAssembly()` 的**第一件事**，先于 `createClient()`
 *    与任何插件安装（幂等、捕获后冻结）。C05 插件不在自己的 `install()` 里捕获。
 * 2. C08 计数/计时：装饰后的**句柄**才交给下游——
 *    `createQueueMetricsSource().queue` → `delivery.attachQueue` / 事件出口；
 *    `createSubmitMetricsSource().submit` → C06 的 `submit`；
 *    `createCallCounter` / `createLatencyDecorators` → 接入方拿到的客户端句柄；
 *    三者与 `createDeliveryMetricsSource` 合并后交给 `createHealthReporter.metrics`。
 * 3. C04 的三个端口：`clock.noteServerTime` ← C07 的 `onServerTime`（`X-Server-Time`）；
 *    `header()` ← 内核能力 `sdk.batch_header`，再补上本条线的 `app_id` 与校准后的
 *    `clock_offset`/`clock_calibrated`，交给 C06 的 `BatchHeaderSource`；
 *    `erasePort` 的 `offlineData` ← C07 的 `clearOffline`，注入 `createClient({ erase })`，
 *    由 C04 在 `setConsent('denied')` 时触发（core 缺陷已修：`ErasePort` 不再是无调用点的死类型）。
 * 4. 存储端口：core 的上下文存储默认驻留内存（负责人 2026-10-13 裁定），本模块不注入持久化实现。
 * 5. `packages/plugins` 的 core 依赖：已由 M3 落地（本模块直接拥有 `PACKAGE_NAME` 侧的类型）。
 * 6. `measure:apm-adapter`：已在根 `package.json`（不归本模块）。
 * 7. 体积预算表重推：见 `.size-limit.json` 与 `docs/reports/`（交付物）。
 * 8. `docs/guides/**` 的 8 处表述：见同步修订。
 *
 * 约束：模块顶层无副作用（不访问 `window`/`document`，不注册监听），所有原生能力都在
 * `createAssembly()` 调用时解析；`createAssembly()` 本身**不**调用 `client.init()`
 * （由接入方或 `assembly.init()` 触发），因此可以在测试里精确断言"从 init() 到批次发出"。
 *
 * 公共语义声明（D-02，`docs/reports/t33-access-blockers.md`）：
 * `Assembly.client.onEvent(sink)` 仍然是**替换事件出口**的公共契约（等价于 `init({ onEvent })`，
 * 语义未改）；装配根的内部投递**不再借用它**，改用内核能力 `EVENT_OBSERVER_CAPABILITY`
 * （追加语义）。因此接入方在装配根上调用 `onEvent` 只会替换"自己的观察出口"，
 * 不会顶掉投递；`onEvent` 返回的注销函数同理只影响接入方自己的出口。
 */
import {
  BATCH_HEADER_CAPABILITY,
  CONTEXT_CAPABILITY,
  EVENT_OBSERVER_CAPABILITY,
  SDK_VERSION,
  VIEW_CAPABILITY,
  createClient,
  createClockCalibration,
  createConfigRuntime,
  createUuid,
  readLocation,
} from '@web-report-sdk/core';
import type {
  Client,
  ClientInitOptions,
  ClockCalibration,
  ConfigRuntime,
  ConsentMode,
  ConsentState,
  ContextStoragePort,
  ContextStore,
  C04BatchHeader,
  ErasePort,
  Kernel,
  KernelEvent,
  LocationSource,
} from '@web-report-sdk/core';
import {
  PAGEVIEW_EVENT_NAME,
  captureNativeHistoryRefs,
  captureNativeHttpRefs as capturePluginHttpRefs,
  createErrorPlugin,
  createHttpPlugin,
  createPerfPlugin,
  createRoutePlugin,
  resolvePluginDefaults,
} from '@web-report-sdk/plugins';
import type {
  ErrorCapture,
  HttpCapture,
  HttpPluginOptions,
  NativeHttpRefs as PluginHttpRefs,
  PerfCapture,
  RouteCapture,
  RouteChange,
  RoutePluginOptions,
} from '@web-report-sdk/plugins';
import {
  captureNativeHttpRefs,
  combineFixedMetrics,
  createCallCounter,
  createDelivery,
  createDeliveryMetricsSource,
  createDefaultLocksPort,
  createDomPageEventsSource,
  createDomPageLeaveSource,
  createHealthDimensionsReader,
  createHealthReporter,
  createLatencyDecorators,
  createLatencyWindow,
  createOfflineExposureSource,
  createQueueMetricsSource,
  createRegistryTimer,
  createSessionSampler,
  createSubmitMetricsSource,
  createTransportQueue,
} from '@web-report-sdk/transport';
import type {
  Delivery,
  HealthReporter,
  LocksPort,
  NativeHttpRefs as TransportHttpRefs,
  QueueEvent,
  TransportPort,
  TransportQueue,
} from '@web-report-sdk/transport';

/** 内置事件的 `event_type`（照抄 `docs/contracts/schemas/builtin-events/*.json` 的 const）。 */
const EVENT_TYPES: Readonly<Record<string, string>> = {
  web_js_error: 'error',
  web_vitals: 'perf',
  web_long_task: 'perf',
  web_pageview: 'pageview',
  web_http: 'http',
  sdk_health: 'sdk_internal',
};

/** 批次头读取端口（内核能力 `sdk.batch_header` 的结构）。 */
type BatchHeaderReader = () => C04BatchHeader;

/** 采集插件的运行句柄；未启用的插件为 `undefined`。 */
export interface CollectorHandles {
  readonly error: ErrorCapture | undefined;
  readonly perf: PerfCapture | undefined;
  readonly route: RouteCapture | undefined;
  readonly http: HttpCapture | undefined;
}

/** 装配根的注入点与初始化参数。 */
export interface AssemblyOptions {
  /** 应用标识（必填；批次头 `app_id` 与本实例状态都用它）。 */
  readonly appId: string;
  /** 上报端点；未提供 `credentials` 时用它组装凭据端口。 */
  readonly endpoint?: string | undefined;
  /** 上报令牌；未提供 `credentials` 时用它组装凭据端口。 */
  readonly token?: string | undefined;
  readonly env?: string | undefined;
  readonly release?: string | undefined;
  readonly consent?: ConsentState | undefined;
  readonly consentMode?: ConsentMode | undefined;
  /** 第三方 APM 共存模式（AC-20）：为 true 时采集插件默认关闭，可由远程配置逐个开启。 */
  readonly apmCoexistence?: boolean | undefined;
  /** 远程配置端点；不传则不拉取、直接用内建默认。 */
  readonly configEndpoint?: string | undefined;
  /** 远程配置签名公钥（`{ key_id: JWK }`）；SDK 不内置公钥。 */
  readonly configPublicKeys?: Readonly<Record<string, JsonWebKey>> | undefined;
  /** 原生事件目标；`null` 表示没有原生目标（SSR/测试）。 */
  readonly target?: EventTarget | null | undefined;
  /** 位置来源注入点（测试与 SSR）。 */
  readonly location?: LocationSource | undefined;
  /**
   * 持久化上下文/会话存储端口（obligation ④）。
   * 不注入时 core 只驻留内存（负责人 2026-10-13 裁定；默认不落盘）。
   */
  readonly storage?: ContextStoragePort | undefined;
  /** 凭据端口；缺省用 `endpoint`/`token`/`appId` 组装（缺 endpoint 或 token 时返回 null）。 */
  readonly credentials?: CredentialsLike | undefined;
  /** 传输适配器（测试注入替身；缺省用 hook 前捕获的原生 fetch/XHR）。 */
  readonly transport?: TransportPort | undefined;
  /**
   * 多标签页选主的 Web Locks 端口（AC-17）。缺省 `createDefaultLocksPort()`：
   * 浏览器有 Web Locks 时用它选主，没有时返回 null，选主退回 C07 的既有降级路径。
   * 注入 `null` 可强制关闭该路径（想验证 BroadcastChannel 降级的接入方）。
   */
  readonly locks?: LocksPort | null | undefined;
  /** 原生 HTTP 引用覆盖（测试注入；缺省 `captureNativeHttpRefs(globalThis)`）。 */
  readonly nativeHttp?: TransportHttpRefs | undefined;
  /** HTTP 采集插件的配置（追踪范围与 `traceparent` 注入端口，CR-006）。 */
  readonly httpPlugin?: HttpPluginOptions | undefined;
  /** 路由采集插件的配置（模式与路由模板，AC-08/09）。 */
  readonly route?: RoutePluginOptions | undefined;
  /**
   * 初始插件启停表，叠加在内建/共存缺省之上（远程配置到达前生效）。
   * 例如 `{ http: true }` 在非共存模式下开启 HTTP 采集（内建缺省是关闭）。
   */
  readonly plugins?: Readonly<Record<string, boolean>> | undefined;
  /** 当前时间源；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  /** 耗时采样的会话判定随机源（C08-F2）；缺省 `Math.random`。 */
  readonly random?: (() => number) | undefined;
  /** 耗时采样的会话采样率（C08-F2）；缺省 1%。测试传 1 可确定性开启。 */
  readonly sessionSampleRate?: number | undefined;
  /** 直接覆盖传给 `client.init()` 的参数（例如 `url_query_allowlist`）。 */
  readonly client?: ClientInitOptions | undefined;
  /** 是否启动自监控周期上报（缺省 `true`）。 */
  readonly startHealthReporting?: boolean | undefined;
}

/** 凭据端口的**结构子集**（与 `@web-report-sdk/transport` 的 `CredentialsPort` 对齐）。 */
export interface CredentialsLike {
  current(): {
    readonly endpoint: string;
    readonly appId: string;
    readonly writeToken: string;
    readonly revision: number;
  } | null;
}

/** 装配完成的 SDK 句柄。 */
export interface Assembly {
  /** 接入方使用的客户端；已接线 C08 的调用计数/耗时装饰器与同意清理。 */
  readonly client: Client;
  readonly kernel: Kernel;
  readonly config: ConfigRuntime;
  readonly clock: ClockCalibration;
  readonly erasePort: ErasePort;
  /** 交给 C06/C07 的队列句柄（**已接线 C08 的 `events_enqueued`/`queue_length_max`**）。 */
  readonly queue: TransportQueue;
  readonly delivery: Delivery;
  readonly reporter: HealthReporter;
  /** hook 前捕获的原生 HTTP 引用（冻结；C07 发送器只用它）。 */
  readonly nativeHttpRefs: TransportHttpRefs;
  /** C05 四个采集插件的运行句柄。 */
  readonly collectors: CollectorHandles;
  /** 触发一次 `client.init()`（幂等；重复调用无副作用）。 */
  init(overrides?: ClientInitOptions): void;
  /** 业务主动冲刷（C06-F2）。 */
  flush(): void;
  /** 销毁：先停传输与自监控，再销毁内核。 */
  destroy(): void;
}

/** 把插件产出的事件补成内核/批次 Schema 要求的事件体（`event_id`/`event_type`/`schema_version`）。 */
function toKernelEvent(event: object, nowMs: number): KernelEvent {
  const source = event as Readonly<Record<string, unknown>>;
  const name = typeof source['event_name'] === 'string' ? source['event_name'] : '';
  const declaredType = EVENT_TYPES[name];
  return {
    ...source,
    event_id: typeof source['event_id'] === 'string' ? source['event_id'] : createUuid(),
    event_name: name,
    event_type:
      typeof source['event_type'] === 'string' ? source['event_type'] : (declaredType ?? 'custom'),
    schema_version: typeof source['schema_version'] === 'number' ? source['schema_version'] : 1,
    occurred_at: typeof source['occurred_at'] === 'number' ? source['occurred_at'] : nowMs,
    priority: source['priority'] === 'critical' ? 'critical' : 'normal',
  };
}

/** 内核输出事件 → C06 队列事件（两者结构一致，只是 `KernelEvent` 没有必填字段标注）。 */
function asQueueEvent(event: KernelEvent): QueueEvent {
  return event as unknown as QueueEvent;
}

/** 读取内核能力，未注册时返回 `undefined`（不用 `any`；调用点自行断言结构）。 */
function readCapability(kernel: Kernel, name: string): unknown {
  return kernel.getCapability(name);
}

/** DOM 目标探测（`document` 存在时返回它，否则 `undefined`）。 */
function domDocument(): (Document & { readonly visibilityState?: string | undefined }) | undefined {
  const candidate = (globalThis as { readonly document?: unknown }).document;
  if (candidate === undefined || candidate === null) return undefined;
  return candidate as Document;
}

/** 远程配置里的插件开关（结构子集，供 `resolvePluginDefaults` 消费）。 */
function remotePluginsOf(config: ConfigRuntime): Readonly<
  Record<string, { readonly enabled?: boolean | undefined } | undefined>
> {
  const result: Record<string, { readonly enabled?: boolean | undefined }> = {};
  for (const [id, setting] of Object.entries(config.current().plugins)) {
    result[id] = { enabled: setting.enabled };
  }
  return result;
}

/**
 * 装配 SDK：捕获原生引用 → 建客户端/配置/传输/自监控 → 安装 C05 插件。
 *
 * 调用顺序是语义的一部分：`captureNativeHttpRefs()` 必须在 `createClient()`（会订阅原生事件）
 * 与任何插件安装之前完成，否则 C07 的发送器会拿到被 C05 包装过的 `fetch`（自我采集 + 泄漏）。
 */
export function createAssembly(options: AssemblyOptions): Assembly {
  const now = options.now ?? ((): number => Date.now());

  // ① 先捕获原生引用（幂等、冻结），再安装任何插件。
  const nativeHttpRefs = options.nativeHttp ?? captureNativeHttpRefs(globalThis);
  const nativeHistoryRefs = captureNativeHistoryRefs();
  const pluginHttpContainer: PluginHttpRefs | undefined = capturePluginHttpRefs();

  const clientOptions: ClientInitOptions = {
    ...options.client,
    appId: options.appId,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.release === undefined ? {} : { release: options.release }),
    ...(options.consent === undefined ? {} : { consent: options.consent }),
    ...(options.consentMode === undefined ? {} : { consent_mode: options.consentMode }),
  };
  // ③ 同意驱动的清理端口：**注入 core**（`setConsent('denied')` 由 C04 触发），
  // 具体实现（C07 的离线数据、C03 的会话随机数）在对应模块创建后回填——这里只放稳定的委托对象。
  const offlineCleanup: { run?: () => void } = {};
  const sessionRandomCleanup: { run?: () => void } = {};
  const erasePort: ErasePort = {
    offlineData: (): void => {
      offlineCleanup.run?.();
    },
    sessionRandom: (): void => {
      sessionRandomCleanup.run?.();
    },
  };
  const rawClient = createClient({
    ...clientOptions,
    erase: erasePort,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.location === undefined ? {} : { location: options.location }),
  });
  const kernel = rawClient.kernel;

  // C03：生效配置运行时（注册 `sdk.config` 能力；异步拉取不阻塞）。
  const config = createConfigRuntime({
    kernel,
    appId: options.appId,
    env: options.env,
    configEndpoint: options.configEndpoint,
    sdkVersion: SDK_VERSION,
    publicKeys: options.configPublicKeys ?? {},
    consentMode: options.consentMode,
    sessionRandom: 0,
  });
  // C03 就绪后回填「清除会话随机数」这一腿（ErasePort.sessionRandom）：重新生成而非置空，
  // 后续配置合并（overrides.when.session_bucket）拿到新值。
  sessionRandomCleanup.run = (): void => {
    config.resetSessionRandom();
  };

  // ③ C04 的时钟端口 + 批次头来源：读内核能力，再补本条线的 app_id 与校准后的偏移。
  const clock = createClockCalibration();
  const readBaseHeader =
    readCapability(kernel, BATCH_HEADER_CAPABILITY) as BatchHeaderReader | undefined;
  const headerSource = {
    header: (): C04BatchHeader => {
      const base =
        readBaseHeader === undefined
          ? undefined
          : readBaseHeader();
      const state = clock.current();
      const fallback: C04BatchHeader = {
        protocol_version: 1,
        app_id: options.appId,
        env: options.env ?? 'production',
        release: options.release ?? '0.0.0',
        sdk_name: '@web-report-sdk/browser',
        sdk_version: SDK_VERSION,
        device_id: '',
        device_id_persistent: false,
        session_id: '',
        clock_offset: state.offsetMs,
        clock_calibrated: state.calibrated,
        consent: 'unknown',
      };
      if (base === undefined) return fallback;
      // `app_id` 由 core 的批次头 provider 提供（缺陷已修：init 的 appId 真正进入批次头）；
      // 这里只补本条线的**时钟校准**（C04 的时钟状态机在 core 内部，没有独立能力可注入）。
      return {
        ...base,
        clock_offset: state.offsetMs,
        clock_calibrated: state.calibrated,
      };
    },
  };
  const initialHeader = headerSource.header();
  // 交付层就绪后回填 C07 的清理函数（ErasePort.offlineData）。
  offlineCleanup.run = (): void => {
    void delivery.clearOffline();
  };

  // ② C07：交付层（`onServerTime` 把 T16 解析出的 `X-Server-Time` 接进 C04 的时钟端口）。
  const credentials: CredentialsLike =
    options.credentials ??
    {
      current: () => {
        if (options.endpoint === undefined || options.token === undefined) return null;
        return {
          endpoint: options.endpoint,
          appId: options.appId,
          writeToken: options.token,
          revision: 1,
        };
      },
    };
  const pageEvents = domDocument();
  // D-3：选主端口必须在**这里**接上——`createDelivery` 的 `locks` 缺省是 `undefined`
  // → `createLeaderElection({locks: null})` → Web Locks 路径永远不可达。缺省用真实端口
  // （环境不支持时 `createDefaultLocksPort()` 返回 null，语义不变）。
  const locks = options.locks === undefined ? createDefaultLocksPort() : options.locks;
  const delivery = createDelivery({
    appId: options.appId,
    sessionId: initialHeader.session_id === '' ? createUuid() : initialHeader.session_id,
    credentials,
    header: headerSource,
    http: nativeHttpRefs,
    locks,
    counters: kernel.counters,
    onServerTime: (serverTimeMs: number): void => {
      const receivedAt = now();
      clock.noteServerTime({
        serverTimeMs,
        clientSentAtMs: receivedAt,
        clientReceivedAtMs: receivedAt,
      });
    },
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(pageEvents === undefined ? {} : { pageEvents: createDomPageEventsSource(pageEvents) }),
    now,
  });

  // ② C08：submit/queue 的装饰器必须**先于**下游使用而建立。
  const submitSource = createSubmitMetricsSource({ submit: delivery.submit });
  const pageLeave = domDocument();
  const rawQueue = createTransportQueue({
    config: { transport: () => config.current().transport },
    submit: submitSource.submit,
    header: headerSource,
    counters: kernel.counters,
    offline: delivery.offline,
    ...(pageLeave === undefined ? {} : { pageLeave: createDomPageLeaveSource(pageLeave) }),
    now,
  });
  const queueSource = createQueueMetricsSource({ queue: rawQueue });
  const queue = queueSource.queue;
  delivery.attachQueue(rawQueue);

  // ② C08：客户端装饰器（调用计数 + 三段耗时），并接 `pipeline.process`。
  const counter = createCallCounter(rawClient);
  // C08-F2：1% 会话采样判定（只判定一次）；未命中时 p99 为空、不上报三个 p99。
  const sampler = createSessionSampler({
    ...(options.sessionSampleRate === undefined ? {} : { rate: options.sessionSampleRate }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  const latencyWindow = createLatencyWindow({ sampled: sampler.sampled() });
  const latency = createLatencyDecorators({ recorder: latencyWindow, now });
  const originalProcess = kernel.pipeline.process.bind(kernel.pipeline);
  const wrappedPipeline = latency.wrapPipeline({
    process: (event: KernelEvent): unknown => originalProcess(event),
  });
  kernel.pipeline.process = wrappedPipeline.process as typeof kernel.pipeline.process;

  // ③ 客户端句柄：C08 的调用计数 + 三段耗时装饰器（同意清理已改为 core 的 ErasePort 注入，
  // 不再用"包装 setConsent"的绕过方式；见 `createClient({ erase })`）。
  const counted = latency.wrapCalls(counter.client);
  const client: Client = counted;

  // C05：安装四个采集插件；事件出口统一走内核管线（C04 富化/脱敏后才入队）。
  const sink = (event: KernelEvent): void => {
    kernel.report(event);
  };
  const contextStore = readCapability(kernel, CONTEXT_CAPABILITY) as ContextStore | undefined;

  const errorPlugin = createErrorPlugin((event) => {
    sink(toKernelEvent(event, now()));
  }, {
    ...(contextStore === undefined
      ? {}
      : { globalContext: () => contextStore.state().contexts }),
  });
  const perfPlugin = createPerfPlugin({
    vitals: (event) => {
      sink(toKernelEvent(event, now()));
    },
    longTask: (event) => {
      sink(toKernelEvent(event, now()));
    },
  });
  const httpPlugin = createHttpPlugin(
    (event) => {
      sink(toKernelEvent(event, now()));
    },
    {
      ...(pluginHttpContainer === undefined ? {} : { refs: pluginHttpContainer }),
      hooker: kernel.registry,
      ...(options.httpPlugin === undefined ? {} : { options: options.httpPlugin }),
    },
  );
  const routePlugin = createRoutePlugin({
    ...(nativeHistoryRefs === undefined ? {} : { history: nativeHistoryRefs.history }),
    hooker: kernel.registry,
    now,
    ...(options.route === undefined ? {} : { options: options.route }),
  });
  const routeCapture = routePlugin.capture;
  routeCapture.onRouteChange((change: RouteChange): void => {
    // 路由插件只"通知"；页面归属归 C04，事件由装配根产出（T18-plan §3）。
    const store = readCapability(kernel, CONTEXT_CAPABILITY) as ContextStore | undefined;
    store?.setPage(change.template);
    const href = options.location?.href ?? readLocation().href;
    const notifyView = readCapability(kernel, VIEW_CAPABILITY) as
      | ((viewOptions: { readonly url?: string | undefined }) => void)
      | undefined;
    if (notifyView !== undefined && href !== undefined) notifyView({ url: href });
    sink(
      toKernelEvent(
        {
          event_name: PAGEVIEW_EVENT_NAME,
          priority: 'normal',
          occurred_at: change.at,
          dimensions: { navigation_type: change.via },
        },
        now(),
      ),
    );
  });

  kernel.registerPlugin(errorPlugin);
  kernel.registerPlugin(perfPlugin);
  kernel.registerPlugin(routePlugin);
  kernel.registerPlugin(httpPlugin);
  const applyPluginToggles = (remote: Readonly<
    Record<string, { readonly enabled?: boolean | undefined } | undefined>
  >): void => {
    kernel.applyPluginConfig(resolvePluginDefaults({ apmCoexistence: options.apmCoexistence }, remote));
  };
  // 初始缺省：远程配置到达前只用内建/共存缺省，不把 C03 的内建表当成"远程显式开启"。
  kernel.applyPluginConfig({
    ...resolvePluginDefaults({ apmCoexistence: options.apmCoexistence }),
    ...options.plugins,
  });

  // ② C08：事件出口接装饰后的队列；自监控窗口聚合后 emit 到同一个队列。
  //
  // D-02：这里**不能**用公共 `client.onEvent(...)`。`onEvent` 的公共契约是**替换**事件出口
  // （等价于 `init({ onEvent })`，替换语义有既有用例与文档锁定）。装配根若借用它接线，
  // 接入方按文档再调一次 `onEvent`（"先只观察产出、不上报"是最自然的动机）就会**静默顶掉**
  // 投递：`flush` 恒为 `empty`、零投递、不抛错、不计数。因此改用内核的
  // `EVENT_OBSERVER_CAPABILITY`（**追加**语义）：内部投递与接入方观察互不顶掉。
  const enqueueFromPipeline = delivery.wireEnqueue(queue);
  const registerObserver = readCapability(kernel, EVENT_OBSERVER_CAPABILITY) as
    | ((observer: (event: KernelEvent) => void) => () => void)
    | undefined;
  if (typeof registerObserver !== 'function') {
    // 宁可**大声失败**也不静默丢数据：拿不到该能力说明 core 与装配根版本不配套。
    throw new Error(
      'core 未提供事件出口观察者能力（sdk.event_observer）：装配根无法在不占用公共 onEvent 的前提下接线投递',
    );
  }
  registerObserver((event: KernelEvent): void => {
    enqueueFromPipeline(event);
  });
  const reporter = createHealthReporter({
    counters: kernel.counters,
    dimensions: createHealthDimensionsReader({
      sdkVersion: SDK_VERSION,
      lifecycle: kernel.lifecycle,
      configVersion: () => config.current().config_version ?? null,
    }),
    emit: (event) => {
      queue.enqueue(asQueueEvent(event as unknown as KernelEvent));
    },
    metrics: combineFixedMetrics(
      queueSource,
      submitSource,
      createDeliveryMetricsSource(delivery),
      counter,
    ),
    latency: latencyWindow,
    exposure: createOfflineExposureSource(delivery.offline),
    timer: createRegistryTimer(kernel.registry),
    now,
  });

  // C03 的配置变更：插件启停（远程或 kill switch）与运行时覆盖。
  config.onPluginToggle((signal) => {
    kernel.applyPluginConfig(signal.enabled);
  });
  config.subscribe(() => {
    const source = config.current().source;
    if (source !== 'remote' && source !== 'cache') return;
    applyPluginToggles(remotePluginsOf(config));
  });
  config.start();
  delivery.start();
  if (options.startHealthReporting !== false) reporter.start();

  return {
    client,
    kernel,
    config,
    clock,
    erasePort,
    queue,
    delivery,
    reporter,
    nativeHttpRefs,
    collectors: {
      error: errorPlugin.capture,
      perf: perfPlugin.capture,
      route: routeCapture,
      http: httpPlugin.capture,
    },
    init(overrides?: ClientInitOptions): void {
      client.init({ ...clientOptions, ...overrides });
    },
    flush(): void {
      queue.flush('manual');
    },
    destroy(): void {
      reporter.dispose();
      queue.dispose();
      delivery.dispose();
      config.stop();
      client.destroy();
    },
  };
}
