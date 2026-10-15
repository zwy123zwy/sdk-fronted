/**
 * 信标切片专用的**校准后**事件体积估算（AC-03 第 3 步）。
 *
 * 为什么不直接用 `queue/size.ts` 的 `estimateEventBytes`：那个口径是给**队列上限**用的，
 * 必须保守（宁大勿小），代价是对每个数字无条件取 20 码元（双精度上界）。真机实测
 * （`docs/reports/e2e-real-browser.md` 追加节第 2 次）给出了这个代价的确切大小：
 * 探针事件含 10 个数字字段（`occurred_at` 13 位、`schema_version` 1 位、
 * `metrics.m0..m7` 各 1 位），单事件原文 **743 B** 而估算 **923 B**（高估 24%；
 * 其中 178 / 180 B 的偏差全部来自数字），于是 32 KiB 的阈值只产出 26391 B 的片，
 * 80 KB 变成 4 片、4 次写挤在同一个同步回合 → 第 4 片被浏览器拒绝。
 *
 * 校准口径：数字按 `String(value).length` 计——与 JSON 的数字序列化**逐字符一致**
 * （有限数走最短往返表示，`NaN` / `±Infinity` 序列化成 `null`），既不低估也不高估。
 * 其余开销（字符串引号、对象花括号、成员的引号/冒号/逗号、数组方括号）沿用
 * `queue/size.ts` 的保守口径，因此仍满足
 * `estimateBeaconEventBytes(event) >= JSON.stringify(event).length`
 * （真机同一条断言：743 B 实际 → **745 B** 估算，余量 2 B 而不是 180 B）。
 *
 * 本模块**只服务信标切片**（`page-leave.ts`），不进 `src/index.ts` 的公共导出面。
 */
import type { QueueEvent } from '../batch/types';

/** 字符串两侧的引号。 */
const STRING_QUOTES = 2;
const BOOLEAN_SIZE = 5;
/** `NaN` / `±Infinity` / `undefined` 在 JSON 里的形态。 */
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

/** 数字：与 JSON 的序列化长度逐字符一致（不再取 20 码元的上界）。 */
function estimateNumber(value: number): number {
  return Number.isFinite(value) ? String(value).length : NULL_SIZE;
}

function estimateValue(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null) return NULL_SIZE;
  if (typeof value === 'string') return value.length + STRING_QUOTES;
  if (typeof value === 'number') return estimateNumber(value);
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

/** 估算一条事件序列化后的 UTF-16 码元数（信标切片口径；见模块头部说明）。 */
export function estimateBeaconEventBytes(event: QueueEvent): number {
  return estimateRecord(event);
}
