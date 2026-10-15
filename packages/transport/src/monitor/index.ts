/**
 * C08 自监控（T17）的目录内聚合导出。公共面只从 `packages/transport/src/index.ts` 暴露。
 */
export { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';
export {
  CR008_METRIC_KEYS,
  CR008_OBSERVABLE_METRIC_KEYS,
  EXPOSURE_WINDOW_LOWER_BOUND_MS,
  EXPOSURE_WINDOW_UPPER_BOUND_MS,
  METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
  METRIC_LEADER_LOST,
} from './observables';
export { WINDOW_METRIC_KEY, buildHealthMetrics, clampWindowMs } from './metrics';
export { MAX_METRICS_PER_EVENT, buildHealthEvents } from './events';
export {
  DEFAULT_LATENCY_CAPACITY,
  DEFAULT_SESSION_SAMPLE_RATE,
  createLatencyWindow,
  createSessionSampler,
  nearestRankPercentile,
} from './latency';
export {
  COUNTED_CALL_METHODS,
  DEFAULT_LATENCY_CALL_METHODS,
  createCallCounter,
  createLatencyDecorators,
} from './instrument';
export {
  combineFixedMetrics,
  createDeliveryMetricsSource,
  createFixedMetricsAccumulator,
  createHealthDimensionsReader,
  createObservableMetricsSource,
  createOfflineExposureSource,
  createQueueMetricsSource,
  createRegistryTimer,
  createSubmitMetricsSource,
} from './adapters';
export { DEFAULT_HEALTH_WINDOW_MS, createHealthReporter } from './reporter';
export { jsonSize, measureTrafficShare } from './traffic';
export { FIXED_METRIC_NAMES, LATENCY_METRIC_NAMES, LATENCY_STAGES } from './types';
export type {
  CallCounterOptions,
  Counted,
  DurationRecorder,
  InstrumentedCalls,
  LatencyDecoratorOptions,
  LatencyDecorators,
  PipelineLike,
} from './instrument';
export type {
  DeliveryMetricsLike,
  ExposureStatsLike,
  FixedMetricsAccumulator,
  HealthDimensionsReaderOptions,
  LeaderObservablesLike,
  LeaveObservablesLike,
  LifecycleStateSource,
  ObservableMetricsSourceOptions,
  QueueMetricsSource,
  QueueMetricsSourceOptions,
  RepeatSchedulerLike,
  SubmitMetricsSource,
  SubmitMetricsSourceOptions,
} from './adapters';
export type { HealthEventInput } from './events';
export type { HealthMetricsInput } from './metrics';
export type {
  LatencyWindow,
  LatencyWindowOptions,
  SessionSampler,
  SessionSamplerOptions,
} from './latency';
export type { TrafficShare } from './traffic';
export type {
  ExposureWindowInput,
  ExposureWindowPort,
  FixedMetricDeltas,
  FixedMetricName,
  FixedMetricsPort,
  HealthCountersPort,
  HealthDimensions,
  HealthDimensionsInput,
  HealthDimensionsPort,
  HealthReporter,
  HealthReporterOptions,
  HealthState,
  HealthTimerPort,
  LatencyP99,
  LatencyStage,
  LatencyWindowPort,
  ObservableMetricsInput,
  ObservableMetricsPort,
  SdkHealthEvent,
} from './types';
