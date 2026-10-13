/**
 * C04-AC-16：时钟校准（C04-F7）。
 *
 * AC-16 原文：接收方响应头 `X-Server-Time` 比本地快 5 秒、往返 100 ms → 前者 `clock_offset`
 * 约为 5000 且 `clock_calibrated: true`；另测往返 3 秒 → 放弃校准。
 *
 * 分工（编排方 2026-10-13 批准）：**响应头解析归 T16**（`parseServerTime`），
 * C04 只做偏移状态机 + `noteServerTime` 端口，因此本文件不构造真实响应。
 *
 * 计算口径：往返 > 2000 ms 放弃；偏移 = 服务端时间 + 往返/2 − 收到时间；
 * 偏移钳制到 ±24 h（批次 Schema 的 `clock_offset` 上下限）。
 *
 * 取证顺序：本文件在**实现前先写**（当时 `createClockCalibration` 是「未校准」的接口桩，
 * 除「缺省未校准」外的用例全部红过），之后实现转绿。
 */
import { describe, expect, it } from 'vitest';

import { createClockCalibration } from './clock';
import { CLOCK_OFFSET_LIMIT_MS, MAX_CLOCK_ROUND_TRIP_MS } from './constants';

/** 构造一次采样：服务端时间比本地快 offsetMs，往返 roundTripMs。 */
function sample(offsetMs: number, roundTripMs: number) {
  const sentAt = 1_700_000_000_000;
  const receivedAt = sentAt + roundTripMs;
  return { serverTimeMs: receivedAt + offsetMs, clientSentAtMs: sentAt, clientReceivedAtMs: receivedAt };
}

describe('C04-AC-16 时钟校准', () => {
  it('初始状态为未校准（offset 0、calibrated false）', () => {
    const clock = createClockCalibration();
    expect(clock.current()).toEqual({ offsetMs: 0, calibrated: false });
  });

  it('服务端快 5 秒、往返 100 ms → offset 约为 5000 且已校准', () => {
    const clock = createClockCalibration();
    clock.noteServerTime(sample(5000, 100));
    const state = clock.current();
    // 含 NTP 半程修正（+50 ms），因此不断言恰好 5000，只断言「约为 5000」。
    expect(state.offsetMs).toBeGreaterThan(4500);
    expect(state.offsetMs).toBeLessThan(5500);
    expect(state.calibrated).toBe(true);
  });

  it('往返 3 秒 → 放弃校准（offset 保持 0、calibrated 仍为 false）', () => {
    const clock = createClockCalibration();
    clock.noteServerTime(sample(5000, 3000));
    expect(clock.current()).toEqual({ offsetMs: 0, calibrated: false });
  });

  it('往返恰好等于漂移上限时仍然校准（边界为「超过才放弃」）', () => {
    const clock = createClockCalibration();
    clock.noteServerTime(sample(1000, MAX_CLOCK_ROUND_TRIP_MS));
    expect(clock.current().calibrated).toBe(true);
  });

  it('服务端慢 5 秒 → offset 为负且已校准', () => {
    const clock = createClockCalibration();
    clock.noteServerTime(sample(-5000, 100));
    const state = clock.current();
    expect(state.offsetMs).toBeLessThan(-4500);
    expect(state.offsetMs).toBeGreaterThan(-5500);
    expect(state.calibrated).toBe(true);
  });

  it('偏移被钳制在 ±24 小时（批次 Schema 的上下限）', () => {
    const clock = createClockCalibration();
    clock.noteServerTime(sample(10 * CLOCK_OFFSET_LIMIT_MS, 100));
    expect(clock.current().offsetMs).toBe(CLOCK_OFFSET_LIMIT_MS);

    const negative = createClockCalibration();
    negative.noteServerTime(sample(-10 * CLOCK_OFFSET_LIMIT_MS, 100));
    expect(negative.current().offsetMs).toBe(-CLOCK_OFFSET_LIMIT_MS);
  });

  it('后续成功的采样覆盖先前的偏移', () => {
    const clock = createClockCalibration();
    clock.noteServerTime(sample(5000, 100));
    clock.noteServerTime(sample(-2000, 100));
    expect(clock.current().offsetMs).toBeLessThan(0);
    expect(clock.current().calibrated).toBe(true);
  });

  it('非法采样（非有限、往返为负）被忽略且不改变状态', () => {
    const clock = createClockCalibration();
    clock.noteServerTime({ serverTimeMs: Number.NaN, clientSentAtMs: 0, clientReceivedAtMs: 100 });
    expect(clock.current()).toEqual({ offsetMs: 0, calibrated: false });

    clock.noteServerTime({ serverTimeMs: 1, clientSentAtMs: 100, clientReceivedAtMs: 0 });
    expect(clock.current()).toEqual({ offsetMs: 0, calibrated: false });
  });

  it('reset 后回到未校准', () => {
    const clock = createClockCalibration();
    clock.noteServerTime(sample(5000, 100));
    clock.reset();
    expect(clock.current()).toEqual({ offsetMs: 0, calibrated: false });
  });
});
