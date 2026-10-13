/**
 * C07-F2 / F3 / F4 的策略：响应分类、退避、熔断、401/403 暂停。
 *
 * 全部是纯函数或闭包状态机，时间与随机数注入，便于假定时器下确定性测试。
 */
import {
  DEFAULT_BACKOFF,
  DEFAULT_CIRCUIT,
  REASON_REJECTED_400,
  REASON_REJECTED_401,
  REASON_REJECTED_403,
  REASON_RETRY_429,
  REASON_RETRY_5XX,
  REASON_RETRY_NETWORK,
} from './constants';
import type { BackoffOptions, CircuitOptions, CredentialsPort, CredentialsSnapshot } from './types';

export type ClassifiedStatus =
  | { readonly kind: 'success' }
  | { readonly kind: 'drop'; readonly reason: string }
  | { readonly kind: 'pause'; readonly reason: string }
  | { readonly kind: 'split' }
  | { readonly kind: 'retry'; readonly reason: string; readonly retryAfterMs: number | null };

/** 解析 `Retry-After`（秒）；缺失或非数字返回 null（AC-26：按没有该响应头处理，不报错）。 */
export function parseRetryAfterMs(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers['retry-after'];
  if (raw === undefined) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1_000;
}

/** 解析 `X-Server-Time`（UTC 毫秒）；缺失或非数字返回 null（AC-26）。 */
export function parseServerTime(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers['x-server-time'];
  if (raw === undefined) return null;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** 按响应码分类（契约 §3.1；204 按 202、418 按 400，见 AC-27）。 */
export function classifyStatus(
  status: number,
  headers: Readonly<Record<string, string>> = {},
): ClassifiedStatus {
  if (status >= 200 && status < 300) return { kind: 'success' };
  if (status === 401) return { kind: 'pause', reason: REASON_REJECTED_401 };
  if (status === 403) return { kind: 'pause', reason: REASON_REJECTED_403 };
  if (status === 413) return { kind: 'split' };
  if (status === 429) {
    return { kind: 'retry', reason: REASON_RETRY_429, retryAfterMs: parseRetryAfterMs(headers) };
  }
  if (status >= 500) {
    return { kind: 'retry', reason: REASON_RETRY_5XX, retryAfterMs: parseRetryAfterMs(headers) };
  }
  return { kind: 'drop', reason: REASON_REJECTED_400 };
}

/** 网络错误 / 超时按 5xx 处理（契约 §3.1，AC-25）。 */
export function classifyError(): ClassifiedStatus {
  return { kind: 'retry', reason: REASON_RETRY_NETWORK, retryAfterMs: null };
}

export interface Backoff {
  readonly options: BackoffOptions;
  /** 第 `attempt` 次失败后的等待时长（毫秒）；取本地退避与 `Retry-After` 的较大值，上限 60 秒。 */
  delayFor(attempt: number, retryAfterMs: number | null): number;
}

export function createBackoff(
  overrides: Partial<BackoffOptions> | undefined,
  random: () => number,
): Backoff {
  const options: BackoffOptions = { ...DEFAULT_BACKOFF, ...overrides };
  return {
    options,
    delayFor(attempt: number, retryAfterMs: number | null): number {
      const exponent = Math.max(0, attempt - 1);
      const local = Math.min(options.baseMs * options.factor ** exponent, options.maxMs);
      const remote = retryAfterMs === null ? 0 : Math.min(retryAfterMs, options.maxMs);
      const target = Math.max(local, remote);
      const jitter = 1 - options.jitterRatio + 2 * options.jitterRatio * random();
      return Math.round(Math.min(target * jitter, options.maxMs));
    },
  };
}

export interface CircuitBreaker {
  /** 是否处于熔断打开状态（含半开等待期）。 */
  isOpen(): boolean;
  /** 是否放行本次发送（熔断中不放行；半开时只放行一个探测批次）。 */
  admit(): boolean;
  onSuccess(): void;
  onFailure(): void;
  opens(): number;
  probes(): number;
  failures(): number;
}

export function createCircuitBreaker(
  overrides: Partial<CircuitOptions> | undefined,
  now: () => number,
): CircuitBreaker {
  const options: CircuitOptions = { ...DEFAULT_CIRCUIT, ...overrides };
  let open = false;
  let openedAt = 0;
  let failures = 0;
  let probeInFlight = false;
  let opens = 0;
  let probes = 0;

  return {
    isOpen(): boolean {
      return open;
    },

    admit(): boolean {
      if (!open) return true;
      if (now() - openedAt < options.openMs) return false;
      if (probeInFlight) return false;
      probeInFlight = true;
      probes += 1;
      return true;
    },

    onSuccess(): void {
      open = false;
      failures = 0;
      probeInFlight = false;
    },

    onFailure(): void {
      probeInFlight = false;
      if (open) {
        openedAt = now();
        return;
      }
      failures += 1;
      if (failures >= options.failuresToOpen) {
        open = true;
        openedAt = now();
        opens += 1;
      }
    },

    opens(): number {
      return opens;
    },

    probes(): number {
      return probes;
    },

    failures(): number {
      return failures;
    },
  };
}

export interface SendGate {
  pause(): void;
  isPaused(): boolean;
}

/**
 * 401/403 的暂停状态机：暂停后不再发送，直到**配置更新过**（`revision` 变化）
 * **且**令牌或端点发生变化（AC-06 / AC-24）。
 */
export function createSendGate(credentials: CredentialsPort): SendGate {
  let paused = false;
  let pausedAt: CredentialsSnapshot | null = null;

  return {
    pause(): void {
      if (paused) return;
      paused = true;
      pausedAt = credentials.current();
    },

    isPaused(): boolean {
      if (!paused) return false;
      const current = credentials.current();
      if (current === null) return true;
      const before = pausedAt;
      if (before === null) {
        paused = false;
        return false;
      }
      const revisionChanged = current.revision !== before.revision;
      const targetChanged =
        current.writeToken !== before.writeToken || current.endpoint !== before.endpoint;
      if (revisionChanged && targetChanged) {
        paused = false;
        pausedAt = null;
        return false;
      }
      return true;
    },
  };
}
