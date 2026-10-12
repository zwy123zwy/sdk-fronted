/**
 * C01-AC-12 默认调试输出（C01-F6）。
 *
 * **这是唯一允许使用 `console` 的文件**：根 `eslint.config.js` 为它开了精确豁免
 * （`files: ['packages/core/src/api/console-sink.ts']` + `no-console: 'off'`，
 * 见指南第 6 节的「已批准豁免」）。其余 SDK 代码仍然禁止 `console`，也不得用
 * `globalThis.console` 之类的间接写法规避规则。
 *
 * 输出内容只有：原因码 + 事件去向（事件整体丢弃 / 哪个字段被丢弃）+ 事件名。
 * **绝不包含令牌**：`DiagnosticsRecord` 本身没有令牌字段，本模块也不读取
 * 初始化选项里的 `token`。其余模块只依赖 `DiagnosticsSink` 接口，替换实现即可
 * （例如 C08 的调试面板）。
 */
import type { DiagnosticsRecord, DiagnosticsSink } from './types';

/** 日志前缀，便于接入方在控制台过滤。 */
const PREFIX = '[web-report-sdk]';

export function createConsoleSink(): DiagnosticsSink {
  return (record: DiagnosticsRecord): void => {
    const parts = [
      `${PREFIX} ${record.kind}`,
      `reason_code=${record.reason_code}`,
      record.dropped === 'event' ? '去向=事件未上报' : '去向=字段未上报',
    ];
    if (record.event_name !== undefined) parts.push(`event_name=${record.event_name}`);
    if (record.field !== undefined) parts.push(`field=${record.field}`);
    // 只输出结构化字段，不拼接任何接入方传入的值，避免把令牌或用户数据带进日志。
    console.warn(parts.join(' '));
  };
}

/** 缺省调试输出：空实现（显式关闭调试模式时使用）。 */
export const NOOP_DIAGNOSTICS_SINK: DiagnosticsSink = () => undefined;
