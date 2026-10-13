/**
 * C07-F1 至 C07-F4、C07-F8 的发送器行为（AC-01/02 的通道选择见 `native.test.ts`）。
 *
 * 全部用假传输 + 立刻 resolve 的 sleep：重试节奏可断言，测试不真的等 1/2/4/7 秒。
 */
import { describe, expect, test } from 'vitest';
import { createCountersSpy, makeBatch, makeEvent } from '../offline/fixtures';
import { COMPRESS_THRESHOLD_BYTES } from './constants';
import { createFakeCredentials, createFakeTransport, createSleepSpy } from './fixtures';
import { createBatchSender } from './sender';
import type { CompressorPort } from './types';

function fixedRandom(): number {
  // 0.5 时抖动系数为 1，退避时长等于目标值（便于断言 1/2/4/7 秒）。
  return 0.5;
}

function makeRig(
  overrides: {
    readonly now?: () => number;
    readonly compressor?: CompressorPort;
  } = {},
): {
  readonly sender: ReturnType<typeof createBatchSender>;
  readonly transport: ReturnType<typeof createFakeTransport>;
  readonly credentials: ReturnType<typeof createFakeCredentials>;
  readonly counters: ReturnType<typeof createCountersSpy>;
  readonly sleep: ReturnType<typeof createSleepSpy>;
} {
  const transport = createFakeTransport();
  const credentials = createFakeCredentials();
  const counters = createCountersSpy();
  const sleep = createSleepSpy();
  const sender = createBatchSender({
    credentials: credentials.port,
    transport: transport.transport,
    counters: counters.port,
    sleep: sleep.sleep,
    random: fixedRandom,
    now: overrides.now ?? ((): number => 1_700_000_000_000),
    ...(overrides.compressor === undefined ? {} : { compressor: overrides.compressor }),
  });
  return { sender, transport, credentials, counters, sleep };
}

describe('C07-F2 响应分类', () => {
  test('AC-04 返回 202：视为成功，不重试（离线副本删除由装配层负责）', async () => {
    const { sender, transport, counters } = makeRig();
    transport.push(202, { 'x-server-time': '1793000000123' });
    const result = await sender.send(makeBatch());
    expect(result.status).toBe('sent');
    expect(result.terminal).toBe(false);
    expect(transport.requests).toHaveLength(1);
    expect(counters.get('retry_5xx')).toBe(0);
  });

  test('AC-27 返回 204 按 202 处理；返回 418 按 400 处理并计 rejected_400', async () => {
    const rig = makeRig();
    rig.transport.push(204);
    expect((await rig.sender.send(makeBatch())).status).toBe('sent');

    rig.transport.push(418);
    const denied = await rig.sender.send(makeBatch());
    expect(denied.status).toBe('failed');
    expect(denied.terminal).toBe(true);
    expect(denied.reason).toBe('rejected_400');
    expect(rig.counters.get('rejected_400')).toBe(1);
  });

  test('AC-05 返回 400：丢弃并计 rejected_400，不重试', async () => {
    const { sender, transport, counters } = makeRig();
    transport.push(400);
    const result = await sender.send(makeBatch());
    expect(result.terminal).toBe(true);
    expect(result.reason).toBe('rejected_400');
    expect(transport.requests).toHaveLength(1);
    expect(counters.get('rejected_400')).toBe(1);
  });

  test('AC-26 缺 X-Server-Time 不校准、不报错；Retry-After 非数字按本地退避', async () => {
    const calibrated: number[] = [];
    const transport = createFakeTransport();
    const counters = createCountersSpy();
    const sleep = createSleepSpy();
    const credentials = createFakeCredentials();
    const sender = createBatchSender({
      credentials: credentials.port,
      transport: transport.transport,
      counters: counters.port,
      sleep: sleep.sleep,
      random: fixedRandom,
      now: () => 1_700_000_000_000,
      onServerTime: (value) => {
        calibrated.push(value);
      },
    });
    transport.push(202);
    await sender.send(makeBatch());
    expect(calibrated).toEqual([]);

    transport.push(429, { 'retry-after': 'soon' });
    transport.push(202);
    await sender.send(makeBatch());
    expect(counters.get('retry_429')).toBe(1);
    expect(sleep.delays).toEqual([1_000]);
  });
});

