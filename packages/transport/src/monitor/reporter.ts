/**
 * C08-F3 自监控上报：每 60 秒聚合一次各环节计数与耗时，作为一条或多条
 * `sdk_health` 事件交给注入的事件出口。
 *
 * 关键行为：
 * - 时间与定时器全部注入（`now` / `timer`），单测无需墙钟；
 * - `window_ms` 取两次 flush 之间的**真实间隔**（常规 60000），而不是写死常量；
 * - 生命周期状态为 `uninitialized`（映射为 `null`）时**不产生事件**，计数留到下一个窗口；
 * - AC-05：`emit` 期间同步产生的计数（上报动作自身的副作用）在窗口结束后再次丢弃，
 *   不进入下一个窗口。
 */
import { buildHealthEvents } from './events';
import { buildHealthMetrics, clampWindowMs } from './metrics';
import type {
  HealthDimensions,
  HealthReporter,
  HealthReporterOptions,
  SdkHealthEvent,
} from './types';

/** 缺省窗口长度（C08-F3：每 60 秒一次）。 */
export const DEFAULT_HEALTH_WINDOW_MS = 60_000;

interface CryptoLike {
  readonly randomUUID?: (() => string) | undefined;
}

function fallbackUuidV4(): string {
  let out = '';
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += '-';
      continue;
    }
    if (index === 14) {
      out += '4';
      continue;
    }
    const value = Math.floor(Math.random() * 16);
    out += (index === 19 ? (value & 0x3) | 0x8 : value).toString(16);
  }
  return out;
}

function defaultCreateId(): string {
  const cryptoRef = (globalThis as unknown as { readonly crypto?: CryptoLike }).crypto;
  if (cryptoRef !== undefined && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return fallbackUuidV4();
}

function toConfigVersionText(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 1 ? String(rounded) : null;
}

function normalizeWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_HEALTH_WINDOW_MS;
  return Math.max(1, Math.round(value));
}

export function createHealthReporter(options: HealthReporterOptions): HealthReporter {
  const now = options.now ?? ((): number => Date.now());
  const createId = options.createId ?? defaultCreateId;
  const windowMs = normalizeWindowMs(options.windowMs);
  let windowStartedAt = now();
  let cancel: (() => void) | null = null;
  let disposed = false;
  let flushing = false;

  function flush(): readonly SdkHealthEvent[] {
    if (disposed || flushing) return [];

    const at = now();
    const elapsed = at - windowStartedAt;
    windowStartedAt = at;

    const dimensions = options.dimensions();
    if (dimensions.state === null) return [];

    const counters = options.counters.snapshot();
    options.counters.reset();

    const metrics = buildHealthMetrics({
      counters,
      fixed: options.metrics?.take(),
      latency: options.latency?.take(),
      exposure: options.exposure?.exposure() ?? null,
      windowMs: clampWindowMs(elapsed),
    });

    const configVersion = toConfigVersionText(dimensions.config_version);
    const healthDimensions: HealthDimensions = {
      sdk_version: dimensions.sdk_version,
      state: dimensions.state,
      ...(configVersion === null ? {} : { config_version: configVersion }),
    };

    flushing = true;
    let events: readonly SdkHealthEvent[];
    try {
      events = buildHealthEvents({
        metrics,
        dimensions: healthDimensions,
        occurredAt: at,
        createId,
        maxMetricsPerEvent: options.maxMetricsPerEvent,
      });
      for (const event of events) options.emit(event);
    } finally {
      flushing = false;
    }

    // AC-05：丢弃上报动作自身在本窗口末尾同步产生的计数，不让它进入下一个窗口。
    options.counters.snapshot();
    options.counters.reset();

    return events;
  }

  return {
    start(): void {
      if (disposed || cancel !== null) return;
      const timer = options.timer;
      if (timer === undefined) return;
      cancel = timer.schedule((): void => {
        flush();
      }, windowMs);
    },
    flush,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const current = cancel;
      cancel = null;
      if (current !== null) current();
    },
  };
}
