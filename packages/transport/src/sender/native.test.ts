/**
 * C07-AC-01 / AC-02 的原生引用与通道降级。
 *
 * 关键证明方式是**反向断言**：把 `globalThis.fetch` 换成桩，断言发送器用的是
 * hook 前捕获的引用（桩**未被调用**）——这比"能发出去"更能证明不被 C05 采集。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, makeBatch } from '../offline/fixtures';
import { createFakeCredentials, createFakeTransport, createSleepSpy } from './fixtures';
import {
  captureNativeHttpRefs,
  createBeaconSender,
  createDefaultTransport,
  createXhrTransport,
  supportsFetchKeepalive,
} from './native';
import { createBatchSender } from './sender';
import type { TransportRequest } from './types';

const REQUEST: TransportRequest = {
  url: 'https://ingest.example.com/v1/batch',
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
  bodyBytes: undefined,
  keepalive: true,
  timeoutMs: 1_000,
};

interface XhrRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 最小 XHR 替身（不用 `class`；用带 `this` 标注的函数构造器）。 */
function createFakeXhrFactory(): {
  readonly records: readonly XhrRecord[];
  readonly ctor: typeof XMLHttpRequest;
} {
  const records: XhrRecord[] = [];
  const Fake = function (this: {
    status: number;
    timeout: number;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    ontimeout: (() => void) | null;
    open: (method: string, url: string) => void;
    setRequestHeader: (key: string, value: string) => void;
    getAllResponseHeaders: () => string;
    send: (body: unknown) => void;
  }): void {
    this.status = 202;
    this.timeout = 0;
    this.onload = null;
    this.onerror = null;
    this.ontimeout = null;
    const record: XhrRecord = { method: '', url: '', headers: {}, body: undefined };
    records.push(record);
    this.open = (method: string, url: string): void => {
      record.method = method;
      record.url = url;
    };
    this.setRequestHeader = (key: string, value: string): void => {
      record.headers[key.toLowerCase()] = value;
    };
    this.getAllResponseHeaders = (): string => 'x-server-time: 1793000000123\r\n';
    this.send = (body: unknown): void => {
      record.body = body;
      globalThis.setTimeout(() => {
        this.onload?.();
      }, 0);
    };
  };
  return { records, ctor: Fake as unknown as typeof XMLHttpRequest };
}

