/**
 * C07 装配层：预写接线（AC-12 / AC-13）、适配器注入（AC-20）、清理（AC-21）、
 * 以及 CR-001 暴露窗口指标的 ≥1 上报规则。
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import type { BatchEnvelope } from '../batch/types';
import { createCountersSpy, createRecordingBackend, makeBatch, makeEvent, TEST_HEADER } from '../offline/fixtures';
import type { ExposureStats, OfflineStats, OfflineStore } from '../offline/types';
import type { SubmitContext } from '../queue/types';
import { createDelivery, createDomPageEventsSource } from './delivery';
import type { PageResumeReason } from './delivery';
import { createFakeCredentials, createFakeTransport } from './fixtures';
import type { NativeHttpRefs } from './types';

function createPageEventsSpy(): {
  readonly fire: (reason: PageResumeReason) => void;
  readonly port: { subscribe: (handler: (reason: PageResumeReason) => void) => () => void };
  readonly unsubscribed: () => boolean;
} {
  const handlers: ((reason: PageResumeReason) => void)[] = [];
  return {
    fire(reason: PageResumeReason): void {
      for (const handler of handlers) handler(reason);
    },
    unsubscribed: (): boolean => handlers.length === 0,
    port: {
      subscribe(handler: (reason: PageResumeReason) => void): () => void {
        handlers.push(handler);
        return (): void => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
    },
  };
}

function createBeaconSpy(accepted: boolean): {
  readonly blobs: Blob[];
  readonly types: string[];
  readonly http: NativeHttpRefs;
} {
  const blobs: Blob[] = [];
  const types: string[] = [];
  return {
    blobs,
    types,
    http: {
      sendBeacon: ((_url: string, data: BodyInit): boolean => {
        if (data instanceof Blob) {
          blobs.push(data);
          types.push(data.type);
        }
        return accepted;
      }) as (url: string, data: BodyInit) => boolean,
    },
  };
}

const NEVER = new Promise<never>(() => undefined);

describe('C07 装配层', () => {
  test('AC-20 注入的自定义传输与离线后端都被真实使用', async () => {
    const recorder = createRecordingBackend();
    const transport = createFakeTransport();
    transport.push(202);
    const counters = createCountersSpy();
    const delivery = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      header: { header: () => TEST_HEADER },
      counters: counters.port,
      offline: { backend: recorder.backend, limits: { commitIntervalMs: 5 } },
    });
    try {
      const batch = makeBatch();
      let completed: string | null = null;
      const context: SubmitContext = {
        channel: 'default',
        complete: (outcome) => {
          completed = outcome;
        },
      };
      delivery.submit.submit(batch, context);
      await delivery.offline.drain();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(transport.requests).toHaveLength(1);
      // 离线后端确实被写入过（AC-20：用的是注入的存储适配器）
      expect(recorder.writes.length).toBeGreaterThanOrEqual(1);
      // 202 之后副本被删除（AC-04）
      expect(recorder.records.size).toBe(0);
      expect(completed).toBe('sent');
    } finally {
      delivery.dispose();
    }
  });

  test('AC-12 响应前"强杀"：离线副本保留，重启后按同一 event_id 补发并删除副本', async () => {
    const recorder = createRecordingBackend();
    const first = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: { send: () => NEVER },
      header: { header: () => TEST_HEADER },
      offline: { backend: recorder.backend, limits: { commitIntervalMs: 5 } },
    });
    const batch = makeBatch();
    try {
      first.submit.submit(batch, { channel: 'default', complete: () => undefined });
      await first.offline.drain();
      // 事务已落盘、响应还没来：副本必须在（"已落盘不丢"）
      expect(recorder.records.has(batch.batch_id)).toBe(true);
    } finally {
      first.dispose();
    }
    // "重启"：同一份离线数据 + 可用的传输
    const transport = createFakeTransport();
    transport.push(202);
    const counters = createCountersSpy();
    const second = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-b',
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      header: { header: () => TEST_HEADER },
      counters: counters.port,
      offline: { backend: recorder.backend, limits: { commitIntervalMs: 5 } },
    });
    try {
      const result = await second.replay('startup');
      expect(result.leader).toBe(true);
      expect(result.events).toBe(batch.events.length);
      expect(counters.get('replayed')).toBe(1);
      expect(recorder.records.size).toBe(0);
      const sent = JSON.parse(transport.requests[0]?.body ?? '{}') as {
        batch_id?: string;
        events?: { event_id: string; replayed?: boolean }[];
      };
      expect(sent.batch_id).toBe(batch.batch_id);
      expect(sent.events?.map((event) => event.event_id)).toEqual(
        batch.events.map((event) => event.event_id),
      );
      expect(sent.events?.every((event) => event.replayed === true)).toBe(true);
    } finally {
      second.dispose();
    }
  });

  test('AC-13 信标通道：sendBeacon 返回 true 也不删离线副本，等常规通道 202 确认', async () => {
    const recorder = createRecordingBackend();
    const beacon = createBeaconSpy(true);
    const transport = createFakeTransport();
    transport.push(202);
    const delivery = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      http: beacon.http,
      header: { header: () => TEST_HEADER },
      offline: { backend: recorder.backend, limits: { commitIntervalMs: 5 } },
    });
    try {
      const batch = makeBatch();
      let outcome: string | null = null;
      delivery.submit.submit(batch, {
        channel: 'page_leave',
        complete: (value) => {
          outcome = value;
        },
      });
      await delivery.offline.drain();
      expect(beacon.blobs.length).toBeGreaterThanOrEqual(1);
      expect(beacon.types[0]).toContain('text/plain');
      const beaconBody = JSON.parse((await beacon.blobs[0]?.text()) ?? '{}') as {
        auth?: { app_id?: string; write_token?: string };
      };
      expect(beaconBody.auth?.app_id).toBe('demo-app');
      expect(beaconBody.auth?.write_token).toBeTruthy();
      // 信标返回 true 只表示"浏览器接受"，不是送达：副本必须还在
      expect(recorder.records.has(batch.batch_id)).toBe(true);
      expect(outcome).toBe('failed');

      // 下一次启动由常规通道确认后才删除
      const result = await delivery.replay('startup');
      expect(result.leader).toBe(true);
      expect(recorder.records.size).toBe(0);
      const confirmed = JSON.parse(transport.requests[0]?.body ?? '{}') as {
        auth?: unknown;
        events?: { event_id: string }[];
      };
      expect(confirmed.auth).toBeUndefined();
      expect(confirmed.events?.length).toBe(1);
    } finally {
      delivery.dispose();
    }
  });

  test('AC-21 clearOffline 清空离线数据（撤回同意 / 注销）', async () => {
    const recorder = createRecordingBackend();
    const delivery = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: { send: () => NEVER },
      header: { header: () => TEST_HEADER },
      offline: { backend: recorder.backend, limits: { commitIntervalMs: 5 } },
    });
    try {
      delivery.submit.submit(makeBatch(), { channel: 'default', complete: () => undefined });
      await delivery.offline.drain();
      expect(recorder.records.size).toBe(1);
      await delivery.clearOffline();
      expect(recorder.records.size).toBe(0);
    } finally {
      delivery.dispose();
    }
  });

  test('AC-15 启动与页面恢复都触发补发；销毁后不再有监听', async () => {
    const recorder = createRecordingBackend();
    const pageEvents = createPageEventsSpy();
    const transport = createFakeTransport();
    const delivery = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      pageEvents: pageEvents.port,
      header: { header: () => TEST_HEADER },
      offline: { backend: recorder.backend, limits: { commitIntervalMs: 5 } },
    });
    try {
      // 初始提交处于失败态，副本保留下来待补发
      transport.setDefault(503);
      delivery.submit.submit(makeBatch(), { channel: 'default', complete: () => undefined });
      await delivery.offline.drain();
      expect(recorder.records.size).toBe(1);

      transport.setDefault(202);
      const stop = delivery.start();
      expect(delivery.metrics().lastReplayReason).toBe('startup');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });

      pageEvents.fire('visible');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      const metrics = delivery.metrics();
      expect(metrics.offlineReplayed, JSON.stringify(metrics)).toBeGreaterThanOrEqual(1);

      stop();
      expect(pageEvents.unsubscribed()).toBe(true);
    } finally {
      delivery.dispose();
    }
  });

  test('CR-001 exposureMetrics 只在事件数 ≥1 时上报，且值 ≥1', () => {
    const makeStub = (exposure: ExposureStats): OfflineStore => {
      const stats: OfflineStats = {
        storedBatches: 0,
        storedEvents: 0,
        storedBytes: 0,
        evictedBatches: 0,
        evictedEvents: 0,
        writeFailures: 0,
        ready: true,
        available: true,
        exposure,
      };
      return {
        prewrite: () => ({
          batchId: 'x',
          eventCount: 0,
          criticalCount: 0,
          bytes: 0,
          settled: Promise.resolve({ status: 'durable' }),
        }),
        spill: () => false,
        list: () => Promise.resolve([]),
        read: () => Promise.resolve(null),
        markAttempt: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        stats: () => stats,
        quota: () => Promise.resolve(null),
        commitLoss: () => ({ events: 0, windowMs: 0, sessionIds: [] }),
        ready: () => Promise.resolve(),
        drain: () => Promise.resolve(),
        dispose: () => undefined,
      };
    };
    const empty = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: { send: () => NEVER },
      offline: makeStub({
        pendingBatches: 0,
        pendingEvents: 0,
        oldestPendingMs: null,
        commitLatencyP50Ms: null,
        commitLatencyP95Ms: null,
        commitLostEvents: 0,
        commitLostWindowMs: null,
      }),
    });
    expect(empty.exposureMetrics()).toEqual([]);
    empty.dispose();

    const lost = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: { send: () => NEVER },
      offline: makeStub({
        pendingBatches: 0,
        pendingEvents: 0,
        oldestPendingMs: null,
        commitLatencyP50Ms: null,
        commitLatencyP95Ms: null,
        commitLostEvents: 3,
        commitLostWindowMs: 1200.4,
      }),
    });
    expect(lost.exposureMetrics()).toEqual([
      { name: 'exposure_window_events', value: 3 },
      { name: 'exposure_window_ms', value: 1200 },
    ]);
    lost.dispose();
  });

  test('wireEnqueue：critical 事件立即冲刷，normal 事件只入队', () => {
    const enqueued: string[] = [];
    const flushes: string[] = [];
    const queue = {
      enqueue: (event: { event_id: string }): void => {
        enqueued.push(event.event_id);
      },
      flush: (reason?: string): void => {
        flushes.push(reason ?? 'default');
      },
    };
    const delivery = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: { send: () => NEVER },
    });
    try {
      const sink = delivery.wireEnqueue(queue);
      sink({ ...makeEvent({ priority: 'critical' }) });
      sink({ ...makeEvent({ priority: 'normal' }) });
      expect(enqueued).toHaveLength(2);
      expect(flushes).toEqual(['events']);
    } finally {
      delivery.dispose();
    }
  });

  test('离线存储不可用时装配层仍不抛错（critical 降级）', async () => {
    const counters = createCountersSpy();
    const delivery = createDelivery({
      appId: 'demo-app',
      sessionId: 'session-a',
      credentials: createFakeCredentials().port,
      transport: { send: () => NEVER },
      counters: counters.port,
      offline: { idbFactory: null },
    });
    try {
      await delivery.offline.ready();
      let outcome: string | null = null;
      const batch: BatchEnvelope = makeBatch();
      delivery.submit.submit(batch, {
        channel: 'default',
        complete: (value) => {
          outcome = value;
        },
      });
      expect(outcome).toBeNull();
      expect(counters.get('storage_unavailable')).toBeGreaterThanOrEqual(1);
    } finally {
      delivery.dispose();
    }
  });
});

describe('C07 页面恢复事件的 DOM 适配', () => {
  test('online / visibilitychange(visible) / pageshow 都触发；注销后不再触发', () => {
    const listeners = new Map<string, () => void>();
    const target = {
      visibilityState: 'hidden',
      addEventListener(type: string, listener: () => void): void {
        listeners.set(type, listener);
      },
      removeEventListener(type: string): void {
        listeners.delete(type);
      },
    };
    const reasons: PageResumeReason[] = [];
    const source = createDomPageEventsSource(target);
    const unsubscribe = source.subscribe((reason) => reasons.push(reason));

    // 隐藏状态下的 visibilitychange 不触发
    listeners.get('visibilitychange')?.();
    expect(reasons).toEqual([]);

    target.visibilityState = 'visible';
    listeners.get('visibilitychange')?.();
    listeners.get('online')?.();
    listeners.get('pageshow')?.();
    expect(reasons).toEqual(['visible', 'online', 'pageshow']);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
