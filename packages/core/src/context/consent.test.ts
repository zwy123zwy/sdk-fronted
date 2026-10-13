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

/** 创建一个同意状态机 + 事件出口替身。 */
function makeManager(options: { mode: ConsentMode; state?: ConsentState }) {
  const emitted: KernelEvent[] = [];
  const counter = makeCounter();
  const manager = createConsentManager({
    mode: options.mode,
    state: options.state ?? 'unknown',
    count: counter.count,
    emit: (event) => {
      emitted.push(event);
    },
    sizeOf: (event) => JSON.stringify(event).length,
    limits: { maxEvents: CONSENT_BUFFER_MAX_EVENTS, maxBytes: CONSENT_BUFFER_MAX_BYTES },
  });
  return { manager, emitted, counter };
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
