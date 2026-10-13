/**
 * C07-AC-14 / AC-15 / AC-16 补发：速率、分片、`replayed: true`、只等 202 才删副本、
 * 失败退避与终态删除。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, createRecordingBackend, makeBatch, TEST_HEADER } from '../offline/fixtures';
import { createOfflineStore } from '../offline/offline-store';
import { createFakeCredentials, createFakeTransport } from '../sender/fixtures';
import { createBatchSender } from '../sender/sender';
import { createLeaderElection } from './leader';
import { createReplayController, markReplayed } from './replay';

describe('C07-AC-14 补发', () => {
  test('AC-14 补发带 replayed: true、计 replayed、只等 202 才删副本', async () => {
    const recorder = createRecordingBackend();
    const offline = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    const transport = createFakeTransport();
    const counters = createCountersSpy();
    const sender = createBatchSender({
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      counters: counters.port,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    });
    const controller = createReplayController({
      offline,
      sender,
      leader: createLeaderElection({ tabId: 'tab-1', sleep: () => Promise.resolve() }),
      counters: counters.port,
      rate: () => 1,
      sleep: () => Promise.resolve(),
    });
    try {
      const batch = makeBatch();
      await offline.prewrite(batch).settled;

      // 第一次补发失败：副本保留、记一次尝试（把缺省响应设为 503，覆盖全部重试尝试）
      transport.setDefault(503);
      const failed = await controller.run();
      expect(failed.events).toBe(0);
      expect(recorder.records.has(batch.batch_id)).toBe(true);
      expect(recorder.summaries.get(batch.batch_id)?.attempt_count).toBe(1);

      // 第二次成功：事件带 replayed: true，副本被删除，计 replayed
      transport.setDefault(202);
      const ok = await controller.run();
      expect(ok.events).toBe(1);
      expect(recorder.records.size).toBe(0);
      expect(counters.get('replayed')).toBe(1);
      const body = JSON.parse(transport.requests[1]?.body ?? '{}') as {
        events?: { replayed?: boolean }[];
      };
      expect(body.events?.every((event) => event.replayed === true)).toBe(true);
    } finally {
      offline.dispose();
    }
  });

  test('AC-14 限速：单轮多批之间至少间隔 1000/rate 毫秒（rate=2 时 ≥500 ms）', async () => {
    const recorder = createRecordingBackend();
    const offline = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    const transport = createFakeTransport();
    const counters = createCountersSpy();
    const sleeps: number[] = [];
    const sender = createBatchSender({
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      counters: counters.port,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    });
    const controller = createReplayController({
      offline,
      sender,
      leader: createLeaderElection({ tabId: 'tab-1', sleep: () => Promise.resolve() }),
      counters: counters.port,
      rate: () => 2,
      sleep: (ms: number): Promise<void> => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    try {
      await offline.prewrite(makeBatch()).settled;
      await offline.prewrite(makeBatch()).settled;
      transport.push(202);
      transport.push(202);
      const result = await controller.run();
      expect(result.batches).toBe(2);
      expect(sleeps).toEqual([500]);
      // 每秒不超过 2 个批次：两份数据在 500 ms 间隔下用时 ≥500 ms
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
    } finally {
      offline.dispose();
    }
  });

  test('AC-16 超过单轮上限时只发一部分（单轮 ≤500 条、单批 ≤100 条）', async () => {
    const recorder = createRecordingBackend();
    const offline = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    const transport = createFakeTransport();
    transport.setDefault(202);
    const counters = createCountersSpy();
    const sender = createBatchSender({
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      counters: counters.port,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    });
    const controller = createReplayController({
      offline,
      sender,
      leader: createLeaderElection({ tabId: 'tab-1', sleep: () => Promise.resolve() }),
      counters: counters.port,
      rate: () => 1,
      sleep: () => Promise.resolve(),
      maxRoundEvents: 3,
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        await offline.prewrite(makeBatch()).settled;
      }
      const result = await controller.run();
      expect(result.events).toBe(3);
      expect(recorder.records.size).toBe(2);
      expect(controller.maxRoundEvents()).toBe(3);
    } finally {
      offline.dispose();
    }
  });

  test('终态失败（4xx）删除副本，避免补发死循环', async () => {
    const recorder = createRecordingBackend();
    const offline = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    const transport = createFakeTransport();
    const counters = createCountersSpy();
    const sender = createBatchSender({
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      counters: counters.port,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    });
    const controller = createReplayController({
      offline,
      sender,
      leader: createLeaderElection({ tabId: 'tab-1', sleep: () => Promise.resolve() }),
      counters: counters.port,
      rate: () => 1,
      sleep: () => Promise.resolve(),
    });
    try {
      await offline.prewrite(makeBatch()).settled;
      transport.push(400);
      const result = await controller.run();
      expect(result.events).toBe(0);
      expect(result.skipped).toBe(1);
      expect(recorder.records.size).toBe(0);
    } finally {
      offline.dispose();
    }
  });

  test('markReplayed 只改事件级标记，batch_id / event_id 不变', () => {
    const batch = makeBatch();
    const marked = markReplayed(batch);
    expect(marked.batch_id).toBe(batch.batch_id);
    expect(marked.events.map((event) => event.event_id)).toEqual(
      batch.events.map((event) => event.event_id),
    );
    expect(marked.events[0]?.replayed).toBe(true);
    // 原始批次不被修改
    expect(batch.events[0]?.replayed).toBeUndefined();
  });

  test('与正常发送不重复：同一批次被 202 确认后不会被再次补发', async () => {
    const recorder = createRecordingBackend();
    const offline = createOfflineStore({
      appId: 'demo-app',
      sessionId: 'session-a',
      backend: recorder.backend,
      header: { header: () => TEST_HEADER },
      limits: { commitBatchSize: 1, commitIntervalMs: 5 },
    });
    const transport = createFakeTransport();
    transport.setDefault(202);
    const counters = createCountersSpy();
    const sender = createBatchSender({
      credentials: createFakeCredentials().port,
      transport: transport.transport,
      counters: counters.port,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    });
    const controller = createReplayController({
      offline,
      sender,
      leader: createLeaderElection({ tabId: 'tab-1', sleep: () => Promise.resolve() }),
      counters: counters.port,
      rate: () => 1,
      sleep: () => Promise.resolve(),
    });
    try {
      const batch = makeBatch();
      await offline.prewrite(batch).settled;
      const first = await controller.run();
      expect(first.events).toBe(1);
      // 第二次补发：已经没有副本可发
      const second = await controller.run();
      expect(second.events).toBe(0);
      expect(transport.requests).toHaveLength(1);
    } finally {
      offline.dispose();
    }
  });
});
