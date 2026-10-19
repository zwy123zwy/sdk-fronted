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

/**
 * 串行 POST 一个合法批次。
 *
 * `port` 默认按调用时刻从模块级变量读取（与 2026-10-19 事故现场一致）；需要在用例内
 * **绑定自己的端口**时显式传 `port`——这样即使有请求活过了用例，也只会打向本用例的
 * （已停止的）receiver，不会污染下一个用例。
 */
async function postBatch(
  options: { port?: number; signal?: AbortSignal } = {},
): Promise<HttpResult> {
  const batch = (await readExample('batch.valid.json')) as Json;
  return httpRequestTo(options.port ?? port, '/v1/batch', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: bodyOf(batch),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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

  /**
   * 2026-10-19 事故与修法（本轮收口，**不要**改成"给本用例加显式超时"）：
   *
   * 这条用例原本是 300 次**串行** HTTP 请求。在被抢占的机器上总耗时超过 vitest 默认
   * 5 s 超时；而 **vitest 的超时只是把用例判红，并不取消被测函数**——实测（探针，见
   * `docs/reports/t33-access-blockers.md` §13）：预算耗尽后循环**又完成了 80 个请求**。
   * 于是泄漏出两条相互独立的害处：
   *   ① 请求活过用例（用例结束后仍有在途请求）；
   *   ② 每个用例的 `beforeEach` 会重建 receiver 并改写**模块级 `port`**，因此泄漏循环的
   *      下一次请求打向**新** receiver 的 injection，先吃掉「清空注入配置后不再注入」
   *      用例的 `setSequence(['429'])`（`none` 不推进游标，所以只吃掉一次）⇒ 该用例拿到
   *      202 而不是 429。
   *
   * 因此修法是**消除泄漏**，共三道（缺一不可）：
   *   1. 用 vitest 的 `TestContext.signal`（超时即 abort，实测 5,005 ms 触发）取消在途
   *      请求，并让循环在 abort 后不再发新请求；
   *   2. `finally` 里再 abort 一次并 `await Promise.allSettled(...)`，把本用例发出的请求
   *      **全部结算**后才离开用例；
   *   3. 用例内绑定自己的端口（`targetPort`），任何残留请求都不可能打向下一个 receiver。
   *
   * 请求数（300）与 25%–35% 的带**未改动**：M01-AC-09 原文要求的 1,000 次占比由同文件
   * 上一条确定性用例承担，本条只验证「经 HTTP 生效且计数正确」。
   */
  it('M01-AC-09 比例注入经 HTTP 生效且计数正确（真实占比 25%–35%）', async ({ signal }) => {
    receiver.injection.setRatio('503', 0.3);
    const total = 300;
    const targetPort = port;
    const controller = new AbortController();
    const cancelOnTestEnd = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', cancelOnTestEnd, { once: true });
    const pending = new Set<Promise<HttpResult>>();
    let hits = 0;
    let sampled = 0;
    try {
      for (let index = 0; index < total; index += 1) {
        if (controller.signal.aborted) break;
        const request = postBatch({ port: targetPort, signal: controller.signal });
        pending.add(request);
        const settled = await request.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        pending.delete(request);
        if (!settled.ok) {
          // 只有「用例超时 → signal abort」才允许静默收尾；其他错误照常抛。
          // 这里读 `signal`（而不是 controller.signal）：后者已被上面的 early-break 收窄成 false。
          if (signal.aborted) break;
          throw settled.error;
        }
        sampled += 1;
        const result = settled.value;
        if (result.status === 503) {
          hits += 1;
          expect(result.headers['retry-after']).toBeDefined();
        } else {
          expect(result.status).toBe(202);
        }
      }
    } finally {
      signal.removeEventListener('abort', cancelOnTestEnd);
      controller.abort();
      await Promise.allSettled([...pending]);
      expect(pending.size, '用例结束时仍有在途请求').toBe(0);
    }
    expect(sampled, '用例必须跑满 300 次请求（超时会先 abort，不会静默少跑）').toBe(total);
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
