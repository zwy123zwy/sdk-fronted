/**
 * M01 单元测试：脱敏、去重与提升还原的边界、上限细节、注入决策与 CLI 参数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  TOKEN_PLACEHOLDER,
  createLogger,
  createSeededRandom,
  createStore,
  createCounters,
  maskIp,
  redactText,
  startReceiver,
  type MockReceiver,
} from './index.js';
import { parseCliArgs } from './cli-args.js';
import {
  JSON_HEADERS,
  PLACEHOLDER_WRITE_TOKEN,
  bodyOf,
  clone,
  errorOf,
  httpRequestTo,
  jsonOf,
  readExample,
} from './test-support.js';

type Json = Record<string, unknown>;

describe('脱敏工具（RR-13、M01-AC-11）', () => {
  it('maskIp 去掉 IPv4 末段、IPv6 截断到 48 位', () => {
    expect(maskIp('127.0.0.1')).toBe('127.0.0.');
    expect(maskIp('192.168.31.77')).toBe('192.168.31.');
    expect(maskIp('::ffff:127.0.0.1')).toBe('::ffff:127.0.0.');
    expect(maskIp('2001:db8:1234:5678:90ab:cdef:1234:5678')).toBe('2001:db8:1234:5678:90ab:cdef');
    expect(maskIp(undefined)).toBe('unknown');
  });

  it('redactText 去掉令牌占位值、auth 字段值与手机号', () => {
    const token = PLACEHOLDER_WRITE_TOKEN;
    expect(redactText(`token=${token}`, [token])).toBe('token=[redacted]');
    expect(redactText(`token=${TOKEN_PLACEHOLDER}`, [])).toBe('token=[redacted]');
    const withAuth = redactText('{"auth":{"app_id":"demo-app","write_token":"placeholder-write-token-0000"}}', []);
    expect(withAuth).not.toContain('placeholder-write-token-0000');
    expect(redactText('call 13800138000 now', [])).toBe('call [redacted-phone] now');
  });

  it('日志对象不落盘自由文本里的令牌，且带请求上下文', () => {
    const logger = createLogger();
    logger.log({ level: 'info', event: 'batch_accepted', request_id: 'r1', ip: '10.1.2.3' }, `x ${PLACEHOLDER_WRITE_TOKEN}`);
    const text = logger.text();
    expect(text).not.toContain(PLACEHOLDER_WRITE_TOKEN);
    expect(text).toContain('r1');
    expect(text).toContain('10.1.2.');
    logger.clear();
    expect(logger.text()).toBe('');
  });
});

describe('去重与 common 还原（RR-05、RR-06）', () => {
  it('同一 app_id + event_id 只入库一次，事件体优先于 common', () => {
    const store = createStore();
    const common = { page_id: '/list', url: 'https://app.example.com/list' };
    const first = store.storeBatch('demo-app', {
      events: [{ event_id: 'a', url: 'https://app.example.com/event-wins' }],
      common,
    });
    expect(first.stored).toBe(1);
    expect(first.duplicate).toBe(0);

    const second = store.storeBatch('demo-app', {
      events: [{ event_id: 'a', url: 'https://app.example.com/again' }],
      common,
    });
    expect(second.stored).toBe(0);
    expect(second.duplicate).toBe(1);

    const listed = store.list('demo-app');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.['url']).toBe('https://app.example.com/event-wins');
    expect(listed[0]?.['page_id']).toBe('/list');

    // 不同 app_id 不去重
    const otherApp = store.storeBatch('other-app', {
      events: [{ event_id: 'a' }],
      common,
    });
    expect(otherApp.stored).toBe(1);
    expect(store.size('demo-app')).toBe(1);
    expect(store.size('other-app')).toBe(1);
  });

  it('嵌套 common.context 与事件 context 合并且事件优先', () => {
    const store = createStore();
    store.storeBatch('demo-app', {
      common: { context: { a: '1', b: '2' } },
      events: [{ event_id: 'a', context: { b: '3', c: '4' } }],
    });
    expect(store.list('demo-app')[0]?.['context']).toEqual({ a: '1', b: '3', c: '4' });
  });
});

describe('计数（M01-F4）', () => {
  it('分类累加、快照隔离、清零', () => {
    const counters = createCounters();
    counters.onBatchReceived(3);
    counters.onEventsStored(2);
    counters.onDuplicate(1);
    counters.onRejected('invalid_token');
    counters.onRejected('invalid_token');
    counters.onRejected('payload_too_large');
    counters.onEventTooLarge();
    counters.onStorageFailure();
    counters.onInjected('timeout');

    const snapshot = counters.snapshot();
    expect(snapshot).toMatchObject({
      received_batches: 1,
      received_events: 3,
      stored_batches: 1,
      stored_events: 2,
      duplicate_events: 1,
      rejected_invalid_token: 2,
      rejected_payload_too_large: 1,
      rejected_event_too_large: 1,
      failed_storage: 1,
      injected_timeout: 1,
    });
    // 每个已知原因码都有一条独立的 rejected_<error>
    const asRecord = snapshot as unknown as Record<string, number>;
    for (const code of [
      'invalid_json',
      'invalid_structure',
      'unsupported_protocol',
      'unsupported_encoding',
      'app_id_mismatch',
      'token_revoked',
      'too_many_events',
    ]) {
      expect(asRecord[`rejected_${code}`]).toBe(0);
    }
    expect(Object.keys(snapshot)).toHaveLength(22);
    expect(counters.snapshot()).not.toBe(snapshot);

    counters.clear();
    expect(counters.snapshot().received_batches).toBe(0);
    expect(counters.snapshot().rejected_invalid_token).toBe(0);
  });

  it('未入库的批次不增加 stored_batches', () => {
    const counters = createCounters();
    counters.onBatchReceived(1);
    counters.onDuplicate(1);
    const snapshot = counters.snapshot();
    expect(snapshot.stored_batches).toBe(0);
    expect(snapshot.stored_events).toBe(0);
  });
});

describe('随机源与注入决策', () => {
  it('固定种子随机源可复现且落在 [0,1)', () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    const values = Array.from({ length: 100 }, () => first());
    expect(values).toEqual(Array.from({ length: 100 }, () => second()));
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('事件级上限（RR-01、ingest-protocol 2.3）', () => {
  let receiver: MockReceiver;
  let port: number;

  beforeEach(async () => {
    receiver = await startReceiver({ port: 0 });
    port = receiver.port;
  });

  afterEach(async () => {
    await receiver.stop();
  });

  async function post(batch: Json): Promise<number> {
    const result = await httpRequestTo(port, '/v1/batch', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: bodyOf(batch),
    });
    return result.status;
  }

  it('恰好 500 条事件正常入库，501 条被拒绝', async () => {
    const base = (await readExample('batch.valid.json')) as Json;
    const template = clone((base['events'] as Json[])[0] as Json);
    const make = (count: number): Json[] =>
      Array.from({ length: count }, (_, index) => ({
        ...clone(template),
        event_id: `e000000e-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }));

    const upToLimit = clone(base);
    upToLimit['events'] = make(500);
    expect(await post(upToLimit)).toBe(202);

    const overLimit = clone(base);
    overLimit['events'] = make(501);
    expect(await post(overLimit)).toBe(413);
    expect(receiver.counters.snapshot().stored_events).toBe(500);
  });

  it('事件体中的 auth 字段不会入库（RR-13）', async () => {
    const base = (await readExample('batch.valid.json')) as Json;
    const events = base['events'] as Json[];
    events[0] = { ...(events[0] as Json), auth: { write_token: PLACEHOLDER_WRITE_TOKEN } };
    expect(await post(base)).toBe(202);

    const listed = await httpRequestTo(port, '/__mock/events');
    const stored = jsonOf(listed, (value: unknown) => (value as { events: Json[] }).events);
    expect(stored[0]?.['auth']).toBeUndefined();
  });

  it('gzip 解压失败返回 400 invalid_json', async () => {
    const result = await httpRequestTo(port, '/v1/batch', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'content-encoding': 'gzip' },
      body: Buffer.from('not gzip at all', 'utf8'),
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toBe('invalid_json');
  });

  it('gzip 压缩的正常请求被解压并入库', async () => {
    const base = (await readExample('batch.valid.json')) as Json;
    const result = await httpRequestTo(port, '/v1/batch', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'content-encoding': 'gzip' },
      body: gzipSync(bodyOf(base)),
    });
    expect(result.status).toBe(202);
    expect(receiver.counters.snapshot().stored_events).toBe((base['events'] as Json[]).length);
  });

  it('非 JSON 的 Content-Type 返回 400', async () => {
    const base = (await readExample('batch.valid.json')) as Json;
    const result = await httpRequestTo(port, '/v1/batch', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'content-type': 'application/octet-stream' },
      body: bodyOf(base),
    });
    expect(result.status).toBe(400);
  });

  it('GET /v1/batch 返回 405 且不影响计数', async () => {
    const result = await httpRequestTo(port, '/v1/batch');
    expect(result.status).toBe(405);
    expect(receiver.counters.snapshot().received_batches).toBe(0);
  });

  it('所有响应都带 X-Server-Time 与 X-Request-Id', async () => {
    const result = await httpRequestTo(port, '/__mock/health', {
      headers: { 'x-request-id': 'health-1' },
    });
    expect(result.status).toBe(200);
    expect(result.headers['x-request-id']).toBe('health-1');
    expect(String(result.headers['x-server-time'])).toMatch(/^\d+$/);
    expect(jsonOf(result, (value: unknown) => value as Json)['tool']).toBe('M01');
  });
});

describe('CLI 参数（M01-F6、M01-AC-15）', () => {
  it('解析默认值、端口与配置路径', () => {
    const parsed = parseCliArgs([]);
    expect(parsed).toEqual({
      host: '127.0.0.1',
      port: 8787,
      configFile: null,
      storageFail: false,
    });

    const custom = parseCliArgs([
      '--port',
      '9000',
      '--config-file',
      'cfg.json',
      '--storage-fail',
    ]);
    expect(custom.port).toBe(9000);
    expect(custom.configFile).toBe('cfg.json');
    expect(custom.storageFail).toBe(true);
  });

  it('非法端口与未知参数抛出可读错误', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseCliArgs(['--port', '70000'])).toThrow(/--port/);
    expect(() => parseCliArgs(['--nope'])).toThrow(/未知参数/);
    expect(() => parseCliArgs(['--help'])).toThrow(/--help/);
  });
});
