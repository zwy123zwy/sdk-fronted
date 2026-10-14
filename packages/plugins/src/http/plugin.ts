/**
 * C05-F4 HTTP 采集插件。
 *
 * 裁定与约束（T18-plan §4、§6）：
 * - `captureNativeHttpRefs()` 由**装配方在任何插件安装之前**调用一次（幂等、捕获后冻结）；
 *   **采集插件不得在自己的 `install()` 里捕获**（那会依赖安装顺序，太脆）；
 * - 插件只接收**已注入**的引用对象，包装后暴露恢复方法；宿主可随时卸载；
 * - 包装叠加规则同 §6：安装时保存当前引用并叠在其上，卸载时**仅当当前值仍是自己的包装**才还原；
 * - **请求体默认不采集**：本模块不注册任何读取 `body`/`FormData`/`Blob` 的逻辑；
 * - **SDK 自己的上报请求不被采集**（AC-10）：靠显式标记 `sdkInternal`，不靠 URL 猜测；
 * - 追踪头只注入同源或白名单（AC-12），值由接入方注入（`traceContextProvider`）。
 */
import type { Plugin, PluginContext } from '@web-report-sdk/core';

import { unused } from '../internal/unused';
import { createInlineHooker } from '../internal/hooker';
import type { Hooker } from '../internal/hooker';
import { resolveTraceHeaders } from './trace';
import { HTTP_EVENT_NAME, SDK_INTERNAL_HEADER } from './types';
import type {
  CapturedRequest,
  CapturedResponse,
  FailureReason,
  HttpDimensions,
  HttpEvent,
  StatusClass,
  TraceContextProvider,
  TraceHeaders,
  TraceScope,
} from './types';

/** 插件 id，与 `remote-config.schema.json` 的 `pluginName` 枚举一致。 */
export const HTTP_PLUGIN_ID = 'http';

export { SDK_INTERNAL_HEADER };

/** HTTP 事件的出口。 */
export type HttpSink = (event: HttpEvent) => void;

/**
 * 注入的原生 HTTP 引用**容器**：包装会替换容器上的属性（与宿主共享同一个对象，
 * 这样宿主后续的 `fetch` 调用才会经过包装）。
 */
export interface NativeHttpRefs {
  fetch: (...args: readonly unknown[]) => Promise<unknown>;
  /** 原生 `XMLHttpRequest` 构造器；容器没有 XHR 时可省略。 */
  XMLHttpRequest?: unknown;
}

/** 采集插件的配置。 */
export interface HttpPluginOptions {
  /** 追踪范围（同源 + 白名单）；缺省不含任何白名单，即只注入同源请求。 */
  readonly traceScope?: TraceScope | undefined;
  /** 追踪上下文注入端口；**未提供则不注入追踪头**。 */
  readonly traceContextProvider?: TraceContextProvider | undefined;
  /** URL → 模板的转换（复用 C04 的 URL 白名单与脱敏后的结果）；缺省去掉查询参数与 hash。 */
  readonly urlTemplate?: ((url: string) => string) | undefined;
}

/** 创建 HTTP 采集所需的注入端口。 */
export interface HttpPorts {
  /** 装配前捕获的引用容器；**不传表示没有可包装的目标**（静默降级）。 */
  readonly refs?: NativeHttpRefs | undefined;
  /** 注入的全局注册表（内核的 `context.registry`）。 */
  readonly hooker?: Hooker | undefined;
  /** 当前时间源；缺省 `performance.now` / `Date.now`。 */
  readonly now?: (() => number) | undefined;
  readonly options?: HttpPluginOptions | undefined;
}

/** HTTP 采集运行端口。 */
export interface HttpCapture {
  /** 读数：已上报事件数与因属于 SDK 自身请求而跳过的条数。 */
  stats(): { readonly captured: number; readonly skippedInternal: number };
  /**
   * 手动记录一次已完成请求（装配根与 XHR/fetch 包装共用同一归一化路径）。
   * 声明为**函数属性**而非方法签名，便于宿主与测试安全地取出后单独调用。
   */
  record: (request: CapturedRequest, response: CapturedResponse, durationMs: number) => void;
  /** 为目标请求计算要注入的追踪头（AC-12；不允许注入时返回 `undefined`）。 */
  traceHeadersFor: (request: { readonly url: string; readonly method: string }) => TraceHeaders | undefined;
  /** 恢复自己装上的那一层；幂等。 */
  uninstall(): void;
}

/** 采集插件定义：可直接交给 `kernel.registerPlugin`。 */
export interface HttpPlugin extends Plugin {
  readonly id: typeof HTTP_PLUGIN_ID;
  readonly capture: HttpCapture;
}

/** 缺省 URL → 模板：去掉查询参数与 hash（令牌只可能出现在查询参数里）。 */
function defaultUrlTemplate(url: string): string {
  const withoutHash = url.split('#')[0] ?? url;
  return withoutHash.split('?')[0] ?? withoutHash;
}

