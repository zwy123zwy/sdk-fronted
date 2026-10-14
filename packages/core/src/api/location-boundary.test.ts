/**
 * D-01 的**边界单测**：注入的位置来源（`LocationSource`）与初始化参数是**外部输入**，
 * 运行期可能不是类型声明所说的 `string | undefined`（JS 接入方、SSR 适配层、
 * 反序列化出来的位置快照）。
 *
 * 口径（与 `context/page.ts` 的既有先例一致：非法 `page_id` 丢弃、保持合法状态）：
 * - 非字符串 / 空串的 `pageId` 一律按"未设置"处理 → 事件体**不写该键**（不是写 `null`）；
 * - 非字符串的 `href` 一律按"未提供"处理 → 不进入 `url`，且**不得抛错**；
 * - `init({ pageId })` / `setPage` 拿到非字符串时**不抛错**（公共方法"从不抛错"）。
 *
 * 为什么单独一组用例：`batch.schema.json` 的 `page_id` 是 `{type: string, maxLength: 256}`
 * 且不在 `required`，所以唯一合法的两种形态是"键不存在"或"string"。`null` 会让
 * **整批**被按结构非法的接收方（M01 等）以 400 拒收 —— 见 `docs/reports/t33-access-blockers.md` D-01。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { createClient } from './index';
import type { Client, LocationSource } from './types';

/** 外部位置快照：只表达"运行期形状不受类型系统约束"，不构造任何业务数据。 */
function externalLocation(value: unknown): LocationSource {
  return value as LocationSource;
}

function captured(): { readonly client: Client; readonly events: KernelEvent[] } {
  const events: KernelEvent[] = [];
  const client = createClient({ onEvent: (event) => events.push(event) });
  return { client, events };
}

/** `page_id` 在事件体里必须"键不存在或为 string"；返回实际观察到的形态。 */
function pageIdShape(event: KernelEvent | undefined): 'absent' | 'string' | 'other' {
  if (event === undefined) return 'absent';
  if (!Object.prototype.hasOwnProperty.call(event, 'page_id')) return 'absent';
  return typeof event['page_id'] === 'string' ? 'string' : 'other';
}

describe('D-01：外部 pageId 不得产出契约外的 null / 非字符串', () => {
  it('location.pageId 运行期为 null：事件不写 page_id，且不抛错', () => {
    const { client, events } = captured();
    client.init({
      appId: 'app-a',
      consent: 'granted',
      location: externalLocation({ href: 'https://app.example.invalid/p', pageId: null }),
    });
    client.track('task_complete');
    client.flush();

    expect(events).toHaveLength(1);
    expect(pageIdShape(events[0])).toBe('absent');
  });

  it('location.pageId 运行期为数字：事件不写 page_id', () => {
    const { client, events } = captured();
    client.init({
      appId: 'app-a',
      consent: 'granted',
      location: externalLocation({ href: 'https://app.example.invalid/p', pageId: 42 }),
    });
    client.track('task_complete');
    client.flush();

    expect(events).toHaveLength(1);
    expect(pageIdShape(events[0])).toBe('absent');
  });

  it('location.pageId 合法时仍原样使用（兜底不得丢值）', () => {
    const { client, events } = captured();
    client.init({
      appId: 'app-a',
      consent: 'granted',
      location: externalLocation({ href: 'https://app.example.invalid/p', pageId: '/injected' }),
    });
    client.track('task_complete');
    client.flush();

    expect(events[0]?.['page_id']).toBe('/injected');
  });

  it('init({ pageId: null }) 不抛错（公共方法从不抛错），且不写 page_id', () => {
    const { client, events } = captured();
    expect(() => {
      client.init({ appId: 'app-a', consent: 'granted', pageId: null as unknown as string });
    }).not.toThrow();
    client.track('task_complete');
    client.flush();

    expect(pageIdShape(events[0])).toBe('absent');
  });

  it('location.href 运行期为 null：不抛错，且不写 url', () => {
    const { client, events } = captured();
    client.init({
      appId: 'app-a',
      consent: 'granted',
      location: externalLocation({ href: null, pageId: '/p' }),
    });
    expect(() => {
      client.track('task_complete');
    }).not.toThrow();
    client.flush();

    expect(events).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(events[0] ?? {}, 'url')).toBe(false);
    expect(events[0]?.['page_id']).toBe('/p');
  });

  it('setPage 拿到非字符串不抛错（先例：非法 page_id 丢弃并计 invalid_args）', () => {
    const { client, events } = captured();
    client.init({ appId: 'app-a', consent: 'granted' });
    expect(() => {
      client.setPage(null as unknown as string);
    }).not.toThrow();

    client.track('task_complete');
    client.flush();
    expect(pageIdShape(events[0])).toBe('absent');
  });
});
