/**
 * C03 采样类型（T13）。M0 阶段：只声明接口与桩。
 */
import type { Dispose, Kernel, KernelEvent } from '../kernel';
import type { ConfigReader, SamplingRule } from '../config/types';

/** 当前用户（由装配根注入；采样判定保持同步）。 */
export interface UserLike {
  readonly id: string;
  readonly hashed?: boolean | undefined;
}

/** 会话随机数持久化端口（默认 `sessionStorage`，回退内存；同意前只存内存）。 */
export interface SessionStorePort {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}

/** 会话级采样状态。 */
export interface SessionSampling {
  /** 会话是否命中（确定性，同一会话恒同）。 */
  isHit(): boolean;
  sessionRandom(): number;
  /** 当前用户是否在白名单内（同步；只做原始 id 与已预计算的哈希比较）。 */
  allowUser(): boolean;
  /**
   * 预计算当前用户 id 的 SHA-256（异步），供后续同步 `allowUser()` 比较哈希白名单。
   * 同步采样判定的耗时护栏不覆盖此异步路径。
   */
  updateUserHash(): Promise<void>;
}

/** 规则匹配结果。 */
export interface RuleOutcome {
  readonly matched: boolean;
  readonly rate: number;
  readonly index: number;
}

/** 采样处理器选项。 */
export interface SamplingProcessorOptions {
  readonly kernel: Kernel;
  readonly config: ConfigReader;
  readonly session: SessionSampling;
  readonly random?: (() => number) | undefined;
  readonly getUser?: (() => UserLike | undefined) | undefined;
}

/** 会话采样选项。 */
export interface SessionSamplingOptions {
  readonly config: ConfigReader;
  readonly storage?: SessionStorePort | undefined;
  readonly storeKey?: string | undefined;
  /** 是否已取得同意（未取得时随机数只存内存）。 */
  readonly consentGranted?: (() => boolean) | undefined;
  readonly random?: (() => number) | undefined;
  /** 当前用户（用于 `allow_users` 白名单判定）。 */
  readonly getUser?: (() => UserLike | undefined) | undefined;
}

/** 采样处理器的输入事件（供 `rules.ts` 使用）。 */
export type SamplingEvent = KernelEvent;

/** 采样处理器的丢弃信号所使用的原因码。 */
export const SAMPLING_REASON_CODES = {
  sampledOutSession: 'sampled_out_session',
  sampledOutRule: 'sampled_out_rule',
  disabledByRule: 'disabled_by_rule',
  killed: 'killed',
} as const;

/** 规则列表类型别名。 */
export type Rules = readonly SamplingRule[];

/** 处理器注销函数。 */
export type SamplingDispose = Dispose;
