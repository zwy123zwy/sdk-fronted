/**
 * M01 侧对账能力（T32 缺口 5）：`tests/e2e/lib/receiver.mjs` 必须具备「去重 + 入库 + 计数」。
 *
 * 断言口径来自：
 * - `tests/acceptance/M01.md` M01-AC-06（同一批次重发只入库一次）、M01-AC-10（按
 *   `received` / `stored` / `duplicate` 分类计数并提供清零接口）；
 * - `docs/contracts/receiver-requirements.md` RR-05（按 `app_id` + `event_id` 在至少 7 天窗口内去重）
 *   与第 4 节（"以 M01 去重后入库计数为准"对账口径）；
 * - `docs/reports/reliability-reconciliation.md` 缺口 5（该接收端"没有去重、没有入库、没有计数"）。
 *
 * 本文件只测 `tests/e2e/lib/receiver.mjs` 这一个模块，不引入、也不修改它的既有断言口径：
 * 既有 `received` / `hits()` 行为仍然保留（见最后一个用例）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { httpRequestTo, type HttpResult } from './test-support.js';

type Json = Record<string, unknown>;

interface EventNameCounters {
  received_events: number;
  stored_events: number;
  duplicate_events: number;
}

interface BatchReconciliation {
  index: number;
  app_id: string;
  path: string;
  received_events: number;
  stored_events: number;
  duplicate_events: number;
  event_names: string[];
}

interface CounterSnapshot {
  received_batches: number;
  received_events: number;
  stored_batches: number;
  stored_events: number;
  duplicate_events: number;
  duplicate_rate: number;
  dedupe_window_ms: number;
  expired_dedupe_keys: number;
  unparsable_batches: number;
  rejected_invalid_json: number;
  rejected_invalid_structure: number;
  rejected_invalid_token: number;
  by_event_name: Record<string, EventNameCounters>;
  by_batch: BatchReconciliation[];
}

interface StoredEvent {
  app_id: string;
  event_id: string;
  event_name: string;
  [key: string]: unknown;
}

interface LedgerRequest {
  path: string;
  method: string | undefined;
  bytes: number;
  accepted: boolean;
}

interface E2eReceiver {
  url: string;
  port: number;
  received: LedgerRequest[];
  hits: (path: string) => LedgerRequest[];
  counters: { snapshot: () => CounterSnapshot; clear: () => void };
  events: { list: (appId?: string) => StoredEvent[]; size: (appId?: string) => number; clear: () => void };
  close: () => Promise<void>;
}

interface E2eReceiverOptions {
  dedupeWindowMs?: number;
  now?: () => number;
}

/** 定位 `tests/e2e/lib/receiver.mjs`：优先相对本模块，其次相对 cwd（Vitest 从仓库根运行）。 */
function receiverModuleFile(): string {
  try {
    const fromModule = resolve(new URL('../../../tests/e2e/lib/receiver.mjs', import.meta.url).pathname);
    if (existsSync(fromModule)) return fromModule;
  } catch {
    // import.meta.url 在 happy-dom 下可能不是 file: URL，走 cwd 分支
  }
  const fromCwd = resolve(process.cwd(), 'tests/e2e/lib/receiver.mjs');
  if (existsSync(fromCwd)) return fromCwd;
  throw new Error('找不到 tests/e2e/lib/receiver.mjs，请在仓库根目录运行测试');
}

/** 动态加载该 `.mjs`（不静态 import：它不属于本包的 TS 程序）。 */
async function loadE2eReceiver(): Promise<{
  startReceiver: (options?: E2eReceiverOptions) => Promise<E2eReceiver>;
}> {
  const specifier = pathToFileURL(receiverModuleFile()).href;
  return (await import(/* @vite-ignore */ specifier)) as {
    startReceiver: (options?: E2eReceiverOptions) => Promise<E2eReceiver>;
  };
}

/** 造一批可被去重键识别的 SDK 批次。 */
function batchOf(
  appId: string,
  batchId: string,
  events: Array<{ event_id: string; event_name: string }>,
): Json {
  return {
    app_id: appId,
    batch_id: batchId,
    protocol_version: 1,
    events: events.map((event) => ({
      event_id: event.event_id,
      event_name: event.event_name,
      event_type: 'business',
      schema_version: '1.0.0',
      occurred_at: '2026-10-16T00:00:00.000Z',
      priority: 'normal',
    })),
  };
}

const JSON_HEADERS = { 'content-type': 'application/json', 'x-app-id': 'e2e-real' };

const THREE_EVENTS = [
  { event_id: 'e0000000-0000-4000-8000-000000000001', event_name: 'order_created' },
  { event_id: 'e0000000-0000-4000-8000-000000000002', event_name: 'order_created' },
  { event_id: 'e0000000-0000-4000-8000-000000000003', event_name: 'page_view' },
];

