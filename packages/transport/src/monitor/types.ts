/**
 * C08 自监控与调试的端口与类型（T17）。
 *
 * 设计约束（任务卡 + 指南第 11 节）：
 * - **零运行时依赖、零跨包 import**：与 `packages/core` 的 `Counters`、`packages/transport`
 *   其它目录之间只用**结构类型**对接（transport 的 `package.json` 未声明 `@web-report-sdk/core`，
 *   与 T15 的 `CountersPort` 做法一致）；
 * - 所有外部能力（计数快照、固定计数、耗时、暴露窗口、定时器、维度、事件出口、调试写端口）
 *   都通过注入端口获取，便于确定性测试与装配根接线；
 * - 模块顶层无副作用（不访问 `window`/`document`，不注册监听、定时器）。
 */

/** 上报时的生命周期状态；取值集合由 `reason-codes.md` 第 4 节与 Schema 的 enum 固定。 */
export type HealthState = 'initialized' | 'running' | 'paused' | 'destroyed';

/** 固定计数指标名；键名与 `sdk_health.schema.json` 的 `metrics` 一致。 */
export const FIXED_METRIC_NAMES = [
  'calls_total',
  'events_enqueued',
  'events_sent',
  'batches_sent',
  'batches_failed',
  'offline_written',
  'offline_replayed',
  'queue_length_max',
] as const;

export type FixedMetricName = (typeof FIXED_METRIC_NAMES)[number];

/** 固定计数的**窗口增量**；缺键表示该窗口为 0（按契约不上报）。 */
export type FixedMetricDeltas = Partial<Record<FixedMetricName, number>>;

/** 固定计数来源；`take()` 返回窗口增量并在实现内清零/推进基线。 */
export interface FixedMetricsPort {
  take(): FixedMetricDeltas;
}

/** CR-001 暴露窗口输入（映射层据此执行「仅事件数 >= 1 时上报 ms」的规则）。 */
export interface ExposureWindowInput {
  readonly events: number;
  readonly windowMs: number | null;
  /**
   * CR-008：真实窗口的**下界**读数（`stats().exposure.commitLostObservedWindowMs`，
   * 结束点＝最后一次「会话仍存活」证据）。`null` / 缺省表示没有可用读数，
   * 此时夹逼不成立，两个端点都不上报。允许 `0`（它是时长，不是计数）。
   */
  readonly observedWindowMs?: number | null | undefined;
}

export interface ExposureWindowPort {
  exposure(): ExposureWindowInput;
}

/**
 * CR-008：两个**观测量**的**窗口增量**。
 *
 * 它们由 CR-001 §5.2 第 3 条裁定为「不计原因码、改为观测量上报」，因此：
 * - 键名照抄 CR-001 原文（`flush_skipped_due_to_budget`、`leader_lost`），**没有**
 *   `drop_` / `count_` 前缀；
 * - 与固定计数同样按窗口取增量（来源是累计值），值为 0 时不上报。
 */
export interface ObservableMetricsInput {
  /** 离开 burst 内首次因预算用尽而停手的次数（每 burst 至多 1 次）。 */
  readonly flushSkippedDueToBudget?: number | undefined;
  /** 本标签页从 leader 变为非 leader 的次数（首轮未当选不计）。 */
  readonly leaderLost?: number | undefined;
}

/** CR-008 观测量来源；`take()` 返回窗口增量并在实现内推进基线。 */
export interface ObservableMetricsPort {
  take(): ObservableMetricsInput;
}

/**
 * 原因码计数快照端口。
 * 与 `packages/core` 的 `Counters`（`snapshot()` + `reset()`）结构兼容：
 * 键是 `reason-codes.md` 第 1/2 节的**裸原因码**，`drop_` / `count_` 前缀由本模块添加。
 */
export interface HealthCountersPort {
  snapshot(): Readonly<Record<string, number>>;
  /** 清空全部计数（C08 每个窗口聚合后调用）。 */
  reset(): void;
}

