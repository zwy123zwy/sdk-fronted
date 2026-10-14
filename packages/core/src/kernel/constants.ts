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

/** 预启动队列条数上限（契约：超过 500 条淘汰最早的 normal 事件）。 */
export const PRESTART_QUEUE_CAPACITY = 500;

/**
 * 预启动队列的**体积上限**：256 KB（T11 非功能目标「预启动队列内存不超过 256 KB」）。
 *
 * 为什么需要字节上限：T20 基准实测「生产上界形态」事件（含 200 字符长值与一处伪造 PII）
 * 每条约 650 B，500 条 = **317 KB > 256 KB**（超 24%）。256 KB / 500 条隐含平均 ≤ 524 B/条，
 * 而 C04 允许单个字符串值到 256 字符（`MAX_DIMENSION_VALUE_LENGTH`，即单值 512 B）——
 * **计条数无法约束字节**，因此在条数上限之外再按字节配额淘汰（两个上限同时生效）。
 *
 * 与 C06 内存队列 `QUEUE_MAX_BYTES = 512 KB` 数值不同的理由：
 * - 两个数字各自来自自己的任务卡：C02/T11 是 **256 KB**，C06/T15 是 **512 KB**；
 * - 预启动队列只覆盖「配置就绪前」这个短暂窗口，且其中的事件**尚未经过 C04 校验/截断**
 *   （是唯一可能暂存原始超长载荷的地方），按 256 KB 收紧是保守方向；
 * - 把两个数字统一会改动契约目标或 C06 默认值，不属于本次修复的授权范围，故保持各自数值。
 *
 * 体积口径：事件的 JSON 码元数（`event-standard.md` 第 4 节；V8 对 Latin-1 字符串按
 * 1 B/码元存储，因此也是内存的良好近似），见 `measureEventBytes`。
 */
export const PRESTART_QUEUE_MAX_BYTES = 256 * 1024;

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
