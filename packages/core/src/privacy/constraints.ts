/**
 * 字段约束（C04-F6；`event-standard.md` 第 4 节）。
 *
 * 处理顺序（每一步都是「先判定是否超限、再动作」，因此对已合规的事件**零计数、零写入** ——
 * 与 C01 的 Schema 合规兜底**幂等，不双重计数**，见 T12 交付时的分工裁定）：
 *
 *   1. 键名格式：非法键**丢弃该字段**，计 `invalid_field_key`
 *      （**非法键名归 C04；非法参数归 C01，两者不合并**）
 *   2. 键数量：`dimensions` / `context` / `metrics` 各按键名字典序保留前 50，其余丢弃
 *   3. 值：先脱敏（`Masker`），再按 UTF-16 码元截断到 256（不切断代理对）
 *   4. 附件：先脱敏（**与第 3 步同一个 `Masker`**），再截断到 8 KB（UTF-8 字节）
 *   5. 非有限指标：丢弃该字段，计 `non_finite_metric`
 *   6. 单条事件：UTF-8 序列化字节 ≤ 16 KB；超出时依次截断附件 → 最长的维度值 → 整键丢弃；
 *      仍超限则整条丢弃，计 `event_too_large`
 *   7. 截断路径写 `truncated`（去重；超过 60 条只保留前 60，不新增原因码）
 */
import { hasValidFieldKey } from '../api/values';
import type { KernelEvent } from '../kernel';
import { MAX_URL_LENGTH } from './constants';
import { truncateUtf16Safe, utf8Bytes } from './limits';
import { PRIVACY_REASON_CODES } from './reason-codes';
import type { ConstrainInput, ConstrainResult } from './types';

/** 事件体字节上限的判定口径：UTF-8 序列化字节（不含批次头与 `common`）。 */
const EVENT_BODY_LIMIT = 16384;

