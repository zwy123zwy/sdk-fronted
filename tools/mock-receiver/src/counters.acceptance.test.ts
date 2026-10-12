/**
 * M01 验收用例：去重、计数、CORS、日志脱敏（M01-AC-05、06、08、10、11）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startReceiver, type CounterSnapshot, type MockReceiver } from './index.js';
import {
  JSON_HEADERS,
  PLACEHOLDER_WRITE_TOKEN,
  bodyOf,
  clone,
  errorOf,
  httpRequestTo,
  jsonOf,
  readExample,
  sdkHealthEvent,
  splitBatch,
  toBeaconBody,
  type HttpResult,
} from './test-support.js';

type Json = Record<string, unknown>;

let receiver: MockReceiver;
let port: number;

beforeEach(async () => {
  receiver = await startReceiver({ port: 0 });
  port = receiver.port;
  receiver.counters.clear();
  receiver.logs.clear();
});

afterEach(async () => {
  await receiver.stop();
});

async function postBatch(
  batch: Json,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<HttpResult> {
  return httpRequestTo(port, '/v1/batch', { method: 'POST', headers, body: bodyOf(batch) });
}

/** 把 JSON 收窄成计数快照。 */
function asCounterSnapshot(value: unknown): CounterSnapshot {
  return value as CounterSnapshot;
}

/** 把 JSON 收窄成入库事件列表。 */
function asStoredEvents(value: unknown): Json[] {
  return (value as { events: Json[] }).events;
}

async function counters(): Promise<CounterSnapshot> {
  const result = await httpRequestTo(port, '/__mock/counters');
  expect(result.status).toBe(200);
  return jsonOf(result, asCounterSnapshot);
}

describe('M01-AC-05 存储失败注入（RR-02）', () => {
  it('M01-AC-05 开启存储失败后返回 503 storage_unavailable，从不返回 2xx，入库数不变', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    await postBatch(batch);
    const before = await counters();

    const enabled = await httpRequestTo(port, '/__mock/injection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ storageFail: true }), 'utf8'),
    });
    expect(enabled.status).toBe(200);

    for (let round = 0; round < 3; round += 1) {
      const copy = clone(batch);
      copy['batch_id'] = `b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c8${String(round)}`;
      const result = await postBatch(copy);
      expect(result.status).toBe(503);
      expect(errorOf(result)).toBe('storage_unavailable');
      expect(result.headers['retry-after']).toBeDefined();
    }

    const after = await counters();
    expect(after.stored_events).toBe(before.stored_events);
    expect(after.failed_storage).toBe(3);
  });

  it('M01-AC-05 存储失败关闭后恢复 202', async () => {
    await httpRequestTo(port, '/__mock/injection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ storageFail: false }), 'utf8'),
    });
    const batch = (await readExample('batch.valid.json')) as Json;
    const result = await postBatch(batch);
    expect(result.status).toBe(202);
  });
});

describe('M01-AC-06 去重与 sdk_health（RR-05、RR-23）', () => {
  it('M01-AC-06 同一批次重发 3 次只入库一次，received 与 stored 的差等于重复数', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const eventCount = (batch['events'] as Json[]).length;
    for (let round = 0; round < 3; round += 1) {
      const result = await postBatch(clone(batch));
      expect(result.status).toBe(202);
    }

    const snapshot = await counters();
    expect(snapshot.received_batches).toBe(3);
    expect(snapshot.stored_events).toBe(eventCount);
    expect(snapshot.duplicate_events).toBe(eventCount * 2);
    expect(snapshot.received_events - snapshot.stored_events).toBe(snapshot.duplicate_events);
  });

  it('M01-AC-06 拆分后的两个批次含相同 event_id 时只入库一次', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const [first, second] = splitBatch(batch);
    expect(await postBatch(first)).toMatchObject({ status: 202 });
    expect(await postBatch(second)).toMatchObject({ status: 202 });

    const snapshot = await counters();
    expect(snapshot.received_batches).toBe(2);
    expect(snapshot.stored_events).toBe((batch['events'] as Json[]).length);
    expect(snapshot.duplicate_events).toBe(0);
    expect(snapshot.received_events - snapshot.stored_events).toBe(snapshot.duplicate_events);
  });

  it('M01-AC-06 sdk_health 与业务事件一样入库并计数', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const events = batch['events'] as Json[];
    batch['events'] = [...events, sdkHealthEvent('e000000a-0000-4000-8000-000000000001')];
    expect((await postBatch(batch)).status).toBe(202);

    const snapshot = await counters();
    expect(snapshot.stored_events).toBe(events.length + 1);
    const listed = await httpRequestTo(port, '/__mock/events');
    const stored = jsonOf(listed, asStoredEvents);
    expect(stored.some((event) => event['event_name'] === 'sdk_health')).toBe(true);
  });
});

