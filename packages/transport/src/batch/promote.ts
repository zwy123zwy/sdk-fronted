/**
 * 批次字段提升（C06-F3，`docs/contracts/event-standard.md` 第 3 节）。
 *
 * 规则：批次内所有事件的 `page_id`、`view_id`、`url`、`sample_rate`、`context` 中，
 * 某个字段取值完全相同时，把它移到批次 `common` 并从事件体删除；取值不同或缺失时不提升。
 * 提升不得改变语义：`{ ...common, ...event }` 必须还原为提升前的事件。
 *
 * 组装器只输出批次 Schema 声明的字段（`additionalProperties: false`），未声明的字段由 C04
 * 在字段约束阶段处理，不进批次。
 */
import type { CommonFields, QueueEvent } from './types';

/** 事件体中允许出现的可选字段，按 Schema 声明顺序输出，保证序列化结果稳定。 */
const OPTIONAL_EVENT_FIELDS = [
  'sample_rate',
  'page_id',
  'view_id',
  'url',
  'level',
  'dimensions',
  'metrics',
  'context',
  'attachment',
  'truncated',
  'retry_count',
  'replayed',
] as const;

/** 可提升字段，顺序固定。 */
const PROMOTABLE_FIELDS = ['page_id', 'view_id', 'url', 'sample_rate', 'context'] as const;

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * JSON 语义的深比较；只处理 JSON 可表示的值。
 * 数组与对象统一按键集合比较，因此 `context` 里的数组也能正确处理。
 */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null) return false;
  if (typeof right !== 'object' || right === null) return false;
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  for (const key of leftKeys) {
    if (!hasOwn(rightRecord, key)) return false;
    if (!deepEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

/** 只保留批次 Schema 声明的事件字段；`omitted` 中的字段（已提升）不输出。 */
export function projectEvent(event: QueueEvent, omitted?: object): QueueEvent {
  const projected: QueueEvent = {
    event_id: event.event_id,
    event_name: event.event_name,
    event_type: event.event_type,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    priority: event.priority,
  };
  for (const field of OPTIONAL_EVENT_FIELDS) {
    if (omitted !== undefined && hasOwn(omitted, field)) continue;
    const value = event[field];
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

/** 提升结果。 */
export interface PromotionResult {
  readonly common: CommonFields | undefined;
  readonly events: readonly QueueEvent[];
}

/** 按 C06-F3 提升公共字段。 */
export function promoteCommonFields(events: readonly QueueEvent[]): PromotionResult {
  const first = events[0];
  if (first === undefined) return { common: undefined, events: [] };

  const shared: Record<string, unknown> = {};
  let promoted = false;
  for (const field of PROMOTABLE_FIELDS) {
    const value = first[field];
    if (value === undefined) continue;
    if (!events.every((event) => deepEqual(event[field], value))) continue;
    shared[field] = value;
    promoted = true;
  }
  if (!promoted) {
    return { common: undefined, events: events.map((event) => projectEvent(event)) };
  }
  // shared 的取值直接来自事件（形状由 C04 按契约保证），这里只做结构性标注。
  return {
    common: shared,
    events: events.map((event) => projectEvent(event, shared)),
  };
}