/** `$defs/event` 声明的字段集合（不在其中的键属异常输入，超限时优先丢弃）。 */
const EVENT_FIELD_KEYS: ReadonlySet<string> = new Set([
  'event_id',
  'event_name',
  'event_type',
  'schema_version',
  'occurred_at',
  'priority',
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
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 拼出 `truncated` / 调试输出使用的字段路径。
 *
 * 单独抽成函数是为了避免 TS 的控制流分析把字面量实参在调用点收窄成 `never`
 * （收窄后模板串与 `+` 都会报 operand 类型错误，而类型声明本身没有问题）。
 */
function joinPath(prefix: string, key: string): string {
  return `${prefix}.${key}`;
}

/** 读取某一层对象的「字符串键 → 字符串值」条目（非字符串值跳过）。 */
function readStringEntries(value: unknown): [string, string][] {
  if (!isRecord(value)) return [];
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') entries.push([key, entry]);
  }
  return entries;
}

/** 在 UTF-8 字节上限内截断字符串（不切断代理对）。 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  // 二分找到「不超字节上限」的最大码元前缀
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return truncateUtf16Safe(text, Math.max(low, 0));
}

/** 事件体的 UTF-8 序列化字节数（判定 16 KB 口径的唯一入口）。 */
function eventBodyBytes(event: KernelEvent): number {
  try {
    return utf8Bytes(JSON.stringify(event));
  } catch {
    return 0;
  }
}

/** 创建一次约束处理的累加器（截断路径去重 + 原因码计数）。 */
function createRecorder(input: ConstrainInput) {
  const paths: string[] = [];
  return {
    addPath(path: string): void {
      if (paths.length < input.limits.maxTruncatedPaths && !paths.includes(path)) paths.push(path);
    },
    paths,
    count(reason: string, delta = 1): void {
      input.count(reason, delta);
    },
    /** 阶梯压缩时若还没有真实路径，就写一个合成的路径名，避免产生空字符串路径。 */
    noteValueClamp(): void {
      if (paths.length === 0) paths.push('attachment');
    },
  };
}

/** 处理 `dimensions` 与 `context`（两者规则完全相同，受 `maxDimensionKeys` 约束）。 */
function constrainStringMap(
  value: unknown,
  label: string,
  input: ConstrainInput,
  recorder: ReturnType<typeof createRecorder>,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const valid: [string, string][] = [];
  for (const [key, entry] of readStringEntries(value)) {
    if (!hasValidFieldKey(key)) {
      recorder.count(PRIVACY_REASON_CODES.invalidFieldKey);
      input.diagnostics?.({
        reason_code: PRIVACY_REASON_CODES.invalidFieldKey,
        kind: label,
        dropped: 'field',
        field: joinPath(label, key),
      });
      continue;
    }
    valid.push([key, entry]);
  }
  valid.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const kept = valid.slice(0, input.limits.maxDimensionKeys);
  if (valid.length > kept.length) {
    recorder.count(PRIVACY_REASON_CODES.truncatedDimensionKeys);
    for (const [key] of valid.slice(kept.length)) recorder.addPath(`${label}.${key}`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of kept) {
    // 顺序：先脱敏、再截断（脱敏会缩短文本，截断在最后以保证长度上限）。
    const masked = input.masker.apply(entry);
    if (masked.length > input.limits.maxDimensionValueLength) {
      recorder.count(PRIVACY_REASON_CODES.truncatedDimension);
      recorder.addPath(`${label}.${key}`);
      result[key] = truncateUtf16Safe(masked, input.limits.maxDimensionValueLength);
      continue;
    }
    result[key] = masked;
  }
  return result;
}

/** 处理 `metrics`：丢弃非有限值、按键名字典序保留前 50。 */
function constrainMetrics(
  value: unknown,
  input: ConstrainInput,
  recorder: ReturnType<typeof createRecorder>,
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const finite: [string, number][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      recorder.count(PRIVACY_REASON_CODES.nonFiniteMetric);
      input.diagnostics?.({ reason_code: PRIVACY_REASON_CODES.nonFiniteMetric, kind: 'metrics', dropped: 'field', field: `metrics.${key}` });
      continue;
    }
    finite.push([key, entry]);
  }
  finite.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const kept = finite.slice(0, input.limits.maxMetricKeys);
  if (finite.length > kept.length) {
    recorder.count(PRIVACY_REASON_CODES.truncatedMetricKeys);
    recorder.addPath('metrics');
  }
  return Object.fromEntries(kept);
}

/**
 * 处理 `attachment`：先用**与 `dimensions` / `context` 同一个 `Masker`** 脱敏，
 * 再按 UTF-8 字节上限压缩（记录截断路径）。
 *
 * **顺序：先脱敏、再截断**（与第 3 步的维度值一致），理由有两条：
 * - 截断在前会把一个敏感值从中间切开，切断后的片段不再匹配任何规则，会以「残片」形式
 *   原样发出 —— 实测 8 KB 边界落在手机号中间时残留 `1380`。脱敏在前则敏感值整体被替换，
 *   边界如何移动都不残留片段。
 * - 8 KB 是**上线字节预算**，必须是最后一步：替换串可能比命中片段更长（远程追加规则由
 *   接入方定义），先截断就无法保证最终长度仍在限内。
 *
 * 这里是 attachment 的唯一脱敏权威：所有 attachment 路径（错误栈、自定义附件等）都汇聚到
 * 本函数，插件侧**不得**自建 masker（自建只拿得到内置规则，会漏掉动态的 `extra_mask_rules`）。
 */
function clampAttachment(
  event: KernelEvent,
  input: ConstrainInput,
  recorder: ReturnType<typeof createRecorder>,
): void {
  const attachment = event['attachment'];
  if (typeof attachment !== 'string') return;
  const masked = input.masker.apply(attachment);
  if (utf8Bytes(masked) > input.limits.maxAttachmentBytes) {
    recorder.count(PRIVACY_REASON_CODES.truncatedAttachment);
    recorder.addPath('attachment');
    event['attachment'] = truncateToBytes(masked, input.limits.maxAttachmentBytes);
    return;
  }
  // 未命中任何规则时不写入，保持「已合规事件零写入」。
  if (masked !== attachment) event['attachment'] = masked;
}

/** 按 UTF-8 字节上限压缩 `url`（Schema `maxLength: 2048`，此处按字节兜底）。 */
function clampUrl(event: KernelEvent, recorder: ReturnType<typeof createRecorder>): void {
  const url = event['url'];
  if (typeof url !== 'string') return;
  if (url.length <= MAX_URL_LENGTH) return;
  recorder.count(PRIVACY_REASON_CODES.truncatedDimension);
  recorder.addPath('url');
  event['url'] = truncateUtf16Safe(url, MAX_URL_LENGTH);
}

/** 事件体里所有「字符串值」的字段位置（含未知字段：异常输入也要能被压到限内）。 */
function collectStringSlots(event: KernelEvent): { container: Record<string, unknown>; key: string }[] {
  const slots: { container: Record<string, unknown>; key: string }[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === 'string') slots.push({ container: event, key });
  }
  for (const label of ['dimensions', 'context'] as const) {
    const map = event[label];
    if (!isRecord(map)) continue;
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === 'string') slots.push({ container: map, key });
    }
  }
  return slots;
}

/**
 * 把事件体里**超出维度值上限**的字符串一次压到上限（含异常输入带进来的未声明字段）。
 *
 * 这一步保证「所有值 ≤ `maxDimensionValueLength`」，此后事件体的字节数只受
 * 「键数量 × 键长」支配：50 键 × (64 + 256) ≈ 16 KB 是上界，因此**合法输入必然能落回限内**，
 * 后续的整键丢弃只对异常输入（超出 Schema 的额外字段/超长键）才需要。
 *
 * 本步骤会顺带压掉 `attachment`（顶层字符串）：它在 `clampAttachment` 里**已经过 masker**，
 * 这里只做长度压缩，因此不构成绕过脱敏的路径。
 */
