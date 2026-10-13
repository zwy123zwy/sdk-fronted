/**
 * C08 调试模式（T17）的目录内聚合导出。公共面只从 `packages/transport/src/index.ts` 暴露。
 */
export { DEBUG_QUERY_PARAM, DEFAULT_PRODUCTION_ENVS, resolveDebugMode } from './gate';
export {
  DEBUG_PREFIX,
  DESTINATION_LABELS,
  DEBUG_DESTINATIONS,
  formatDiagnosticsRecord,
  formatRouteRecord,
} from './format';
export { NOOP_DEBUG_TRACER, createDebugTracer } from './tracer';
export type { DebugDecision, DebugDecisionReason, DebugGateOptions } from './gate';
export type {
  DebugDestination,
  DebugDiagnosticsRecord,
  DebugRouteRecord,
  DebugTracer,
  DebugTracerOptions,
  DebugWritePort,
} from './types';
