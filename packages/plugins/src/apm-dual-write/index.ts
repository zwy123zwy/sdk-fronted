/**
 * C05-F5 第三方 APM 双写适配器（T19）的公共入口。
 * 只从 `packages/plugins/src/index.ts` 对外暴露；模块顶层无副作用。
 */
export {
  APM_DUAL_WRITE_PLUGIN_ID,
  APM_DUAL_WRITE_STATS_CAPABILITY,
  DEFAULT_APM_EVENT_TYPES,
  DEFAULT_APM_FIELD_MAP,
  createApmDualWritePlugin,
} from './create-plugin';
export type {
  ApmDualWriteContext,
  ApmDualWriteEvent,
  ApmDualWriteOptions,
  ApmDualWritePlugin,
  ApmDualWriteStats,
  ApmForward,
} from './create-plugin';