describe('C07-AC-01/02 原生引用与通道选择', () => {
  test('captureNativeHttpRefs 幂等、冻结、每个 target 只捕获一次', () => {
    const target: { fetch?: unknown; XMLHttpRequest?: unknown; navigator?: unknown } = {
      fetch: (): Promise<Response> => Promise.resolve(new Response('', { status: 202 })),
    };
    const first = captureNativeHttpRefs(target);
    const second = captureNativeHttpRefs(target);
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);

    // 再次调用前替换 target 上的引用：不得改变已捕获的结果（"只捕获一次"）
    const hooked = (): Promise<Response> => Promise.resolve(new Response('', { status: 500 }));
    target.fetch = hooked;
    const third = captureNativeHttpRefs(target);
    expect(third.fetch).toBe(first.fetch);
    expect(third.fetch).not.toBe(hooked);
  });

  test('反向断言：发送器使用注入的原生引用，不碰 globalThis.fetch', async () => {
    const target: { fetch?: unknown } = {};
    const calls: string[] = [];
    const nativeFetch = (url: string): Promise<Response> => {
      calls.push(url);
      return Promise.resolve(new Response('', { status: 202 }));
    };
    target.fetch = nativeFetch;
    const refs = captureNativeHttpRefs(target);

    const originalGlobal = globalThis.fetch;
    const globalCalls: string[] = [];
    globalThis.fetch = ((url: string): Promise<Response> => {
      globalCalls.push(url);
      return Promise.resolve(new Response('', { status: 599 }));
    }) as typeof fetch;
    try {
      const sender = createBatchSender({
        credentials: createFakeCredentials().port,
        http: refs,
        transport: createDefaultTransport(refs, () => true),
        counters: createCountersSpy().port,
        sleep: createSleepSpy().sleep,
        now: () => 1_700_000_000_000,
      });
      const result = await sender.send(makeBatch());
      expect(result.status).toBe('sent');
      expect(calls).toHaveLength(1);
      expect(globalCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalGlobal;
    }
  });

  test('AC-02 keepalive 不支持时降级为 XMLHttpRequest', async () => {
    const fake = createFakeXhrFactory();
    const transport = createDefaultTransport({ xhr: fake.ctor }, () => false);
    const response = await transport.send(REQUEST);
    expect(response.status).toBe(202);
    expect(fake.records).toHaveLength(1);
    const record = fake.records[0];
    expect(record?.method).toBe('POST');
    expect(record?.url).toBe(REQUEST.url);
    expect(record?.headers['content-type']).toBe('application/json');
    expect(record?.body).toBe(REQUEST.body);
  });

  test('AC-01 keepalive 可用时用 fetch，不走 XHR', async () => {
    const fake = createFakeXhrFactory();
    const calls: string[] = [];
    const transport = createDefaultTransport(
      {
        fetch: ((url: string): Promise<Response> => {
          calls.push(url);
          return Promise.resolve(new Response('', { status: 202 }));
        }) as typeof fetch,
        xhr: fake.ctor,
      },
      () => true,
    );
    await transport.send(REQUEST);
    expect(calls).toEqual([REQUEST.url]);
    expect(fake.records).toHaveLength(0);
  });

  test('XHR 传输把网络错误与超时都变成 rejection（交给 classifyError 计 retry_network）', async () => {
    const failing = function (this: { open: () => void }): void {
      this.open = (): void => {
        throw new Error('boom');
      };
    } as unknown as typeof XMLHttpRequest;
    const transport = createXhrTransport({ xhr: failing });
    await expect(transport.send(REQUEST)).rejects.toThrow('boom');
  });

  test('没有信标能力时 createBeaconSender 返回 null', () => {
    expect(createBeaconSender({})).toBeNull();
  });

  test('信标抛错时返回 false（不把异常抛给业务）', () => {
    const sender = createBeaconSender({
      sendBeacon: (): boolean => {
        throw new Error('beacon blocked');
      },
    });
    expect(sender).not.toBeNull();
    expect(sender?.('https://x/', new Blob(['{}']))).toBe(false);
  });

  test('只有 XHR 时即使 keepalive 可用也走 XHR（没有 fetch）', async () => {
    const fake = createFakeXhrFactory();
    const transport = createDefaultTransport({ xhr: fake.ctor }, () => true);
    const response = await transport.send(REQUEST);
    expect(response.status).toBe(202);
    expect(fake.records).toHaveLength(1);
  });

  test('既没有 fetch 也没有 XHR 时 send 以 rejection 结束', async () => {
    const transport = createDefaultTransport({}, () => true);
    await expect(transport.send(REQUEST)).rejects.toThrow('no transport available');
  });

  test('supportsFetchKeepalive 返回布尔值（特性探测不抛错）', () => {
    expect(typeof supportsFetchKeepalive()).toBe('boolean');
  });

  test('没有可用传输时不抛错到业务：send 返回 failed', async () => {
    const sender = createBatchSender({
      credentials: createFakeCredentials().port,
      http: {},
      keepaliveSupported: () => false,
      counters: createCountersSpy().port,
      sleep: createSleepSpy().sleep,
      now: () => 1_700_000_000_000,
      random: () => 0.5,
    });
    const result = await sender.send(makeBatch());
    expect(result.status).toBe('failed');
  });

  test('注入的自定义传输优先于默认传输（AC-20 的传输侧）', async () => {
    const fake = createFakeTransport();
    fake.push(202);
    const sender = createBatchSender({
      credentials: createFakeCredentials().port,
      transport: fake.transport,
      counters: createCountersSpy().port,
      sleep: createSleepSpy().sleep,
      now: () => 1_700_000_000_000,
    });
    await sender.send(makeBatch());
    expect(fake.requests).toHaveLength(1);
  });
});