/** 耗时阶段；与 `reason-codes.md` 第 4 节的三个指标一一对应。 */
export type LatencyStage = 'track' | 'pipeline' | 'serialize';

export const LATENCY_STAGES = ['track', 'pipeline', 'serialize'] as const;

/** 阶段 → 契约指标名。 */
export const LATENCY_METRIC_NAMES: Readonly<Record<LatencyStage, string>> = {
  track: 'track_p99_ms',
  pipeline: 'pipeline_p99_ms',
  serialize: 'serialize_p99_ms',
};

/** 本窗口各阶段的 P99；缺键表示该阶段没有样本（不上报）。 */
export type LatencyP99 = Partial<Record<LatencyStage, number>>;

export interface LatencyWindowPort {
  take(): LatencyP99;
}

/** 维度输入；`state` 为 `null` 表示当前没有可上报的生命周期状态（不产生事件）。 */
export interface HealthDimensionsInput {
  readonly sdk_version: string;
  readonly state: HealthState | null;
  /** 生效的远程配置版本；`null` / 缺省表示没有生效配置（不上报 `config_version`）。 */
  readonly config_version?: number | null | undefined;
}

export interface HealthDimensionsPort {
  dimensions(): HealthDimensionsInput;
}

/** 周期定时器端口；`schedule` 返回取消函数（C02 全局注册表的 `scheduleRepeat` 结构兼容）。 */
export interface HealthTimerPort {
  schedule(handler: () => void, intervalMs: number): () => void;
}

/** `sdk_health` 的 dimensions（`config_version` 以十进制字符串编码）。 */
export interface HealthDimensions {
  readonly sdk_version: string;
  readonly state: HealthState;
  readonly config_version?: string | undefined;
}

/**
 * `sdk_health` 事件体（与 `docs/contracts/schemas/builtin-events/sdk_health.schema.json` 对应）。
 * `priority` 固定 `normal`（Q3 结论第 4 条）。
 */
export interface SdkHealthEvent {
  readonly event_id: string;
  readonly event_name: 'sdk_health';
  readonly event_type: 'sdk_internal';
  readonly schema_version: 1;
  readonly occurred_at: number;
  readonly priority: 'normal';
  readonly dimensions: HealthDimensions;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface HealthReporterOptions {
  readonly counters: HealthCountersPort;
  readonly dimensions: () => HealthDimensionsInput;
  /** 事件出口；装配根接到 C01 的 `EventSink` / C06 的 `enqueue`。 */
  readonly emit: (event: SdkHealthEvent) => void;
  readonly metrics?: FixedMetricsPort | undefined;
  readonly latency?: LatencyWindowPort | undefined;
  readonly exposure?: ExposureWindowPort | undefined;
  /** CR-008：两个观测量的窗口增量来源（离开预算停手、失去 leader）。 */
  readonly observables?: ObservableMetricsPort | undefined;
  readonly timer?: HealthTimerPort | undefined;
  readonly now?: (() => number) | undefined;
  /** `event_id` 生成器；缺省 `crypto.randomUUID()`，不可用时退回 UUID v4。 */
  readonly createId?: (() => string) | undefined;
  /** 窗口长度（毫秒）；缺省 60000。实际 `window_ms` 取两次 flush 之间的真实间隔。 */
  readonly windowMs?: number | undefined;
  /** 单条事件的 metrics 上限；缺省 50（Schema 的 `maxProperties`），仅在超限时拆成多条。 */
  readonly maxMetricsPerEvent?: number | undefined;
}

export interface HealthReporter {
  /** 启动周期上报；未注入定时器时为空操作（测试与手动 flush 场景）。 */
  start(): void;
  /** 立即聚合并产出一个窗口的事件；返回本次产出的事件（便于断言）。 */
  flush(): readonly SdkHealthEvent[];
  /** 停止定时器并禁止后续 flush。 */
  dispose(): void;
}