let receiver: E2eReceiver | null = null;

afterEach(async () => {
  if (receiver !== null) {
    await receiver.close();
    receiver = null;
  }
});

async function start(options?: E2eReceiverOptions): Promise<E2eReceiver> {
  const { startReceiver } = await loadE2eReceiver();
  const started = await startReceiver(options);
  receiver = started;
  return started;
}

function portOf(target: E2eReceiver): number {
  return Number(new URL(target.url).port);
}

async function postBatch(target: E2eReceiver, path: string, batch: Json): Promise<HttpResult> {
  return httpRequestTo(portOf(target), path, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: Buffer.from(JSON.stringify(batch), 'utf8'),
  });
}

async function countersViaHttp(target: E2eReceiver, path: string): Promise<CounterSnapshot> {
  const result = await httpRequestTo(portOf(target), path);
  expect(result.status).toBe(200);
  return JSON.parse(result.body) as CounterSnapshot;
}

describe('对账①：重复送达率与去重后入库计数（M01-AC-06/10、RR-05）', () => {
  it('同一批次重发 3 次：stored 只算一次，received - stored === duplicate，并给出重复送达率', async () => {
    const target = await start();
    const batch = batchOf('e2e-real', 'batch-0001', THREE_EVENTS);
    for (let round = 0; round < 3; round += 1) {
      expect((await postBatch(target, '/ingest', batch)).status).toBe(202);
    }

    const snapshot = target.counters.snapshot();
    expect(snapshot.received_batches).toBe(3);
    expect(snapshot.received_events).toBe(9);
    expect(snapshot.stored_batches).toBe(1);
    expect(snapshot.stored_events).toBe(3);
    expect(snapshot.duplicate_events).toBe(6);
    expect(snapshot.received_events - snapshot.stored_events).toBe(snapshot.duplicate_events);
    expect(snapshot.duplicate_rate).toBeCloseTo(6 / 9, 10);

    // "以 M01 去重后入库计数为准"：入库表里确实只有 3 条
    expect(target.events.size()).toBe(3);
    expect(target.events.list().map((event) => event.event_id)).toEqual(
      THREE_EVENTS.map((event) => event.event_id),
    );
  });

  it('去重键是 app_id + event_id：换 app_id 后同一 event_id 仍入库', async () => {
    const target = await start();
    const batch = batchOf('e2e-real', 'batch-0002', THREE_EVENTS);
    expect((await postBatch(target, '/ingest', batch)).status).toBe(202);
    const otherApp = batchOf('other-app', 'batch-0002', THREE_EVENTS);
    expect((await postBatch(target, '/ingest', otherApp)).status).toBe(202);

    const snapshot = target.counters.snapshot();
    expect(snapshot.stored_events).toBe(6);
    expect(snapshot.duplicate_events).toBe(0);
    expect(snapshot.received_events - snapshot.stored_events).toBe(0);
    expect(target.events.size('e2e-real')).toBe(3);
    expect(target.events.size('other-app')).toBe(3);
  });
});

describe('对账②：按事件名分别计数（便于与 SDK 侧逐事件名对账）', () => {
  it('by_event_name 分别给出 received / stored / duplicate', async () => {
    const target = await start();
    const batch = batchOf('e2e-real', 'batch-0003', THREE_EVENTS);
    expect((await postBatch(target, '/ingest', batch)).status).toBe(202);
    expect((await postBatch(target, '/ingest', batch)).status).toBe(202);

    const { by_event_name: byName } = target.counters.snapshot();
    expect(byName['order_created']).toEqual({
      received_events: 4,
      stored_events: 2,
      duplicate_events: 2,
    });
    expect(byName['page_view']).toEqual({
      received_events: 2,
      stored_events: 1,
      duplicate_events: 1,
    });
  });
});

describe('对账③：按批次分别计数（逐批 received / stored / duplicate）', () => {
  it('by_batch 逐批记录事件名与三要素，索引与发送顺序一致', async () => {
    const target = await start();
    const first = batchOf('e2e-real', 'batch-0004', THREE_EVENTS.slice(0, 2));
    const second = batchOf('e2e-real', 'batch-0005', THREE_EVENTS.slice(0, 2));
    expect((await postBatch(target, '/ingest', first)).status).toBe(202);
    expect((await postBatch(target, '/gzip', second)).status).toBe(202);

    const batches = target.counters.snapshot().by_batch;
    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({
      index: 0,
      app_id: 'e2e-real',
      path: '/ingest',
      received_events: 2,
      stored_events: 2,
      duplicate_events: 0,
    });
    expect(batches[1]).toMatchObject({
      index: 1,
      app_id: 'e2e-real',
      path: '/gzip',
      received_events: 2,
      stored_events: 0,
      duplicate_events: 2,
    });
    expect(batches[1]?.event_names).toEqual(['order_created', 'order_created']);
  });
});

