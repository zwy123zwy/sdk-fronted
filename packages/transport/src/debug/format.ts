/**
 * C08-F4 的调试输出格式化。
 *
 * 与 `packages/core/src/api/console-sink.ts` 的既有约定保持一致：
 * `[web-report-sdk] <kind> reason_code=<码> 去向=<事件未上报|字段未上报> [event_name=…] [field=…]`。
 * 传输层去向用同一前缀与 `去向=` 形式。
 *
 * **令牌安全**：只读取类型声明的白名单字段；`kind` / `reason_code` / `event_name` / `field`
 * 会先做字符清洗与 64 字符截断，避免日志注入。调用方传进来的任何令牌 / 请求头
 * 都不在读取范围内。
 */
import type { DebugDestination, DebugDiagnosticsRecord, DebugRouteRecord } from './types';

export { DEBUG_DESTINATIONS } from './types';

/** 日志前缀，便于接入方在控制台过滤（与 core console-sink 一致）。 */
export const DEBUG_PREFIX = '[web-report-sdk]';

/** 去向的中文标签（逐条展示事件去向，C08-AC-08）。 */
export const DESTINATION_LABELS: Readonly<Record<DebugDestination, string>> = {
  queued: '已入队',
  sent: '已发送',
  failed: '发送失败',
  retry: '重试',
  circuit_open: '熔断暂停',
  offline: '已转离线',
  replayed: '离线补发',
  dropped: '已丢弃',
  page_leave: '页面离开通道',
  emitted: '已产出',
};

const SCRUB_PATTERN = /[^\w.:\-/]/gu;
const SCRUB_MAX_LENGTH = 64;

function scrub(value: string): string {
  return value.replace(SCRUB_PATTERN, '').slice(0, SCRUB_MAX_LENGTH);
}

/** 诊断记录 → 一行文本（与 core console-sink 的输出逐字一致）。 */
export function formatDiagnosticsRecord(record: DebugDiagnosticsRecord): string {
  const parts = [
    `${DEBUG_PREFIX} ${scrub(record.kind)}`,
    `reason_code=${scrub(record.reason_code)}`,
    record.dropped === 'event' ? '去向=事件未上报' : '去向=字段未上报',
  ];
  if (record.event_name !== undefined) parts.push(`event_name=${scrub(record.event_name)}`);
  if (record.field !== undefined) parts.push(`field=${scrub(record.field)}`);
  return parts.join(' ');
}

/** 传输层去向记录 → 一行文本。 */
export function formatRouteRecord(record: DebugRouteRecord): string {
  const parts = [
    `${DEBUG_PREFIX} ${scrub(record.kind)}`,
    `去向=${DESTINATION_LABELS[record.destination]}`,
  ];
  if (record.reason_code !== undefined) parts.push(`reason_code=${scrub(record.reason_code)}`);
  if (record.event_name !== undefined) parts.push(`event_name=${scrub(record.event_name)}`);
  if (record.count !== undefined) parts.push(`count=${String(record.count)}`);
  return parts.join(' ');
}