/** 状态码 → `status_class`（Schema 枚举）。 */
export function statusClassOf(status: number): StatusClass | undefined {
  if (status >= 100 && status <= 199) return '1xx';
  if (status >= 200 && status <= 299) return '2xx';
  if (status >= 300 && status <= 399) return '3xx';
  if (status >= 400 && status <= 499) return '4xx';
  if (status >= 500 && status <= 599) return '5xx';
  return undefined;
}

/**
 * 传输层失败的归类（CR-006 的取值集，只表达传输层失败）。
 *
 * 说明：浏览器对网络失败只给 `TypeError: Failed to fetch` 这类笼统信息，
 * 因此这里按名称/消息做**尽力归类**；分类不出来时用 `network_error`（不虚构更细的语义）。
 */
export function classifyFailure(error: unknown): FailureReason {
  if (error === null || typeof error !== 'object') return 'network_error';
  const named = error as { readonly name?: unknown; readonly message?: unknown };
  const name = typeof named.name === 'string' ? named.name : '';
  const message = typeof named.message === 'string' ? named.message : '';
  if (name === 'AbortError') return 'aborted';
  if (name === 'TimeoutError' || /timeout/i.test(message)) return 'timeout';
  if (/cors/i.test(message)) return 'cors';
  return 'network_error';
}

/** 从 fetch 入参读取方法与 URL（只读元信息，绝不读请求体）。 */
function readFetchArgs(args: readonly unknown[]): { method: string; url: string } {
  const input = args[0];
  let url = '';
  let method = 'GET';
  if (typeof input === 'string') {
    url = input;
  } else if (input !== null && typeof input === 'object') {
    const request = input as { readonly url?: unknown; readonly method?: unknown };
    if (typeof request.url === 'string') url = request.url;
    if (typeof request.method === 'string') method = request.method.toUpperCase();
  }
  const init = args[1];
  if (init !== null && typeof init === 'object') {
    const maybeMethod = (init as { readonly method?: unknown }).method;
    if (typeof maybeMethod === 'string') method = maybeMethod.toUpperCase();
  }
  return { method, url };
}

/** fetch 的 `init` 形状子集（只声明我们会改写的 `headers`）。 */
interface FetchInitLike {
  readonly headers?: unknown;
  readonly [field: string]: unknown;
}

/** 把追踪头写进 fetch 的 init；没有可注入的头时原样返回。 */
function withTraceHeaders(
  init: unknown,
  headers: TraceHeaders | undefined,
): FetchInitLike | undefined {
  if (headers === undefined) return init === undefined ? undefined : (init as FetchInitLike);
  const base = init !== undefined && init !== null && typeof init === 'object' ? (init as FetchInitLike) : {};
  const existing = base.headers;
  const merged: Record<string, string> = {};
  if (existing !== undefined && existing !== null && typeof existing === 'object') {
    for (const [key, value] of Object.entries(existing as Record<string, unknown>)) {
      if (typeof value === 'string') merged[key] = value;
    }
  }
  merged['traceparent'] = headers.traceparent;
  if (headers.tracestate !== undefined) merged['tracestate'] = headers.tracestate;
  return { ...base, headers: merged };
}

