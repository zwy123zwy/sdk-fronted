/**
 * C04 的处理器契约（C02-F2 六段管线的接入形态）。
 *
 * 覆盖：
 * - 字段约束处理器：丢弃路径必须返回 `stopPipeline('event_too_large')` 并计数（AC-15 的落点）；
 * - 同意门处理器：放行 / 缓冲 / `stopPipeline('consent_denied')`（AC-10/11/12/18 的落点）；
 * - 富化处理器：入队时已写好的值**不被覆盖**（AC-03 的语义基础）。
 *
 * 取证顺序：本文件在处理器实现前先写（当时的处理器是透传桩，除「放行」外的用例全部红过）。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { PRIVACY_REASON_CODES } from './reason-codes';
import { PROCESSOR_IDS, createConsentFilterProcessor, createContextEnrichProcessor, createFieldConstraintsProcessor } from './processors';
import { C04_LIMITS } from './constants';
import { createMasker } from './mask';
import { utf8Bytes } from './limits';
import type { ConsentMode, ConsentState } from './types';

function makeEvent(extra: Record<string, unknown> = {}): KernelEvent {
  return {
    event_id: '00000000-0000-4000-8000-000000000001',
    event_name: 'task_complete',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: 1_700_000_000_000,
    priority: 'normal',
    ...extra,
  };
}

/** 完整实现内核 `Counters`（处理器上下文要求全量接口）。 */
function makeCounter() {
  const counts = new Map<string, number>();
  return {
    count: (reason: string, delta = 1): void => {
      counts.set(reason, (counts.get(reason) ?? 0) + delta);
    },
    get: (reason: string): number => counts.get(reason) ?? 0,
    snapshot: (): Readonly<Record<string, number>> => Object.fromEntries(counts),
    reset: (): void => {
      counts.clear();
    },
  };
}

describe('字段约束处理器', () => {
  it('正常事件被放行（返回事件本身，而不是 stop）', () => {
    const counter = makeCounter();
    const processor = createFieldConstraintsProcessor({
      limits: C04_LIMITS,
      masker: createMasker(),
      count: counter.count,
    });
    const event = makeEvent({ dimensions: { ok: 'v' } });
    const result = processor(event, { stage: 'validate', counters: counter, processorId: PROCESSOR_IDS.fieldConstraints });
    expect(result).toBe(event);
    expect('stop' in result).toBe(false);
  });

  it('截断在处理器里发生（300 字符 → 256）', () => {
    const counter = makeCounter();
    const processor = createFieldConstraintsProcessor({ limits: C04_LIMITS, masker: createMasker(), count: counter.count });
    const result = processor(makeEvent({ dimensions: { title: 'x'.repeat(300) } }), {
      stage: 'validate',
      counters: counter,
      processorId: PROCESSOR_IDS.fieldConstraints,
    });
    expect(((result as KernelEvent)['dimensions'] as Record<string, string>)['title']).toHaveLength(256);
  });

  it('收到 dropped 结果时返回 stopPipeline(event_too_large) 并计数一次', () => {
    const counter = makeCounter();
    // `event_too_large` 的丢弃分支在格式合法的输入下不可达（阶梯总能压回 16 KB），
    // 因此这里注入一个必然返回 dropped 的约束替身，验证处理器侧**契约行为**。
    const processor = createFieldConstraintsProcessor({
      limits: C04_LIMITS,
      masker: createMasker(),
      count: counter.count,
      constrain: () => ({ event: makeEvent(), dropped: true, dropReason: PRIVACY_REASON_CODES.eventTooLarge }),
    });
    const result = processor(makeEvent(), { stage: 'validate', counters: counter, processorId: PROCESSOR_IDS.fieldConstraints });
    expect('stop' in result).toBe(true);
    expect((result as { stop: true; reason: string }).reason).toBe(PRIVACY_REASON_CODES.eventTooLarge);
    expect(counter.get(PRIVACY_REASON_CODES.eventTooLarge)).toBe(1);
  });

  it('阶梯在真实输入下总能压回上限（因此不会误触发整条丢弃）', () => {
    const counter = makeCounter();
    const processor = createFieldConstraintsProcessor({ limits: C04_LIMITS, masker: createMasker(), count: counter.count });
    const blobby: Record<string, string> = {};
    for (let index = 0; index < 400; index += 1) blobby[`blob_${String(index).padStart(3, '0')}_${'z'.repeat(60)}`] = 'v';
    const result = processor(makeEvent({ known: 'v', blobby }), {
      stage: 'validate',
      counters: counter,
      processorId: PROCESSOR_IDS.fieldConstraints,
    });
    expect('stop' in result).toBe(false);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(16384);
  });
});

