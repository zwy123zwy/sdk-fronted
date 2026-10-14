/**
 * C05-F3 自动路由插件。
 *
 * 裁定（T18-plan §3 与 §6）：
 * - AC-08/09 要求自动上报，所以提供**可卸载**的自动路由插件
 *   （包装 `history.pushState`/`replaceState` + 监听 `popstate`/`hashchange`）；
 * - **包装叠加规则**（§6，依 Q7 第 16 行）：安装时保存**当前**引用并叠在其上，包装内先调用保存的那一层；
 *   卸载时**仅当当前值仍是自己的包装**才还原（否则会误删第三方 hook）；
 * - **不改变**原生方法的签名、返回值与 `this` 绑定；**不吞**宿主抛出的异常；
 * - 自动路由**默认开启**；关闭（`mode: 'manual'`）后 `setPage` 仍可用。
 *
 * 分工：本模块只负责**在路由变化时发出通知**（`RouteChange.path`/`template`/`via`）；
 * `page_id`/`view_id` 的计算与生命周期归 C04。
 */
import type { Plugin, PluginContext } from '@web-report-sdk/core';

import { createInlineHooker } from '../internal/hooker';
import type { Hooker } from '../internal/hooker';
import { createMatcher, stripQuery } from './match';
import type {
  HistoryPort,
  RouteChange,
  RouteMode,
  RoutePluginOptions,
  RouteSource,
  RouteSurface,
} from './types';

/** 插件 id，与 `remote-config.schema.json` 的 `pluginName` 枚举一致。 */
export const ROUTE_PLUGIN_ID = 'route';

/** 路由变化监听器。 */
export type RouteListener = (change: RouteChange) => void;

/** 兼容旧名：包装端口（见 `internal/hooker.ts`）。 */
export type RouteHooker = Hooker;

/** 创建路由采集所需的注入端口。 */
export interface RoutePorts {
  /** 注入的裸 `history`（装配方在插件安装前捕获；测试注入伪造对象）。 */
  readonly history?: HistoryPort | undefined;
  /** 注入的全局注册表（内核的 `context.registry`）。 */
  readonly hooker?: Hooker | undefined;
  /**
   * 订阅原生事件（`popstate` / `hashchange`）；返回注销函数。
   * 缺省实现由装配根用内核 `context.listen` 提供。
   */
  readonly listen?: ((type: string, handler: () => void) => () => void) | undefined;
  /** 当前 URL 读取（缺省读 `location`）。 */
  readonly currentUrl?: (() => { readonly pathname: string; readonly hash: string }) | undefined;
  /** 当前时间源；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined;
  /** 路由模式与模板配置。 */
  readonly options?: RoutePluginOptions | undefined;
}

/** 自动路由的运行端口。 */
export interface RouteCapture {
  /** 当前生效的路由模式。 */
  readonly mode: RouteMode;
  /** 订阅路由变化；返回注销函数，可安全重复调用。 */
  onRouteChange(listener: RouteListener): () => void;
  /** 手动路径：通知"路由已变"（并存模式与降级用）。 */
  setPage(path: string): void;
  /** 读数：已通知次数、按来源拆分。 */
  stats(): { readonly changes: number; readonly bySource: Readonly<Record<RouteSource, number>> };
  /** 卸载：恢复自己装上的那一层、移除监听；幂等。 */
  uninstall(): void;
}

/** 自动路由插件定义：可直接交给 `kernel.registerPlugin`。 */
export interface RoutePlugin extends Plugin {
  readonly id: typeof ROUTE_PLUGIN_ID;
  readonly capture: RouteCapture;
}

/** 本地读取当前 URL（无注入时用；SSR 下返回空路径）。 */
function defaultCurrentUrl(): { readonly pathname: string; readonly hash: string } {
  if (typeof location === 'undefined') return { pathname: '', hash: '' };
  return { pathname: location.pathname, hash: location.hash };
}

/** 采集状态。 */
interface RouteState {
  readonly capture: RouteCapture;
  attach(context?: PluginContext): void;
}