/** 读取响应状态码（只读状态，绝不读响应体）。 */
function statusOf(response: unknown): number {
  if (response !== null && typeof response === 'object') {
    const status = (response as { readonly status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return 0;
}

/** XHR 实例的结构子集（只用我们需要的成员）。 */
interface XhrLike {
  open: (method: string, url: string | URL, ...rest: readonly unknown[]) => void;
  addEventListener?: (type: string, listener: () => void) => void;
  status?: number;
}

/** 采集状态。 */
interface HttpState {
  readonly capture: HttpCapture;
  attach(context?: PluginContext): void;
}

/** 创建 HTTP 采集状态。 */
function createHttpState(sink: HttpSink, ports?: HttpPorts): HttpState {
  const options = ports?.options;
  const urlTemplate = options?.urlTemplate ?? defaultUrlTemplate;
  const now = ports?.now ?? ((): number => Date.now());
  const disposers: (() => void)[] = [];
  let disposed = false;
  let captured = 0;
  let skippedInternal = 0;

  const traceHeadersFor = (request: {
    readonly url: string;
    readonly method: string;
  }): TraceHeaders | undefined => {
    const scope = options?.traceScope;
    if (scope === undefined) return undefined;
    return resolveTraceHeaders(request, scope, options?.traceContextProvider);
  };

  const record = (request: CapturedRequest, response: CapturedResponse, durationMs: number): void => {
    // SDK 自己的上报请求不被采集（AC-10）：显式标记，不靠 URL 猜测。
    if (request.sdkInternal === true) {
      skippedInternal += 1;
      return;
    }
    const failureReason = response.failureReason;
    const statusClass =
      failureReason === undefined && response.status > 0 ? statusClassOf(response.status) : undefined;
    const dimensions: HttpDimensions = {
      method: request.method,
      url_template: urlTemplate(request.url),
      ...(statusClass === undefined ? {} : { status_class: statusClass }),
      ...(failureReason === undefined ? {} : { failure_reason: failureReason }),
    };
    const metrics = {
      duration_ms: durationMs,
      ...(failureReason === undefined && response.status > 0 ? { status: response.status } : {}),
      ...(response.requestBytes === undefined ? {} : { request_bytes: response.requestBytes }),
      ...(response.responseBytes === undefined ? {} : { response_bytes: response.responseBytes }),
    };
    const event: HttpEvent = {
      event_name: HTTP_EVENT_NAME,
      priority: 'normal',
      occurred_at: now(),
      dimensions,
      metrics,
    };
    captured += 1;
    sink(event);
  };

  const capture: HttpCapture = {
    stats(): { readonly captured: number; readonly skippedInternal: number } {
      return { captured, skippedInternal };
    },
    record,
    traceHeadersFor,
    uninstall(): void {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
    },
  };

  return {
    capture,
    attach(context?: PluginContext): void {
      if (disposed) return;
      const refs = ports?.refs;
      // 没有注入注册表（无内核上下文）时用内存实现降级包装：语义与 C02 注册表一致。
      const hooker = ports?.hooker ?? createInlineHooker();
      if (refs === undefined) return;

      // fetch：包装叠在当前引用之上；先转发（宿主异常继续冒泡），再记录。
      disposers.push(
        hooker.hook(refs, 'fetch', (original) => {
          return async (...args: readonly unknown[]): Promise<unknown> => {
            const { method, url } = readFetchArgs(args);
            const headers = traceHeadersFor({ url, method });
            const startedAt = now();
            const init = withTraceHeaders(args[1], headers);
            const callArgs: readonly unknown[] = init === undefined ? [args[0]] : [args[0], init];
            try {
              const response = await original(...callArgs);
              if (!disposed) record({ method, url }, { status: statusOf(response) }, now() - startedAt);
              return response;
            } catch (error) {
              if (!disposed) {
                record(
                  { method, url },
                  { status: 0, failureReason: classifyFailure(error) },
                  now() - startedAt,
                );
              }
              // 绝不吞宿主异常。
              throw error;
            }
          };
        }),
      );

      // XMLHttpRequest：用 Proxy 的 construct 陷阱包装构造器（不用 class）。
      const originalXhr = refs.XMLHttpRequest;
      if (originalXhr !== undefined && originalXhr !== null) {
        disposers.push(
          // eslint 语义同 fetch：包装叠在当前构造器之上。
          hooker.hook(refs, 'XMLHttpRequest', (original) => {
            const target = original as new (...args: readonly unknown[]) => XhrLike;
            return new Proxy(target, {
              construct: (ctor, ctorArgs: readonly unknown[]): object => {
                const instance = Reflect.construct<readonly unknown[], XhrLike>(ctor, ctorArgs);
                let method = 'GET';
                let url = '';
                let startedAt = now();
                const open = instance.open;
                instance.open = (nextMethod: string, nextUrl: string | URL, ...rest: readonly unknown[]): void => {
                  method = nextMethod.toUpperCase();
                  url = typeof nextUrl === 'string' ? nextUrl : nextUrl.toString();
                  startedAt = now();
                  open.call(instance, nextMethod, nextUrl, ...rest);
                };
                instance.addEventListener?.('loadend', () => {
                  if (disposed) return;
                  const status = typeof instance.status === 'number' ? instance.status : 0;
                  record({ method, url }, { status }, now() - startedAt);
                });
                return instance;
              },
            });
          }),
        );
      }
      // `context` 当前未用到：包装目标由注入的 refs/hooker 决定；此处显式消费以保持签名。
      unused(context);
    },
  };
}

/** 用注入端口创建一个 HTTP 采集实例（测试入口）。 */
export function createHttpCapture(sink: HttpSink, ports?: HttpPorts): HttpCapture {
  const state = createHttpState(sink, ports);
  state.attach();
  return state.capture;
}

/** 从内核安装上下文创建并安装 HTTP 采集（装配根使用）。 */
export function installHttpCapture(
  context: PluginContext,
  sink: HttpSink,
  ports?: HttpPorts,
): HttpCapture {
  const state = createHttpState(sink, ports);
  state.attach(context);
  return state.capture;
}

/** 创建 HTTP 采集插件。 */
export function createHttpPlugin(sink: HttpSink, ports?: HttpPorts): HttpPlugin {
  const state = createHttpState(sink, ports);
  return {
    id: HTTP_PLUGIN_ID,
    install(context: PluginContext): void {
      state.attach(context);
    },
    capture: state.capture,
  };
}

/**
 * 捕获原生 HTTP 引用容器；**由装配方在任何插件安装之前调用一次**（幂等、捕获后冻结）。
 *
 * 返回的是**宿主自身的容器**（`globalThis`），因此插件包装后宿主的调用会经过包装。
 * 没有可用 `fetch` 时返回 `undefined`（静默降级）。
 */
export function captureNativeHttpRefs(): NativeHttpRefs | undefined {
  const scope = globalThis as { fetch?: unknown; XMLHttpRequest?: unknown };
  if (typeof scope.fetch !== 'function') return undefined;
  return scope as NativeHttpRefs;
}
