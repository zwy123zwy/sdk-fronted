/**
 * C01 公共 API 的类型定义（T12）。
 *
 * 公共方法同步返回 `undefined`、从不抛错；本文件只声明类型，不产生任何运行时副作用。
 * 事件出口（`EventSink`）与调试输出（`DiagnosticsSink`）都是注入点，模块顶层不访问 `window`。
 */
import type { GlobalRegistry, Kernel, KernelEvent } from '../kernel';
import type { EventDictionary, EventRequestOf, PermissiveDictionary } from './typed-events';

/** 事件接收端口：C06 传输层就绪前由接入方或测试注入；抛错只计数，不影响业务。 */
export type EventSink = (event: KernelEvent) => void;

/** 同意状态。`granted` 为缺省值（D002：远程配置不得把它改成 `full`）。 */
export type ConsentState = 'granted' | 'denied' | 'buffer';

/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 用户标识。 */
export interface UserInput {
  readonly id: string;
  /** 传入的 id 是否已经是哈希值。 */
  readonly hashed?: boolean | undefined;
}

/** 调试输出记录：只含原因码与事件去向，绝不含令牌或用户数据。 */
export interface DiagnosticsRecord {
  /** 命中的原因码，见 `docs/contracts/reason-codes.md`。 */
  readonly reason_code: string;
  /** 触发该记录的公共方法。 */
  readonly kind: string;
  readonly event_name?: string | undefined;
  /** 事件整体被丢弃，还是只丢弃了某个字段。 */
  readonly dropped: 'event' | 'field';
  /** 被丢弃字段的路径，例如 `metrics.duration_ms`。 */
  readonly field?: string | undefined;
}

/**
 * 调试输出端口（C01-AC-12 的接入点）。
 *
 * 缺省为空实现：SDK 不写任何控制台。默认 console sink 的落地方式待负责人裁定
 * （`packages` 下 `src` 目录的 TS 文件全局禁止 `console`，见根 eslint 配置）；届时只需把这里换成
 * 一个打印 `reason_code` 的函数，公共 API 不需要改动。
 */
export type DiagnosticsSink = (record: DiagnosticsRecord) => void;

/** 事件公共结构，供 `track` / `log` / `captureError` 的参数使用。 */
export interface EventInput<
  TDimensions extends object = Readonly<Record<string, string>>,
  TMetrics extends object = Readonly<Record<string, number>>,
> {
  readonly dimensions?: TDimensions | undefined;
  readonly metrics?: TMetrics | undefined;
  /** 附加文本（日志、错误栈）；长度约束由 C04 处理。 */
  readonly attachment?: string | undefined;
  /** 覆盖事件优先级；缺省 `normal`（Q3 确认后的字典默认值由 C04 接续）。 */
  readonly priority?: 'normal' | 'critical' | undefined;
}

/** 事件位置来源：用于在调用当时解析 `url` 与 `page_id`。 */
export interface LocationSource {
  /** 当前页面 URL（脱敏由 C04 处理）。 */
  readonly href: string | undefined;
  /** 手动路由模式下的当前页面标识。 */
  readonly pageId: string | undefined;
}

/** 客户端状态快照（只读，用于调试与多实例隔离自检）。 */
export interface ClientState {
  /** 实例的应用标识（初始化参数；**不是**事件体字段）。 */
  readonly app_id: string | undefined;
  readonly initialized: boolean;
  readonly destroyed: boolean;
  readonly consent: ConsentState;
  readonly user: UserInput | undefined;
  readonly pageId: string | undefined;
  readonly contexts: Readonly<Record<string, string>>;
}

/** 公共 API 方法名。销毁后调用其中任何一个都计数 `destroyed`（C01-AC-03、C02-AC-14）。 */
export const PUBLIC_METHODS = [
  'init',
  'track',
  'log',
  'captureError',
  'setUser',
  'clearUser',
  'setContext',
  'removeContext',
  'setPage',
  'setConsent',
  'flush',
  'destroy',
] as const;

/** 公共 API 方法名取值。 */
export type PublicMethod = (typeof PUBLIC_METHODS)[number];

/**
 * 公共 API 客户端（C01-F1、C01-F5）。
 *
 * 类型参数 `TTrackMap` 是**已经展开**的「事件名 → track 函数」映射
 * （`TrackMap<TDictionary>`，由 `createClient` 计算）。`track` 用
 * `Parameters<TTrackMap[TName]>[0]` 取参数类型，因此调用点能解析出完整的字段形状，
 * 缺字段、字段类型错误都会在 `tsc` 报错（C01-AC-09）。
 *
 * 若把 `track` 写成 `track<N extends keyof TDictionary>(name: N, input: 依赖 N 的类型)`，
 * 参数类型会一直停留在「待求值」状态，上述校验全部失效。
 */
/**
 * 公共 API 客户端（C01-F1、C01-F5）。
 *
 * `track` 用「事件名依赖参数类型」的泛型签名（`EventRequestOf<TDictionary, TName>`）：
 * 未登记的事件名与字段类型错误会在 `tsc` 报错（C01-AC-09）。已知限制见交付报告：
 * 缺少字典声明的字段不会被类型系统拦住。
 */
