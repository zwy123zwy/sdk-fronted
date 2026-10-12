/**
 * 事件体积估算（C06-F1 的体积上限、C06-AC-02/AC-05 的冲刷阈值）。
 *
 * 口径与 `event-standard.md` 第 4 节一致：按 UTF-16 码元数计算，纯 ASCII 时等于字节数。
 * 为避免每次入队都做 JSON.stringify，这里直接遍历字段累加，并对数字、引号、括号、冒号等
 * 取保守的固定开销；估算值不小于实际序列化长度，因此上限判断偏安全。
 * 与 JSON 一样，函数、Symbol 等不可序列化的值按 0 计。
 */
import type { QueueEvent } from '../batch/types';

/** 字符串两侧的引号。 */
const STRING_QUOTES = 2;
/** 数字的保守长度（双精度最多 17 位有效数字 + 符号 + 小数点 + 指数）。 */
const NUMBER_SIZE = 20;
const BOOLEAN_SIZE = 5;
const NULL_SIZE = 4;
/** 对象花括号。 */
const OBJECT_BRACES = 2;
/** 数组方括号。 */
const ARRAY_BRACKETS = 2;
/** 每个成员的引号、冒号与分隔逗号。 */
const ENTRY_OVERHEAD = 4;

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function estimateValue(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null) return NULL_SIZE;
  if (typeof value === 'string') return value.length + STRING_QUOTES;
  if (typeof value === 'number') return NUMBER_SIZE;
  if (typeof value === 'boolean') return BOOLEAN_SIZE;
  if (isUnknownArray(value)) {
    let total = ARRAY_BRACKETS;
    for (const item of value) total += estimateValue(item) + 1;
    return total;
  }
  if (typeof value === 'object') return estimateRecord(asRecord(value));
  return 0;
}

function estimateRecord(record: Record<string, unknown>): number {
  let total = OBJECT_BRACES;
  for (const [key, value] of Object.entries(record)) {
    total += key.length + ENTRY_OVERHEAD + estimateValue(value);
  }
  return total;
}

/** 估算一条事件序列化后的 UTF-16 码元数。 */
export function estimateEventBytes(event: QueueEvent): number {
  return estimateRecord(event);
}
