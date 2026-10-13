/**
 * 时钟校准状态机（C04-F7）。
 *
 * 分工（编排方 2026-10-13 批准）：**响应头 `X-Server-Time` 的解析归 T16**
 * （`packages/transport/src/sender/policy.ts` 的 `parseServerTime`）；C04 只提供偏移状态机，
 * 由装配根把 T16 的采样结果接进 `noteServerTime`。C04 **不解析任何响应头**。
 *
 * 算法：
 *   往返 = 收到时间 − 发出时间；
 *   往返非有限 / 为负 / > `MAX_CLOCK_ROUND_TRIP_MS`（2000 ms）→ **放弃本次校准**（保持原值）；
 *   偏移 = 服务端时间 + 往返/2 − 收到时间（NTP 半程修正），取整；
 *   偏移钳制到 ±`CLOCK_OFFSET_LIMIT_MS`（±24 h，批次 Schema 的 `clock_offset` 上下限）；
 *   首次成功即 `calibrated: true`，之后每次成功覆盖（客户端时钟可能被用户改）。
 */
import { CLOCK_OFFSET_LIMIT_MS, MAX_CLOCK_ROUND_TRIP_MS } from './constants';
import type { ClockCalibration, ClockSample, ClockState } from './ports';

/** 把偏移钳制到批次 Schema 允许的范围（`clock_offset` 的 `minimum/maximum`）。 */
export function clampOffset(offsetMs: number): number {
  if (offsetMs > CLOCK_OFFSET_LIMIT_MS) return CLOCK_OFFSET_LIMIT_MS;
  if (offsetMs < -CLOCK_OFFSET_LIMIT_MS) return -CLOCK_OFFSET_LIMIT_MS;
  return offsetMs;
}

/** 创建时钟校准状态机。 */
export function createClockCalibration(): ClockCalibration {
  let offsetMs = 0;
  let calibrated = false;

  return {
    noteServerTime(sample: ClockSample): void {
      const { serverTimeMs, clientSentAtMs, clientReceivedAtMs } = sample;
      if (!Number.isFinite(serverTimeMs) || !Number.isFinite(clientSentAtMs) || !Number.isFinite(clientReceivedAtMs)) {
        return;
      }
      const roundTripMs = clientReceivedAtMs - clientSentAtMs;
      if (roundTripMs < 0 || roundTripMs > MAX_CLOCK_ROUND_TRIP_MS) return;
      // NTP 半程修正：假定响应在网络上的去回耗时对称。
      offsetMs = clampOffset(Math.round(serverTimeMs + roundTripMs / 2 - clientReceivedAtMs));
      calibrated = true;
    },
    current(): ClockState {
      return { offsetMs, calibrated };
    },
    reset(): void {
      offsetMs = 0;
      calibrated = false;
    },
  };
}