describe('C07-F3 重试与退避', () => {
  test('AC-08 返回 429 + Retry-After: 7 → 7 秒后重试，计 retry_429', async () => {
    const { sender, transport, counters, sleep } = makeRig();
    transport.push(429, { 'retry-after': '7' });
    transport.push(202);
    const result = await sender.send(makeBatch());
    expect(result.status).toBe('sent');
    expect(counters.get('retry_429')).toBe(1);
    expect(sleep.delays).toEqual([7_000]);
  });

  test('AC-09 连续 503：按 1、2、4 秒重试 3 次后落盘，batch_id 不变，retry_5xx=3', async () => {
    const { sender, transport, counters, sleep } = makeRig();
    for (let index = 0; index < 4; index += 1) transport.push(503);
    const batch = makeBatch();
    const result = await sender.send(batch);
    expect(result.status).toBe('failed');
    expect(result.terminal).toBe(false);
    expect(result.reason).toBe('retry_exhausted');
    expect(result.attempts).toBe(4);
    expect(sleep.delays).toEqual([1_000, 2_000, 4_000]);
    expect(counters.get('retry_5xx')).toBe(3);
    for (const request of transport.requests) {
      expect(request.headers['x-request-id']).toBe(batch.batch_id);
    }
  });

  test('AC-25 网络错误与超时：按退避重试并计 retry_network', async () => {
    const { sender, transport, counters, sleep } = makeRig();
    transport.pushError();
    transport.push(202);
    const result = await sender.send(makeBatch());
    expect(result.status).toBe('sent');
    expect(counters.get('retry_network')).toBe(1);
    expect(sleep.delays).toEqual([1_000]);
  });
});

describe('C07-F4 熔断与暂停', () => {
  test('AC-10 连续 5 个批次失败 → 熔断；等待后放行一个探测批次', async () => {
    let current = 1_700_000_000_000;
    const rig = makeRig({ now: () => current });
    rig.transport.setDefault(503);
    for (let index = 0; index < 5; index += 1) {
      // 每个批次 4 次尝试后失败
      for (let attempt = 0; attempt < 4; attempt += 1) rig.transport.push(503);
      await rig.sender.send(makeBatch());
    }
    expect(rig.sender.isCircuitOpen()).toBe(true);
    const blocked = await rig.sender.send(makeBatch());
    expect(blocked.status).toBe('circuit_open');
    expect(blocked.attempts).toBe(0);

    // 5 分钟后放行一个探测批次
    current += 5 * 60 * 1_000;
    rig.transport.push(202);
    const probe = await rig.sender.send(makeBatch());
    expect(probe.status).toBe('sent');
    expect(rig.sender.isCircuitOpen()).toBe(false);
    expect(rig.sender.stats().probes).toBe(1);
  });

  test('AC-11 连续 401 不触发熔断：暂停会抑制后续发送，换令牌恢复后仍不熔断', async () => {
    const rig = makeRig();
    // 第一次 401：暂停，且**后续发送被抑制**（不产生新请求）
    rig.transport.push(401);
    await rig.sender.send(makeBatch());
    expect(rig.sender.isPaused()).toBe(true);
    let suppressed = 0;
    for (let index = 0; index < 4; index += 1) {
      const before = rig.transport.requests.length;
      const result = await rig.sender.send(makeBatch());
      expect(result.attempts).toBe(0);
      if (rig.transport.requests.length === before) suppressed += 1;
    }
    expect(suppressed).toBe(4);
    expect(rig.counters.get('rejected_401')).toBe(1);

    // 每次换令牌恢复后再吃一个 401：仍不计数到熔断
    for (let index = 0; index < 4; index += 1) {
      rig.credentials.set({
        revision: 10 + index,
        writeToken: `placeholder-write-token-1${String(index)}`,
      });
      expect(rig.sender.isPaused()).toBe(false);
      rig.transport.push(401);
      await rig.sender.send(makeBatch());
    }
    expect(rig.sender.isCircuitOpen()).toBe(false);
    expect(rig.counters.get('rejected_401')).toBe(5);
  });

  test('AC-24 返回 403：与 401 相同的暂停逻辑，计 rejected_403', async () => {
    const rig = makeRig();
    rig.transport.push(403);
    const result = await rig.sender.send(makeBatch());
    expect(result.terminal).toBe(false);
    expect(rig.sender.isPaused()).toBe(true);
    expect(rig.counters.get('rejected_403')).toBe(1);
  });

  test('AC-06 401 暂停；配置更新（revision + 令牌变化）后恢复', async () => {
    const rig = makeRig();
    rig.transport.push(401);
    await rig.sender.send(makeBatch());
    expect(rig.sender.isPaused()).toBe(true);

    // 只拉取配置、令牌没变：仍然暂停
    rig.credentials.set({ revision: 2 });
    expect(rig.sender.isPaused()).toBe(true);

    // 令牌变化且 revision 变化：恢复
    rig.credentials.set({ revision: 3, writeToken: 'placeholder-write-token-0002' });
    expect(rig.sender.isPaused()).toBe(false);
    rig.transport.push(202);
    const result = await rig.sender.send(makeBatch());
    expect(result.status).toBe('sent');
  });
});

