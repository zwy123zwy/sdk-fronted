/**
 * C08-AC-07 的「自监控流量占比」可测量定义（确定性、无墙钟）。
 *
 * - 计数口径：窗口内 `sdk_health` 事件数 / 业务事件数；
 * - 体积口径：JSON 的 UTF-16 码元长度之和（与 C06 的体积估算约定一致）。
 *
 * 阈值断言放在用例里（`reporter.test.ts` 的 AC-07），本模块只提供测量。
 */
export interface TrafficShare {
  readonly healthEvents: number;
  readonly businessEvents: number;
  readonly healthBytes: number;
  readonly businessBytes: number;
  /** `healthEvents / businessEvents`；业务为空且自监控非空时为 `Infinity`。 */
  readonly countRatio: number;
  /** `healthBytes / businessBytes`；业务为空且自监控非空时为 `Infinity`。 */
  readonly byteRatio: number;
}

/** JSON 序列化后的码元长度；无法序列化时返回 0。 */
export function jsonSize(value: unknown): number {
  const text = JSON.stringify(value);
  return typeof text === 'string' ? text.length : 0;
}

function ratio(part: number, whole: number): number {
  if (whole > 0) return part / whole;
  return part > 0 ? Number.POSITIVE_INFINITY : 0;
}

export function measureTrafficShare(
  healthEvents: readonly unknown[],
  businessEvents: readonly unknown[],
): TrafficShare {
  const healthBytes = healthEvents.reduce<number>((total, event) => total + jsonSize(event), 0);
  const businessBytes = businessEvents.reduce<number>((total, event) => total + jsonSize(event), 0);
  return {
    healthEvents: healthEvents.length,
    businessEvents: businessEvents.length,
    healthBytes,
    businessBytes,
    countRatio: ratio(healthEvents.length, businessEvents.length),
    byteRatio: ratio(healthBytes, businessBytes),
  };
}
