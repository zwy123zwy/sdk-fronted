/**
 * C05-F1 错误去重与计数（AC-03）。
 *
 * AC-03：「同一错误 1 秒内抛出 100 次 → 按 `fingerprint` 去重，上报次数受控，
 * `count` 记录总次数」。
 *
 * 为什么是**聚合窗口**而不是「首条立即上报 + 后续折叠」：`metrics.count` 只有在
 * 窗口结束时才是最终值。若首条立即上报，那么它携带的 `count` 永远是 1，
 * 之后累计到的 100 无处表达（再补发一条又会与首条重复计数）。
 * 因此以 `windowMs`（缺省 1000，与 AC 的「1 秒内」一致）为窗口聚合，
 * 窗口结束时**只上报一条**，其 `metrics.count` 即窗口内总次数。
 * 代价是错误事件最多延迟一个窗口；`flush()` 与卸载会立即结算，避免页面关闭丢数据。
 *
 * 采集回调只做最小工作（T18-plan §2 与 §10）：观察只更新一个 Map，
 * 不做序列化、不组装批次。
 */

/** 去重窗口的缺省时长（毫秒）；与 C05-AC-03 的「1 秒内」一致。 */
export const DEFAULT_DEDUP_WINDOW_MS = 1000;

/** 一次观察的结果。 */
export interface DedupObservation {
  /** 是否为该指纹在本窗口内的**首次**出现（首次出现才会开启新窗口）。 */
  readonly started: boolean;
  /** 截至本次为止该指纹在本窗口内的累计次数。 */
  readonly count: number;
}

/** 结算结果：窗口内累计次数与首次出现时携带的负载。 */
export interface DedupSettlement<TPayload> {
  readonly fingerprint: string;
  readonly payload: TPayload;
  readonly count: number;
  /** 窗口内首次出现的时间戳。 */
  readonly firstAt: number;
}

/** 以 `fingerprint` 为键、按时间窗口聚合的去重器。 */
export interface Deduplicator<TPayload> {
  /**
   * 记录一次出现。
   * 返回 `started: true` 表示这是本窗口的首条（调用方据此安排窗口结算）。
   */
  observe(fingerprint: string, payload: TPayload, at: number): DedupObservation;
  /** 已到期（`at - firstAt >= windowMs`）的指纹清单，按首次出现时间升序。 */
  due(at: number): readonly string[];
  /** 结算一个指纹：返回累计次数与首条负载并清除该窗口；不存在时返回 `undefined`。 */
  take(fingerprint: string): DedupSettlement<TPayload> | undefined;
  /** 结算全部未到期窗口（`flush()` 与卸载时使用），按首次出现时间升序。 */
  takeAll(): readonly DedupSettlement<TPayload>[];
  /** 未结算的指纹数量。 */
  size(): number;
  /** 某个指纹在当前窗口内的累计次数；不存在返回 0。 */
  count(fingerprint: string): number;
  /** 清空全部窗口。 */
  reset(): void;
}

/** 窗口内的聚合项。 */
interface WindowEntry<TPayload> {
  readonly payload: TPayload;
  readonly firstAt: number;
  count: number;
}

/**
 * 创建去重器。
 *
 * @param options.windowMs 聚合窗口长度（毫秒）；缺省 `DEFAULT_DEDUP_WINDOW_MS`。
 */
export function createDeduplicator<TPayload>(options?: {
  readonly windowMs?: number | undefined;
}): Deduplicator<TPayload> {
  const windowMs = options?.windowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const windows = new Map<string, WindowEntry<TPayload>>();

  const settle = (fingerprint: string): DedupSettlement<TPayload> | undefined => {
    const entry = windows.get(fingerprint);
    if (entry === undefined) return undefined;
    windows.delete(fingerprint);
    return { fingerprint, payload: entry.payload, count: entry.count, firstAt: entry.firstAt };
  };

  return {
    observe(fingerprint: string, payload: TPayload, at: number): DedupObservation {
      const entry = windows.get(fingerprint);
      if (entry === undefined) {
        windows.set(fingerprint, { payload, firstAt: at, count: 1 });
        return { started: true, count: 1 };
      }
      entry.count += 1;
      return { started: false, count: entry.count };
    },
    due(at: number): readonly string[] {
      const due: string[] = [];
      for (const [fingerprint, entry] of windows) {
        if (at - entry.firstAt >= windowMs) due.push(fingerprint);
      }
      return due.sort((left, right) => {
        const a = windows.get(left)?.firstAt ?? 0;
        const b = windows.get(right)?.firstAt ?? 0;
        return a - b;
      });
    },
    take(fingerprint: string): DedupSettlement<TPayload> | undefined {
      return settle(fingerprint);
    },
    takeAll(): readonly DedupSettlement<TPayload>[] {
      const settled: DedupSettlement<TPayload>[] = [];
      for (const fingerprint of [...windows.keys()].sort((left, right) => {
        const a = windows.get(left)?.firstAt ?? 0;
        const b = windows.get(right)?.firstAt ?? 0;
        return a - b;
      })) {
        const entry = settle(fingerprint);
        if (entry !== undefined) settled.push(entry);
      }
      return settled;
    },
    size(): number {
      return windows.size;
    },
    count(fingerprint: string): number {
      return windows.get(fingerprint)?.count ?? 0;
    },
    reset(): void {
      windows.clear();
    },
  };
}