function clampAllStringValues(event: KernelEvent, recorder: ReturnType<typeof createRecorder>): boolean {
  const limit = 256;
  for (const slot of collectStringSlots(event)) {
    const value = slot.container[slot.key];
    if (typeof value !== 'string' || value.length <= limit) continue;
    slot.container[slot.key] = truncateUtf16Safe(value, limit);
    recorder.count(PRIVACY_REASON_CODES.truncatedDimension);
    recorder.noteValueClamp();
  }
  return eventBodyBytes(event) <= EVENT_BODY_LIMIT;
}

/**
 * 规范化 `truncated`：只保留字符串项、去重、上限 60。
 *
 * 防御异常输入（`truncated` 不是数组、或塞入大字符串）：正常路径下它是本模块自己写出来的。
 * 去重与上限是 Schema 的 `uniqueItems` / `maxItems: 60`（超 60 只保留前 60，不新增原因码）。
 */
function normalizeTruncatedPaths(event: KernelEvent, input: ConstrainInput): void {
  const value = event['truncated'];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    delete event['truncated'];
    return;
  }
  const unique: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (unique.includes(item)) continue;
    if (unique.length >= input.limits.maxTruncatedPaths) continue;
    unique.push(item);
  }
  if (unique.length === 0) delete event['truncated'];
  else event['truncated'] = unique;
}

/** 丢弃整个维度键（按键名字典序从后往前），直到字节数达标。 */
function dropDimensionKeys(
  event: KernelEvent,
  recorder: ReturnType<typeof createRecorder>,
): boolean {
  for (const label of ['dimensions', 'context'] as const) {
    const initial = event[label];
    if (!isRecord(initial)) continue;
    const map: Record<string, unknown> = initial;
    let keys = Object.keys(map);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      if (eventBodyBytes(event) <= EVENT_BODY_LIMIT) return true;
      const key = keys[index];
      if (key === undefined) continue;
      Reflect.deleteProperty(map, key);
      recorder.count(PRIVACY_REASON_CODES.truncatedDimensionKeys);
      recorder.addPath(`${label}.${key}`);
      keys = Object.keys(map);
    }
  }
  return eventBodyBytes(event) <= EVENT_BODY_LIMIT;
}

/** 丢弃未在 Schema 中声明的额外字段（防御异常输入，正常事件不会走到这里）。 */
function dropUnknownKeys(event: KernelEvent): boolean {
  for (const key of Object.keys(event)) {
    if (eventBodyBytes(event) <= EVENT_BODY_LIMIT) return true;
    if (EVENT_FIELD_KEYS.has(key)) continue;
    // 用 `Reflect.deleteProperty` 而非 `delete` 运算符：语义相同，且不受
    // `@typescript-eslint/no-dynamic-delete` 限制（该规则针对 `delete obj[expr]` 写法）。
    Reflect.deleteProperty(event, key);
  }
  return eventBodyBytes(event) <= EVENT_BODY_LIMIT;
}

/**
 * 对一条事件施加全部字段约束。
 *
 * 返回值中的 `dropped` 为 true 时，调用方（处理器）应返回 `stopPipeline(dropReason)`，
 * 由内核按原因码计数（`event_too_large`）。
 */
export function constrainEvent(input: ConstrainInput): ConstrainResult {
  const event = input.event;
  const recorder = createRecorder(input);

  const dimensions = constrainStringMap(event['dimensions'], 'dimensions', input, recorder);
  if (dimensions !== undefined) event['dimensions'] = dimensions;
  const context = constrainStringMap(event['context'], 'context', input, recorder);
  if (context !== undefined) event['context'] = context;
  const metrics = constrainMetrics(event['metrics'], input, recorder);
  if (metrics !== undefined) event['metrics'] = metrics;

  clampAttachment(event, input, recorder);
  clampUrl(event, recorder);
  normalizeTruncatedPaths(event, input);

  if (eventBodyBytes(event) > EVENT_BODY_LIMIT) {
    // 阶梯（顺序有意义，且每一步之后都重新判定，避免无谓改动）：
    //   ① 把所有超长字符串压到维度值上限（防御异常输入带进来的大字段）
    //   ② 按键名字典序从后往前逐个丢弃维度/上下文键
    //   ③ 丢弃未在 Schema 中声明的额外字段
    //   ④ 仍超限 → 整条丢弃
    let fits = clampAllStringValues(event, recorder);
    if (!fits) fits = dropDimensionKeys(event, recorder);
    if (!fits) fits = dropUnknownKeys(event);
    if (!fits && eventBodyBytes(event) > EVENT_BODY_LIMIT) {
      return { event, dropped: true, dropReason: PRIVACY_REASON_CODES.eventTooLarge };
    }
  }

  if (recorder.paths.length > 0) event['truncated'] = recorder.paths;
  return { event, dropped: false, dropReason: undefined };
}
