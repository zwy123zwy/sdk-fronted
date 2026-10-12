/**
 * M01 验收用例：协议校验、通道、上限（M01-AC-01 至 M01-AC-04，M01-AC-07）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { startReceiver, type MockReceiver, type StoredEvent } from './index.js';
import {
  JSON_HEADERS,
  PLACEHOLDER_WRITE_TOKEN,
  bodyOf,
  clone,
  errorOf,
  httpRequestTo,
  invalidCases,
  jsonOf,
  readExample,
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
  body: Buffer | string,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<HttpResult> {
  return httpRequestTo(port, '/v1/batch', { method: 'POST', headers, body });
}

/** 把 JSON 收窄成入库事件列表。 */
function asStoredEvents(value: unknown): StoredEvent[] {
  return (value as { events: StoredEvent[] }).events;
}

async function storedEvents(): Promise<StoredEvent[]> {
  const result = await httpRequestTo(port, '/__mock/events');
  expect(result.status).toBe(200);
  return jsonOf(result, asStoredEvents);
}

/** 未提升写法：`common` 展开到每条事件，事件体中的值优先（RR-06）。 */
function expectedFromCommon(common: Json, event: Json): Json {
  const merged: Json = {};
  for (const [key, value] of Object.entries(common)) {
    const override = event[key];
    if (typeof value === 'object' && value !== null && typeof override === 'object' && override !== null) {
      merged[key] = { ...(value as Json), ...(override as Json) };
    } else if (key in event) {
      merged[key] = override;
    } else {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(event)) merged[key] = value;
  return merged;
}

describe('M01-AC-01 常规通道接受合法批次', () => {
  it('M01-AC-01 batch.valid.json 与 batch-promoted.valid.json 返回 202 且带 X-Server-Time、X-Request-Id', async () => {
    const valid = (await readExample('batch.valid.json')) as Json;
    const promoted = (await readExample('batch-promoted.valid.json')) as Json;

    const first = await postBatch(bodyOf(valid));
    const second = await postBatch(bodyOf(promoted));

    for (const result of [first, second]) {
      expect(result.status).toBe(202);
      expect(result.headers['x-server-time']).toBeDefined();
      expect(Number.isInteger(Number(result.headers['x-server-time']))).toBe(true);
      expect(result.headers['x-request-id']).toBeDefined();
    }
    expect(receiver.counters.snapshot().received_batches).toBe(2);
  });

  it('M01-AC-01 X-Request-Id 回显请求头中的值，未提供时由服务生成', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const echoed = await postBatch(bodyOf(batch), {
      ...JSON_HEADERS,
      'x-request-id': 'req-echo-0001',
    });
    expect(echoed.headers['x-request-id']).toBe('req-echo-0001');

    const generated = await postBatch(bodyOf(batch));
    expect(typeof generated.headers['x-request-id']).toBe('string');
    expect(String(generated.headers['x-request-id']).length).toBeGreaterThan(0);
  });

  it('M01-AC-01 接受并入库 sdk_health 事件（RR-23）', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    batch['events'] = [
      {
        event_id: 'e0000009-0000-4000-8000-000000000001',
        event_name: 'sdk_health',
        event_type: 'sdk_internal',
        schema_version: 1,
        occurred_at: 1793000005000,
        priority: 'normal',
        metrics: { calls_total: 3 },
        dimensions: { sdk_version: '0.1.0', state: 'running', config_version: '42' },
      },
    ];
    const result = await postBatch(bodyOf(batch));
    expect(result.status).toBe(202);
    const events = await storedEvents();
    expect(events.some((event) => event.event_name === 'sdk_health')).toBe(true);
  });
});

describe('M01-AC-02 令牌校验与吊销', () => {
  it('M01-AC-02 令牌错误返回 401 invalid_token', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const result = await postBatch(bodyOf(batch), {
      ...JSON_HEADERS,
      'x-write-token': 'placeholder-write-token-9999',
    });
    expect(result.status).toBe(401);
    expect(errorOf(result)).toBe('invalid_token');
    expect(receiver.counters.snapshot().rejected_invalid_token).toBe(1);
  });

  it('M01-AC-02 缺少令牌请求头返回 401 invalid_token', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const result = await postBatch(bodyOf(batch), {
      'content-type': 'application/json',
      'x-app-id': 'demo-app',
    });
    expect(result.status).toBe(401);
    expect(errorOf(result)).toBe('invalid_token');
  });

  it('M01-AC-02 吊销后原令牌返回 401 token_revoked', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const before = await postBatch(bodyOf(batch));
    expect(before.status).toBe(202);

    const revoke = await httpRequestTo(port, '/__mock/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ write_token: PLACEHOLDER_WRITE_TOKEN }), 'utf8'),
    });
    expect(revoke.status).toBe(200);

    const after = await postBatch(bodyOf(batch));
    expect(after.status).toBe(401);
    expect(errorOf(after)).toBe('token_revoked');
  });
});

