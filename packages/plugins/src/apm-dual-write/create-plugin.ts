/**
 * C05-F5 第三方 APM 双写适配器（T19）。
 *
 * 约束（Q7、指南第 4.2 节与第 11 节）：
 * - **单向**：只把本 SDK 的事件按映射转发给注入的第三方接口，不从第三方读取数据；
 * - **不 import 任何第三方包**：第三方接口由接入方注入，本模块只依赖相对路径；
 * - 模块顶层无副作用（不注册监听、不访问 `window`），可被 SSR 与 Vitest 直接导入；
 * - 用函数式工厂与闭包组织代码，无 class；
 * - 第三方接口抛错或不存在时只计数 `processor_error`，不影响本 SDK 上报；
 * - **默认关闭**：只有宿主显式安装本插件（`applyPluginConfig`）后才转发。
 *
 * 本模块不依赖 `@web-report-sdk/core`：`ApmDualWriteContext` 是 C02 `PluginContext`
 * 的结构子集，`ApmDualWritePlugin` 因此可以直接交给 `kernel.registerPlugin`。
 */

/** 插件 id，与 `docs/contracts/schemas/remote-config.schema.json` 的 `pluginName` 枚举一致。 */
export const APM_DUAL_WRITE_PLUGIN_ID = 'apm_dual_write';

/** 转发计数能力名；T33 用它读取双写侧计数做对账（Q6）。 */
export const APM_DUAL_WRITE_STATS_CAPABILITY = 'apm_dual_write.stats';

/** 缺省字段映射：第三方字段名 → 本 SDK 事件字段路径（`dimensions.x` 取 dimensions 下的 x）。 */
export const DEFAULT_APM_FIELD_MAP: Readonly<Record<string, string>> = {
  event_name: 'event_name',
  event_type: 'event_type',
  occurred_at: 'occurred_at',
  event_id: 'event_id',
  priority: 'priority',
  page_id: 'page_id',
  url: 'url',
  dimensions: 'dimensions',
  metrics: 'metrics',
};

/** 缺省转发范围：只转发自定义事件（Q7 第 3 条）。 */
export const DEFAULT_APM_EVENT_TYPES: readonly string[] = ['custom'];

/**
 * 第三方接口抛错或不存在时的原因码。
 * 取值来自 `docs/contracts/reason-codes.md` 第 2 节（只计数），本适配器不新增原因码。
 */
const PROCESSOR_ERROR = 'processor_error';

/** 注入的第三方 APM 接口：接收按映射构造的记录，返回值忽略。 */
export type ApmForward = (record: Readonly<Record<string, unknown>>) => void;

/** 转发计数快照；`failed` 的每一次同时计数 `processor_error`。 */
export interface ApmDualWriteStats {
  /** 成功交给第三方接口的记录数（与 Q6 的「双写转发计数」一致）。 */
  readonly forwarded: number;
  /** 第三方接口抛错或不存在而被跳过的记录数。 */
  readonly failed: number;
  /** `event_type` 不在转发范围内而未转发的记录数。 */
  readonly skipped: number;
}

/** 映射配置与注入接口。 */
export interface ApmDualWriteOptions {
  /** 直接注入的第三方上报函数。 */
  readonly forward?: ApmForward | undefined;
  /** 惰性解析第三方上报函数；第三方 SDK 未加载时返回 `undefined`，记 `processor_error`（AC-16）。 */
  readonly resolve?: (() => ApmForward | undefined) | undefined;
  /** 目标字段名 → SDK 事件字段路径；缺省 `DEFAULT_APM_FIELD_MAP`。 */
  readonly fieldMap?: Readonly<Record<string, string>> | undefined;
  /** 每条记录都附加的固定字段（目标字段名 → 固定值）；映射结果优先于固定值。 */
  readonly constants?: Readonly<Record<string, unknown>> | undefined;
  /** 转发的 `event_type` 集合；缺省 `DEFAULT_APM_EVENT_TYPES`（仅 `custom`）。 */
  readonly eventTypes?: readonly string[] | undefined;
}

/** 事件形状：C02 `KernelEvent` 的结构子集。 */
export interface ApmDualWriteEvent {
  readonly event_name: string;
  readonly priority: 'normal' | 'critical';
  readonly occurred_at: number;
  [field: string]: unknown;
}

/** 安装上下文：C02 `PluginContext` 的结构子集，只声明适配器用到的三个成员。 */
export interface ApmDualWriteContext {
  readonly counters: { count(reason: string, delta?: number): void };
  addProcessor(
    stage: 'before_send',
    processor: (event: ApmDualWriteEvent) => ApmDualWriteEvent,
    options?: { readonly id?: string | undefined },
  ): () => void;
  registerCapability(name: string, value: unknown): () => void;
}

/** 插件定义：可直接交给 C02 插件宿主注册（`kernel.registerPlugin`）。 */
export interface ApmDualWritePlugin {
  readonly id: string;
  readonly install: (context: ApmDualWriteContext) => void;
  /** 转发计数快照；与能力 `apm_dual_write.stats` 同源。 */
  stats(): ApmDualWriteStats;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** 按 `a.b.c` 路径读取字段；任一段缺失返回 `undefined`。 */
function readPath(event: ApmDualWriteEvent, path: string): unknown {
  let current: unknown = event;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** 按映射构造一条第三方记录；取值缺失的目标字段不写入。 */
function buildRecord(
  event: ApmDualWriteEvent,
  fieldMap: Readonly<Record<string, string>>,
  constants: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...constants };
  for (const [target, path] of Object.entries(fieldMap)) {
    const value = readPath(event, path);
    if (value !== undefined) record[target] = value;
  }
  return record;
}

/**
 * 创建第三方 APM 双写适配器（C05-F5）。
 *
 * 默认关闭：`registerPlugin` 只登记定义，接入方要显式
 * `applyPluginConfig({ apm_dual_write: true })` 才安装并开始转发；
 * `applyPluginConfig({ apm_dual_write: false })` 卸载插件，宿主会自动注销
 * `before_send` 处理器与计数能力。
 */
export function createApmDualWritePlugin(options: ApmDualWriteOptions = {}): ApmDualWritePlugin {
  const fieldMap = options.fieldMap ?? DEFAULT_APM_FIELD_MAP;
  const constants = options.constants ?? {};
  const eventTypes = options.eventTypes ?? DEFAULT_APM_EVENT_TYPES;
  const direct = options.forward;
  const resolve = options.resolve;
  const stats = { forwarded: 0, failed: 0, skipped: 0 };

  return {
    id: APM_DUAL_WRITE_PLUGIN_ID,
    install(context: ApmDualWriteContext): void {
      context.addProcessor(
        'before_send',
        (event) => {
          const type = event.event_type;
          if (typeof type !== 'string' || !eventTypes.includes(type)) {
            stats.skipped += 1;
            return event;
          }
          const forward = direct ?? resolve?.();
          if (forward === undefined) {
            stats.failed += 1;
            context.counters.count(PROCESSOR_ERROR);
            return event;
          }
          try {
            forward(buildRecord(event, fieldMap, constants));
            stats.forwarded += 1;
          } catch {
            // 第三方接口抛错：吞掉异常并计数，本 SDK 的上报链路继续（AC-16）。
            stats.failed += 1;
            context.counters.count(PROCESSOR_ERROR);
          }
          return event;
        },
        { id: APM_DUAL_WRITE_PLUGIN_ID },
      );
      context.registerCapability(APM_DUAL_WRITE_STATS_CAPABILITY, stats);
    },
    stats: () => ({ ...stats }),
  };
}
