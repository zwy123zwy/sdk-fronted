/**
 * C08-F1 / C08-F2 的**装饰器实现**（模块内已实现并测试；装配根接线归 T18）。
 *
 * 只包装其它模块的**公开方法**，不改动它们的代码：
 * - `createCallCounter`：包装客户端公共方法，得到窗口内的 `calls_total`；
 * - `createLatencyDecorators`：
 *   - `wrapCalls` 包装 `track` / `log` / `captureError`（可配置），耗时记到 `track`；
 *   - `wrapPipeline` 包装 `Pipeline.process`，耗时记到 `pipeline`；
 *   - `wrapFunction` 包装任意同步函数（如序列化），耗时记到 `serialize`。
 *
 * 计时用注入的 `now()`，因此可在单测里完全确定性地断言；被包装方法抛错时
 * `finally` 仍会记录耗时并把异常原样抛出（与 C02「异常不向业务冒泡由上游兜底」一致）。
 */
import type { FixedMetricDeltas, LatencyStage } from './types';

/** 缺省计入 `calls_total` 的公共方法（与 core 的 `PUBLIC_METHODS` 一致）。 */
export const COUNTED_CALL_METHODS = [
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

/** 缺省计入 `track_p99_ms` 的公共方法。 */
export const DEFAULT_LATENCY_CALL_METHODS = ['track', 'log', 'captureError'] as const;

/** 保留方法签名的包装结果类型。 */
export type Counted<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R : T[K];
};

export interface InstrumentedCalls<T> {
  readonly client: Counted<T>;
  /** 返回并清零窗口内的调用次数。 */
  take(): FixedMetricDeltas;
}

export interface CallCounterOptions {
  /** 计入统计的方法名；缺省 `COUNTED_CALL_METHODS`。 */
  readonly methods?: readonly string[] | undefined;
}

function wrapMethods<T extends object>(
  client: T,
  methods: ReadonlySet<string>,
  wrapper: (invoke: () => unknown) => unknown,
): Counted<T> {
  const source = client as unknown as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'function' && methods.has(key)) {
      const invoke = value as (...args: readonly unknown[]) => unknown;
      wrapped[key] = (...args: readonly unknown[]): unknown => wrapper(() => invoke(...args));
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped as unknown as Counted<T>;
}

/**
 * 包装客户端公开方法统计 `calls_total`（C08-F1）。
 * 只处理**自有可枚举属性**中的方法（core 的 `createClient` 返回对象字面量，满足该前提）；
 * 接线方法与内部句柄默认不计入。
 */
export function createCallCounter<T extends object>(
  client: T,
  options: CallCounterOptions = {},
): InstrumentedCalls<T> {
  const methods = new Set<string>(options.methods ?? COUNTED_CALL_METHODS);
  let calls = 0;
  const wrapped = wrapMethods(client, methods, (invoke) => {
    calls += 1;
    return invoke();
  });
  return {
    client: wrapped,
    take(): FixedMetricDeltas {
      const delta = calls;
      calls = 0;
      return delta >= 1 ? { calls_total: delta } : {};
    },
  };
}

/** 耗时接收端；`LatencyWindow` 结构上满足它。 */
export interface DurationRecorder {
  record(stage: LatencyStage, durationMs: number): void;
}

/** 管线最小结构（core 的 `Pipeline` 结构上满足它）。 */
export interface PipelineLike {
  process(event: {
    readonly event_name: string;
    readonly priority: 'normal' | 'critical';
    readonly occurred_at: number;
    [field: string]: unknown;
  }): unknown;
}

export interface LatencyDecoratorOptions {
  readonly recorder: DurationRecorder;
  /** 当前时间（毫秒）；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  readonly callMethods?: readonly string[] | undefined;
  readonly callStage?: LatencyStage | undefined;
  readonly pipelineStage?: LatencyStage | undefined;
  readonly functionStage?: LatencyStage | undefined;
}

export interface LatencyDecorators {
  wrapCalls<T extends object>(client: T): Counted<T>;
  wrapPipeline<T extends PipelineLike>(pipeline: T): T;
  wrapFunction<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
}

/** 创建三个阶段的耗时装饰器。 */
export function createLatencyDecorators(options: LatencyDecoratorOptions): LatencyDecorators {
  const now = options.now ?? ((): number => Date.now());
  const callMethods = new Set<string>(options.callMethods ?? DEFAULT_LATENCY_CALL_METHODS);
  const callStage: LatencyStage = options.callStage ?? 'track';
  const pipelineStage: LatencyStage = options.pipelineStage ?? 'pipeline';
  const functionStage: LatencyStage = options.functionStage ?? 'serialize';

  function measure<T>(stage: LatencyStage, invoke: () => T): T {
    const startedAt = now();
    try {
      return invoke();
    } finally {
      options.recorder.record(stage, now() - startedAt);
    }
  }

  return {
    wrapCalls<T extends object>(client: T): Counted<T> {
      return wrapMethods(client, callMethods, (invoke) => measure(callStage, invoke));
    },
    wrapPipeline<T extends PipelineLike>(pipeline: T): T {
      const process = (event: Parameters<T['process']>[0]): ReturnType<T['process']> => {
        const startedAt = now();
        try {
          return pipeline.process(event) as ReturnType<T['process']>;
        } finally {
          options.recorder.record(pipelineStage, now() - startedAt);
        }
      };
      const wrapped = { ...pipeline, process } as T;
      return wrapped;
    },
    wrapFunction<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
      return (...args: A): R => measure(functionStage, () => fn(...args));
    },
  };
}
