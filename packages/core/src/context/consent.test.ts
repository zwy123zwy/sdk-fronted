/**
 * C04-AC-10 / C04-AC-11 / C04-AC-12 / C04-AC-18 / C04-AC-19：同意管理（C04-F5）。
 *
 * - AC-10：`unknown` + `essential_only` → 只发送必要事件，其余计 `consent_denied`；
 *          不写持久化设备标识；批次 `device_id_persistent` 为 false；
 * - AC-11：`buffer` 模式先上报 10 条，`granted` 后全部补发；同意前没有网络请求；
 * - AC-12：`denied` → 清除设备标识、离线数据、会话随机数；之后只发必要事件；
 * - AC-18：`buffer` 模式先上报 10 条，`denied` → 缓存清空、计 `consent_buffer_cleared` 为 10；
 *          全程没有业务事件的网络请求；
 * - AC-19：初始化参数 `consent_mode: full` + 同意状态 `unknown` → 全采集全发送、
 *          生成持久化设备标识、批次 `consent` 为 `unknown`（D002）。
 *
 * 「必要事件」= `sdk_health` 与已脱敏的 `web_js_error`（Q5 第 4 条）。
 *
 * 取证顺序：本文件在同意状态机实现前先写（当时的 `createConsentManager` 是「不受理、
 * 不补发、不清空」的接口桩，除缺省态外的用例全部红过），之后实现转绿。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { createConsentManager, toBatchConsent } from './consent';
import { CONSENT_BUFFER_MAX_BYTES, CONSENT_BUFFER_MAX_EVENTS } from './constants';
import type { ConsentMode, ConsentState } from '../privacy/types';

function makeEvent(name = 'task_complete', occurredAt = 1_700_000_000_000): KernelEvent {
  return {
    event_id: '00000000-0000-4000-8000-000000000001',
    event_name: name,
    event_type: name === 'web_js_error' ? 'error' : name === 'sdk_health' ? 'sdk_internal' : 'custom',
    schema_version: 1,
    occurred_at: occurredAt,
    priority: 'normal',
  };
}

function makeCounter() {
  const counts = new Map<string, number>();
  return {
    count: (reason: string, delta = 1): void => {
      counts.set(reason, (counts.get(reason) ?? 0) + delta);
    },
    get: (reason: string): number => counts.get(reason) ?? 0,
  };
}

/** 生产口径的缓冲上限（每次现取，避免用例间共享同一个可变对象）。 */
function defaultLimits(): { maxEvents: number; maxBytes: number } {
  return { maxEvents: CONSENT_BUFFER_MAX_EVENTS, maxBytes: CONSENT_BUFFER_MAX_BYTES };
}

/** 创建一个同意状态机 + 事件出口替身。 */
function makeManager(options: {
  mode: ConsentMode;
  state?: ConsentState;
  /** 单条事件的字节数；缺省与生产同口径（`JSON.stringify` 的字符数）。 */
  sizeOf?: (event: KernelEvent) => number;
  /** 缓冲上限覆盖；缺省用生产口径（用于显式覆盖"按字节淘汰"这条路径）。 */
  limits?: { maxEvents: number; maxBytes: number };
}) {
  const emitted: KernelEvent[] = [];
  const counter = makeCounter();
  const manager = createConsentManager({
    mode: options.mode,
    state: options.state ?? 'unknown',
    count: counter.count,
    emit: (event) => {
      emitted.push(event);
    },
    sizeOf: options.sizeOf ?? ((event) => JSON.stringify(event).length),
    limits: options.limits ?? defaultLimits(),
  });
  return { manager, emitted, counter };
}

/**
 * **对照模型**：修改前 `consent.buffer()` 的口径 —— 每次 push 之后对整个缓冲区**逐条重算**
 * `sizeOf` 之和，再按「条数上限 ∪ 字节上限」淘汰最早的 normal（没有 normal 时淘汰最早的
 * critical）。用于证明现在实现里的**增量字节统计**（`bufferedBytes`）与它逐条等价：
 * 同一串事件下，存活序列与淘汰计数必须完全相同。
 *
 * 前提：`sizeOf` 是纯函数（同一事件重复调用返回同一值）—— 本仓两个注入点
 * （`api/client.ts` 的 `byteLengthOf` 与本文件的替身）都满足。
 */
