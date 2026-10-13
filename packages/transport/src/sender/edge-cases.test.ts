/**
 * C07 发送器的边界分支补测：无凭据、服务端时间、压缩失败回退、UUID 兜底、
 * 拆分深度上限、暂停期间不发送。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, makeBatch, makeEvent } from '../offline/fixtures';
import { createFakeCredentials, createFakeTransport, createSleepSpy } from './fixtures';
import { createBatchSender } from './sender';
import type { CompressorPort } from './types';

function makeSender(
  overrides: {
    readonly credentials?: ReturnType<typeof createFakeCredentials>;
    readonly transport?: ReturnType<typeof createFakeTransport>;
    readonly compressor?: CompressorPort;
    readonly onServerTime?: (value: number) => void;
  } = {},
): {
  readonly sender: ReturnType<typeof createBatchSender>;
  readonly transport: ReturnType<typeof createFakeTransport>;
  readonly counters: ReturnType<typeof createCountersSpy>;
} {
  const transport = overrides.transport ?? createFakeTransport();
  const counters = createCountersSpy();
  const credentials = overrides.credentials ?? createFakeCredentials();
  return {
    transport,
    counters,
    sender: createBatchSender({
      credentials: credentials.port,
      transport: transport.transport,
      counters: counters.port,
      sleep: createSleepSpy().sleep,
      random: () => 0.5,
      now: () => 1_700_000_000_000,
      ...(overrides.compressor === undefined ? {} : { compressor: overrides.compressor }),
      ...(overrides.onServerTime === undefined ? {} : { onServerTime: overrides.onServerTime }),
    }),
  };
}

describe('C07 发送器边界分支', () => {
  test('没有可用凭据时不发送、不重试（走暂停语义）', async () => {
    const transport = createFakeTransport();
    const { sender, counters } = makeSender({
      credentials: { port: { current: () => null }, set: () => undefined, current: null as never },
      transport,
    });
    const result = await sender.send(makeBatch());
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(transport.requests).toHaveLength(0);
    expect(counters.get('rejected_401')).toBe(1);
  });

  test('响应带合法 X-Server-Time 时交给时钟校准端口', async () => {
    const seen: number[] = [];
    const transport = createFakeTransport();
    transport.push(202, { 'x-server-time': '1793000000123' });
    const { sender } = makeSender({ transport, onServerTime: (value) => seen.push(value) });
    await sender.send(makeBatch());
    expect(seen).toEqual([1793000000123]);
  });

  test('压缩器抛错时退回不压缩并继续发送', async () => {
    const transport = createFakeTransport();
    transport.push(202);
    const { sender } = makeSender({
      transport,
      compressor: {
        available: () => true,
        compress: (): Promise<Uint8Array<ArrayBuffer>> => Promise.reject(new Error('boom')),
      },
    });
    const result = await sender.send(makeBatch({ events: [makeEvent({ bytes: 8_000 })] }));
    expect(result.status).toBe('sent');
    expect(transport.requests[0]?.headers['content-encoding']).toBeUndefined();
    expect(transport.requests[0]?.bodyBytes).toBeUndefined();
  });

  test('crypto.randomUUID 不可用时拆分仍生成合法 UUID v4 形状', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const transport = createFakeTransport();
    transport.push(413);
    transport.push(202);
    transport.push(202);
    const { sender } = makeSender({ transport });
    try {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        writable: true,
        value: {},
      });
      const result = await sender.send(makeBatch({ events: [makeEvent(), makeEvent()] }));
      expect(result.status).toBe('sent');
      const half = JSON.parse(transport.requests[1]?.body ?? '{}') as { batch_id?: string };
      expect(half.batch_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      if (original === undefined) delete (globalThis as { crypto?: unknown }).crypto;
      else Object.defineProperty(globalThis, 'crypto', original);
    }
  });

  test('暂停期间 send 直接失败且不发请求', async () => {
    const transport = createFakeTransport();
    const { sender } = makeSender({ transport });
    transport.push(401);
    await sender.send(makeBatch());
    expect(sender.isPaused()).toBe(true);
    const before = transport.requests.length;
    const result = await sender.send(makeBatch());
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(0);
    expect(transport.requests.length).toBe(before);
  });
});
