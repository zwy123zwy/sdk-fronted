/**
 * C05-F1 错误采集插件。
 *
 * 采集源（T18-plan §1）：
 * - `error` 事件（未捕获异常；资源加载错误为可选扩展，默认关闭），AC-01，`source = window_error`；
 * - `unhandledrejection`（AC-02，`source = unhandled_rejection`，Error 对象与字符串两种拒绝值都归一化）。
 *
 * 装配约束：
 * - 插件只依赖 C02 `PluginContext`（原生监听与定时器由内核注册表统一回收，卸载即归零）；
 * - 采集回调做最小工作，归一化与序列化延后到窗口结算；
 * - 脱敏由 C04 负责，本插件不重复实现，也不在脱敏前落地/缓存；
 * - **面包屑**固定 20 条、不开放配置，且绝不记录输入框内容（AC-04）。
 */
import type { Plugin, PluginContext } from '@web-report-sdk/core';

import { createBreadcrumbBuffer, encodeBreadcrumbs } from './breadcrumbs';
import type { BreadcrumbBuffer } from './breadcrumbs';
import { DEFAULT_DEDUP_WINDOW_MS, createDeduplicator } from './dedup';
import { normalizeError } from './stack';
import {
  ERROR_TYPE_EXCEPTION,
  ERROR_TYPE_RESOURCE,
  ERROR_TYPE_UNHANDLED_REJECTION,
  JS_ERROR_EVENT_NAME,
  SOURCE_UNHANDLED_REJECTION,
  SOURCE_WINDOW_ERROR,
} from './types';
import type { Breadcrumb, JsErrorEvent } from './types';

/** 插件 id，与 `remote-config.schema.json` 的 `pluginName` 枚举一致。 */
export const ERROR_PLUGIN_ID = 'error';

/** C02 原因码：同指纹被折叠（`docs/contracts/reason-codes.md` 第 27 行，归属 C02/C05）。 */
const FILTERED_BY_PLUGIN = 'filtered_by_plugin';

/** 插件配置；全部字段可选，缺省值见 `DEFAULT_ERROR_PLUGIN_OPTIONS`。 */
export interface ErrorPluginOptions {
  /** 是否采集资源加载错误（默认 `false`；AC-01 只覆盖未捕获异常）。 */
  readonly captureResourceErrors?: boolean | undefined;
  /** 同一指纹的重复错误是否也在窗口结算时逐条上报（默认 `false`：窗口内只上报一条）。 */
  readonly reportRepeats?: boolean | undefined;
  /** 参与归一化的采集源；缺省全部内置源。 */
  readonly sources?: readonly string[] | undefined;
  /** 当前时间源；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  /** 聚合窗口长度（毫秒）；缺省 `DEFAULT_DEDUP_WINDOW_MS`（1000，与 AC-03 的「1 秒内」一致）。 */
  readonly windowMs?: number | undefined;
  /**
   * 读取 C04 的全局自定义上下文，用于与面包屑**合并**后写入事件 `context`。
   *
   * 为什么需要这个端口：C04 的 `enrich` 采用「入队快照优先」——事件已带 `context`
   * 时不再补全局上下文。面包屑必须占用 `context`（契约没有专属字段），
   * 若不合并，错误事件会**丢掉接入方的全局上下文**。未注入该端口时只写面包屑。
   */
  readonly globalContext?: (() => Readonly<Record<string, string>> | undefined) | undefined;
  /**
   * 「页面离开」生命周期的注入端口（`pagehide` / 隐藏）。
   *
   * 为什么必须有：聚合窗口最多把错误事件延迟 1 个窗口（≤1s），而"错误刚好发生在
   * 离开前"正是最需要它的场景；`flush()`/`uninstall()` 在页面被关闭或隐藏时都不保证被调用。
   * 注入该端口后，窗口会在页面离开路径上结算；未注入时由 `attach` 用
   * `pagehide` + `visibilitychange(hidden)` 兜底（同一内核监听注册表管理）。
   */
  readonly onLeave?: ((callback: () => void) => () => void) | undefined;
}

