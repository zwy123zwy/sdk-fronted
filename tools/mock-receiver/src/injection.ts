/**
 * 故障注入（M01-F3）：按序列或按比例返回 429 / 5xx / 413 / 401 / 超时 / 断连。
 *
 * 比例模式默认使用固定种子的伪随机源，保证同一注入配置下 1,000 次采样的占比可复现，
 * 便于 M01-AC-09 稳定断言 25%–35%。需要真随机时可注入 `random`。
 */

/** 可注入的故障。`none` 表示放行。 */
export type FaultKind = '429' | '503' | '413' | '401' | 'timeout' | 'reset' | 'none';

/** 比例模式支持的故障（`timeout` / `reset` 也允许，接口统一）。 */
export type InjectionKind = Exclude<FaultKind, 'none'>;

export interface InjectionDecision {
  kind: FaultKind;
  /** 响应码，`timeout` / `reset` / `none` 时为 null。 */
  status: 429 | 503 | 413 | 401 | null;
  /** 响应体的 `error` 字段。 */
  error: string | null;
  /** 429 / 503 需要整数 `Retry-After`。 */
  retryAfter: number | null;
}

export interface InjectionConfig {
  mode: 'off' | 'sequence' | 'ratio';
  sequence: readonly FaultKind[];
  kind: InjectionKind;
  rate: number;
  /** 存储失败注入（M01-AC-05），与响应码注入正交。 */
  storageFail: boolean;
}

export interface InjectionController {
  decide: () => InjectionDecision;
  setSequence: (sequence: readonly string[]) => InjectionConfig;
  setRatio: (kind: InjectionKind, rate: number) => InjectionConfig;
  setStorageFail: (enabled: boolean) => InjectionConfig;
  clear: () => InjectionConfig;
  config: () => InjectionConfig;
  /** 已消费的序列位置（调试用）。 */
  cursor: () => number;
}

export interface InjectionControllerOptions {
  /** 随机源，默认使用固定种子的 `createSeededRandom`。 */
  random?: () => number;
  seed?: number;
}

/** 默认随机种子：固定值，保证比例注入可复现。 */
export const DEFAULT_INJECTION_SEED = 0x5eed_2b1a;

const DECISIONS: Record<InjectionKind, InjectionDecision> = {
  '429': { kind: '429', status: 429, error: 'rate_limited', retryAfter: 1 },
  '503': { kind: '503', status: 503, error: 'storage_unavailable', retryAfter: 1 },
  '413': { kind: '413', status: 413, error: 'payload_too_large', retryAfter: null },
  '401': { kind: '401', status: 401, error: 'invalid_token', retryAfter: null },
  timeout: { kind: 'timeout', status: null, error: null, retryAfter: null },
  reset: { kind: 'reset', status: null, error: null, retryAfter: null },
};

const NONE: InjectionDecision = {
  kind: 'none',
  status: null,
  error: null,
  retryAfter: null,
};

const INJECTION_KINDS: readonly InjectionKind[] = ['429', '503', '413', '401', 'timeout', 'reset'];
const FAULT_KINDS = new Set<string>([...INJECTION_KINDS, 'none']);

function isInjectionKind(value: string): value is InjectionKind {
  return (INJECTION_KINDS as readonly string[]).includes(value);
}

/** mulberry32：小而快、可复现的伪随机源。 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 校验注入序列；非法取值抛出可读错误。 */
export function normalizeSequence(sequence: readonly string[]): FaultKind[] {
  const normalized: FaultKind[] = [];
  for (const item of sequence) {
    if (!FAULT_KINDS.has(item)) {
      throw new Error(
        `未知的故障注入取值：${item}；允许：${[...FAULT_KINDS].join(', ')}`,
      );
    }
    normalized.push(item as FaultKind);
  }
  return normalized;
}

/** 创建注入控制器。 */
export function createInjectionController(
  options: InjectionControllerOptions = {},
): InjectionController {
  const random = options.random ?? createSeededRandom(options.seed ?? DEFAULT_INJECTION_SEED);
  let mode: InjectionConfig['mode'] = 'off';
  let sequence: FaultKind[] = [];
  let kind: InjectionKind = '503';
  let rate = 0;
  let storageFail = false;
  let cursor = 0;

  const config = (): InjectionConfig => ({ mode, sequence: [...sequence], kind, rate, storageFail });

  return {
    decide: (): InjectionDecision => {
      if (mode === 'sequence') {
        const item = sequence[cursor];
        if (item === undefined) return NONE;
        cursor += 1;
        return item === 'none' ? NONE : DECISIONS[item];
      }
      if (mode === 'ratio') {
        if (rate <= 0) return NONE;
        return random() < rate ? DECISIONS[kind] : NONE;
      }
      return NONE;
    },
    setSequence: (next: readonly string[]): InjectionConfig => {
      sequence = normalizeSequence(next);
      mode = sequence.length > 0 ? 'sequence' : 'off';
      cursor = 0;
      return config();
    },
    setRatio: (nextKind: InjectionKind, nextRate: number): InjectionConfig => {
      if (typeof nextKind !== 'string' || !isInjectionKind(nextKind)) {
        throw new Error(`未知的故障注入类型：${JSON.stringify(nextKind)}`);
      }
      if (!Number.isFinite(nextRate) || nextRate < 0 || nextRate > 1) {
        throw new Error(`注入比例必须在 [0, 1]：${String(nextRate)}`);
      }
      kind = nextKind;
      rate = nextRate;
      mode = nextRate > 0 ? 'ratio' : 'off';
      cursor = 0;
      return config();
    },
    setStorageFail: (enabled: boolean): InjectionConfig => {
      storageFail = enabled;
      return config();
    },
    clear: (): InjectionConfig => {
      mode = 'off';
      sequence = [];
      rate = 0;
      storageFail = false;
      cursor = 0;
      return config();
    },
    config,
    cursor: () => cursor,
  };
}