describe('C07-F8 压缩决策', () => {
  test('AC-19 超过 4 KB 才压缩并带 Content-Encoding: gzip', async () => {
    const compressed: string[] = [];
    const compressor: CompressorPort = {
      available: () => true,
      compress: (text: string): Promise<Uint8Array<ArrayBuffer>> => {
        compressed.push(text);
        return Promise.resolve(new Uint8Array(new ArrayBuffer(16)));
      },
    };
    const rig = makeRig({ compressor });

    // 小批次：不压缩
    rig.transport.push(202);
    await rig.sender.send(makeBatch({ events: [makeEvent({ bytes: 64 })] }));
    expect(compressed).toHaveLength(0);
    expect(rig.transport.requests[0]?.headers['content-encoding']).toBeUndefined();

    // 大批次：压缩
    rig.transport.push(202);
    await rig.sender.send(makeBatch({ events: [makeEvent({ bytes: COMPRESS_THRESHOLD_BYTES })] }));
    expect(compressed).toHaveLength(1);
    expect(rig.transport.requests[1]?.headers['content-encoding']).toBe('gzip');
    expect(rig.transport.requests[1]?.bodyBytes).toBeInstanceOf(Uint8Array);
  });

  test('AC-19 压缩能力不可用时退回不压缩（不带该头）', async () => {
    const compressor: CompressorPort = {
      available: () => false,
      compress: (): Promise<Uint8Array<ArrayBuffer>> => Promise.reject(new Error('unavailable')),
    };
    const rig = makeRig({ compressor });
    rig.transport.push(202);
    await rig.sender.send(makeBatch({ events: [makeEvent({ bytes: COMPRESS_THRESHOLD_BYTES })] }));
    expect(rig.transport.requests[0]?.headers['content-encoding']).toBeUndefined();
  });
});

describe('非功能：健康期重试流量', () => {
  test('1% 批次首次 503 后成功 → 重试流量占比 ≤5%', async () => {
    const { sender, transport } = makeRig();
    const total = 400;
    for (let index = 0; index < total; index += 1) {
      if (index % 100 === 0) transport.push(503);
      transport.push(202);
      await sender.send(makeBatch());
    }
    const stats = sender.stats();
    expect(stats.attempts).toBe(total + total / 100);
    expect(stats.retryRatio).toBeLessThanOrEqual(0.05);
  });

  test('正向对照：50% 批次失败时重试流量占比明显上升（指标非恒 0）', async () => {
    const { sender, transport } = makeRig();
    for (let index = 0; index < 100; index += 1) {
      if (index % 2 === 0) transport.push(503);
      transport.push(202);
      await sender.send(makeBatch());
    }
    expect(sender.stats().retryRatio).toBeGreaterThan(0.05);
  });
});

describe('安全性：令牌不出现在 URL', () => {
  test('AC-01 请求头带 X-App-Id / X-Write-Token，令牌不出现在 URL', async () => {
    const { sender, transport, credentials } = makeRig();
    transport.push(202);
    await sender.send(makeBatch());
    const request = transport.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.url).toBe(credentials.current.endpoint);
    expect(request.url.includes(credentials.current.writeToken)).toBe(false);
    expect(request.headers['x-app-id']).toBe('demo-app');
    expect(request.headers['x-write-token']).toBe(credentials.current.writeToken);
    expect(request.headers['content-type']).toBe('application/json');
  });
});
