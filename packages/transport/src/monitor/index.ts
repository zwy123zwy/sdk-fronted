/**
 * C08 自监控（T17）的目录内聚合导出。公共面只从 `packages/transport/src/index.ts` 暴露。
 */
export { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';
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
  LifecycleStateSource,
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
  SdkHealthEvent,
} from './types';
