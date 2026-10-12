/**
 * M01 验收用例：故障注入（M01-AC-09）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInjectionController,
  createSeededRandom,
  startReceiver,
  type FaultKind,
  type MockReceiver,
} from './index.js';
import {
  JSON_HEADERS,
  bodyOf,
  httpRequestTo,
  readExample,
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

async function postBatch(headers: Record<string, string> = JSON_HEADERS): Promise<HttpResult> {
  const batch = (await readExample('batch.valid.json')) as Json;
  return httpRequestToBatch(batch, headers);
}

async function httpRequestToBatch(
  batch: Json,
  headers: Record<string, string> = JSON_HEADERS,
): Promise<HttpResult> {
  return httpRequestTo(port, '/v1/batch', {
    method: 'POST',
    headers,
    body: bodyOf(batch),
  });
}

describe('M01-AC-09 按序列注入故障', () => {
  it('M01-AC-09 序列 [429, 503, 413, 401, timeout, reset, 202] 依次生效，429/503 带整数 Retry-After', async () => {
    const sequence: FaultKind[] = [
      '429',
      '503',
      '413',
      '401',
      'timeout',
      'reset',
      'none',
    ];
    const configured = receiver.injection.setSequence(sequence);
    expect(configured.mode).toBe('sequence');

    const seen: string[] = [];
    const statuses: number[] = [];

    for (const [index, kind] of sequence.entries()) {
      if (kind === 'timeout' || kind === 'reset') {
        const error = await postBatch().then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error, `step ${String(index)} (${kind}) 应产生网络错误`).toBeInstanceOf(Error);
        seen.push('network');
        continue;
      }
      const result = await postBatch();
      statuses.push(result.status);
      seen.push(String(result.status));
      if (result.status === 429 || result.status === 503) {
        const raw = result.headers['retry-after'];
        expect(String(raw)).toMatch(/^\d+$/);
      }
    }

    expect(seen.slice(0, 4)).toEqual(['429', '503', '413', '401']);
    expect(seen.slice(4)).toEqual(['network', 'network', '202']);
    expect(statuses).toEqual([429, 503, 413, 401, 202]);

    const counters = receiver.counters.snapshot();
    expect(counters.injected_429).toBe(1);
    expect(counters.injected_503).toBe(1);
    expect(counters.injected_413).toBe(1);
    expect(counters.injected_401).toBe(1);
    expect(counters.injected_timeout).toBe(1);
    expect(counters.injected_reset).toBe(1);
  });

  it('M01-AC-09 序列耗尽后恢复正常处理', async () => {
    receiver.injection.setSequence(['503', 'none']);
    expect((await postBatch()).status).toBe(503);
    expect((await postBatch()).status).toBe(202);
    expect((await postBatch()).status).toBe(202);
  });
});

describe('M01-AC-09 按比例注入故障', () => {
  it('M01-AC-09 按可注入随机源统计 1000 次的 503 占比在 25%–35%', () => {
    const injection = createInjectionController({ random: createSeededRandom(20261010) });
    injection.setRatio('503', 0.3);

    let hits = 0;
    for (let index = 0; index < 1_000; index += 1) {
      const decision = injection.decide();
      if (decision.kind === '503') hits += 1;
    }
    const share = hits / 1_000;
    expect(share).toBeGreaterThanOrEqual(0.25);
    expect(share).toBeLessThanOrEqual(0.35);
  });

  it('M01-AC-09 比例注入经 HTTP 生效且计数正确（真实占比 25%–35%）', async () => {
    receiver.injection.setRatio('503', 0.3);
    const total = 300;
    let hits = 0;
    for (let index = 0; index < total; index += 1) {
      const result = await postBatch();
      if (result.status === 503) {
        hits += 1;
        expect(result.headers['retry-after']).toBeDefined();
      } else {
        expect(result.status).toBe(202);
      }
    }
    const share = hits / total;
    expect(share).toBeGreaterThanOrEqual(0.25);
    expect(share).toBeLessThanOrEqual(0.35);
    expect(receiver.counters.snapshot().injected_503).toBe(hits);
  });

  it('M01-AC-09 清空注入配置后不再注入', async () => {
    receiver.injection.setSequence(['429']);
    expect((await postBatch()).status).toBe(429);
    receiver.injection.clear();
    expect((await postBatch()).status).toBe(202);
  });
});
