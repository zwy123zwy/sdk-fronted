/**
 * C04 上下文模块的注入端口与状态类型（T14）。
 *
 * 全部为结构类型：core 不依赖其它包，也不读 `window`/`localStorage`（由装配根注入实现）。
 *
 * 本文件只声明类型与状态形状；工厂实现见同目录各文件（全部已实现并有用例覆盖）。
 */
import type { KernelEvent } from '../kernel';
import type { ConsentMode, ConsentState, ContextSnapshot, ContextUser } from '../privacy/types';

/** `configureView` 的选项（装配根/路由插件在导航时调用；C04 不监听 History）。 */
export interface ViewOptions {
  /** 当前 URL；`undefined` 表示不改变。 */
  readonly url?: string | undefined;
  /** 显式指定 `view_id`（一般不需要；测试与接管场景用）。 */
  readonly view_id?: string | undefined;
}

/** 存储端口（键值对，同步）。未取得同意时由调用方只传内存实现。 */
export interface ContextStoragePort {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * 同意驱动的清理端口（AC-12：`denied` 时清除设备标识、离线数据、会话随机数）。
 *
 * 分工：C04 只负责**触发**清理；离线数据归 C07（T16）、会话随机数归 C03（T13）。
 * 两个模块都不可被 C04 直接 import（零依赖 + 所有权边界），因此用端口注入。
 */
export interface ErasePort {
  /** 清除本地持久化的设备标识。 */
  readonly deviceId?: (() => void) | undefined;
  /** 清除离线数据（C07）。 */
  readonly offlineData?: (() => void) | undefined;
  /** 清除会话随机数（C03）。 */
  readonly sessionRandom?: (() => void) | undefined;
}

/** 时钟采样（由 T16 在收到响应头后注入；C04 不解析 `X-Server-Time`）。 */
export interface ClockSample {
  /** 接收方时间（`X-Server-Time`，UTC 毫秒）。 */
  readonly serverTimeMs: number;
  /** 请求发出时的客户端时间。 */
  readonly clientSentAtMs: number;
  /** 收到响应时的客户端时间。 */
  readonly clientReceivedAtMs: number;
}

/** 时钟校准状态。 */
export interface ClockState {
  readonly offsetMs: number;
  readonly calibrated: boolean;
}

/** 时钟校准端口。 */
export interface ClockCalibration {
  /** 记一次响应采样；往返超过漂移上限或采样非法时放弃本次校准。 */
  noteServerTime(sample: ClockSample): void;
  /** 当前校准状态。 */
  current(): ClockState;
  /** 重置（测试与销毁用）。 */
  reset(): void;
}

/**
 * 页面追踪器。
 *
 * `snapshot()` 直接返回**事件字段形态**（`page_id`/`view_id`/`url` 的 snake_case），
 * 以便 `api/client.ts` 在入队当时原样写进命令与事件体；`context` 由 store 层补齐。
 */
export interface PageTracker {
  /** 当前页面归属快照（事件字段形态）。 */
  snapshot(): ContextSnapshot;
  /** `setPage` 的原样使用（写入优先级最高的 `page_id`；值变化时轮换 `view_id`）。 */
  setPage(pageId: string | undefined): void;
  /** 导航通知（装配根/路由插件调用；同 `page_id` 下 URL 变化也轮换 `view_id`）。 */
  noteLocation(url: string | undefined, explicitViewId?: string  ): void;
  /** 让事件带上当前页面归属（已有值不覆盖）。 */
  enrich(event: KernelEvent): KernelEvent;
  /** 只在 URL 变化时返回 true 的内部判定结果（测试用）。 */
  isSamePage(pageId: string | undefined): boolean;
}

/** 页面追踪器的创建选项。 */
export interface PageTrackerOptions {
  readonly createId: () => string;
  readonly pageId?: string | undefined;
  readonly url?: string | undefined;
  /** 当前时间（缺省 `Date.now`）；只用于记录 URL 变更时刻等观测量。 */
  readonly now?: (() => number) | undefined;
}

/** 会话与设备标识状态（C04-F1）。 */
export interface SessionState {
  readonly sessionId: string;
  readonly deviceId: string;
  /** `device_id` 是否已持久化（决定批头 `device_id_persistent`）。 */
  readonly deviceIdPersistent: boolean;
}

/** 会话追踪器。 */
export interface SessionTracker {
  /** 记一次活动；超过 30 分钟空闲时轮换 `session_id`。 */
  touch(nowMs: number): SessionState;
  /**
   * 只读当前状态：**不刷新活动时间、不因空闲作废**（轮换只由 `touch` 推进）。
   *
   * 首次调用会**惰性物化**会话/设备标识（设备标识在已授权时顺带落盘），以保证批头字段稳定、
   * `device_id_persistent` 与实际落盘同源；仍不写 `sessionStorage`、不推进活动时间。
   */
  current(): SessionState;
  /** 同意状态变化：决定是否持久化设备标识；`denied` 时清除。 */
  onConsentChange(state: ConsentState, mode: ConsentMode): void;
  /** 清除（`denied` / `destroy`）。 */
  purge(): void;
}

/** 会话追踪器的创建选项。 */
export interface SessionTrackerOptions {
  readonly createId: () => string;
  readonly now: () => number;
  /** 初始同意状态（缺省 `unknown`）；授权判定用它决定设备标识是否持久化。 */
  readonly state?: ConsentState | undefined;
  /** 初始生效的 consent_mode（缺省 `essential_only`）；`full` 表示接入方声明已获授权。 */
  readonly mode?: ConsentMode | undefined;
  /** 已授权时才使用的持久化存储；未授权时为 `undefined`（只用内存）。 */
  readonly persistentStorage?: ContextStoragePort | undefined;
  /** 页面级临时存储（同意前也使用）。 */
  readonly sessionStorage?: ContextStoragePort | undefined;
  readonly limits: {
    readonly sessionIdleMs: number;
  };
}

/** 自定义上下文存储的观测量与快照。 */
export interface ContextStoreState {
  readonly pageId: string | undefined;
  readonly viewId: string | undefined;
  readonly contexts: Readonly<Record<string, string>>;
  readonly user: ContextUser | undefined;
  /** 被拒绝写入的 `context` 键次数（第 51 个键起；**不占契约原因码**）。 */
  readonly contextKeysBeyondLimit: number;
  /** `buffer` 溢出被淘汰的事件条数（**不占契约原因码**）。 */
  readonly bufferEvicted: number;
  /** 当前缓冲事件条数。 */
  readonly bufferSize: number;
}

/**
 * 同意状态机（C04-F5）。
 *
 * 状态与缓冲都在本模块；`consent_mode` 由配置侧（T13 的 `EffectiveConfig.privacy`）驱动。
 * 全部方法**同步**，不存在异步窗口（见 `docs/tasks/T14-plan.md` 的风险表第 3 条）。
 */
export interface ConsentManager {
  readonly state: () => ConsentState;
  readonly mode: () => ConsentMode;
  /**
   * 批头 `consent` 的取值（批次 Schema 的枚举只有 `granted|denied|unknown`）。
   * 映射：`granted`→`granted`、`denied`→`denied`、`buffer`/`unknown`→`unknown`。
   */
  readonly headerConsent: () => BatchConsent;
  /** 设置同意状态；同值重复设置不触发副作用。 */
  readonly setState: (next: ConsentState) => void;
  /** 应用生效的 `consent_mode`（配置变更时调用）。 */
  readonly setMode: (mode: ConsentMode) => void;
  /** 让步（`granted`）后按原顺序补发缓冲；返回补发条数。 */
  readonly drain: () => number;
  /** 丢弃缓冲；返回被丢弃的条数（`denied` 时按契约计 `consent_buffer_cleared`）。 */
  readonly clearBuffer: (reason: string) => number;
  /** 把事件停放进缓冲；返回是否受理（容量满时淘汰最旧并只记观测量）。 */
  readonly buffer: (event: KernelEvent) => boolean;
  readonly bufferSize: () => number;
  readonly bufferEvicted: () => number;
}

/** 同意状态机的创建选项。 */
export interface ConsentManagerOptions {
  readonly mode: ConsentMode;
  readonly state?: ConsentState | undefined;
  /** 计数端口（内核 `Counters` 的结构子集）。 */
  readonly count: (reason: string, delta?: number) => void;
  /** 补发出口（缓冲的事件从这里交回管线出口）。 */
  readonly emit: (event: KernelEvent) => void;
  /** 事件字节数（缓冲容量判定）。 */
  readonly sizeOf: (event: KernelEvent) => number;
  readonly limits: {
    readonly maxEvents: number;
    readonly maxBytes: number;
  };
}

/** 公共上下文的聚合状态（发给批次头 provider 与只读快照）。 */
export interface ContextStore {
  /** 快照（入队时使用）。 */
  readonly snapshot: () => ContextSnapshot;
  readonly setContext: (key: string, value: string) => void;
  readonly removeContext: (key: string) => void;
  readonly setUser: (id: string, options?: { readonly hashed?: boolean | undefined }) => void;
  readonly clearUser: () => void;
  readonly setPage: (pageId: string) => void;
  readonly setConsentMode: (mode: ConsentMode) => void;
  readonly configureView: (options: { readonly url?: string | undefined; readonly view_id?: string | undefined }) => void;
  /** 当前 `page_id`（只读快照与 `setPage` 的幂等判定用）。 */
  readonly pageId: () => string | undefined;
  /** 当前用户标识（批次头 provider 读取；只进批次头，绝不进事件体）。 */
  readonly user: () => ContextUser | undefined;
  /** 当前生效的 `consent_mode`（初始化参数值或装配根注入的配置值）。 */
  readonly consentMode: () => ConsentMode;
  readonly state: () => ContextStoreState;
  /** 应用初始化参数里的自定义上下文（键名按 `setContext` 的同一规则校验）。 */
  readonly setInitialContext: (values: Readonly<Record<string, string>>) => void;
  /** 补齐事件缺失的上下文（`enrich` 段；已有值不覆盖）。 */
  readonly enrich: (event: KernelEvent) => KernelEvent;
  /** 销毁：释放存储与缓冲。 */
  readonly destroy: () => void;
}

/** 批头 `consent` 的取值（批次 Schema `properties.consent` 的枚举）。 */
export type BatchConsent = 'granted' | 'denied' | 'unknown';

/**
 * 批次公共头（C04/C07 提供；**结构类型**，逐字段对齐
 * `packages/transport/src/batch/types.ts` 的 `BatchHeader` 与批次 Schema）。
 *
 * 为什么不在 core 里 import transport：core 与 transport 之间没有任何依赖
 * （两边都是零运行时依赖的独立包），装配根在 T18 做结构赋值。
 */
export interface C04BatchHeader {
  readonly protocol_version: 1;
  readonly app_id: string;
  readonly env: string;
  readonly release: string;
  readonly sdk_name: string;
  readonly sdk_version: string;
  readonly device_id: string;
  readonly device_id_persistent: boolean;
  readonly session_id: string;
  readonly clock_offset: number;
  readonly clock_calibrated: boolean;
  readonly consent: BatchConsent;
  readonly user_id?: string | undefined;
  readonly user_id_hashed?: boolean | undefined;
}

/** 批次头提供者的创建选项（全部为读取函数，每次取头重新求值）。 */
export interface BatchHeaderProviderOptions {
  /**
   * 应用标识。常量或**读取函数**均可：`api/client.ts` 传读取函数，取 `init` 之后才有的
   * `appId`（此前构造时写死 `''`，会让批次 Schema 的必填 `app_id` 为空——已合入代码里的契约违规）。
   */
  readonly appId: string | (() => string);
  readonly sdkName: string;
  readonly sdkVersion: string;
  /** 缺省 `production`（批次 Schema 要求 env 小写字母开头、≤32 字符）。 */
  readonly env?: string | undefined;
  /** 缺省 `0.0.0`（批次 Schema 要求非空、≤64 字符）。 */
  readonly release?: string | undefined;
  readonly session: () => SessionState;
  readonly user: () => ContextUser | undefined;
  readonly consent: () => BatchConsent;
  readonly clock: () => ClockState;
}
