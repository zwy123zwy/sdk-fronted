/**
 * C05-F1 错误插件（错误、性能、路由、HTTP 四入口之一）。
 *
 * 只导出错误采集相关符号：`import ... from '@web-report-sdk/plugins/error'`
 * 的构建产物不得包含 perf / route / http 的代码（C05-AC-13）。
 */
export {
  BREADCRUMB_CAPACITY,
  ERROR_TYPE_EXCEPTION,
  ERROR_TYPE_RESOURCE,
  ERROR_TYPE_UNHANDLED_REJECTION,
  JS_ERROR_EVENT_NAME,
  SOURCE_UNHANDLED_REJECTION,
  SOURCE_WINDOW_ERROR,
} from './types';
export type {
  Breadcrumb,
  JsErrorEvent,
  JsErrorMetrics,
  JsErrorSource,
  JsErrorType,
  NormalizedJsError,
} from './types';
export { computeFingerprint, normalizeError, normalizeMessage } from './stack';
export type { NormalizeInput } from './stack';
export {
  BREADCRUMB_CONTEXT_PREFIX,
  createBreadcrumbBuffer,
  decodeBreadcrumbs,
  describeElement,
  encodeBreadcrumbs,
} from './breadcrumbs';
export type { BreadcrumbBuffer } from './breadcrumbs';
export { DEFAULT_DEDUP_WINDOW_MS, createDeduplicator } from './dedup';
export type { DedupObservation, DedupSettlement, Deduplicator } from './dedup';
export {
  DEFAULT_ERROR_PLUGIN_OPTIONS,
  ERROR_PLUGIN_ID,
  createErrorPlugin,
  installErrorCapture,
} from './plugin';
export type {
  ErrorCapture,
  ErrorCapturePlugin,
  ErrorPluginOptions,
  JsErrorSink,
} from './plugin';
