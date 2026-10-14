/**
 * C05-F1 错误归一化的类型契约。
 *
 * 字段名照抄 `docs/contracts/schemas/builtin-events/web_js_error.schema.json`
 * （`dimensions.error_type` / `message` / `source` / `fingerprint` 必填，
 * `metrics.count` 必填且为 `integer, minimum: 1`，错误栈走顶层 `attachment`）。
 *
 * `source` 的取值来自 `tests/acceptance/C05.md`：AC-01 要求 `window_error`，
 * AC-02 要求 `unhandled_rejection`。Schema 未加枚举，这两个值是 AC 的硬要求。
 */

/** 归一化后的事件名。 */
export const JS_ERROR_EVENT_NAME = 'web_js_error';

/** C05-AC-01 的 `source` 取值。 */
export const SOURCE_WINDOW_ERROR = 'window_error';

/** C05-AC-02 的 `source` 取值。 */
export const SOURCE_UNHANDLED_REJECTION = 'unhandled_rejection';

/** `error_type` 取值：未捕获异常。 */
export const ERROR_TYPE_EXCEPTION = 'exception';

/** `error_type` 取值：未处理拒绝。 */
export const ERROR_TYPE_UNHANDLED_REJECTION = 'unhandled_rejection';

/** `error_type` 取值：资源加载错误（Schema 不排除，属计划内的合理扩展）。 */
export const ERROR_TYPE_RESOURCE = 'resource_error';

/** 面包屑容量：固定 20 条，不开放配置（T18-plan §2 裁定）。 */
export const BREADCRUMB_CAPACITY = 20;

/** 未捕获异常来源标识（两种 `source` 取值之一）。 */
export type JsErrorSource = typeof SOURCE_WINDOW_ERROR | typeof SOURCE_UNHANDLED_REJECTION;

/** `error_type` 取值集合。 */
export type JsErrorType =
  | typeof ERROR_TYPE_EXCEPTION
  | typeof ERROR_TYPE_UNHANDLED_REJECTION
  | typeof ERROR_TYPE_RESOURCE;

/** 单条行为面包屑：只记元素标识与动作类型，绝不记录输入框的 `value`。 */
export interface Breadcrumb {
  /** 动作类型，例如 `click` / `route`。 */
  readonly type: string;
  /** 元素标识（选择器或标签名），不含用户输入内容。 */
  readonly target: string;
  /** 采集时刻（毫秒时间戳）。 */
  readonly at: number;
}

/** `web_js_error` 的 `dimensions` 段（归一化后的错误负载）。 */
export interface NormalizedJsDimensions {
  /**
   * 错误类型名（`TypeError`、`ReferenceError`、`resource_error` 等）。
   * Schema 是自由字符串（`minLength: 1`、`maxLength: 128`），只有 AC 点名的取值才是硬要求。
   */
  readonly error_type: string;
  /** 归一化后的消息：剥离数字与 URL 查询参数（指纹的稳定性前提）。 */
  readonly message: string;
  /**
   * 错误来源。AC 点名 `window_error`（AC-01）与 `unhandled_rejection`（AC-02）；
   * Schema 是自由字符串，新增取值属兼容变更。
   */
  readonly source: string;
  /** 稳定哈希：同错误同值、不随易变部分漂移（用于 AC-03 去重）。 */
  readonly fingerprint: string;
}

/** `web_js_error` 的 `metrics` 段。 */
export interface JsErrorMetrics {
  /** 同一指纹被折叠的总次数（`integer, minimum: 1`）。 */
  readonly count: number;
  /** 错误发生的行号；取不到时不上报。 */
  readonly line?: number | undefined;
  /** 错误发生的列号；取不到时不上报。 */
  readonly column?: number | undefined;
}

/**
 * `normalizeError` 的产出：`web_js_error` 的字段骨架。
 *
 * **不含完整事件公共字段**（`event_id`/`occurred_at` 等由内核与投递层补），
 * 也不含最终的 `metrics.count`（由去重器写入）。
 */
export interface NormalizedJsError {
  readonly dimensions: NormalizedJsDimensions;
  readonly metrics: JsErrorMetrics;
  /** 脱敏后的错误栈；顶层 `attachment`，非 `dimensions`。 */
  readonly attachment?: string | undefined;
}

/**
 * 归一化后的一条错误事件。
 *
 * 形状对齐 C02 `KernelEvent`（`event_name` / `priority` / `occurred_at` 必填），
 * 其余字段按 `web_js_error` Schema 组装。
 */
export interface JsErrorEvent {
  /** C02 `KernelEvent` 的形状要求：允许内核与后续段补充字段。 */
  readonly [field: string]: unknown;
  readonly event_name: typeof JS_ERROR_EVENT_NAME;
  readonly priority: 'normal' | 'critical';
  readonly occurred_at: number;
  readonly dimensions: NormalizedJsDimensions;
  readonly metrics: JsErrorMetrics;
  /** 脱敏前的错误栈；脱敏由 C04 负责（`attachment` 只被 C04 按字节截断）。 */
  readonly attachment?: string | undefined;
  /**
   * 行为面包屑的承载（见 `breadcrumbs.ts` 的 `BREADCRUMB_CONTEXT_PREFIX`）。
   *
   * 契约把 `web_js_error.dimensions` 定为**封闭四键**（`additionalProperties: false`）、
   * `metrics` 只认 `count`/`line`/`column`，因此面包屑没有专属字段；
   * `context` 是该事件上唯一可承载结构化文本的开放字段。
   */
  readonly context?: Readonly<Record<string, string>> | undefined;
}
