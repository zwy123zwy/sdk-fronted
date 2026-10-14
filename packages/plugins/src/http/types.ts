/**
 * C05-F4 HTTP 采集的类型契约（M1 接口桩）。
 *
 * 字段名照抄 `docs/contracts/schemas/builtin-events/web_http.schema.json`：
 * - `dimensions` 必填 `method`、`url_template`；可选 `status_class`
 *   （枚举 **`1xx`/`2xx`/`3xx`/`4xx`/`5xx`**）、`failure_reason`（自由字符串，Schema 无枚举）；
 * - `metrics` 必填 `duration_ms`；可选 `status`（`integer, minimum: 100`）、`request_bytes`、`response_bytes`。
 *
 * 裁定（T18-plan §4、§5，依 CR-006）：
 * - AC-12 的链路追踪头采用 **W3C Trace Context：`traceparent`（必需）/ `tracestate`（可选）**；
 * - **值由接入方注入，SDK 不自造**（`traceContextProvider`）：未提供则**不注入该头**；
 * - 只对**同源或命中白名单**的请求注入；白名单外一律不注入（不做"尽力而为"的降级注入）；
 * - AC-10 的 `failure_reason` 取值集为 **`network_error`/`timeout`/`aborted`/`cors`**，
 *   只表达**传输层失败**；成功请求**省略该维度**；HTTP 4xx/5xx 走 `metrics.status`，不用该维度。
 *
 * 隐私硬约束：**请求体默认不采集**——不注册任何读取 `body`/`FormData`/`Blob` 的逻辑。
 */

/** HTTP 事件名（AC-10）。 */
export const HTTP_EVENT_NAME = 'web_http';

/**
 * 标记 SDK 自身请求的请求头名（随上报请求一起发送，服务端可忽略）。
 * 采集侧靠**显式标记**识别自身上报请求，不靠 URL 猜测（AC-10）。
 */
export const SDK_INTERNAL_HEADER = 'x-web-report-sdk-internal';

/** `status_class` 的五个取值（照抄 Schema 枚举）。 */
export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

/** `status_class` 取值清单。 */
export const STATUS_CLASSES: readonly StatusClass[] = ['1xx', '2xx', '3xx', '4xx', '5xx'];

/**
 * `failure_reason` 的取值集（CR-006 裁定）。
 * 只表达传输层失败；成功请求省略该维度；4xx/5xx 不走这里。
 */
export type FailureReason = 'network_error' | 'timeout' | 'aborted' | 'cors';

/** `failure_reason` 取值清单（README 与用例据此断言）。 */
export const FAILURE_REASONS: readonly FailureReason[] = [
  'network_error',
  'timeout',
  'aborted',
  'cors',
];

/** `web_http` 的 `dimensions` 段。 */
export interface HttpDimensions {
  readonly method: string;
  /** URL 模板（不是实参 URL）；令牌只可能出现在查询参数里，已由 C04 的白名单与脱敏处理。 */
  readonly url_template: string;
  readonly status_class?: StatusClass | undefined;
  readonly failure_reason?: FailureReason | undefined;
}

/** `web_http` 的 `metrics` 段。 */
export interface HttpMetrics {
  readonly duration_ms: number;
  /** HTTP 状态码；`integer, minimum: 100`。 */
  readonly status?: number | undefined;
  readonly request_bytes?: number | undefined;
  readonly response_bytes?: number | undefined;
}

/** 一条归一化后的 HTTP 事件。 */
export interface HttpEvent {
  readonly event_name: typeof HTTP_EVENT_NAME;
  readonly priority: 'normal' | 'critical';
  readonly occurred_at: number;
  readonly dimensions: HttpDimensions;
  readonly metrics: HttpMetrics;
}

/**
 * AC-12 的链路追踪注入端口。
 *
 * **值由接入方提供**：接入方返回 `undefined` 时**不注入该头**（不伪造）。
 * SDK 只决定"要不要给这个请求注入"，不决定"头里写什么"。
 */
export interface TraceContextProvider {
  /** 返回要注入的追踪头；返回 `undefined` 表示本次不注入。 */
  (request: { readonly url: string; readonly method: string }): TraceHeaders | undefined;
}

/** 要注入的追踪头（W3C Trace Context）。 */
export interface TraceHeaders {
  /** 必需：`traceparent`。 */
  readonly traceparent: string;
  /** 可选：`tracestate`。 */
  readonly tracestate?: string | undefined;
}

/** 追踪注入范围：同源 + 显式白名单。 */
export interface TraceScope {
  /** 当前页面源（如 `https://app.example.com`）；同源请求总是允许注入。 */
  readonly origin: string;
  /** 追踪白名单（完整源或域名）；**远程配置只能收紧**注入范围。 */
  readonly allowlist: readonly string[];
}

/** 采集到的请求元信息（**不含请求体**）。 */
export interface CapturedRequest {
  readonly method: string;
  /** 实参 URL；进事件前必须经 C04 的 URL 白名单与脱敏处理，并转成模板。 */
  readonly url: string;
  /** 是否由 SDK 自己发出（自身上报请求不得被采集，AC-10）。 */
  readonly sdkInternal?: boolean | undefined;
}

/** 采集到的响应元信息。 */
export interface CapturedResponse {
  readonly status: number;
  /** 传输层失败原因；成功时省略。 */
  readonly failureReason?: FailureReason | undefined;
  readonly requestBytes?: number | undefined;
  readonly responseBytes?: number | undefined;
}