describe('M01-AC-03 常规通道与信标通道', () => {
  it('M01-AC-03 信标通道（text/plain + 请求体 auth）返回 202', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const body = toBeaconBody(batch);
    const result = await postBatch(bodyOf(body), {
      'content-type': 'text/plain;charset=UTF-8',
      'x-app-id': 'demo-app',
    });
    expect(result.status).toBe(202);
    expect(receiver.counters.snapshot().received_batches).toBe(1);
  });

  it('M01-AC-03 常规通道忽略请求体 auth，只认请求头', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const body = toBeaconBody(batch);
    const wrong = await postBatch(bodyOf(body), {
      'content-type': 'application/json',
      'x-app-id': 'demo-app',
      'x-write-token': 'placeholder-write-token-9999',
    });
    expect(wrong.status).toBe(401);
    expect(errorOf(wrong)).toBe('invalid_token');

    const right = await postBatch(bodyOf(body), {
      'content-type': 'application/json',
      'x-app-id': 'demo-app',
      'x-write-token': PLACEHOLDER_WRITE_TOKEN,
    });
    expect(right.status).toBe(202);
  });

  it('M01-AC-03 信标通道不认请求头令牌，令牌只在请求体', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const result = await postBatch(bodyOf(clone(batch)), {
      'content-type': 'text/plain;charset=UTF-8',
      'x-app-id': 'demo-app',
      'x-write-token': PLACEHOLDER_WRITE_TOKEN,
    });
    expect(result.status).toBe(401);
    expect(errorOf(result)).toBe('invalid_token');
  });
});

describe('M01-AC-04 结构与上限校验', () => {
  it('M01-AC-04 batch.invalid.json 每个 case 返回 400', async () => {
    const cases = await invalidCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const [index, invalid] of cases.entries()) {
      const result = await postBatch(bodyOf(invalid));
      expect(result.status, `case #${String(index)} ${String(invalid['_why'])}`).toBe(400);
      expect(errorOf(result).length).toBeGreaterThan(0);
    }
    const counters = receiver.counters.snapshot();
    expect(counters.rejected_invalid_structure + counters.rejected_unsupported_protocol).toBe(
      cases.length,
    );
  });

  it('M01-AC-04 X-App-Id 与请求体不一致返回 400 app_id_mismatch', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const result = await postBatch(bodyOf(batch), { ...JSON_HEADERS, 'x-app-id': 'other-app' });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe('app_id_mismatch');
  });

  it('M01-AC-04 非 JSON 请求体返回 400 invalid_json', async () => {
    const result = await postBatch('not-json', JSON_HEADERS);
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe('invalid_json');
  });

  it('M01-AC-04 Content-Encoding: br 返回 400 unsupported_encoding', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const result = await postBatch(bodyOf(batch), { ...JSON_HEADERS, 'content-encoding': 'br' });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe('unsupported_encoding');
  });

  it('M01-AC-04 解压后 1.2 MB 返回 413 并在 1 MB 处中止（RR-04）', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const events = batch['events'] as Json[];
    events[0] = { ...(events[0] as Json), attachment: 'a'.repeat(1_200_000) };
    const compressed = gzipSync(bodyOf(batch));

    const result = await postBatch(compressed, { ...JSON_HEADERS, 'content-encoding': 'gzip' });
    expect(result.status).toBe(413);
    expect(errorOf(result)).toBe('payload_too_large');
    expect(receiver.inspect.lastDecompressedBytes).toBeLessThanOrEqual(1_048_576);
  });

  it('M01-AC-04 gzip 炸弹（解压后约 1 GB）返回 413 且 RSS 增长不超过 50 MB', async () => {
    const events = Array.from({ length: 3 }, (_, index) => ({
      event_id: `e000000b-0000-4000-8000-00000000000${String(index + 1)}`,
      event_name: 'app_debug_log',
      event_type: 'log',
      schema_version: 1,
      occurred_at: 1793000000000,
      priority: 'normal',
      level: 'info',
      attachment: 'b'.repeat(2_000_000),
    }));
    const bomb = {
      protocol_version: 1,
      app_id: 'demo-app',
      env: 'staging',
      release: '1.4.0',
      sdk_name: 'web-report-sdk',
      sdk_version: '0.1.0',
      device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
      session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
      batch_id: 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c99',
      sent_at: 1793000000500,
      clock_offset: 0,
      events,
    };
    const compressed = gzipSync(bodyOf(bomb), { level: 9 });
    expect(compressed.byteLength).toBeLessThanOrEqual(256 * 1024);

    const rssBefore = process.memoryUsage().rss;
    const result = await postBatch(compressed, { ...JSON_HEADERS, 'content-encoding': 'gzip' });
    const rssGrowth = process.memoryUsage().rss - rssBefore;

    expect(result.status).toBe(413);
    expect(receiver.inspect.lastDecompressedBytes).toBeLessThanOrEqual(1_048_576);
    expect(rssGrowth).toBeLessThan(50 * 1024 * 1024);
  });

  it('M01-AC-04 压缩后超过 256 KB 返回 413', async () => {
    const events = Array.from({ length: 3 }, (_, index) => ({
      event_id: `e000000c-0000-4000-8000-00000000000${String(index + 1)}`,
      event_name: 'app_debug_log',
      event_type: 'log',
      schema_version: 1,
      occurred_at: 1793000000000,
      priority: 'normal',
      level: 'info',
      attachment: randomText(200_000),
    }));
    const batch = {
      protocol_version: 1,
      app_id: 'demo-app',
      env: 'staging',
      release: '1.4.0',
      sdk_name: 'web-report-sdk',
      sdk_version: '0.1.0',
      device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
      session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
      batch_id: 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c98',
      sent_at: 1793000000500,
      clock_offset: 0,
      events,
    };
    const compressed = gzipSync(bodyOf(batch), { level: 9 });
    expect(compressed.byteLength).toBeGreaterThan(256 * 1024);

    const result = await postBatch(compressed, { ...JSON_HEADERS, 'content-encoding': 'gzip' });
    expect(result.status).toBe(413);
    expect(errorOf(result)).toBe('payload_too_large');
  });

  it('M01-AC-04 501 条事件返回 413 too_many_events', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const template = (batch['events'] as Json[])[0] as Json;
    batch['events'] = Array.from({ length: 501 }, (_, index) => ({
      ...clone(template),
      event_id: `e000000d-0000-4000-8000-${String(index).padStart(12, '0')}`,
    }));
    const result = await postBatch(bodyOf(batch));
    expect(result.status).toBe(413);
    expect(errorOf(result)).toBe('too_many_events');
  });

  it('M01-AC-04 单条事件超过 16 KB 时只拒绝该条，其余事件正常入库', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    const events = batch['events'] as Json[];
    events[0] = { ...(events[0] as Json), attachment: 'x'.repeat(17_000) };
    const result = await postBatch(bodyOf(batch));
    expect(result.status).toBe(202);

    const stored = await storedEvents();
    expect(stored).toHaveLength(events.length - 1);
    expect(stored.some((event) => event.event_id === events[1]?.['event_id'])).toBe(true);
    expect(receiver.counters.snapshot().rejected_event_too_large).toBe(1);
  });
});

