/**
 * C03 配置（T13）对外类型。M0 阶段：只声明接口，`store.ts` 等为桩实现。
 *
 * 契约依据：`docs/contracts/remote-config.md` 0.2（冻结）。
 * 本文件是交接给 T18 装配根与 C04–C07 的接口基线。
 */
import type { Dispose, Kernel } from '../kernel';

/** 生效配置的来源。 */
export type ConfigSource = 'builtin' | 'cache' | 'remote' | 'conservative';

/** 契约允许的插件名（`remote-config.schema.json#$defs/pluginName`）。 */
export type PluginName = 'error' | 'perf' | 'route' | 'http' | 'apm_dual_write';

/** 插件名清单（运行时枚举）。 */
export const PLUGIN_NAMES = ['error', 'perf', 'route', 'http', 'apm_dual_write'] as const;

/** `consent_mode` 全部取值；远程配置只接受前两者（D002）。 */
export type ConsentMode = 'essential_only' | 'buffer' | 'full';

/** 生效配置里的 `consent_mode`（不含 `full`）。 */
export type ConfigConsentMode = 'essential_only' | 'buffer';

/** 事件级采样规则。 */
export interface SamplingRule {
  readonly match: {
    readonly event_name?: string | undefined;
    readonly event_type?: 'custom' | 'log' | 'error' | 'perf' | 'pageview' | 'http' | undefined;
    readonly dimension?: { readonly key: string; readonly equals: string } | undefined;
  };
  readonly rate: number;
}

/** 生效的采样设置。 */
export interface ResolvedSampling {
  readonly session_rate: number;
  readonly allow_users: readonly string[];
  readonly rules: readonly SamplingRule[];
}

