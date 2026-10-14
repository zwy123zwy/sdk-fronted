/**
 * 采集插件包（C05）：内置采集插件（T18）与第三方 APM 双写适配器（T19）。
 *
 * 说明：这里不放包级文档标签。tsup 打包入口 DTS 时会把入口自己的注释排到文件末尾，
 * API Extractor 因此报「package documentation 标签位置错误」（与 `packages/core/src/index.ts`
 * 的处理方式一致）。本模块顶层无副作用：不注册原生监听、不访问 `window`。
 *
 * C05-AC-13 的按需引入走子路径导出：`@web-report-sdk/plugins/error`、`/perf`、`/route`、`/http`。
 * 本全量入口另行聚合；`src/contract/**` 只含契约自证的测试用件，**不导出**。
 */

/** 包名，用于自监控事件的维度。 */
export const PACKAGE_NAME = '@web-report-sdk/plugins';

// C05-F1 错误采集（T18，错误、性能、路由、HTTP 四入口之一）。
export * from './error';
// C05-F2 性能条目与长任务（T18）。
export * from './perf';
// C05-F3 路由与页面浏览（T18）。
export * from './route';
// C05-F4 HTTP 采集（T18）。
export * from './http';
// C05 / Q7 与第三方 APM 共存（T18）。
export * from './coexist';

// C05-F5 第三方 APM 双写适配器（T19）。默认关闭，由 applyPluginConfig 显式开启。
export {
  APM_DUAL_WRITE_PLUGIN_ID,
  APM_DUAL_WRITE_STATS_CAPABILITY,
  DEFAULT_APM_EVENT_TYPES,
  DEFAULT_APM_FIELD_MAP,
  createApmDualWritePlugin,
} from './apm-dual-write';
export type {
  ApmDualWriteContext,
  ApmDualWriteEvent,
  ApmDualWriteOptions,
  ApmDualWritePlugin,
  ApmDualWriteStats,
  ApmForward,
} from './apm-dual-write';