describe('M01-AC-07 common 字段提升还原（RR-06）', () => {
  it('M01-AC-07 提升写法还原后与未提升写法完全一致', async () => {
    const promoted = (await readExample('batch-promoted.valid.json')) as Json;
    const result = await postBatch(bodyOf(promoted));
    expect(result.status).toBe(202);

    const common = promoted['common'] as Json;
    const expected = (promoted['events'] as Json[]).map((event) =>
      expectedFromCommon(common, event),
    );

    const stored = await storedEvents();
    expect(stored).toHaveLength(expected.length);
    for (const [index, event] of stored.entries()) {
      // 存储层额外记录 app_id（查询接口按应用过滤用）
      expect(event).toMatchObject(expected[index] as Json);
      expect(event['app_id']).toBe(promoted['app_id']);
    }
  });

  it('M01-AC-07 事件体中的值优先于 common', async () => {
    const promoted = (await readExample('batch-promoted.valid.json')) as Json;
    const events = promoted['events'] as Json[];
    events[0] = { ...(events[0] as Json), url: 'https://app.example.com/event-wins' };
    // 第二条事件本来就有 url，先删掉再验证 common 的取值
    const second = events[1];
    if (second === undefined) throw new Error('样例缺少第二条事件');
    const secondWithoutUrl = clone(second);
    delete secondWithoutUrl['url'];
    events[1] = secondWithoutUrl;
    (promoted['common'] as Json)['url'] = 'https://app.example.com/common-loses';

    const result = await postBatch(bodyOf(promoted));
    expect(result.status).toBe(202);
    const stored = await storedEvents();
    expect(stored[0]?.['url']).toBe('https://app.example.com/event-wins');
    expect(stored[1]?.['url']).toBe('https://app.example.com/common-loses');
  });

  it('M01-AC-07 不提升的批次原样入库', async () => {
    const batch = (await readExample('batch.valid.json')) as Json;
    await postBatch(bodyOf(batch));
    const stored = await storedEvents();
    expect(stored).toHaveLength((batch['events'] as Json[]).length);
    expect(stored[0]).toMatchObject((batch['events'] as Json[])[0] as Json);
    expect(stored[0]?.['app_id']).toBe(batch['app_id']);
  });
});

/** 生成一段压缩率低的文本，用于构造超过 256 KB 的压缩请求。 */
function randomText(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}