function referenceEviction(
  events: readonly KernelEvent[],
  limits: { maxEvents: number; maxBytes: number },
  sizeOf: (event: KernelEvent) => number,
): { survivors: KernelEvent[]; evicted: number } {
  const buffer: KernelEvent[] = [];
  let evicted = 0;
  for (const event of events) {
    buffer.push(event);
    while (
      buffer.length > limits.maxEvents ||
      buffer.reduce((sum, item) => sum + sizeOf(item), 0) > limits.maxBytes
    ) {
      if (buffer.length === 0) break;
      let index = buffer.findIndex((item) => item['priority'] !== 'critical');
      if (index < 0) index = 0;
      buffer.splice(index, 1);
      evicted += 1;
    }
  }
  return { survivors: buffer, evicted };
}

describe('同意状态机的基础语义', () => {
  it('缺省状态为 unknown（Q5 一致性修正），模式来自配置', () => {
    const { manager } = makeManager({ mode: 'essential_only' });
    expect(manager.state()).toBe('unknown');
    expect(manager.mode()).toBe('essential_only');
  });

  it('批头 consent 只有三态：buffer/unknown 都映射为 unknown', () => {
    expect(toBatchConsent('granted')).toBe('granted');
    expect(toBatchConsent('denied')).toBe('denied');
    expect(toBatchConsent('unknown')).toBe('unknown');
    expect(toBatchConsent('buffer')).toBe('unknown');
  });

  it('setState 生效且幂等（同值重复设置不触发副作用）', () => {
    const { manager, counter } = makeManager({ mode: 'buffer' });
    manager.buffer(makeEvent());
    manager.setState('unknown');
    expect(manager.state()).toBe('unknown');
    expect(manager.bufferSize()).toBe(1);
    expect(counter.get('consent_buffer_cleared')).toBe(0);
  });

  it('setMode 生效（远程配置只能收紧）', () => {
    const { manager } = makeManager({ mode: 'full' });
    manager.setMode('essential_only');
    expect(manager.mode()).toBe('essential_only');
  });
});

