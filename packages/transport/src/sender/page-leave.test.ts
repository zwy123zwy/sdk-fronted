/**
 * C07-AC-03 页面离开通道：按 32 KiB 切片（实测额度）、`text/plain`、令牌放在 body 的 `auth`；
 * 并验证离开预算（≤144 KB / ≤200 条 / ≤4 批）用尽即停手。
 *
 * **修复后的口径**（依据 `tests/e2e/beacon-quota.spec.mjs` 的两引擎实测，见 `docs/reports/e2e-real-browser.md`）：
 * 浏览器除单次上限外还有「同一同步回合累计在途额度 ≈64 KiB」，因此 80 KB 必须拆成
 * 「每片 ≤32 KiB + 每回合 ≤64 KiB + 回合之间让出主线程」；超预算的片**二次切片**（头部优先），
 * 不再整片丢弃。
 *
 * `sendBeacon` 与 `fetch keepalive` 都拿不到 202，因此这里**不产生任何"已送达"信号**。
 */
import { describe, expect, test } from 'vitest';
import type { QueueEvent } from '../batch/types';
import { createCountersSpy, makeBatch, makeEvent } from '../offline/fixtures';
import { BEACON_INFLIGHT_BYTES, BEACON_MAX_BYTES, BEACON_SLICE_BYTES, LEAVE_BUDGET } from './constants';
import { createFakeCredentials, createFakeTransport } from './fixtures';
import { createLeaveSender, sliceForBeacon } from './page-leave';
import type { NativeHttpRefs } from './types';