/** 归一化后的错误事件回调（装配根接内核的 `kernel.report`）。 */
export type JsErrorSink = (event: JsErrorEvent) => void;

/** 错误采集插件的运行端口：宿主可显式驱动与检查，测试无需真实 `window`。 */
export interface ErrorCapture {
  /** 手动上报一条错误（也是公共 API `captureError` 的落点）。 */
  capture(error: unknown, options?: { readonly source?: string | undefined }): void;
  /** 处理一次 `error` 事件形状的入参；返回是否阻止默认处理（始终 `false`，不吞宿主行为）。 */
  handleWindowError(message: string, line?: number, column?: number, error?: unknown): boolean;
  /** 处理一次 `unhandledrejection` 的拒绝值。 */
  handleRejection(reason: unknown): void;
  /** 立即结算全部未到期的聚合窗口（页面隐藏/装配根冲刷时调用，避免丢数据）。 */
  flush(): void;
  /** 当前面包屑缓冲（错误事件组装时读取）。 */
  breadcrumbs(): BreadcrumbBuffer;
  /** 读数：已上报事件数与已折叠的重复条数；供自检与用例断言。 */
  stats(): { readonly reported: number; readonly collapsed: number };
  /** 卸载：先结算未到期窗口，再移除监听与定时器；重复调用幂等。 */
  uninstall(): void;
}

/** 采集插件定义：可直接交给 `kernel.registerPlugin`。 */
export interface ErrorCapturePlugin extends Plugin {
  readonly id: typeof ERROR_PLUGIN_ID;
  /** 运行端口；`install` 会把监听接到同一实例上。 */
  readonly capture: ErrorCapture;
}

/** 缺省配置。 */
export const DEFAULT_ERROR_PLUGIN_OPTIONS: Required<
  Omit<ErrorPluginOptions, 'sources' | 'now' | 'windowMs' | 'globalContext' | 'onLeave'>
> = {
  captureResourceErrors: false,
  reportRepeats: false,
};

/** 从任意拒绝值/错误值里取出名字、消息与栈（尽量不抛错）。 */
function readErrorShape(error: unknown): {
  errorType: string;
  message: string;
  stack?: string | undefined;
} {
  if (error instanceof Error) {
    const errorType = error.name === '' ? ERROR_TYPE_EXCEPTION : error.name;
    const stack = error.stack;
    return stack === undefined || stack === ''
      ? { errorType, message: error.message }
      : { errorType, message: error.message, stack };
  }
  if (typeof error === 'string') {
    return { errorType: ERROR_TYPE_UNHANDLED_REJECTION, message: error };
  }
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return { errorType: ERROR_TYPE_UNHANDLED_REJECTION, message: String(error) };
  }
  if (error === null || error === undefined) {
    return { errorType: ERROR_TYPE_EXCEPTION, message: 'UnknownError' };
  }
  const maybe = error as { readonly message?: unknown };
  const message =
    typeof maybe.message === 'string' && maybe.message !== '' ? maybe.message : 'UnknownError';
  return { errorType: ERROR_TYPE_UNHANDLED_REJECTION, message };
}

/** 归一化事件的内部输入（窗口结算时使用）。 */
interface ReportInput {
  readonly message: string;
  readonly source: string;
  readonly errorType: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly stack?: string | undefined;
}

