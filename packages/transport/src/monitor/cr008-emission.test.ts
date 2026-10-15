/**
 * CR-008 **发出点**自证：从「真实事件发生处」到 `sdk_health.metrics` 的整条链路。
 *
 * 三层各自的发出点：
 * 1. T16 `offline-store.stats().exposure.commitLostObservedWindowMs`（下界读数）
 *    → `createOfflineExposureSource`；
 * 2. `page-leave` 的 `LeaveStats.budgetStops` 与 `leader` 的 `leaderLost()`（两个累计观测量）
 *    → `createObservableMetricsSource`（窗口差分）；
 * 3. `createHealthReporter` 把它们一路带进 `sdk_health`，并用**真实 Schema** 校验产出。
 *
 * 变异验证（把发出点临时去掉）见 CR-008 的落地说明：去掉第 2/3 步的接线后，
 * 本文件的用例必须变红。
 */
import { Ajv2020 } from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv';
import { describe, expect, test } from 'vitest';
import sdkHealthSchema from '../../../../docs/contracts/schemas/builtin-events/sdk_health.schema.json';
import { createLeaderElection } from '../leader/leader';
import type { LeaderElection, LocksPort } from '../leader/leader';
import { createLeaveSender } from '../sender/page-leave';
import { createFakeCredentials, createFakeTransport } from '../sender/fixtures';
import type { NativeHttpRefs } from '../sender/types';
import { createCountersSpy, makeBatch, makeEvent } from '../offline/fixtures';
import { createObservableMetricsSource, createOfflineExposureSource } from './adapters';
import {
  EXPOSURE_WINDOW_LOWER_BOUND_MS,
  EXPOSURE_WINDOW_UPPER_BOUND_MS,
  METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
  METRIC_LEADER_LOST,
} from './observables';
import { createHealthReporter } from './reporter';
import type { ExposureWindowInput, SdkHealthEvent } from './types';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validateHealth: ValidateFunction = ajv.compile(sdkHealthSchema);

let sequence = 0;
function createId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

/** 只授予一次锁的替身：第二轮起不再授予，用于触发「从 leader 变为非 leader」。 */
function createOneShotLocks(): LocksPort {
  let granted = 0;
  return {
    tryAcquire(_name: string, task: () => Promise<void>): Promise<boolean> {
      granted += 1;
      if (granted > 1) return Promise.resolve(false);
      return task().then(() => true);
    },
  };
}

/** 上报器的原因码计数端口替身；CR-008 的两个观测量**不**经过它。 */
function createHealthCountersSpy(): {
  snapshot(): Readonly<Record<string, number>>;
  reset(): void;
} {
  return {
    snapshot: (): Readonly<Record<string, number>> => ({}),
    reset: (): void => undefined,
  };
}