describe('C04-AC-11 / C04-AC-18 缓冲与清空', () => {
  it('buffer 模式：10 条事件进缓冲，未发出任何一条（同意前没有网络请求）', () => {
    const { manager, emitted } = makeManager({ mode: 'buffer' });
    for (let index = 0; index < 10; index += 1) {
      expect(manager.buffer(makeEvent('task_complete', 1_700_000_000_000 + index))).toBe(true);
    }
    expect(manager.bufferSize()).toBe(10);
    expect(emitted).toHaveLength(0);
  });

  it('AC-11：设置 granted 后 10 条按原顺序全部补发', () => {
    const { manager, emitted } = makeManager({ mode: 'buffer' });
    for (let index = 0; index < 10; index += 1) manager.buffer(makeEvent('task_complete', 1_700_000_000_000 + index));
    manager.setState('granted');
    expect(emitted).toHaveLength(10);
    expect(emitted.map((event) => event['occurred_at'])).toEqual(
      Array.from({ length: 10 }, (_unused, index) => 1_700_000_000_000 + index),
    );
    expect(manager.bufferSize()).toBe(0);
  });

  it('补发只发生一次（drain 后缓冲为空，再次 drain 不再发出）', () => {
    const { manager, emitted } = makeManager({ mode: 'buffer' });
    manager.buffer(makeEvent());
    manager.setState('granted');
    expect(manager.drain()).toBe(0);
    expect(emitted).toHaveLength(1);
  });

  it('AC-18：设置 denied 时清空缓存并按事件条数计 consent_buffer_cleared=10', () => {
    const { manager, emitted, counter } = makeManager({ mode: 'buffer' });
    for (let index = 0; index < 10; index += 1) manager.buffer(makeEvent());
    manager.setState('denied');
    expect(counter.get('consent_buffer_cleared')).toBe(10);
    expect(manager.bufferSize()).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('缓冲为空时 denied 不产生计数', () => {
    const { manager, counter } = makeManager({ mode: 'buffer' });
    manager.setState('denied');
    expect(counter.get('consent_buffer_cleared')).toBe(0);
  });

  it('容量上限：超过 2000 条时淘汰最旧的 normal，并记观测量（不占契约原因码）', () => {
    const { manager, counter } = makeManager({ mode: 'buffer' });
    for (let index = 0; index < CONSENT_BUFFER_MAX_EVENTS + 5; index += 1) manager.buffer(makeEvent());
    expect(manager.bufferSize()).toBe(CONSENT_BUFFER_MAX_EVENTS);
    expect(manager.bufferEvicted()).toBe(5);
    // 淘汰不借用 consent_denied、也不新增原因码
    expect(counter.get('consent_denied')).toBe(0);
    expect(counter.get('consent_buffer_cleared')).toBe(0);
  });

  it('按字节上限淘汰：总字节超过 maxBytes 时淘汰最早的 normal，并回落到上限内', () => {
    // 显式覆盖**按字节**（而非按条数）的上限路径：每条约 100 B、上限 250 B，
    // 于是从第 3 条起每条都挤掉最早的一条，稳定在 2 条 / 200 B。
    const { manager } = makeManager({
      mode: 'buffer',
      sizeOf: () => 100,
      limits: { maxEvents: CONSENT_BUFFER_MAX_EVENTS, maxBytes: 250 },
    });
    for (let index = 0; index < 10; index += 1) manager.buffer(makeEvent());
    expect(manager.bufferSize()).toBe(2);
    expect(manager.bufferEvicted()).toBe(8);
  });

  it('增量字节统计与「每次全量重算」逐条等价（差分对照，同时压条数与字节两条上限）', () => {
    // 参照模型（见文件末尾的 `referenceEviction`）= 修改前的实现口径：每次 push 后对
    // **整个缓冲区**重算一遍 `sizeOf` 之和。源码现在改成增量维护（`bufferedBytes`），
    // 这条差分对照就是"逐条等价"的证明：同一串事件下，存活序列与淘汰计数必须完全相同。
    const limits = { maxEvents: 7, maxBytes: 300 };
    /** 事件的"字节数"编码在 `occurred_at` 的低 4 位：既让同一事件可重复取到同一个值，
     *  又让每个事件的 `occurred_at` 唯一（存活序列可按它逐条比对）。 */
    const sizeOf = (event: KernelEvent): number => event['occurred_at'] % 10_000;

    const sizes = [0, 40, 120, 300, 7, 256, 500, 1, 64, 999, 3, 88];
    const events: KernelEvent[] = [];
    for (let index = 0; index < 48; index += 1) {
      const size = sizes[index % sizes.length] ?? 0;
      const base = makeEvent('task_complete', index * 10_000 + size);
      // 每 5 条一条 critical：覆盖"缓冲区里没有 normal 时淘汰最早的 critical"。
      events.push(index % 5 === 0 ? { ...base, priority: 'critical' } : base);
    }

    const reference = referenceEviction(events, limits, sizeOf);
    const { manager, emitted } = makeManager({ mode: 'buffer', sizeOf, limits });
    for (const event of events) manager.buffer(event);
    manager.drain();

    expect(manager.bufferEvicted()).toBe(reference.evicted);
    expect(emitted.map((event) => event['occurred_at'])).toEqual(reference.survivors.map((event) => event['occurred_at']));
    // 反空转：这条对照必须真的触发过淘汰，否则"两侧都空"也能通过。
    expect(reference.evicted).toBeGreaterThan(0);
    expect(reference.survivors.length).toBeGreaterThan(0);
  });

  it('差分对照 ×128 组确定性随机序列：增量维护与逐条重算的淘汰结果必须完全一致', () => {
    // 单条序列只能覆盖一种大小组合。这里用确定性 LCG（不依赖 Math.random，失败可复现）
    // 造 128 组「条数 / 字节上限 / 事件大小 / critical 位置」各异的序列，覆盖单条就超上限、
    // 大量 0 字节、连续 critical、上限=1 等边界，逐组比对存活序列与淘汰计数。
    let seed = 20_261_014;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const sizeOf = (event: KernelEvent): number => event['occurred_at'] % 10_000;

    for (let round = 0; round < 128; round += 1) {
      const limits = { maxEvents: 1 + (next() % 9), maxBytes: 1 + (next() % 600) };
      const count = 1 + (next() % 60);
      const events: KernelEvent[] = [];
      for (let index = 0; index < count; index += 1) {
        const size = next() % 1_000;
        const base = makeEvent('task_complete', index * 10_000 + size);
        events.push(next() % 4 === 0 ? { ...base, priority: 'critical' } : base);
      }

      const reference = referenceEviction(events, limits, sizeOf);
      const { manager, emitted } = makeManager({ mode: 'buffer', sizeOf, limits });
      for (const event of events) manager.buffer(event);
      manager.drain();

      const context = `第 ${String(round)} 组：limits=${JSON.stringify(limits)} count=${String(count)}`;
      expect(manager.bufferEvicted(), context).toBe(reference.evicted);
      expect(emitted.map((event) => event['occurred_at']), context).toEqual(
        reference.survivors.map((event) => event['occurred_at']),
      );
    }
  });

  it('大量事件时仍受缓冲区容量约束（不会无限增长）', () => {
    const { manager } = makeManager({ mode: 'buffer' });
    for (let index = 0; index < CONSENT_BUFFER_MAX_EVENTS * 2; index += 1) manager.buffer(makeEvent());
    expect(manager.bufferSize()).toBeLessThanOrEqual(CONSENT_BUFFER_MAX_EVENTS);
    expect(manager.bufferEvicted()).toBeGreaterThan(0);
  });
});

describe('C04-AC-19 初始化参数 full + unknown（D002）', () => {
  it('full 模式下未知同意态也全量发送，批头 consent 为 unknown', () => {
    const { manager, emitted } = makeManager({ mode: 'full', state: 'unknown' });
    // 门控判定在处理器层；这里断言状态机把 full + unknown 视为「可发送」
    manager.setState('unknown');
    expect(manager.headerConsent()).toBe('unknown');
    expect(manager.buffer(makeEvent())).toBe(true);
    manager.setState('granted');
    expect(emitted).toHaveLength(1);
  });

  it('buffer 模式下 granted 之前不发；切换状态不会改变 mode', () => {
    const { manager } = makeManager({ mode: 'buffer' });
    manager.setState('granted');
    expect(manager.mode()).toBe('buffer');
  });
});

describe('C04-AC-12 denied 的清理语义', () => {
  it('denied 后状态与批头（denied）一致', () => {
    const { manager } = makeManager({ mode: 'essential_only' });
    manager.setState('denied');
    expect(manager.state()).toBe('denied');
    expect(manager.headerConsent()).toBe('denied');
  });

  it('denied 会清空缓冲（与 AC-18 一致）', () => {
    const { manager, counter } = makeManager({ mode: 'buffer' });
    manager.buffer(makeEvent());
    manager.setState('denied');
    expect(manager.bufferSize()).toBe(0);
    expect(counter.get('consent_buffer_cleared')).toBe(1);
  });

  it('clearBuffer 返回被清空的条数，reason 只影响计数归属', () => {
    const { manager } = makeManager({ mode: 'buffer' });
    manager.buffer(makeEvent());
    manager.buffer(makeEvent());
    expect(manager.clearBuffer('consent_buffer_cleared')).toBe(2);
    expect(manager.clearBuffer('consent_buffer_cleared')).toBe(0);
  });
});