/** 手动波次调度器：`schedule` 被调用即记下「此刻已发出的片数」，测试随后 `drain()` 逐波恢复。 */
function createWaveRecorder(blobs: readonly Blob[]): {
  readonly boundaries: number[];
  readonly schedule: (flush: () => void) => void;
  drain(): void;
} {
  const pending: (() => void)[] = [];
  const boundaries: number[] = [];
  return {
    boundaries,
    schedule(flush: () => void): void {
      boundaries.push(blobs.length);
      pending.push(flush);
    },
    drain(): void {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

/** 每个同步回合实际写入的字节数（按 `schedule` 的边界切分；浏览器额度按真实字节计）。 */
function waveBytes(blobs: readonly Blob[], boundaries: readonly number[]): number[] {
  const marks = [0, ...boundaries, blobs.length];
  const totals: number[] = [];
  for (let index = 1; index < marks.length; index += 1) {
    const from = marks[index - 1] ?? 0;
    const to = marks[index] ?? 0;
    let total = 0;
    for (let cursor = from; cursor < to; cursor += 1) total += blobs[cursor]?.size ?? 0;
    if (total > 0) totals.push(total);
  }
  return totals;
}

/** 按发出顺序读出各请求正文字段里的事件 `event_id`。 */
async function blobEventIds(blobs: readonly Blob[]): Promise<string[]> {
  const ids: string[] = [];
  for (const blob of blobs) {
    const body = JSON.parse(await blob.text()) as { events?: { readonly event_id?: string }[] };
    for (const event of body.events ?? []) {
      if (event.event_id !== undefined) ids.push(event.event_id);
    }
  }
  return ids;
}

function beaconSpy(accepted: boolean): {
  readonly blobs: Blob[];
  readonly urls: string[];
  readonly types: string[];
  readonly http: NativeHttpRefs;
} {
  const blobs: Blob[] = [];
  const urls: string[] = [];
  const types: string[] = [];
  return {
    blobs,
    urls,
    types,
    http: {
      sendBeacon: ((url: string, data: BodyInit): boolean => {
        urls.push(url);
        if (data instanceof Blob) {
          blobs.push(data);
          types.push(data.type);
        }
        return accepted;
      }) as (url: string, data: BodyInit) => boolean,
    },
  };
}

/**
 * AC-03 的真机载荷（**逐字段复刻** `tests/e2e/probes/leave-slice-driver.js` 的
 * `112 × (520 B attachment + 8 个数字 metrics)`）：实测单事件原文 **743 B**
 * （见 `docs/reports/e2e-real-browser.md` 追加节第 2 次的「估算器高估 24%」一条）。
 */
function ac03Event(index: number): QueueEvent {
  const metrics: Record<string, number> = {};
  for (let slot = 0; slot < 8; slot += 1) metrics[`m${String(slot)}`] = 1;
  return {
    event_id: `ac03-${String(index).padStart(4, '0')}`,
    event_name: 'ac03_slice',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: 1_750_000_000_000 + index,
    priority: 'normal',
    attachment: 'A'.repeat(520),
    metrics,
  };
}

function ac03Events(count = 112): readonly QueueEvent[] {
  return Array.from({ length: count }, (_, index) => ac03Event(index));
}

/**
 * 复刻真机「**同一同步回合累计在途额度**」的信标假实现：本回合累计写入再加 `size` 就超
 * `quotaBytes` 时返回 `false`（浏览器行为；实测 `sync-32x32 → [true,true]`、
 * `sync-21×4 → [true,true,true,false]`）。**不自动重置**：重置只能由 `newTurn()` 显式做，
 * 用来区分「同一回合」与「跨任务」两种情形。
 */
function quotaBeacon(quotaBytes: number): {
  readonly blobs: Blob[];
  readonly http: NativeHttpRefs;
  readonly rejected: number;
  readonly written: number;
  newTurn(): void;
} {
  const blobs: Blob[] = [];
  const state = { bytes: 0, rejected: 0, written: 0 };
  const http: NativeHttpRefs = {
    sendBeacon: ((_url: string, data: BodyInit): boolean => {
      const size = data instanceof Blob ? data.size : 0;
      if (state.bytes + size > quotaBytes) {
        state.rejected += 1;
        return false;
      }
      state.bytes += size;
      state.written += size;
      if (data instanceof Blob) blobs.push(data);
      return true;
    }) as (url: string, data: BodyInit) => boolean,
  };
  return {
    blobs,
    http,
    get rejected() {
      return state.rejected;
    },
    get written() {
      return state.written;
    },
    newTurn(): void {
      state.bytes = 0;
    },
  };
}

/** 一个同步回合里已写入的字节合计（用于「按回合约束」的判定）。 */
function totalBytes(blobs: readonly Blob[]): number {
  return blobs.reduce((sum, blob) => sum + blob.size, 0);
}

describe('C07-AC-03 离开通道', () => {
  test('AC-03 80 KB 数据切成至少两个不超过 60 KB 的请求', () => {
    const events = Array.from({ length: 8 }, () => makeEvent({ bytes: 10_000 }));
    const batch = makeBatch({ events });
    const slices = sliceForBeacon(batch, BEACON_MAX_BYTES - 256);
    expect(slices.length).toBeGreaterThanOrEqual(2);
    for (const slice of slices) {
      expect(JSON.stringify(slice).length).toBeLessThanOrEqual(BEACON_MAX_BYTES);
      // event_id 不变
      expect(slice.events.map((event) => event.event_id)).toEqual(
        batch.events
          .filter((event) => slice.events.some((item) => item.event_id === event.event_id))
          .map((event) => event.event_id),
      );
    }
    const totalEvents = slices.reduce((sum, slice) => sum + slice.events.length, 0);
    expect(totalEvents).toBe(events.length);
  });

  test('AC-03 信标请求为 text/plain，令牌在 body 的 auth 字段（不在 URL）', async () => {
    const spy = beaconSpy(true);
    const credentials = createFakeCredentials();
    const leave = createLeaveSender({
      credentials: credentials.port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
    });
    leave.resetBudget();
    const result = leave.send(makeBatch());
    expect(result.accepted).toBe(true);
    expect(result.requests).toBe(1);
    expect(spy.types[0]?.toLowerCase()).toBe('text/plain;charset=utf-8');
    expect(spy.urls[0]?.includes(credentials.current.writeToken)).toBe(false);
    const body = JSON.parse((await spy.blobs[0]?.text()) ?? '{}') as {
      auth?: { app_id?: string; write_token?: string };
    };
    expect(body.auth?.app_id).toBe('demo-app');
    expect(body.auth?.write_token).toBe(credentials.current.writeToken);
  });

  test('离开预算用尽即停手并记录 skipped（不把没发出去的批次当成已发）', () => {
    const spy = beaconSpy(true);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
      budget: { maxBatches: 1, maxEvents: 10, maxBytes: LEAVE_BUDGET.maxBytes },
    });
    leave.resetBudget();
    const first = leave.send(makeBatch({ events: [makeEvent(), makeEvent()] }));
    const second = leave.send(makeBatch({ events: [makeEvent(), makeEvent()] }));
    expect(first.requests).toBe(1);
    expect(second.requests).toBe(0);
    expect(second.skippedEvents).toBe(2);
    expect(leave.stats().skipped).toBeGreaterThanOrEqual(2);
  });

  test('信标返回 false：计 retry_network 并把批次留给下次加载补发', () => {
    const counters = createCountersSpy();
    const spy = beaconSpy(false);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      counters: counters.port,
      now: () => 1_700_000_000_000,
    });
    leave.resetBudget();
    const result = leave.send(makeBatch());
    expect(result.accepted).toBe(false);
    expect(counters.get('retry_network')).toBeGreaterThanOrEqual(1);
  });

  test('没有信标能力时退化到 fetch keepalive，且不把 Promise 结果当送达', () => {
    const transport = createFakeTransport();
    transport.setDefault(503);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: {},
      transport: transport.transport,
      now: () => 1_700_000_000_000,
    });
    leave.resetBudget();
    const result = leave.send(makeBatch());
    expect(result.accepted).toBe(false);
    expect(result.requests).toBe(1);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.keepalive).toBe(true);
  });

  test('单条事件批次不切片（保持原 batch_id）', () => {
    const batch = makeBatch({ events: [makeEvent()] });
    const slices = sliceForBeacon(batch, BEACON_MAX_BYTES - 256);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.batch_id).toBe(batch.batch_id);
  });

  test('体积预算用尽时后续切片被跳过并计入 skipped', () => {
    const spy = beaconSpy(true);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
      budget: { maxBytes: 10, maxBatches: 10, maxEvents: 100 },
    });
    leave.resetBudget();
    const result = leave.send(makeBatch());
    expect(result.requests).toBe(0);
    expect(result.skippedEvents).toBe(1);
  });

  test('超过软时间上限后不再发送', () => {
    let current = 1_000;
    const spy = beaconSpy(true);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => current,
      budget: { maxMs: 1, maxBatches: 10, maxEvents: 100, maxBytes: LEAVE_BUDGET.maxBytes },
    });
    leave.resetBudget();
    current = 5_000;
    const result = leave.send(makeBatch());
    expect(result.requests).toBe(0);
  });

  test('没有凭据时不发送、计 skipped，不抛错', () => {
    const spy = beaconSpy(true);
    const leave = createLeaveSender({
      credentials: { current: () => null },
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
    });
    leave.resetBudget();
    const result = leave.send(makeBatch());
    expect(result.requests).toBe(0);
    expect(result.accepted).toBe(false);
    expect(spy.blobs).toHaveLength(0);
  });

  test('AC-03 修复：切片参数与实测额度一致（预算 ≥ 80 KB 载荷、两片装得下一个回合）', () => {
    // 依据 `tests/e2e/results/beacon-quota-{chromium,webkit}.json`：
    // `sync-32x32 → [true,true]`（合计 64 KiB）被接受，`sync-40x40 → [true,false]`（80 KiB）被拒。
    expect(LEAVE_BUDGET.maxBytes, '默认离开预算必须容纳 AC-03 的 80 KB 载荷').toBeGreaterThanOrEqual(80 * 1024);
    expect(BEACON_SLICE_BYTES).toBeLessThanOrEqual(32 * 1024);
    expect(BEACON_INFLIGHT_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(BEACON_SLICE_BYTES * 2).toBeLessThanOrEqual(BEACON_INFLIGHT_BYTES);
    expect(LEAVE_BUDGET.maxEvents).toBeGreaterThanOrEqual(200);
  });

  test('AC-03 修复：默认预算下 80 KB 全部发出（无 skipped）、切 ≥2 片、每回合 ≤ 实测额度', async () => {
    const events = Array.from({ length: 8 }, () => makeEvent({ bytes: 10_000 }));
    const spy = beaconSpy(true);
    const recorder = createWaveRecorder(spy.blobs);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
      schedule: recorder.schedule,
    });
    leave.resetBudget();
    const result = leave.send(makeBatch({ events }));
    recorder.drain();
    const stats = leave.stats();

    expect(result.accepted).toBe(true);
    expect(stats.sent, '默认预算下不得丢事件').toBe(events.length);
    expect(stats.skipped).toBe(0);
    expect(stats.budgetStops).toBe(0);
    expect(stats.requests, 'AC-03：至少两个信标请求').toBeGreaterThanOrEqual(2);
    for (const blob of spy.blobs) {
      expect(blob.size, '每片不得超过契约的 60 KB').toBeLessThanOrEqual(BEACON_MAX_BYTES);
    }
    // 波次：超过累计在途额度的片必须让出主线程后再发。
    expect(recorder.boundaries.length, '超过 64 KiB 时必须有波次让出').toBeGreaterThanOrEqual(1);
    for (const total of waveBytes(spy.blobs, recorder.boundaries)) {
      expect(total, '每个同步回合写入不得超过实测累计在途额度').toBeLessThanOrEqual(BEACON_INFLIGHT_BYTES);
    }
    const ids = await blobEventIds(spy.blobs);
    expect(ids, '保序且无重复').toEqual(events.map((event) => event.event_id));
  });

  test('AC-03 修复：预算小于载荷时二次切片（头部优先），不整片丢弃', async () => {
    const events = Array.from({ length: 8 }, () => makeEvent({ bytes: 10_000 }));
    const spy = beaconSpy(true);
    const recorder = createWaveRecorder(spy.blobs);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
      budget: { maxBytes: 45 * 1024, maxBatches: 99, maxEvents: 999, maxMs: 10_000 },
      schedule: recorder.schedule,
    });
    leave.resetBudget();
    const result = leave.send(makeBatch({ events }));
    recorder.drain();
    const stats = leave.stats();
    const ids = await blobEventIds(spy.blobs);

    // 预算不够时也必须先保证**头部**：第一条事件必须发出，且发出的序列必须是原始序列的前缀。
    expect(ids.length, '二次切片后必须仍有事件被发出').toBeGreaterThan(0);
    expect(ids[0], '不得整片丢弃头部').toBe(events[0]?.event_id);
    expect(ids).toEqual(events.slice(0, ids.length).map((event) => event.event_id));
    expect(stats.sent).toBe(ids.length);
    expect(stats.skipped, '预算不足的尾部仍要计数').toBe(events.length - ids.length);
    expect(stats.skipped).toBeGreaterThan(0);
    expect(stats.budgetStops, 'CR-008：预算停手必须可观测').toBeGreaterThanOrEqual(1);
    expect(result.requests).toBeGreaterThanOrEqual(1);
    for (const blob of spy.blobs) {
      expect(blob.size).toBeLessThanOrEqual(BEACON_MAX_BYTES);
    }
  });

  test('dispose 后待发波次不再发送（离开路径结束即停手）', () => {
    const events = Array.from({ length: 8 }, () => makeEvent({ bytes: 10_000 }));
    const spy = beaconSpy(true);
    const recorder = createWaveRecorder(spy.blobs);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
      schedule: recorder.schedule,
    });
    leave.resetBudget();
    leave.send(makeBatch({ events }));
    expect(recorder.boundaries.length, '前置：确实有待发波次').toBeGreaterThanOrEqual(1);
    const sentBeforeDispose = spy.blobs.length;
    leave.dispose();
    recorder.drain();
    expect(spy.blobs.length, 'dispose 后不得再发信标').toBe(sentBeforeDispose);
    const afterDispose = leave.send(makeBatch({ events }));
    recorder.drain();
    expect(afterDispose.requests).toBe(0);
    expect(spy.blobs.length).toBe(sentBeforeDispose);
  });

  test('AC-03 第 3 步①：同一同步回合的累计写入必须 ≤ 实测额度（真机 112 事件载荷）', async () => {
    // 真机失败形态（`docs/reports/e2e-real-browser.md` 追加节第 2 次）：4 片全在**同一个同步回合**
    // 写完，累计 105564 B 撞上浏览器 ≈64 KiB 的回合额度 → 第 4 片被拒、静默丢 35 条。
    // 依据：`beacon-quota-*.json`（`sync-21x21x21x21 → [true,true,true,false]`、
    // `sync-32x32 → [true,true]`、`raf-28x28x28 → [true,true,true]`）。
    const events = ac03Events();
    const spy = beaconSpy(true);
    const recorder = createWaveRecorder(spy.blobs);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
      schedule: recorder.schedule,
    });
    leave.resetBudget();
    leave.send(makeBatch({ events }));

    // `send()` 返回时写入的片就是「本回合」写入的片（还没有任何让出）。
    const syncTurnBytes = totalBytes(spy.blobs);
    expect(spy.blobs.length, '同步部分至少要写出一片').toBeGreaterThanOrEqual(1);
    expect(
      syncTurnBytes,
      `同一同步回合写入 ${String(syncTurnBytes)} B 不得超过实测累计额度 ${String(
        BEACON_INFLIGHT_BYTES,
      )} B`,
    ).toBeLessThanOrEqual(BEACON_INFLIGHT_BYTES);

    recorder.drain();
    const stats = leave.stats();
    expect(stats.sent, '默认预算下不得丢事件').toBe(events.length);
    expect(stats.skipped).toBe(0);
    expect(recorder.boundaries.length, '超出回合额度必须让出').toBeGreaterThanOrEqual(1);
    for (const total of waveBytes(spy.blobs, recorder.boundaries)) {
      expect(total, '每个同步回合写入不得超过实测累计额度').toBeLessThanOrEqual(BEACON_INFLIGHT_BYTES);
    }
    const ids = await blobEventIds(spy.blobs);
    expect(ids, '保序且无重复').toEqual(events.map((event) => event.event_id));
  });

  test('AC-03 第 3 步②：估算器校准后 112 事件 80 KB 只需 3 片，且每片贴近 32 KiB 目标', () => {
    // 真机实测：单事件原文 743 B、`queue/size.ts` 估 923 B（高估 24%），于是 32 KiB 阈值
    // 只产出 26391 B 的片 → 80 KB 变 4 片 → 4 次写挤在同一回合。校准后每片必须真的接近目标。
    const batch = makeBatch({ events: ac03Events() });
    const slices = sliceForBeacon(batch, BEACON_SLICE_BYTES);
    expect(slices.length, '112 事件 / 80 KB 必须只需 3 片').toBe(3);
    const sizes = slices.map((slice) => JSON.stringify(slice).length);
    for (const bytes of sizes) {
      expect(bytes, '每片不得超过契约的 60 KB').toBeLessThanOrEqual(BEACON_MAX_BYTES);
      expect(bytes, '每片不得超过 32 KiB 的切片目标').toBeLessThanOrEqual(BEACON_SLICE_BYTES);
    }
    // 除最后一片是余数外，前面的片必须真的装满（不能被估算虚高掏空）。
    for (const bytes of sizes.slice(0, -1)) {
      expect(bytes, '满片必须接近 32 KiB 的目标（旧口径只有 26391 B）').toBeGreaterThanOrEqual(
        27 * 1024,
      );
    }
    expect(slices.reduce((sum, slice) => sum + slice.events.length, 0)).toBe(112);
  });

  test('AC-03 第 3 步③：未注入 schedule 时默认路径真的让出（后续片在新任务里写）', async () => {
    // 真机结论：默认 `schedule` 立即执行 → 后续片没有被推到下一个同步回合（追加节第 2 次第 4 条）。
    // 这里不注入任何调度钩子：`send()` 只许写满**一个**回合，剩下的必须在真实让出（宏任务）之后写。
    const events = ac03Events();
    const spy = beaconSpy(true);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
    });
    leave.resetBudget();
    leave.send(makeBatch({ events }));

    const syncCount = spy.blobs.length;
    expect(syncCount, '同步部分至少要写出一片').toBeGreaterThanOrEqual(1);
    expect(
      totalBytes(spy.blobs),
      '默认路径也必须把同一回合的累计写入压在实测额度内',
    ).toBeLessThanOrEqual(BEACON_INFLIGHT_BYTES);
    expect(syncCount, '至少有一片必须被推到下一个同步回合').toBeLessThan(3);

    for (let round = 0; round < 5 && spy.blobs.length < 3; round += 1) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });
    }
    expect(spy.blobs.length, '让出之后剩余片必须真的写出去').toBeGreaterThan(syncCount);
    const stats = leave.stats();
    expect(stats.sent, '默认路径下 112 条都要发出').toBe(events.length);
    expect(stats.skipped).toBe(0);
    expect(stats.budgetStops).toBe(0);
  });

  test('AC-03 第 3 步④：信标被拒的整片事件必须计入 skipped（stats 不得乐观自报）', () => {
    // 真机失败形态：SDK `requests=4` 而接收端只有 3 片，第 4 片被拒且**不重试不再切**；
    // 而 `leave.stats={"sent":112,"skipped":0,"budgetStops":0}` 自报全绿，丢失只在不进 stats 的
    // `counters.retry_network` 里。这里用「同一回合累计额度」的假信标复刻同一形态。
    const events = ac03Events();
    const beacon = quotaBeacon(64 * 1024);
    const counters = createCountersSpy();
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: beacon.http,
      transport: createFakeTransport().transport,
      counters: counters.port,
      now: () => 1_700_000_000_000,
      // 立即执行的调度（等价于修复前的默认路径）：回合额度不会真正重置。
      schedule: (flush: () => void): void => {
        flush();
      },
    });
    leave.resetBudget();
    leave.send(makeBatch({ events }));

    const stats = leave.stats();
    const delivered = beacon.blobs.reduce((sum, blob) => sum + blob.size, 0);
    expect(beacon.rejected, '前置：本用例必须真的触发浏览器拒绝').toBeGreaterThanOrEqual(1);
    expect(delivered).toBeLessThanOrEqual(64 * 1024);
    expect(
      stats.sent + stats.skipped,
      'stats 必须对账：发出的 + 丢掉的 = 提交的总数（不得把被拒的片算成已发）',
    ).toBe(events.length);
    expect(stats.skipped, '被拒整片的事件数必须出现在 skipped 里').toBeGreaterThan(0);
    expect(stats.sent, '被拒的片不得计入 sent').toBe(events.length - stats.skipped);
    expect(stats.budgetStops, 'CR-008：因额度停手必须可观测').toBeGreaterThanOrEqual(1);
    expect(counters.get('retry_network'), '既有的 counters 出口保持不变').toBeGreaterThanOrEqual(1);
  });

  test('AC-03 第 3 步④：dispose 丢掉的待发片必须计入 skipped（不得静默丢）', async () => {
    const events = ac03Events();
    const spy = beaconSpy(true);
    const recorder = createWaveRecorder(spy.blobs);
    const leave = createLeaveSender({
      credentials: createFakeCredentials().port,
      http: spy.http,
      transport: createFakeTransport().transport,
      now: () => 1_700_000_000_000,
      schedule: recorder.schedule,
    });
    leave.resetBudget();
    leave.send(makeBatch({ events }));
    expect(recorder.boundaries.length, '前置：必须有片落在待发波次里').toBeGreaterThanOrEqual(1);

    leave.dispose();
    recorder.drain();
    const stats = leave.stats();
    const delivered = (await blobEventIds(spy.blobs)).length;
    expect(delivered, '前置：确实有事件没写出去').toBeLessThan(events.length);
    expect(stats.sent).toBe(delivered);
    expect(stats.skipped, 'dispose 丢掉的事件数必须在 stats 里可见').toBe(events.length - delivered);
    expect(stats.budgetStops).toBeGreaterThanOrEqual(1);
  });
});