describe('CR-008 发出点（真实事件处 → sdk_health）', () => {
  test('createOfflineExposureSource 把 T16 的下界读数带进 ExposureWindowInput', () => {
    const source = createOfflineExposureSource({
      stats: () => ({
        exposure: {
          commitLostEvents: 3,
          commitLostWindowMs: 1247,
          commitLostObservedWindowMs: 7,
        },
      }),
    });
    const input: ExposureWindowInput = source.exposure();
    expect(input).toEqual({ events: 3, windowMs: 1247, observedWindowMs: 7 });
  });

  test('createOfflineExposureSource 在没有下界读数时给 null（旧产物/未捕获窗口）', () => {
    const source = createOfflineExposureSource({
      stats: () => ({ exposure: { commitLostEvents: 0, commitLostWindowMs: null } }),
    });
    expect(source.exposure().observedWindowMs).toBeNull();
  });

  test('page-leave 的预算停手真的被计数（且同一 burst 只记 1 次）', () => {
    const beacon: NativeHttpRefs = { sendBeacon: (): boolean => true };
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: beacon,
      transport: createFakeTransport().transport,
      counters: createCountersSpy().port,
      budget: { maxBatches: 1, maxEvents: 10_000, maxBytes: 10_000_000, maxMs: 10_000 },
    });
    leave.resetBudget();
    const batch = makeBatch({ events: [makeEvent(), makeEvent(), makeEvent()] });
    // 第一次 send：用掉 1 个批次额度；第二次 send：预算已用尽 → 停手并计数。
    leave.send(batch);
    leave.send(batch);
    leave.send(batch);
    expect(leave.stats().budgetStops).toBe(1);

    // 新 burst 再停手一次 → 累计 2 次（映射层差分后是窗口增量）。
    leave.resetBudget();
    leave.send(batch);
    leave.send(batch);
    expect(leave.stats().budgetStops).toBe(2);
  });

  test('leader 的「从 leader 变为非 leader」真的被计数（首轮未当选不计）', async () => {
    const leader: LeaderElection = createLeaderElection({ locks: createOneShotLocks() });
    await leader.run(() => Promise.resolve(undefined));
    expect(leader.leaderLost()).toBe(0);
    await leader.run(() => Promise.resolve(undefined));
    expect(leader.leaderLost()).toBe(1);

    // 首轮即未当选的实例：它没有"失去"，计数保持 0。
    const never = createLeaderElection({
      locks: { tryAcquire: () => Promise.resolve(false) },
    });
    await never.run(() => Promise.resolve(undefined));
    expect(never.leaderLost()).toBe(0);
  });

  test('createObservableMetricsSource 把累计观测量差分成本窗口增量（0 不上报）', () => {
    const leave = { stops: 0 };
    const leaderLosses = { count: 0 };
    const source = createObservableMetricsSource({
      leave: { stats: () => ({ budgetStops: leave.stops }) },
      leader: { leaderLost: () => leaderLosses.count },
    });

    leaderLosses.count += 1;
    leave.stops += 1;
    expect(source.take()).toEqual({ flushSkippedDueToBudget: 1, leaderLost: 1 });

    // 没有新事件 → 空增量（不是 0 值）。
    expect(source.take()).toEqual({});

    leave.stops += 2;
    expect(source.take()).toEqual({ flushSkippedDueToBudget: 2 });
  });

  test('createHealthReporter 把夹逼端点与两个观测量真的发进 sdk_health 并过 Schema', () => {
    const emitted: SdkHealthEvent[] = [];
    // 适配器在**创建时**取累计值的基线，因此先建源、再制造事件（与装配顺序一致）。
    const leave = { stops: 0 };
    const leaderLosses = { count: 0 };
    const observables = createObservableMetricsSource({
      leave: { stats: () => ({ budgetStops: leave.stops }) },
      leader: { leaderLost: () => leaderLosses.count },
    });
    const reporter = createHealthReporter({
      counters: createHealthCountersSpy(),
      dimensions: () => ({ sdk_version: '1.2.3', state: 'running' }),
      emit: (event) => {
        emitted.push(event);
      },
      exposure: {
        exposure: () => ({ events: 4, windowMs: 1085, observedWindowMs: 1 }),
      },
      observables,
      windowMs: 60_000,
      createId,
    });

    leave.stops = 2;
    leaderLosses.count = 1;
    const events = reporter.flush();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const metrics: Record<string, number> = {};
    for (const event of events) Object.assign(metrics, event.metrics);
    expect(metrics[EXPOSURE_WINDOW_LOWER_BOUND_MS]).toBe(1);
    expect(metrics[EXPOSURE_WINDOW_UPPER_BOUND_MS]).toBe(1085);
    expect(metrics[METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET]).toBe(2);
    expect(metrics[METRIC_LEADER_LOST]).toBe(1);
    for (const event of events) {
      const valid = validateHealth(JSON.parse(JSON.stringify(event)) as unknown);
      expect(valid, JSON.stringify(validateHealth.errors)).toBe(true);
    }
    reporter.dispose();
    expect(emitted).toHaveLength(events.length);
  });
});
