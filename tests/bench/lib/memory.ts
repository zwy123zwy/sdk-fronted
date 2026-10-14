/**
 * 内存测量（T20）。
 *
 * 两种口径分开报，不混为一谈：
 * 1. **确定性结构字节**（`structuralBytes`）：对对象图做一次确定性遍历，累加字符串的 UTF-16
 *    码元数与数字/布尔的固定开销。**可复现、无 GC 噪声**，适合与「500 条事件 ≤ 256 KB」这类
 *    容量预算直接比较；它衡量的是**载荷**，不含引擎的对象头/Map 槽位等实现开销。
 * 2. **进程堆增量**（`heapDeltaBytes`）：`process.memoryUsage().heapUsed` 的差值。包含引擎
 *    实现开销，但**未强制 GC**（vitest 默认不带 `--expose-gc`），因此是**上界**，只作参考。
 */

/** 单个数字/布尔字段的结构开销（保守取 8 B）。 */
const SCALAR_BYTES = 8;

/** 确定性结构字节：字符串按 UTF-16 码元数计，数字/布尔按 8 B 计。 */
export function structuralBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return SCALAR_BYTES;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += structuralBytes(item);
    return total;
  }
  if (typeof value === 'object') {
    let total = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += key.length * 2 + structuralBytes(item);
    }
    return total;
  }
  return 0;
}

/**
 * 仓库体积口径（`event-standard.md` 第 4 节、`packages/transport/src/queue/size.ts`）：
 * 累加 JSON 序列化后的 **UTF-16 码元数**。V8 对全 Latin-1 字符串按 1 B/码元存储，
 * 因此这是内存的**良好近似**；下面的 `structuralBytes` 按 2 B/码元计，是**保守上界**。
 */
export function totalJsonUnits(values: readonly unknown[]): number {
  let total = 0;
  for (const value of values) {
    const text = JSON.stringify(value);
    total += typeof text === 'string' ? text.length : 0;
  }
  return total;
}

/** 结构字节总和。 */
export function totalStructuralBytes(values: readonly unknown[]): number {
  let total = 0;
  for (const value of values) total += structuralBytes(value);
  return total;
}

export interface HeapDelta {
  /** 堆增量（字节）；负数表示测量期间发生过 GC，应视为不可用。 */
  readonly bytes: number;
  /** 参与测量的对象数（用于摊薄）。 */
  readonly perItem: number;
  readonly gcForced: boolean;
}

/**
 * 测量创建 `count` 份 `make()` 的堆增量上界。
 *
 * 未强制 GC 时结果偏大（含尚未回收的临时对象），因此调用方必须标注「上界」。
 */
export function heapDeltaBytes(count: number, make: (index: number) => unknown): HeapDelta {
  const gc = (globalThis as { gc?: (() => void) | undefined }).gc;
  gc?.();
  const before = process.memoryUsage().heapUsed;
  const kept: unknown[] = [];
  for (let index = 0; index < count; index += 1) kept.push(make(index));
  const after = process.memoryUsage().heapUsed;
  // 防止 kept 被优化掉
  if (kept.length !== count) throw new Error('unreachable');
  return { bytes: after - before, perItem: count, gcForced: typeof gc === 'function' };
}

/** 人类可读的字节数（KB，保留 2 位小数）。 */
export function formatKb(bytes: number): string {
  return (bytes / 1024).toFixed(2);
}
