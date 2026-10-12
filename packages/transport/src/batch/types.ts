/**
 * C06 批次组装使用的契约类型（对齐 `docs/contracts/schemas/batch.schema.json` 0.2 与
 * `docs/contracts/event-standard.md` 第 3 节）。
 *
 * 这里只用结构类型，不 import 其他包，保证 transport 包（C06–C08）零运行时依赖，
 * 也保证 `packages/core`（C01–C04）尚未验收时本包可以独立开发与测试。
 */

/** 事件优先级；critical 事件不会被内存队列淘汰（C06-F1）。 */
export type EventPriority = 'normal' | 'critical';

/**
 * 队列中的事件：必填字段与批次 Schema 中 `event.required` 一致；
 * 其余字段（`page_id`、`url`、`dimensions` 等）通过索引签名透传。
 * 事件形状由 C04 按契约保证，C06 只做组装、字段提升与丢弃计数。
 */
export interface QueueEvent {
  readonly event_id: string;
  readonly event_name: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly occurred_at: number;
  readonly priority: EventPriority;
  [field: string]: unknown;
}

/** 维度对象；事件体与批次 `common` 共用。 */
export type Dimensions = Readonly<Record<string, string>>;

/** 可提升到批次头的字段（C06-F3；event-standard.md 第 3 节）。 */
export interface CommonFields {
  readonly page_id?: string | undefined;
  readonly view_id?: string | undefined;
  readonly url?: string | undefined;
  readonly sample_rate?: number | undefined;
  readonly context?: Dimensions | undefined;
}

/**
 * 批次公共头。由 C04/C07 提供（设备、会话、版本、时钟偏移等），
 * C06 只负责把它拼进批次，不自行编造这些字段。
 */
export interface BatchHeader {
  readonly protocol_version: 1;
  readonly app_id: string;
  readonly env: string;
  readonly release: string;
  readonly sdk_name: string;
  readonly sdk_version: string;
  readonly device_id: string;
  readonly session_id: string;
  readonly clock_offset: number;
  readonly device_id_persistent?: boolean | undefined;
  readonly user_id?: string | undefined;
  readonly user_id_hashed?: boolean | undefined;
  readonly consent?: 'granted' | 'denied' | 'unknown' | undefined;
  readonly clock_calibrated?: boolean | undefined;
}

/** 批次头来源（给 T16/C04 注入）。 */
export interface BatchHeaderSource {
  /** 返回当前批次头；每次组装批次时调用一次。 */
  header(): BatchHeader;
}

/** 组装完成的批次（I-01 请求体）。 */
export interface BatchEnvelope extends BatchHeader {
  readonly batch_id: string;
  readonly sent_at: number;
  /** 取值相同而被提升的字段；没有可提升字段时缺省。 */
  readonly common?: CommonFields | undefined;
  readonly events: readonly QueueEvent[];
}

/** 批次组装器选项。 */
export interface BatchAssemblerOptions {
  /** 批次头来源；必填。 */
  readonly header: BatchHeaderSource;
  /** 当前时间（毫秒）；缺省 `Date.now`。用于生成 `sent_at`。 */
  readonly now?: (() => number) | undefined;
  /** `batch_id` 生成器；缺省使用 `crypto.randomUUID()`，不可用时退回 Math.random 实现的 UUID v4。 */
  readonly createId?: (() => string) | undefined;
}

/** 批次组装器（C06-F3）。 */
export interface BatchAssembler {
  /**
   * 把事件组装成一个批次：提升取值完全相同的 `page_id`/`view_id`/`url`/`sample_rate`/`context`，
   * 只输出批次 Schema 声明的字段。
   * @throws 事件数组为空时抛错（Schema 的 `events.minItems` 为 1）；调用方保证非空。
   */
  assemble(events: readonly QueueEvent[]): BatchEnvelope;
}