describe('同意门处理器', () => {
  /** 构造一个可控的同意门。 */
  function makeGate(state: ConsentState, mode: ConsentMode) {
    const buffered: KernelEvent[] = [];
    return {
      buffered,
      gate: {
        state: (): ConsentState => state,
        mode: (): ConsentMode => mode,
        buffer: (event: KernelEvent): boolean => {
          buffered.push(event);
          return true;
        },
      },
    };
  }

  it('granted：所有事件放行', () => {
    const { gate, buffered } = makeGate('granted', 'essential_only');
    const processor = createConsentFilterProcessor(gate);
    const event = makeEvent();
    const result = processor(event, { stage: 'filter', counters: makeCounter(), processorId: PROCESSOR_IDS.consentGate });
    expect(result).toBe(event);
    expect(buffered).toHaveLength(0);
  });

  it('unknown + essential_only：非必要事件返回 stopPipeline(consent_denied)，必要事件放行', () => {
    const { gate } = makeGate('unknown', 'essential_only');
    const processor = createConsentFilterProcessor(gate);
    const context = { stage: 'filter', counters: makeCounter(), processorId: PROCESSOR_IDS.consentGate } as const;

    const custom = processor(makeEvent(), context);
    expect('stop' in custom).toBe(true);
    expect((custom as { reason: string }).reason).toBe(PRIVACY_REASON_CODES.consentDenied);

    const health = processor(makeEvent({ event_name: 'sdk_health', event_type: 'sdk_internal' }), context);
    expect(health).not.toBe(undefined);
    expect('stop' in health).toBe(false);
  });

  it('unknown + buffer：事件被停放到缓冲，且**不在管线里继续流转**', () => {
    const { gate, buffered } = makeGate('unknown', 'buffer');
    const processor = createConsentFilterProcessor(gate);
    const event = makeEvent();
    const result = processor(event, { stage: 'filter', counters: makeCounter(), processorId: PROCESSOR_IDS.consentGate });
    // 关键：必须终止管线，否则被缓存的事件会被当作正常事件发出（会重复上报）。
    expect('stop' in result).toBe(true);
    expect(buffered).toEqual([event]);
  });

  it('denied：非必要事件被拒（consent_denied），必要事件放行', () => {
    const { gate, buffered } = makeGate('denied', 'essential_only');
    const processor = createConsentFilterProcessor(gate);
    const context = { stage: 'filter', counters: makeCounter(), processorId: PROCESSOR_IDS.consentGate } as const;
    expect('stop' in processor(makeEvent(), context)).toBe(true);
    expect(buffered).toHaveLength(0);
    const error = processor(makeEvent({ event_name: 'web_js_error', event_type: 'error' }), context);
    expect('stop' in error).toBe(false);
  });

  it('unknown + full：全部放行（接入方在初始化参数里声明已授权）', () => {
    const { gate } = makeGate('unknown', 'full');
    const processor = createConsentFilterProcessor(gate);
    const result = processor(makeEvent(), { stage: 'filter', counters: makeCounter(), processorId: PROCESSOR_IDS.consentGate });
    expect('stop' in result).toBe(false);
  });
});

describe('富化处理器（入队快照优先）', () => {
  /** 记录调用次数的富化端口替身。 */
  function makePort() {
    const seen: KernelEvent[] = [];
    return {
      seen,
      port: {
        enrich: (event: KernelEvent): KernelEvent => {
          seen.push(event);
          return event;
        },
      },
    };
  }

  it('富化端口被调用（处理器不是空转）', () => {
    const { port, seen } = makePort();
    const processor = createContextEnrichProcessor(port);
    const event = makeEvent();
    const result = processor(event, { stage: 'enrich', counters: makeCounter(), processorId: PROCESSOR_IDS.contextEnrich });
    expect(seen).toEqual([event]);
    expect(result).toBe(event);
  });

  it('入队快照优先：端口不覆盖事件已有的 page_id/view_id（AC-03 的语义基础）', () => {
    // 端口按契约实现为「只补缺失值」：已有值原样保留。
    const port = {
      enrich: (event: KernelEvent): KernelEvent => {
        const next: KernelEvent = { ...event };
        next['page_id'] = next['page_id'] ?? '/current';
        next['view_id'] = next['view_id'] ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        return next;
      },
    };
    const processor = createContextEnrichProcessor(port);
    const event = makeEvent({ page_id: '/a', view_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const result = processor(event, { stage: 'enrich', counters: makeCounter(), processorId: PROCESSOR_IDS.contextEnrich }) as KernelEvent;
    expect(result['page_id']).toBe('/a');
    expect(result['view_id']).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('缺失值时由端口补齐', () => {
    const processor = createContextEnrichProcessor({
      enrich: (event) => ({ ...event, page_id: '/current', url: 'https://a.example/p' }),
    });
    const result = processor(makeEvent(), { stage: 'enrich', counters: makeCounter(), processorId: PROCESSOR_IDS.contextEnrich }) as KernelEvent;
    expect(result['page_id']).toBe('/current');
    expect(result['url']).toBe('https://a.example/p');
  });
});