export interface Client<TDictionary extends EventDictionary = PermissiveDictionary> {
  /** 当前生效的内核句柄（内核按实例隔离）。 */
  readonly kernel: Kernel;
  /** 事件出口注册/注销（C06 传输层接入用）。 */
  onEvent(sink: EventSink): () => void;
  /** 调试输出注册/注销（C08 调试模式接入用）。 */
  onDiagnostics(sink: DiagnosticsSink): () => void;

  init(options?: ClientInitOptions): undefined;
  /**
   * 上报自定义事件。参数类型来自事件字典（C01-F4）：未登记的事件名、缺字段、
   * 字段类型错误都会在 `tsc` 报错；未传字典时事件名放宽为 `string`。
   */
  /**
   * 上报自定义事件（C01-F4）。参数类型来自事件字典：
   * 未登记的事件名、字段类型错误在 `tsc` 报错；未传字典时事件名放宽为 `string`。
   */
  track<TName extends keyof TDictionary & string>(
    name: TName,
    input?: EventRequestOf<TDictionary, TName>,
  ): undefined;
  log(level: LogLevel, message: string, input?: EventInput): undefined;
  captureError(error: unknown, input?: EventInput): undefined;
  setUser(id: string, options?: { readonly hashed?: boolean | undefined }): undefined;
  clearUser(): undefined;
  setContext(key: string, value: string): undefined;
  removeContext(key: string): undefined;
  setPage(pageId: string): undefined;
  setConsent(state: ConsentState): undefined;
  flush(): undefined;
  destroy(): undefined;
}

/** 加载桩缓存的一条命令（C01-F3）。 */
export interface StubCommand {
  readonly kind: string;
  readonly name?: string | undefined;
  readonly args?: readonly unknown[] | undefined;
  /** 调用当时生成的 UUID v4；缺省时由主包补生成。 */
  readonly eventId?: string | undefined;
  readonly occurredAt?: number | undefined;
  readonly pageId?: string | undefined;
  readonly url?: string | undefined;
}

/** `init` 的选项。 */
export interface ClientInitOptions {
  /** 应用标识，由接收方分配。必填且非空。 */
  readonly appId?: string | undefined;
  /** 上报端点（C06 使用）。 */
  readonly endpoint?: string | undefined;
  /** 上报令牌；只在公共 API 层的参数校验中使用，绝不进入事件或调试输出。 */
  readonly token?: string | undefined;
  /** 环境，如 `production`。 */
  readonly env?: string | undefined;
  /** 接入方应用版本。 */
  readonly release?: string | undefined;
  /** 初始同意状态，缺省 `granted`。 */
  readonly consent?: ConsentState | undefined;
  /** 手动路由模式下的当前页面标识。 */
  readonly pageId?: string | undefined;
  /** 位置来源注入点；缺省按 `globalThis.window.location` 解析。 */
  readonly location?: LocationSource | undefined;
  /**
   * 调试输出：**缺省静默**（C08-AC-09 要求非白名单用户不因 URL 参数自动进入调试模式）。
   * `true` 用默认 console sink（C01-AC-12）；也可以传入自定义 `DiagnosticsSink`。
   */
  readonly debug?: boolean | DiagnosticsSink | undefined;
  /**
   * 运行期事件字典（K01 生成物）：用于取事件的 `schema_version` 与默认 `priority`。
   * 只影响运行期取值，不影响类型推导（类型来自 `createClient<TDictionary>()`）。
   */
  readonly dictionary?: EventDictionary | undefined;
  /** 事件出口；缺省不发送。 */
  readonly onEvent?: EventSink | undefined;
}

/** `createClient` 的选项：既包含 `init` 的全部选项，也包含只影响本实例的注入点。 */
export interface ClientOptions extends ClientInitOptions {
  /** 事件出口，等价于 `init({ onEvent })`。 */
  readonly onEvent?: EventSink | undefined;
  /** 调试输出，等价于 `init({ debug })`。 */
  readonly debug?: boolean | DiagnosticsSink | undefined;
  /**
   * 原生事件目标。不传时在首次订阅时解析 `globalThis`；传 `null` 表示没有原生目标。
   * 同一实例内，同一目标 + 事件 + capture 只安装一次原生监听（由全局注册表保证）。
   */
  readonly target?: EventTarget | null | undefined;
  /**
   * 可选的共享全局注册表（C01-AC-10 多实例）：多个实例传入同一个注册表时，
   * 同一 `(target, type, capture)` 在页面上只安装一次原生监听，所有实例的订阅者都收到事件。
   * 计数**不共享**，每个实例仍持有自己的计数器。
   */
  readonly registry?: GlobalRegistry | undefined;
  /** 位置来源注入点，便于测试与 SSR；缺省按 `globalThis.window.location` 解析。 */
  readonly location?: LocationSource | undefined;
}