describe('M01-AC-08 CORS（RR-08）', () => {
  it('M01-AC-08 预检允许 POST 与 RR-08 列出的请求头，并暴露 Retry-After、X-Server-Time', async () => {
    const result = await httpRequestTo(port, '/v1/batch', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'content-type,content-encoding,x-app-id,x-write-token,x-request-id',
      },
    });

    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    expect(result.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(String(result.headers['access-control-allow-methods'])).toContain('POST');

    const allowed = String(result.headers['access-control-allow-headers']).toLowerCase();
    for (const header of [
      'content-type',
      'content-encoding',
      'x-app-id',
      'x-write-token',
      'x-request-id',
    ]) {
      expect(allowed).toContain(header);
    }

    const exposed = String(result.headers['access-control-expose-headers']).toLowerCase();
    expect(exposed).toContain('retry-after');
    expect(exposed).toContain('x-server-time');
  });

  it('M01-AC-08 实际响应也带允许来源与暴露头', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const result = await postBatch(batch, { ...JSON_HEADERS, origin: 'https://app.example.com' });
    expect(result.status).toBe(202);
    expect(result.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const exposed = String(result.headers['access-control-expose-headers']).toLowerCase();
    expect(exposed).toContain('retry-after');
  });
});

describe('M01-AC-10 计数与清零（M01-F4）', () => {
  it('M01-AC-10 按 received/stored/duplicate/rejected_<error> 分类计数，并提供清零接口', async () => {
    const good = (await readExample('batch.valid.json')) as Json;
    const events = (good['events'] as Json[]).length;

    expect((await postBatch(good)).status).toBe(202);
    expect((await postBatch(clone(good))).status).toBe(202);
    expect((await postBatch(clone(good), { ...JSON_HEADERS, 'x-write-token': 'wrong-token-000' })).status).toBe(401);
    expect(await postBatch({ nonsense: true })).toMatchObject({ status: 400 });

    const snapshot = await counters();
    expect(snapshot.received_batches).toBe(4);
    expect(snapshot.received_events).toBe(events * 3);
    expect(snapshot.stored_events).toBe(events);
    expect(snapshot.duplicate_events).toBe(events);
    expect(snapshot.stored_batches).toBe(1);
    expect(snapshot.rejected_invalid_token).toBe(1);
    expect(snapshot.rejected_invalid_structure).toBe(1);

    const cleared = await httpRequestTo(port, '/__mock/counters/reset', { method: 'POST' });
    expect(cleared.status).toBe(200);
    const after = await counters();
    expect(after.received_batches).toBe(0);
    expect(after.stored_events).toBe(0);
    expect(after.duplicate_events).toBe(0);
    expect(after.rejected_invalid_token).toBe(0);
    expect(after.rejected_invalid_structure).toBe(0);
  });

  it('M01-AC-10 计数器可按原因码枚举，未知 error 也单独计数', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    await postBatch(batch, { ...JSON_HEADERS, 'content-encoding': 'br' });
    const snapshot = await counters();
    expect(snapshot.rejected_unsupported_encoding).toBe(1);
    expect(receiver.counters.snapshot()).toEqual(snapshot);
  });
});

describe('M01-AC-11 日志与入库数据脱敏（RR-13）', () => {
  it('M01-AC-11 日志中不出现令牌占位值、auth 字段与请求方 IP 末段', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    await postBatch(batch);
    await postBatch(toBeaconBody(batch), {
      'content-type': 'text/plain;charset=UTF-8',
      'x-app-id': 'demo-app',
    });
    await postBatch(batch, { ...JSON_HEADERS, 'x-write-token': 'wrong-token-000' });
    await postBatch(batch, { ...JSON_HEADERS, 'content-encoding': 'br' });
    await postBatch(batch, { ...JSON_HEADERS, 'x-app-id': 'other-app' });

    const text = receiver.logs.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(PLACEHOLDER_WRITE_TOKEN);
    expect(text).not.toContain('"auth"');
    expect(text).not.toMatch(/127\.0\.0\.1(?![0-9])/);
    expect(text).toContain('127.0.0.');

    const listed = await httpRequestTo(port, '/__mock/logs');
    expect(listed.status).toBe(200);
    expect(listed.body).not.toContain(PLACEHOLDER_WRITE_TOKEN);
    expect(listed.body).not.toContain('"auth"');
  });

  it('M01-AC-11 入库数据不含 auth 字段与令牌', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    await postBatch(toBeaconBody(batch), {
      'content-type': 'text/plain;charset=UTF-8',
      'x-app-id': 'demo-app',
    });

    const listed = await httpRequestTo(port, '/__mock/events');
    expect(listed.status).toBe(200);
    expect(listed.body).not.toContain(PLACEHOLDER_WRITE_TOKEN);
    expect(listed.body).not.toContain('"auth"');

    const stored = jsonOf(listed, asStoredEvents);
    for (const event of stored) {
      expect(Object.keys(event)).not.toContain('auth');
      expect(Object.keys(event)).not.toContain('write_token');
    }
  });
});