describe('对账④：RR-05 的 7 天窗口（默认口径 + 可配置）', () => {
  it('默认窗口是 7 天（604800000 ms），窗口内的重复计入 duplicate', async () => {
    const target = await start();
    const batch = batchOf('e2e-real', 'batch-0006', THREE_EVENTS);
    await postBatch(target, '/ingest', batch);
    await postBatch(target, '/ingest', batch);

    const snapshot = target.counters.snapshot();
    expect(snapshot.dedupe_window_ms).toBe(7 * 24 * 60 * 60 * 1000);
    expect(snapshot.duplicate_events).toBe(3);
    expect(snapshot.expired_dedupe_keys).toBe(0);
  });

  it('窗口可配置且按时钟判定：窗口内 duplicate、超窗后重新入库', async () => {
    let clock = 0;
    const target = await start({ dedupeWindowMs: 60_000, now: () => clock });
    const batch = batchOf('e2e-real', 'batch-0007', THREE_EVENTS);

    expect((await postBatch(target, '/ingest', batch)).status).toBe(202);
    clock = 59_000;
    expect((await postBatch(target, '/ingest', batch)).status).toBe(202);
    clock = 61_000;
    expect((await postBatch(target, '/ingest', batch)).status).toBe(202);

    const snapshot = target.counters.snapshot();
    expect(snapshot.dedupe_window_ms).toBe(60_000);
    expect(snapshot.received_events).toBe(9);
    expect(snapshot.stored_events).toBe(6);
    expect(snapshot.duplicate_events).toBe(3);
    expect(snapshot.expired_dedupe_keys).toBe(3);
    expect(target.events.size()).toBe(6);
  });
});

describe('对账⑤：读接口与清零接口（对齐 M01-F4 既有 API）', () => {
  it('GET /__mock/counters（别名 /__mock/stats）与编程 API 一致，/__mock/events 返回入库数据', async () => {
    const target = await start();
    const batch = batchOf('e2e-real', 'batch-0008', THREE_EVENTS);
    await postBatch(target, '/ingest', batch);
    await postBatch(target, '/ingest', batch);

    expect(await countersViaHttp(target, '/__mock/counters')).toEqual(target.counters.snapshot());
    expect(await countersViaHttp(target, '/__mock/stats')).toEqual(target.counters.snapshot());

    const listed = await httpRequestTo(portOf(target), '/__mock/events');
    expect(listed.status).toBe(200);
    const events = (JSON.parse(listed.body) as { events: StoredEvent[] }).events;
    expect(events).toHaveLength(3);
  });

  it('POST /__mock/counters/reset 与 DELETE /__mock/events 清零', async () => {
    const target = await start();
    const batch = batchOf('e2e-real', 'batch-0009', THREE_EVENTS);
    await postBatch(target, '/ingest', batch);
    await postBatch(target, '/ingest', batch);

    const reset = await httpRequestTo(portOf(target), '/__mock/counters/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    expect(target.counters.snapshot().received_events).toBe(0);
    expect(target.counters.snapshot().duplicate_events).toBe(0);
    expect(target.counters.snapshot().by_batch).toEqual([]);

    const cleared = await httpRequestTo(portOf(target), '/__mock/events', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(target.events.size()).toBe(0);
  });
});

describe('对账⑥：不改变既有口径（失败/挂起路径不进对账计数，received/hits 仍逐请求记录）', () => {
  it('401 与不响应的请求不计入 received/stored，但仍出现在 received/hits 中', async () => {
    const target = await start();
    const batch = batchOf('e2e-real', 'batch-0010', THREE_EVENTS);
    expect((await postBatch(target, '/ingest', batch)).status).toBe(202);
    expect((await postBatch(target, '/revoked', batch)).status).toBe(401);

    const snapshot = target.counters.snapshot();
    expect(snapshot.received_batches).toBe(1);
    expect(snapshot.received_events).toBe(3);
    expect(snapshot.stored_events).toBe(3);
    expect(snapshot.duplicate_events).toBe(0);
    expect(snapshot.rejected_invalid_token).toBe(1);

    expect(target.hits('/revoked')).toHaveLength(1);
    expect(target.hits('/revoked')[0]?.accepted).toBe(false);
    expect(target.received).toHaveLength(2);
  });

  it('无法解析为批次的正文不使服务失败，只计入 unparsable_batches', async () => {
    const target = await start();
    const result = await httpRequestTo(portOf(target), '/beacon', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: Buffer.from([1, 2, 3, 4, 5]),
    });
    expect(result.status).toBe(202);
    const snapshot = target.counters.snapshot();
    expect(snapshot.received_batches).toBe(1);
    expect(snapshot.received_events).toBe(0);
    expect(snapshot.unparsable_batches).toBe(1);
    expect(snapshot.rejected_invalid_json).toBe(1);
  });
});
