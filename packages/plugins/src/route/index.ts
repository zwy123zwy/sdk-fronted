/**
 * C05-F3 路由插件（错误、性能、路由、HTTP 四入口之一）。
 */
export { PAGEVIEW_EVENT_NAME } from './types';
export type {
  HistoryPort,
  RouteChange,
  RouteMode,
  RoutePluginOptions,
  RouteSource,
  RouteSurface,
  RouteTemplateMatcher,
} from './types';
export { createMatcher, matchTemplate, stripQuery } from './match';
export {
  ROUTE_PLUGIN_ID,
  captureNativeHistoryRefs,
  createRouteCapture,
  createRoutePlugin,
  installRouteCapture,
} from './plugin';
export type {
  RouteCapture,
  RouteHooker,
  RouteListener,
  RoutePlugin,
  RoutePorts,
} from './plugin';