/** 创建采集状态与端口（`install` 只负责把监听与窗口定时器接上去）。 */
function createCapture(
  sink: JsErrorSink,
  options?: ErrorPluginOptions,
): { capture: ErrorCapture; attach(context: PluginContext): void } {
  const now = options?.now ?? ((): number => Date.now());
  const windowMs = options?.windowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const breadcrumbs = createBreadcrumbBuffer(now);
  const dedup = createDeduplicator<ReportInput>({ windowMs });
  const disposers: (() => void)[] = [];
  let reported = 0;
  let collapsed = 0;
  // `attach` 时从内核拿到 counters；直接调用 handler 时也要计数 `filtered_by_plugin`。
  let counters: PluginContext['counters'] | undefined;

  /** 把一条已结算的窗口组装成事件并上报（归一化与序列化在此发生，采集回调保持轻量）。 */
  const emit = (payload: ReportInput, count: number): void => {
    const fields = normalizeError({
      message: payload.message,
      source: payload.source,
      errorType: payload.errorType,
      ...(payload.line === undefined ? {} : { line: payload.line }),
      ...(payload.column === undefined ? {} : { column: payload.column }),
      ...(payload.stack === undefined ? {} : { stack: payload.stack }),
    });
    const globalContext = options?.globalContext?.();
    const context = { ...(globalContext ?? {}), ...encodeBreadcrumbs(breadcrumbs.snapshot()) };
    const event: JsErrorEvent = {
      event_name: JS_ERROR_EVENT_NAME,
      priority: 'normal',
      occurred_at: now(),
      dimensions: fields.dimensions,
      metrics: {
        count,
        ...(fields.metrics.line === undefined ? {} : { line: fields.metrics.line }),
        ...(fields.metrics.column === undefined ? {} : { column: fields.metrics.column }),
      },
      ...(fields.attachment === undefined ? {} : { attachment: fields.attachment }),
      ...(Object.keys(context).length === 0 ? {} : { context }),
    };
    reported += 1;
    sink(event);
  };

  /** 结算到期窗口。 */
  const flushDue = (): void => {
    for (const fingerprint of dedup.due(now())) {
      const settled = dedup.take(fingerprint);
      if (settled !== undefined) emit(settled.payload, settled.count);
    }
  };

  /** 观察一条错误：窗口内首条开启窗口；重复只累计并计数 `filtered_by_plugin`。 */
  const observe = (input: ReportInput): void => {
    const fingerprint = normalizeError({
      message: input.message,
      source: input.source,
      errorType: input.errorType,
      ...(input.line === undefined ? {} : { line: input.line }),
      ...(input.column === undefined ? {} : { column: input.column }),
    }).dimensions.fingerprint;
    const observation = dedup.observe(fingerprint, input, now());
    if (!observation.started) {
      collapsed += 1;
      counters?.count(FILTERED_BY_PLUGIN);
    }
  };

  const capture: ErrorCapture = {
    capture(error: unknown, captureOptions?: { readonly source?: string | undefined }): void {
      const shape = readErrorShape(error);
      observe({
        message: shape.message,
        source: captureOptions?.source ?? SOURCE_WINDOW_ERROR,
        errorType: shape.errorType,
        ...(shape.stack === undefined ? {} : { stack: shape.stack }),
      });
    },
    handleWindowError(message: string, line?: number, column?: number, error?: unknown): boolean {
      const shape = readErrorShape(error);
      observe({
        message: message === '' ? shape.message : message,
        source: SOURCE_WINDOW_ERROR,
        errorType: shape.errorType,
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
        ...(shape.stack === undefined ? {} : { stack: shape.stack }),
      });
      // 永不阻止宿主默认处理。
      return false;
    },
    handleRejection(reason: unknown): void {
      const shape = readErrorShape(reason);
      observe({
        message: shape.message,
        source: SOURCE_UNHANDLED_REJECTION,
        errorType:
          reason instanceof Error && shape.errorType !== ERROR_TYPE_EXCEPTION
            ? shape.errorType
            : ERROR_TYPE_UNHANDLED_REJECTION,
        ...(shape.stack === undefined ? {} : { stack: shape.stack }),
      });
    },
    flush(): void {
      for (const settled of dedup.takeAll()) emit(settled.payload, settled.count);
    },
    breadcrumbs(): BreadcrumbBuffer {
      return breadcrumbs;
    },
    stats(): { readonly reported: number; readonly collapsed: number } {
      return { reported, collapsed };
    },
    uninstall(): void {
      // 先结算未到期窗口：卸载不得丢已采集的错误。
      capture.flush();
      for (const dispose of disposers.splice(0)) dispose();
    },
  };

  return {
    capture,
    attach(context: PluginContext): void {
      counters = context.counters;
      const captureResourceErrors = options?.captureResourceErrors === true;
      disposers.push(
        context.listen('error', (event: Event): void => {
          const target = event.target;
          // 资源加载错误：`error` 在资源元素上触发（可选，默认关闭）。
          if (captureResourceErrors && target !== null && 'tagName' in target) {
            const tag = (target as Element).tagName.toLowerCase();
            if (tag !== '' && tag !== 'window' && tag !== 'body') {
              observe({
                message: `resource error: ${tag}`,
                source: SOURCE_WINDOW_ERROR,
                errorType: ERROR_TYPE_RESOURCE,
              });
              return;
            }
          }
          const detail = event as Event & {
            readonly message?: unknown;
            readonly lineno?: unknown;
            readonly colno?: unknown;
            readonly error?: unknown;
          };
          const message = typeof detail.message === 'string' ? detail.message : '';
          const line = typeof detail.lineno === 'number' ? detail.lineno : undefined;
          const column = typeof detail.colno === 'number' ? detail.colno : undefined;
          const shape = readErrorShape(detail.error);
          observe({
            message: message === '' ? shape.message : message,
            source: SOURCE_WINDOW_ERROR,
            errorType: shape.errorType,
            ...(line === undefined ? {} : { line }),
            ...(column === undefined ? {} : { column }),
            ...(shape.stack === undefined ? {} : { stack: shape.stack }),
          });
        }),
      );
      disposers.push(
        context.listen('unhandledrejection', (event: Event): void => {
          const detail = event as Event & { readonly reason?: unknown };
          const shape = readErrorShape(detail.reason);
          observe({
            message: shape.message,
            source: SOURCE_UNHANDLED_REJECTION,
            errorType: ERROR_TYPE_UNHANDLED_REJECTION,
            ...(shape.stack === undefined ? {} : { stack: shape.stack }),
          });
        }),
      );
      // 行为面包屑：点击只记元素标识（绝不读 value）。
      disposers.push(
        context.listen('click', (event: Event): void => {
          const target = event.target;
          if (target === null || !('tagName' in target)) return;
          breadcrumbs.push(target as Element, 'click');
        }),
      );
      // 窗口定时结算：由内核注册表管理，卸载时一并回收。
      disposers.push(context.scheduleRepeat(flushDue, windowMs));
      // 页面离开路径上也要结算（否则"离开前发生的错误"会随窗口一起丢掉）。
      const settleOnLeave = (): void => {
        capture.flush();
      };
      if (options?.onLeave !== undefined) {
        disposers.push(options.onLeave(settleOnLeave));
      } else {
        disposers.push(context.listen('pagehide', settleOnLeave));
        disposers.push(
          context.listen('visibilitychange', (): void => {
            const visibility =
              typeof document === 'undefined' ? undefined : document.visibilityState;
            if (visibility === 'hidden') settleOnLeave();
          }),
        );
      }
    },
  };
}

/**
 * 创建错误采集插件。
 *
 * @param sink 归一化后的事件出口（装配根接 `kernel.report`）。
 * @param options 见 `ErrorPluginOptions`。
 */
export function createErrorPlugin(
  sink: JsErrorSink,
  options?: ErrorPluginOptions,
): ErrorCapturePlugin {
  const state = createCapture(sink, options);
  return {
    id: ERROR_PLUGIN_ID,
    install(context: PluginContext): void {
      state.attach(context);
    },
    capture: state.capture,
  };
}

/** 从内核安装上下文创建并安装错误采集（装配根使用）。 */
export function installErrorCapture(
  context: PluginContext,
  sink: JsErrorSink,
  options?: ErrorPluginOptions,
): ErrorCapture {
  const state = createCapture(sink, options);
  state.attach(context);
  return state.capture;
}

/** 供测试断言使用的面包屑形状再导出（避免测试直接依赖 `types` 深路径）。 */
export type { Breadcrumb };
