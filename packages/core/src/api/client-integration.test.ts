/**
 * C04 的端到端接线用例（经公共 API 真实产出）。
 *
 * 覆盖：
 * - AC-01：`track` 产出的事件带 `page_id`/`view_id`/`url`；
 * - AC-03：页面 A 入队后切到 B 再发送，A 的事件仍带 A 的 `view_id`；
 * - AC-04：`setPage` 的值原样成为 `page_id`；
 * - AC-05：`setContext` / `removeContext` 的语义；
 * - AC-07：错误信息与维度里的伪造 PII 经公共 API 上报后被掩码，且事件照常上报；
 * - AC-10：`unknown` + `essential_only` → 非必要事件被拒并计 `consent_denied`；
 * - AC-11：`buffer` 模式先缓存、`granted` 后补发；
 * - AC-17：非法维度键经公共 API 被丢弃并计 `invalid_field_key`；
 * - AC-19：初始化 `consent_mode: full` + `unknown` → 事件照常发出。
 *
 * 取证顺序：本文件在 `api/client.ts` 接线前先写（当时 C01 的 `setContext`/`setUser`/
 * `setConsent`/`setPage` 只改闭包内状态、不产出任何行为，因此大部分用例红过）。
 */
import { describe, expect, it } from 'vitest';

import { createClient } from './client';
import { STATE_CAPABILITY } from './client';
import type { Client, ClientState, EventSink } from './types';
import type { KernelEvent } from '../kernel';