/** 创建路由采集状态。 */
function createRouteState(ports?: RoutePorts): RouteState {
  const options = ports?.options;
  const mode: RouteMode = options?.mode ?? 'history';
  const matcher = createMatcher(options?.templates ?? []);
  const now = ports?.now ?? ((): number => Date.now());
  const currentUrl = ports?.currentUrl ?? defaultCurrentUrl;
  const listeners = new Set<RouteListener>();
  const disposers: (() => void)[] = [];
  const bySource: Record<RouteSource, number> = { push: 0, replace: 0, pop: 0, hash: 0, manual: 0 };
  let changes = 0;
  let disposed = false;

  /** 取当前路径：history 模式用 pathname，hash 模式用 `#` 之后的片段。 */
  const readPath = (): string => {
    const url = currentUrl();
    if (mode === 'hash') return stripQuery(url.hash.replace(/^#/, ''));
    return stripQuery(url.pathname);
  };

  const notify = (via: RouteSource, path?: string): void => {
    if (disposed) return;
    const target = path ?? readPath();
    const change: RouteChange = { path: target, template: matcher(target), via, at: now() };
    changes += 1;
    bySource[via] += 1;
    for (const listener of [...listeners]) listener(change);
  };

  const capture: RouteCapture = {
    mode,
    onRouteChange(listener: RouteListener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    setPage(path: string): void {
      // 手动路径：只负责"通知路由已变"，页面归属仍由 C04 计算。
      notify('manual', stripQuery(path));
    },
    stats(): {
      readonly changes: number;
      readonly bySource: Readonly<Record<RouteSource, number>>;
    } {
      return { changes, bySource: { ...bySource } };
    },
    uninstall(): void {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
      listeners.clear();
    },
  };

  /** 在 history 模式下包装两个方法；包装先调用保存的那一层，再通知。 */
  const hookHistory = (hooker: Hooker, history: HistoryPort): void => {
    // 用**函数属性**而非方法调用，避免 `this` 丢失；同时把 `this` 原样转发给保存的那一层。
    const wrap = (method: 'pushState' | 'replaceState', via: RouteSource): void => {
      disposers.push(
        hooker.hook(history, method, (original) => {
          return (data: unknown, unused: string, url?: string | URL | null): void => {
            // 先转发（宿主抛出的异常必须继续冒泡，不得被包装吞掉）。
            if (url === undefined) original.call(history, data, unused);
            else original.call(history, data, unused, url);
            notify(via);
          };
        }),
      );
    };
    wrap('pushState', 'push');
    wrap('replaceState', 'replace');
  };

  return {
    capture,
    attach(context?: PluginContext): void {
      if (disposed) return;
      const listen =
        ports?.listen ??
        (context === undefined
          ? undefined
          : (type: string, handler: () => void): (() => void) =>
              context.listen(type, () => {
                handler();
              }));

      if (mode === 'manual') {
        // 手动模式：不包装、不监听，只在业务调用 setPage 时通知（AC-09）。
        return;
      }
      if (mode === 'hash') {
        if (listen !== undefined) {
          disposers.push(
            listen('hashchange', () => {
              notify('hash');
            }),
          );
        }
        return;
      }
      // history 模式
      const history = ports?.history;
      // 没有注入注册表（无内核上下文）时用内存实现降级包装：语义与 C02 注册表一致。
      const hooker = ports?.hooker ?? createInlineHooker();
      if (history !== undefined) hookHistory(hooker, history);
      if (listen !== undefined) {
        disposers.push(
          listen('popstate', () => {
            notify('pop');
          }),
        );
      }
    },
  };
}

/** 用注入端口创建一个自动路由实例（测试入口）。 */
export function createRouteCapture(ports?: RoutePorts): RouteCapture {
  const state = createRouteState(ports);
  state.attach();
  return state.capture;
}

/** 从内核安装上下文创建并安装自动路由（装配根使用）。 */
export function installRouteCapture(context: PluginContext, ports?: RoutePorts): RouteCapture {
  const state = createRouteState(ports);
  state.attach(context);
  return state.capture;
}

/** 创建自动路由插件。 */
export function createRoutePlugin(ports?: RoutePorts): RoutePlugin {
  const state = createRouteState(ports);
  return {
    id: ROUTE_PLUGIN_ID,
    install(context: PluginContext): void {
      state.attach(context);
    },
    capture: state.capture,
  };
}

/**
 * 捕获路由原始引用；**必须在任何插件安装之前调用一次**（幂等、捕获后冻结）。
 *
 * M1 起由装配根调用；此处返回宿主 `history` 的形状子集，无 `history` 时返回 `undefined`。
 */
export function captureNativeHistoryRefs(): RouteSurface | undefined {
  if (typeof history === 'undefined') return undefined;
  const surface: RouteSurface = { history };
  return Object.freeze(surface);
}