/** 生效的单个插件设置。 */
export interface ResolvedPluginSetting {
  readonly enabled: boolean;
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

/** 生效的 kill switch。 */
export interface ResolvedKillSwitch {
  readonly all: boolean;
  readonly sdk_versions: readonly string[];
  readonly plugins: readonly PluginName[];
}

/** 生效的脱敏规则。 */
export interface ResolvedMaskRule {
  readonly name: string;
  readonly pattern: string;
  readonly flags?: string | undefined;
  readonly replacement?: string | undefined;
}

/** 生效的隐私设置。 */
export interface ResolvedPrivacy {
  /** 生效值可含 `full`（仅来自初始化参数）；远程配置只允许收紧为 `essential_only`/`buffer`。 */
  readonly consent_mode: ConsentMode;
  readonly url_query_allowlist: readonly string[];
  readonly sensitive_headers: readonly string[];
  readonly extra_mask_rules: readonly ResolvedMaskRule[];
}

/** `transport` 组；形状与 `packages/transport/src/queue/types.ts` 的 `TransportSettings` 对齐。 */
export interface TransportSettings {
  readonly max_batch_events?: number | undefined;
  readonly max_batch_bytes?: number | undefined;
  readonly idle_flush_ms?: number | undefined;
  readonly max_wait_ms?: number | undefined;
  readonly replay_batches_per_second?: number | undefined;
}

/** 运行时覆盖：只允许 `transport`、`debug` 与关闭插件（契约第 2 节）。 */
export interface RuntimeOverrides {
  readonly transport?: TransportSettings | undefined;
  readonly debug?: boolean | undefined;
  readonly plugins?: Readonly<Record<string, boolean>> | undefined;
}

/** 生效配置（不可变）。 */
export interface EffectiveConfig {
  readonly source: ConfigSource;
  /** 远程/缓存配置的版本；内置默认与保守默认没有版本，为 `undefined`。 */
  readonly config_version: number | undefined;
  readonly published_at: number | undefined;
  readonly sampling: ResolvedSampling;
  readonly kill_switch: ResolvedKillSwitch;
  readonly plugins: Readonly<Record<PluginName, ResolvedPluginSetting>>;
  readonly privacy: ResolvedPrivacy;
  readonly endpoints: Readonly<{ ingest?: string | undefined }>;
  readonly transport: Readonly<TransportSettings>;
  readonly debug: boolean | undefined;
  /** 命中的 `overrides` 条数（可观测性）。 */
  readonly applied_overrides: number;
}

/** 生效配置读取接口（供 C04/C05/C06/C07 读取）。 */
export interface ConfigReader {
  current(): EffectiveConfig;
  subscribe(listener: (next: EffectiveConfig, previous: EffectiveConfig) => void): Dispose;
}

/** 插件启停信号。 */
export interface PluginToggleSignal {
  readonly enabled: Readonly<Record<string, boolean>>;
  readonly reason: 'config' | 'sampled_out_session' | 'kill_switch';
}

/** 时钟注入（缓存 TTL、最小拉取间隔；测试可构造 25 小时前）。 */
export interface ClockPort {
  now(): number;
}

/** 拉取请求。 */
export interface ConfigFetchRequest {
  readonly url: string;
  readonly etag: string | undefined;
}

/** 拉取响应。 */
export interface ConfigFetchResponse {
  readonly status: number;
  readonly etag: string | undefined;
  readonly body: string;
}

/** 拉取端口；默认实现用 `globalThis.fetch`。 */
export type ConfigFetchPort = (request: ConfigFetchRequest) => Promise<ConfigFetchResponse>;

/** 发布物（签名信封）；缓存必须保存它本体的原始字段，才能读回后重新验签。 */
export interface ConfigEnvelope {
  readonly format_version: number;
  readonly key_id: string;
  readonly alg: string;
  /** 签名覆盖的原始 payload 字符串（不得用重新序列化的 JSON 代替）。 */
  readonly payload: string;
  readonly signature: string;
}

/**
 * 缓存条目。
 *
 * **只保存发布物本体（信封）**，不保存解析后的配置正文：IndexedDB 对同源脚本可读写，
 * 缓存是可篡改输入，因此构造生效配置**必须在读回后对原始 `payload` 字符串重新验签**
 * （安全负责人 2026-10-13 批准的安全项 8）。`stored_at` 用于 24 小时 TTL。
 */
export interface CachedConfig {
  readonly envelope: ConfigEnvelope;
  readonly etag: string | undefined;
  readonly stored_at: number;
}

/** 缓存端口；默认 IDB 主 + 内存回退（不使用 `localStorage`）。 */
export interface ConfigCachePort {
  read(): Promise<CachedConfig | undefined>;
  write(entry: CachedConfig): Promise<void>;
  /** 删除当前条目；缓存发布物验签/结构失败（视为被篡改）时调用。 */
  remove(): Promise<void>;
}

/** 可注入的 WebCrypto 视图（AC-20 需要把 `subtle` 置为 `undefined`）。 */
export interface WebCryptoLike {
  readonly subtle: SubtleCrypto | undefined;
}

/** 创建配置运行时的选项。 */
export interface ConfigRuntimeOptions {
  readonly kernel: Kernel;
  readonly appId: string | undefined;
  readonly env: string | undefined;
  readonly configEndpoint: string | undefined;
  readonly sdkVersion: string;
  readonly publicKeys: Readonly<Record<string, JsonWebKey>>;
  readonly consentMode: ConsentMode | undefined;
  readonly runtimeOverrides?: RuntimeOverrides | undefined;
  readonly fetch?: ConfigFetchPort | undefined;
  readonly cache?: ConfigCachePort | undefined;
  readonly clock?: ClockPort | undefined;
  /** 初始会话随机数（`overrides[].when.session_bucket` 用）；缺省 0。 */
  readonly sessionRandom?: number | undefined;
  /** 重置会话随机数的随机源；缺省 `randomUnit`（WebCrypto 优先，回退 `Math.random`）。 */
  readonly random?: (() => number) | undefined;
  /** 可注入的 WebCrypto 视图；缺省在调用时解析 `globalThis.crypto`（AC-20 用）。 */
  readonly webcrypto?: WebCryptoLike | undefined;
}

/** 配置运行时：同步 `start()`，异步拉取，不阻塞初始化。 */
export interface ConfigRuntime extends ConfigReader {
  start(): void;
  stop(): void;
  /** 触发一次拉取；返回 Promise 便于测试等待（公开 API 不依赖它）。 */
  refresh(): Promise<void>;
  onPluginToggle(listener: (signal: PluginToggleSignal) => void): Dispose;
  isKilled(): boolean;
  ready(): boolean;
  /** 当前会话随机数（`resetSessionRandom()` 之后读取到新值，直到下次重置）。 */
  sessionRandom(): number;
  /**
   * **重新生成**会话随机数（不是置空），返回新值；后续配置合并使用新值。
   * 由装配根接到 `ErasePort.sessionRandom`：`setConsent('denied')` 时清除（AC-12）。
   */
  resetSessionRandom(): number;
}
