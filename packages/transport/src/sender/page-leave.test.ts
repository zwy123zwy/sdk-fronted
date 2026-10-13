/**
 * C07-AC-03 页面离开通道：按 60 KB 切片、`text/plain`、令牌放在 body 的 `auth`；
 * 并验证离开预算（≤48 KB / ≤200 条 / ≤4 批）用尽即停手。
 *
 * `sendBeacon` 与 `fetch keepalive` 都拿不到 202，因此这里**不产生任何"已送达"信号**。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, makeBatch, makeEvent } from '../offline/fixtures';
import { BEACON_MAX_BYTES, LEAVE_BUDGET } from './constants';
import { createFakeCredentials, createFakeTransport } from './fixtures';
import { createLeaveSender, sliceForBeacon } from './page-leave';
import type { NativeHttpRefs } from './types';

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
});
