/**
 * C05-F2 性能插件（错误、性能、路由、HTTP 四入口之一）。
 */
export {
  LONG_TASK_EVENT_NAME,
  METRIC_NAMES,
  VITALS_EVENT_NAME,
} from './types';
export type {
  LongTaskEvent,
  LongTaskMetrics,
  MetricName,
  PerfEntryLike,
  PerfObserverCallback,
  PerfObserverFactory,
  PerfObserverLike,
  PerfPorts,
  VitalsDimensions,
  VitalsEvent,
  VitalsMetrics,
  VitalsRating,
} from './types';
export {
  OBSERVED_ENTRY_TYPES,
  createVitalsAccumulator,
  normalizeLongTask,
  rate,
} from './vitals';
export type { VitalsAccumulator } from './vitals';
export { PERF_PLUGIN_ID, createPerfCapture, createPerfPlugin, installPerfCapture } from './plugin';
export type { PerfCapture, PerfPlugin, PerfSink } from './plugin';
