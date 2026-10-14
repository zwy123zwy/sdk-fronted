/**
 * C01 公共 API 的类型定义（T12）。
 *
 * 公共方法同步返回 `undefined`、从不抛错；本文件只声明类型，不产生任何运行时副作用。
 * 事件出口（`EventSink`）与调试输出（`DiagnosticsSink`）都是注入点，模块顶层不访问 `window`。
 */
import type { GlobalRegistry, Kernel, KernelEvent } from '../kernel';
import type { MaskRule } from '../privacy/types';
import type { ViewOptions } from '../context/ports';
import type { ContextStoragePort, ErasePort } from '../context/ports';
import type { EventDictionary, EventRequestOf, PermissiveDictionary } from './typed-events';

/** 事件接收端口：C06 传输层就绪前由接入方或测试注入；抛错只计数，不影响业务。 */
export type EventSink = (event: KernelEvent) => void;

/**
 * 同意状态（Q5；D002）。
 *
 * `unknown` 是**初始态**：Q5 规定「初始化时为 `unknown`，接入方可以在初始化参数中传入已知状态」。
 * 2026-10-13 经负责人签字把缺省值由 `'granted'` 修正为 `'unknown'`（Q5 一致性修正：
 * 默认「已授权」意味着未经同意即采集，属合规问题）。`'buffer'` 表示「先缓存、不发送」。
 */
export type ConsentState = 'granted' | 'denied' | 'buffer' | 'unknown';

/**
 * 生效的 `consent_mode`（配置面；`full` 只能来自初始化参数，见 D002）。
 *
 * 权威定义在 C03 的 `config/types.ts`；这里**再导出**，避免公共面出现两个同名联合
 * （API Extractor 会因此报 `ae-forgotten-export` / `ConsentMode_2`）。
 */
import type { ConsentMode } from '../config/types';

export type { ConsentMode };

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
  /** 当前页面访问标识（C04-F2；AC-01/AC-03 的可观测性）。 */
  readonly viewId: string | undefined;
  /** 生效的 `consent_mode`（AC-10/AC-19 的可观测性）。 */
  readonly consentMode: ConsentMode | undefined;
  /** `buffer` 模式下当前缓冲的事件条数（AC-11/AC-18 的可观测性）。 */
  readonly bufferSize: number;
  /** `buffer` 溢出被淘汰的事件条数（**不占契约原因码**）。 */
  readonly bufferEvicted: number;
  /** 第 51 个及之后被拒绝写入的 `context` 键次数（**不占契约原因码**）。 */
  readonly contextKeysBeyondLimit: number;
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
  'configureView',
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
  /**
   * 通知页面导航（装配根/路由插件在路由变化时调用；C04 不监听 History）。
   *
   * 存在的必要性：AC-03 要求「路由变化时 `view_id` 重新生成」，而 C04 的采集面不含
   * History/popstate（属 C05/T18）。没有这个注入点，同 `page_id` 下的 SPA 导航
   * （URL 变化）无法被感知，`url` 也会停留在旧值。
   */
  configureView(options?: ViewOptions): undefined;
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
  /** 初始同意状态，缺省 `unknown`（Q5；2026-10-13 负责人签字修正）。 */
  readonly consent?: ConsentState | undefined;
  /**
   * 生效的 `consent_mode`（D002：`full` **只能**在这里设置，远程配置不接受）。
   * 缺省 `essential_only`；装配根注入 C03 的配置运行时后，生效值以远程配置为准。
   */
  readonly consent_mode?: ConsentMode | undefined;
  /** 初始化时的自定义上下文（键名按 `setContext` 的同一规则校验）。 */
  readonly context?: Readonly<Record<string, string>> | undefined;
  /**
   * URL 查询参数白名单（`privacy.url_query_allowlist`）。
   *
   * 白名单之外的参数**一律删除**；为空时删除全部查询参数（`remote-config.md` 5.4）。
   * 装配根在 T18 接入 C03 的配置运行时后，生效值以远程配置为准（这里只是注入面）。
   */
  readonly url_query_allowlist?: readonly string[] | undefined;
  /** 追加的脱敏规则（`privacy.extra_mask_rules`；只能追加，不能删除内置 7 条）。 */
  readonly extra_mask_rules?: readonly MaskRule[] | undefined;
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
  /**
   * 上下文/会话存储端口（C04-F1）。
   *
   * **缺省只驻留内存**（2026-10-13 经负责人裁定），core 不自行读写 `window.localStorage`；
   * 需要跨页面持久的接入方由装配根注入实现。设备标识是否真的落盘仍由授权判定控制
   * （`granted`，或初始化参数声明已授权的 `full`）。
   */
  readonly storage?: ContextStoragePort | undefined;
  /**
   * 同意驱动的清理端口（C04-F5 / AC-12）：`setConsent('denied')` 时 C04 触发。
   *
   * 分工：C04 清除自己的设备标识/会话；C07 的离线数据与 C03 的会话随机数由装配根注入的
   * 实现清除（core 不能 import 它们）。缺省不注入时只有 C04 自己的清除生效。
   */
  readonly erase?: ErasePort | undefined;
}
