/**
 * C08-F4 调试 tracer：把诊断与去向记录写到**注入的输出端口**。
 *
 * 本模块**不使用 `console`**（包内 src 目录全局禁止，唯一豁免是 core 的
 * `console-sink.ts` 与 browser 的加载桩）：输出能力由装配根注入，接入方可以接到
 * core 的 console sink、自己的 logger，或测试的数组。
 *
 * 默认状态由 `enabled` 控制：门禁不开时为空操作（AC-09），不产生任何输出。
 */
import { formatDiagnosticsRecord, formatRouteRecord } from './format';
import type { DebugTracer, DebugTracerOptions } from './types';

export function createDebugTracer(options: DebugTracerOptions): DebugTracer {
  const enabledOption = options.enabled;
  const isEnabled: () => boolean =
    typeof enabledOption === 'function' ? enabledOption : (): boolean => enabledOption;
  return {
    enabled: isEnabled,
    diagnostic(record): void {
      if (!isEnabled()) return;
      options.write(formatDiagnosticsRecord(record));
    },
    route(record): void {
      if (!isEnabled()) return;
      options.write(formatRouteRecord(record));
    },
  };
}

/** 恒关闭的 tracer（显式关闭调试模式时使用）。 */
export const NOOP_DEBUG_TRACER: DebugTracer = {
  enabled: (): boolean => false,
  diagnostic: (): void => undefined,
  route: (): void => undefined,
};
