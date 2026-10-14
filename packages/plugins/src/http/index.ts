/**
 * C05-F4 HTTP 插件（错误、性能、路由、HTTP 四入口之一）。
 */
export {
  FAILURE_REASONS,
  HTTP_EVENT_NAME,
  STATUS_CLASSES,
} from './types';
export type {
  CapturedRequest,
  CapturedResponse,
  FailureReason,
  HttpDimensions,
  HttpEvent,
  HttpMetrics,
  StatusClass,
  TraceContextProvider,
  TraceHeaders,
  TraceScope,
} from './types';
export { isSameOriginOrAllowed, narrowScope, resolveTraceHeaders } from './trace';
export {
  HTTP_PLUGIN_ID,
  SDK_INTERNAL_HEADER,
  captureNativeHttpRefs,
  classifyFailure,
  createHttpCapture,
  createHttpPlugin,
  installHttpCapture,
  statusClassOf,
} from './plugin';
export type {
  HttpCapture,
  HttpPlugin,
  HttpPluginOptions,
  HttpPorts,
  HttpSink,
  NativeHttpRefs,
} from './plugin';
