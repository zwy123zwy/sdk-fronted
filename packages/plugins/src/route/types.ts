/**
 * C05-F3 路由与页面浏览的类型契约（M1 接口桩）。
 *
 * 裁定（T18-plan §3）：**按 AC-08/09 做自动路由**——提供**可卸载**的自动路由插件
 * （包装 `history.pushState`/`replaceState` + 监听 `popstate`/`hashchange`），
 * 并在 `uninstall()` 中**恢复原生方法**（保存原引用、成对恢复，重复卸载幂等）。
 *
 * 分工：本模块只负责**在路由变化时发出通知**；页面归属的计算与
 * `page_id`/`view_id` 的生命周期归 C04（`packages/core/src/context/page.ts`）。
 * 因此本模块的通知载荷用 `path`（路由模板）+ `via`（变化来源），
 * 由装配根交给 C04 计算 `page_id`，本模块不自行生成 `page_id`。
 */

/** 页面浏览事件名（AC-08/AC-09）。 */
export const PAGEVIEW_EVENT_NAME = 'web_pageview';

/** 路由变化来源：`pushState` / `replaceState` / 后退或前进 / hash 变化 / 手动调用。 */
export type RouteSource = 'push' | 'replace' | 'pop' | 'hash' | 'manual';

/** 路由模式。 */
export type RouteMode = 'history' | 'hash' | 'manual';

/** 一次路由变化的通知载荷。 */
export interface RouteChange {
  /** 变化后的路径（history 模式为 pathname，hash 模式为 `#` 后的片段）。 */
  readonly path: string;
  /** 匹配到的路由模板（如 `/task/:id`）；未配置模板时等于去掉查询参数的路径。 */
  readonly template: string;
  readonly via: RouteSource;
  /** 采集时刻（毫秒时间戳）。 */
  readonly at: number;
}

/** 路由模板匹配：`/task/123` → `/task/:id`。 */
export type RouteTemplateMatcher = (path: string) => string;

/** 路由模式与模板配置。 */
export interface RoutePluginOptions {
  /** 路由模式；缺省 `history`（AC-08 的默认场景）。 */
  readonly mode?: RouteMode | undefined;
  /** 路由模板清单（按顺序匹配，首个命中生效）；缺省回落到去查询参数的路径。 */
  readonly templates?: readonly string[] | undefined;
  /** 自定义模板匹配器；未提供时按 `templates` 的首段字面量匹配。 */
  readonly match?: RouteTemplateMatcher | undefined;
}

/**
 * 最小化的 `history` 端口：只声明被包装的两个方法。
 * 用结构子集而非 DOM 的 `History`，便于测试注入伪造对象并断言恢复行为。
 */
export interface HistoryPort {
  pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
}

/** 原生方法的引用容器：装配方在**任何插件安装之前**捕获一次并冻结。 */
export interface RouteSurface {
  readonly history: HistoryPort;
}
