/**
 * C08-F4 调试模式的类型。
 *
 * **令牌安全**：这些类型**没有**任何令牌 / 请求头 / 用户数据字段；格式化函数只读
 * 白名单字段，调用方多带的字段不会被序列化（`tracer.test.ts` 有泄漏对照）。
 * `DebugDiagnosticsRecord` 与 `packages/core` 的 `DiagnosticsRecord` 结构一致
 * （不 import，保持零跨包依赖），因此 core 的 `DiagnosticsSink` 可以直接用
 * `DebugTracer.diagnostic` 作为实现。
 */

/** 与 `packages/core/src/api/types.ts` 的 `DiagnosticsRecord` 结构一致。 */
export interface DebugDiagnosticsRecord {
  readonly reason_code: string;
  readonly kind: string;
  readonly event_name?: string | undefined;
  readonly dropped: 'event' | 'field';
  readonly field?: string | undefined;
}

/** 调试输出端口：由装配根注入（例如接到 core 的 console sink 或接入方的 logger）。 */
export type DebugWritePort = (line: string) => void;

/** 事件/批次的去向取值（与 C06/C07 的公开状态对应）。 */
export const DEBUG_DESTINATIONS = [
  'queued',
  'sent',
  'failed',
  'retry',
  'circuit_open',
  'offline',
  'replayed',
  'dropped',
  'page_leave',
  'emitted',
] as const;

export type DebugDestination = (typeof DEBUG_DESTINATIONS)[number];

/** 逐条事件去向记录；同样不含令牌等敏感字段。 */
export interface DebugRouteRecord {
  readonly kind: string;
  readonly destination: DebugDestination;
  readonly reason_code?: string | undefined;
  readonly event_name?: string | undefined;
  readonly count?: number | undefined;
}

export interface DebugTracerOptions {
  /** 是否输出；传函数时按运行期判定（便于门禁变化后立即生效）。 */
  readonly enabled: boolean | (() => boolean);
  readonly write: DebugWritePort;
}

export interface DebugTracer {
  enabled(): boolean;
  /** 输出一条诊断记录（reason_code + 事件去向），与 core 的 console-sink 格式一致。 */
  diagnostic(record: DebugDiagnosticsRecord): void;
  /** 输出一条传输层去向记录（入队 / 发送 / 重试 / 熔断 / 离线 / 丢弃…）。 */
  route(record: DebugRouteRecord): void;
}
