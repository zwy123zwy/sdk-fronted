/**
 * 内核常量与原因码（C02）。
 *
 * 原因码取自 `docs/contracts/reason-codes.md`（0.2，已冻结），内核只负责计数，
 * `drop_` / `count_` 前缀由 C08 聚合 `sdk_health` 时添加。
 */

/** 六段处理管线的固定顺序：校验 → 富化 → 过滤 → 采样 → 构建 → 发送前。 */
export const PIPELINE_STAGES = [
  'validate',
  'enrich',
  'filter',
  'sample',
  'build',
  'before_send',
] as const;

/** 管线段标识。 */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** 预启动队列上限（契约：超过 500 条淘汰最早的 normal 事件）。 */
export const PRESTART_QUEUE_CAPACITY = 500;

/** 内核负责的原因码。 */
export const REASON_CODES = {
  /** 处理器抛错，跳过该处理器，事件继续（只计数）。 */
  processorError: 'processor_error',
  /** 预启动队列溢出，淘汰最早的 normal 事件（丢弃）。 */
  prestartQueueOverflow: 'prestart_queue_overflow',
  /** 插件依赖的插件不存在，该插件不安装（丢弃）。 */
  pluginDependencyMissing: 'plugin_dependency_missing',
  /** 插件安装函数抛错，该插件不安装（丢弃）。 */
  pluginInstallFailed: 'plugin_install_failed',
  /** 插件过滤规则命中，事件不进入后续段（丢弃）。 */
  filteredByPlugin: 'filtered_by_plugin',
  /** SDK 销毁后仍有调用（丢弃）。 */
  destroyed: 'destroyed',
} as const;

/** 内核原因码取值。 */
export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];