/** 采集事件出口。 */
function collector(): { sink: EventSink; events: KernelEvent[] } {
  const events: KernelEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

/** 读取只读状态快照（与既有 C01 测试同一方式）。 */
function stateOf(client: Client): ClientState {
  const reader = client.kernel.getCapability(STATE_CAPABILITY) as (() => ClientState) | undefined;
  if (reader === undefined) throw new Error('缺少 STATE_CAPABILITY');
  return reader();
}

function setup(
  options: {
    consent?: 'granted' | 'denied' | 'buffer' | 'unknown';
    consentMode?: 'essential_only' | 'buffer' | 'full';
    url?: string;
    pageId?: string;
    allowlist?: readonly string[];
  } = {},
) {
  const { sink, events } = collector();
  const client = createClient({
    onEvent: sink,
    location: { href: options.url ?? 'https://a.example/p?tab=1', pageId: options.pageId },
    ...(options.allowlist === undefined ? {} : { url_query_allowlist: options.allowlist }),
  });
  client.init({
    appId: 'app-a',
    ...(options.consent === undefined ? {} : { consent: options.consent }),
    ...(options.consentMode === undefined ? {} : { consent_mode: options.consentMode }),
    ...(options.pageId === undefined ? {} : { pageId: options.pageId }),
  });
  return { client, events };
}

describe('C04-AC-01 / AC-03 / AC-04 上下文与页面归属（端到端）', () => {
  it('track 产出的事件带 page_id / view_id / url', () => {
    const { client, events } = setup({ pageId: '/task/:id', consent: 'granted', allowlist: ['tab'] });
    client.track('task_complete', { dimensions: { task_id: 't-1' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.['page_id']).toBe('/task/:id');
    expect(typeof events[0]?.['view_id']).toBe('string');
    expect(events[0]?.['url']).toBe('https://a.example/p?tab=1');
  });

  it('AC-03：A 入队后切到 B，A 的事件保留 A 的 view_id；B 的事件用新 view_id', () => {
    const { client, events } = setup({ pageId: '/a', consent: 'granted' });
    client.track('task_complete');
    const viewA = events[0]?.['view_id'];
    client.setPage('/b');
    client.track('task_complete');
    expect(events).toHaveLength(2);
    expect(events[0]?.['view_id']).toBe(viewA);
    expect(events[1]?.['view_id']).not.toBe(viewA);
    expect(events[0]?.['page_id']).toBe('/a');
    expect(events[1]?.['page_id']).toBe('/b');
  });

  it('AC-04：setPage("/task/:id") 使 page_id 原样为 /task/:id', () => {
    const { client, events } = setup({ consent: 'granted' });
    client.setPage('/task/:id');
    client.track('task_complete');
    expect(events[0]?.['page_id']).toBe('/task/:id');
  });
});

describe('C04-AC-05 自定义上下文（端到端）', () => {
  it('setContext 后事件含 context.k1；removeContext 后不含', () => {
    const { client, events } = setup({ consent: 'granted' });
    client.setContext('k1', 'v1');
    client.track('task_complete');
    client.removeContext('k1');
    client.track('task_complete');
    expect(events[0]?.['context']).toEqual({ k1: 'v1' });
    expect(events[1]?.['context']).toBeUndefined();
  });

  it('初始化参数里的 context 也会进入事件', () => {
    const { sink, events } = collector();
    const client = createClient({ onEvent: sink });
    client.init({ appId: 'app-a', consent: 'granted', context: { tenant: 'acme' } });
    client.track('task_complete');
    expect(events[0]?.['context']).toEqual({ tenant: 'acme' });
  });

  it('非法上下文键被丢弃并计 invalid_field_key（不是 invalid_args）', () => {
    const { client, events } = setup();
    const before = client.kernel.counters.get('invalid_field_key');
    client.setContext('Title', 'v');
    client.track('task_complete');
    expect(events[0]?.['context']).toBeUndefined();
    expect(client.kernel.counters.get('invalid_field_key')).toBe(before + 1);
    expect(client.kernel.counters.get('invalid_args')).toBe(0);
  });
});

describe('C04-AC-07 / AC-17 端上脱敏与字段约束（端到端）', () => {
  it('错误信息里的伪造 PII 被掩码，事件照常上报（计数不影响上报）', () => {
    const { client, events } = setup({ consent: 'granted' });
    client.captureError(new Error('submit 13800138000 alice.smith+tag@example.co.uk failed'));
    client.flush();
    expect(events).toHaveLength(1);
    const dimensions = events[0]?.['dimensions'] as Record<string, string>;
    expect(dimensions['message']).toBe('submit 1********** ***@*** failed');
  });

  it('维度值里的伪造 PII 被掩码', () => {
    const { client, events } = setup({ consent: 'granted' });
    client.track('task_complete', { dimensions: { contact: 'mail a@b.com' } });
    expect((events[0]?.['dimensions'] as Record<string, string>)['contact']).toBe('mail ***@***');
  });

  it('非法维度键被丢弃并计 invalid_field_key', () => {
    const { client, events } = setup({ consent: 'granted' });
    client.track('task_complete', { dimensions: { Title: 'v', '1abc': 'v', ok: 'v' } });
    expect(events[0]?.['dimensions']).toEqual({ ok: 'v' });
    expect(client.kernel.counters.get('invalid_field_key')).toBe(2);
  });

  it('超长维度值被截断且事件仍发出', () => {
    const { client, events } = setup({ consent: 'granted' });
    client.track('task_complete', { dimensions: { title: 'x'.repeat(300) } });
    expect(((events[0]?.['dimensions'] as Record<string, string>)['title'] ?? '').length).toBe(256);
    expect(events[0]?.['truncated']).toContain('dimensions.title');
  });
});

describe('C04-AC-10 / AC-11 / AC-19 同意（端到端）', () => {
  it('AC-10：unknown + essential_only → 非必要事件被拒并计 consent_denied', () => {
    const { client, events } = setup({ consent: 'unknown', consentMode: 'essential_only' });
    client.track('task_complete');
    client.track('another_event');
    expect(events).toHaveLength(0);
    expect(client.kernel.counters.get('consent_denied')).toBe(2);
  });

  it('AC-10：必要事件（web_js_error）在 unknown + essential_only 下仍然发出', () => {
    // 说明：`sdk_health` 的事件名带保留前缀 `sdk_`，公共 API 的 `track` 会按 C01 的规则
    // 拒绝（`invalid_event_name`）；真实链路里 `sdk_health` 由 C08 经内核直接上报。
    // 因此这里用另一类必要事件 `web_js_error`（经真实公共 API 产出）验证同意门放行。
    const { client, events } = setup({ consent: 'unknown', consentMode: 'essential_only' });
    client.captureError(new Error('boom'));
    client.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.['event_name']).toBe('web_js_error');
    expect(client.kernel.counters.get('consent_denied')).toBe(0);
  });

  it('AC-10：保留前缀事件名仍由 C01 拒绝（与同意门无关）', () => {
    const { client, events } = setup({ consent: 'granted' });
    client.track('sdk_health', { metrics: { calls_total: 1 } });
    expect(events).toHaveLength(0);
    expect(client.kernel.counters.get('invalid_event_name')).toBe(1);
  });

  it('AC-11：buffer 模式先缓存 10 条，granted 后全部补发', () => {
    const { client, events } = setup({ consent: 'unknown', consentMode: 'buffer' });
    for (let index = 0; index < 10; index += 1) client.track('task_complete', { metrics: { index } });
    expect(events).toHaveLength(0);
    client.setConsent('granted');
    expect(events).toHaveLength(10);
  });

  it('AC-19：初始化 consent_mode: full + unknown → 事件照常发出', () => {
    const { client, events } = setup({ consent: 'unknown', consentMode: 'full' });
    client.track('task_complete');
    expect(events).toHaveLength(1);
    expect(client.kernel.counters.get('consent_denied')).toBe(0);
  });

  it('AC-19：full 模式下状态快照的 consent 仍是 unknown', () => {
    const { client } = setup({ consent: 'unknown', consentMode: 'full' });
    expect(stateOf(client).consent).toBe('unknown');
    expect(stateOf(client).consentMode).toBe('full');
  });

  it('Q5 一致性：未传 consent 时缺省为 unknown（不是 granted）', () => {
    const { client } = setup({ consentMode: 'essential_only' });
    expect(stateOf(client).consent).toBe('unknown');
  });
});
