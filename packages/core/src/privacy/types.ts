/**
 * C04 的注入端口与对外类型（T14）。
 *
 * 设计要点：
 * - 本文件只声明类型，模块顶层无副作用。
 * - `BatchHeader` 用**结构类型**重复声明（不 import `@web-report-sdk/transport`）：
 *   core 对 transport 没有任何依赖，装配根在 T18 做结构赋值。字段逐条对齐
 *   `packages/transport/src/batch/types.ts` 的 `BatchHeader` 与
 *   `docs/contracts/schemas/batch.schema.json` 的批次头。
 * - 所有上限常量见 `constants.ts`；本文件不重复数值。
 */
import type { KernelEvent } from '../kernel';

/**
 * 同意状态（运行时）。区别于 `ConsentMode`（配置面）。
 *
 * 权威定义在 `api/types.ts`（公共 API 的一部分）；这里**再导出**，避免两个同名联合漂移。
 */
export type { ConsentState } from '../api/types';

/**
 * 生效的 `consent_mode`（配置面）。`full` 只能来自初始化参数（D002）。
 *
 * 权威定义在 C03 的 `config/types.ts`；这里**再导出**，避免出现两个同名联合
 * （公共 API 会因此产生 `ConsentMode$1` 这类重名符号）。
 */
export type { ConsentMode } from '../config/types';

/** 事件优先级（与内核一致）。 */
export type EventPriority = 'normal' | 'critical';

/** 用户标识（对外形态）。 */
export interface ContextUser {
  readonly id: string;
  /** 传入的 id 是否已经是哈希值。 */
  readonly hashed?: boolean | undefined;
}

/** 事件在**入队当时**绑定的上下文快照（C04-F1 / C04-F2）。 */
export interface ContextSnapshot {
  /** 路由模板或 `setPage` 的原样值；`undefined` 表示不写该字段。 */
  readonly page_id: string | undefined;
  /** 页面访问标识（UUID v4）。 */
  readonly view_id: string | undefined;
  /** 脱敏后的完整 URL。 */
  readonly url: string | undefined;
  /** 调用当时生效的自定义上下文（脱敏后的副本）。 */
  readonly context: Readonly<Record<string, string>> | undefined;
}

/** 脱敏规则（内置与远程追加的统一形态）。 */
export interface MaskRule {
  readonly name: string;
  /** 正则源字符串（远程追加时来自 `privacy.extra_mask_rules[].pattern`）。 */
  readonly pattern: string;
  /** 正则标志，只允许 `imsu`（远程 schema 的 `^[imsu]{0,4}$`）。 */
  readonly flags?: string | undefined;
  /** 命中后的替换串；缺省 `***`。 */
  readonly replacement?: string | undefined;
  /** 是否内置（内置规则不可删除、不可禁用）。 */
  readonly builtin: boolean;
}

/** 脱敏器：规则表在配置到达时预编译，`apply` 不再 `new RegExp`。 */
export interface Masker {
  /** 对一段文本依次应用全部规则（内置在前、追加在后）。 */
  apply(text: string): string;
  /** 编译成功并生效的规则条数（观测用）。 */
  ruleCount(): number;
}

/** 长度/数量上限（不可由配置放宽）。 */
export interface FieldLimits {
  readonly maxDimensionValueLength: number;
  readonly maxDimensionKeys: number;
  readonly maxContextKeys: number;
  readonly maxMetricKeys: number;
  readonly maxAttachmentBytes: number;
  readonly maxEventBodyBytes: number;
  readonly maxTruncatedPaths: number;
}

/** 调试输出端口（沿用 C01 的形态：只带原因码与字段路径，绝不带字段值）。 */
export type PrivacyDiagnosticsSink = (record: {
  readonly reason_code: string;
  readonly kind: string;
  readonly event_name?: string | undefined;
  readonly dropped: 'event' | 'field';
  readonly field?: string | undefined;
}) => void;

/** 字段约束处理器的创建选项。 */
export interface FieldConstraintsOptions {
  readonly limits: FieldLimits;
  /** 脱敏器（配置到达时预编译；处理器只做遍历）。 */
  readonly masker: Masker;
  /** 计数端口（内核 `Counters` 的结构子集）。 */
  readonly count: (reason: string, delta?: number) => void;
  /** 调试输出（可选；只写原因码与字段路径，绝不写字段值）。 */
  readonly diagnostics?: PrivacyDiagnosticsSink | undefined;
  /**
   * 约束函数的注入点（缺省用 `constrainEvent`）。
   *
   * 存在的理由：`event_too_large` 的**丢弃分支**在格式合法的输入下不可达（阶梯总能把事件压回
   * 16 KB 以内），因此需要可注入替身来验证「处理器在收到 dropped 结果时确实返回
   * `stopPipeline(event_too_large)` 并计数」这一契约行为。生产路径不使用该选项。
   */
  readonly constrain?: ((input: ConstrainInput) => ConstrainResult) | undefined;
}

/** 字段约束处理的输入。 */
export interface ConstrainInput {
  readonly event: KernelEvent;
  readonly limits: FieldLimits;
  readonly masker: Masker;
  /** 计数端口（内核 `Counters` 的结构子集）。 */
  readonly count: (reason: string, delta?: number) => void;
  /** 调试输出（可选；只写原因码与字段路径，绝不写字段值）。 */
  readonly diagnostics?: PrivacyDiagnosticsSink | undefined;
}

/** 字段约束处理的结果。 */
export interface ConstrainResult {
  /** 处理后的字段（就地或替换后的事件）。 */
  readonly event: KernelEvent;
  /** 整条事件是否应被丢弃（`event_too_large` 等）。 */
  readonly dropped: boolean;
  /** 导致丢弃的原因码；未丢弃时为 `undefined`。 */
  readonly dropReason: string | undefined;
}

/** 同意驱动的事件出口（缓冲后的补发路径）。 */
export type ConsentEmit = (event: KernelEvent) => void;
