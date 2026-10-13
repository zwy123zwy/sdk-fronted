/**
 * C07 发送器的端口与类型。
 *
 * 零运行时依赖：原生 HTTP 引用、传输、压缩、计时、随机数、计数器全部注入，
 * 便于在单测里做**反向断言**（证明用的是 hook 前捕获的引用，而不是全局对象）。
 */
import type { BatchEnvelope } from '../batch/types';
import type { CountersPort } from '../queue/types';

export type DeliveryChannel = 'default' | 'page_leave';

/** hook 前捕获的原生引用（见 `captureNativeHttpRefs`）。 */
export interface NativeHttpRefs {
  readonly fetch?: typeof fetch | undefined;
  readonly xhr?: typeof XMLHttpRequest | undefined;
  readonly sendBeacon?: ((url: string, data: BodyInit) => boolean) | undefined;
}

/** 令牌 / 端点的当前快照；`revision` 变化表示配置更新过。 */
export interface CredentialsSnapshot {
  readonly endpoint: string;
  readonly appId: string;
  readonly writeToken: string;
  readonly revision: number;
}

export interface CredentialsPort {
  /** 返回 null 表示当前没有可用凭据（此时不发送）。 */
  current(): CredentialsSnapshot | null;
}

export interface TransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** 未压缩正文（压缩时仅用于计算体积与信标通道）。 */
  readonly body: string;
  /** 压缩后的字节；未压缩时为 undefined。 */
  readonly bodyBytes: Uint8Array<ArrayBuffer> | undefined;
  readonly keepalive: boolean;
  readonly timeoutMs: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** 传输适配器（AC-20 的注入点）。 */
export interface TransportPort {
  send(request: TransportRequest): Promise<TransportResponse>;
}

/** 压缩适配器（AC-19 的注入点）。 */
export interface CompressorPort {
  available(): boolean;
  compress(text: string): Promise<Uint8Array<ArrayBuffer>>;
}

/** 批次发送结果。`terminal` 表示「终态、不得再补发」（4xx 丢弃 / 单条超限丢弃）。 */
export interface SendResult {
  readonly status: 'sent' | 'failed' | 'circuit_open';
  readonly attempts: number;
  readonly terminal: boolean;
  /** 终态时的原因码（用于计数与调试）。 */
  readonly reason?: string | undefined;
}

export interface SenderStats {
  readonly attempts: number;
  readonly retries: number;
  readonly sent: number;
  readonly dropped: number;
  /** 重试流量占比（重试次数 / 总尝试次数）；健康期目标 ≤5%。 */
  readonly retryRatio: number;
  readonly circuitOpen: boolean;
  readonly paused: boolean;
  readonly circuitOpens: number;
  readonly probes: number;
}

export interface BackoffOptions {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
  readonly maxAttempts: number;
  readonly jitterRatio: number;
}

export interface CircuitOptions {
  readonly failuresToOpen: number;
  readonly openMs: number;
}

export interface SenderOptions {
  readonly credentials: CredentialsPort;
  readonly http?: NativeHttpRefs | undefined;
  readonly transport?: TransportPort | undefined;
  readonly compressor?: CompressorPort | undefined;
  readonly counters?: CountersPort | undefined;
  readonly now?: (() => number) | undefined;
  readonly random?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly keepaliveSupported?: (() => boolean) | undefined;
  readonly onServerTime?: ((serverTimeMs: number) => void) | undefined;
  readonly backoff?: Partial<BackoffOptions> | undefined;
  readonly circuit?: Partial<CircuitOptions> | undefined;
}

/** 批次发送器（C07-F1 至 C07-F4、C07-F8）。 */
export interface BatchSender {
  send(batch: BatchEnvelope): Promise<SendResult>;
  /** 熔断当前是否打开。 */
  isCircuitOpen(): boolean;
  /** 是否因 401/403 暂停。 */
  isPaused(): boolean;
  stats(): SenderStats;
  /** 供测试与装配读取：使用的传输实现。 */
  readonly transport: TransportPort;
}

/** 页面离开通道的发送结果（信标拿不到响应，只报"浏览器是否接受"）。 */
export interface LeaveSendResult {
  readonly accepted: boolean;
  readonly requests: number;
  readonly skipped: number;
  readonly bytes: number;
}

export type { CountersPort };
