/**
 * `createClient({ consent })` 必须生效（`docs/reports/t33-access-blockers.md` 的 D-09）。
 *
 * 缺陷：`client.ts` 把初始同意态硬编码为 `unknown`，**从不读 `options.consent`**；
 * 同一处的 `options.consent_mode` 却生效。结果是「看起来设了、实际没设」：
 * `createClient({ consent: 'granted' }) + init({ appId })` 下非必要事件全被
 * `consent_denied` 丢掉且不报错。
 *
 * 契约依据：Q5（`docs/decisions/Q5-consent.md` 第 2 条）——「初始化时为 `unknown`，
 * 接入方可以在**初始化参数**中传入已知状态」；`ClientOptions extends ClientInitOptions`
 * 且 `consent` 在该接口中声明为「初始同意状态，缺省 `unknown`」。
 *
 * 关系口径（不改语义，只固化既有事实）：
 * - `consent` 与 `consent_mode` 是**两条独立的轴**（状态 × 策略），判定见
 *   `privacy/consent-policy.ts`：`state === 'granted' || mode === 'full'` 即放行，
 *   因此两者不是「谁覆盖谁」，而是任一满足放行条件即放行；`full` 不重写状态快照。
 * - 同属初始化参数时 `init({ consent })` 覆盖 `createClient({ consent })`
 *   （`performInit` 用它覆盖闭包变量）；未传则不覆盖 `createClient` 的值。
 */
import { describe, expect, it } from 'vitest';

import { createClient, STATE_CAPABILITY } from './client';
import type { Client, ClientOptions, ClientState, ConsentState, EventSink } from './types';
import type { KernelEvent } from '../kernel';

/** 采集事件出口。 */
function collector(): { sink: EventSink; events: KernelEvent[] } {
  const events: KernelEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

/** 读取只读状态快照（与既有 C01/C04 测试同一方式）。 */
function stateOf(client: Client): ClientState {
  const reader = client.kernel.getCapability(STATE_CAPABILITY) as (() => ClientState) | undefined;
  if (reader === undefined) throw new Error('缺少 STATE_CAPABILITY');
  return reader();
}

/** 只影响 `createClient` 的注入面；`consent` / `consent_mode` 都可落在这里。 */
function setup(clientOptions: ClientOptions, initConsent?: ConsentState) {
  const { sink, events } = collector();
  const client = createClient({
    ...clientOptions,
    onEvent: sink,
    location: { href: 'https://a.example/p?tab=1', pageId: '/consent-probe' },
  });
  client.init({
    appId: 'app-a',
    ...(initConsent === undefined ? {} : { consent: initConsent }),
  });
  return { client, events };
}

describe('createClient({ consent }) 必须被读取（D-09）', () => {
  it("复现实测形态：createClient({ consent:'granted' }) + init({ appId }) → 两条 normal 事件都上报", () => {
    const { sink, events } = collector();
    const client = createClient({ consent: 'granted', onEvent: sink });
    client.init({ appId: 'app-a' });
    client.track('task_complete');
    client.track('another_event');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event['event_name'])).toEqual(['task_complete', 'another_event']);
    expect(client.kernel.counters.get('consent_denied')).toBe(0);
    expect(stateOf(client).consent).toBe('granted');
  });

  it("options.consent='denied'：deny(consent_denied) 判定路径不变，必要事件仍放行", () => {
    const { client, events } = setup({ consent: 'denied' });
    client.track('task_complete');
    expect(events).toHaveLength(0);
    expect(client.kernel.counters.get('consent_denied')).toBe(1);
    client.captureError(new Error('boom'));
    client.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.['event_name']).toBe('web_js_error');
    expect(client.kernel.counters.get('consent_denied')).toBe(1);
  });

  it("consent 与 consent_mode 是两条独立的轴：consent='granted' + essential_only 仍放行", () => {
    const { client, events } = setup({ consent: 'granted', consent_mode: 'essential_only' });
    client.track('task_complete');
    expect(events).toHaveLength(1);
    expect(client.kernel.counters.get('consent_denied')).toBe(0);
  });

  it("consent='denied' + consent_mode='full'：full 是放行条件（OR），但不重写状态快照", () => {
    const { client, events } = setup({ consent: 'denied', consent_mode: 'full' });
    client.track('task_complete');
    expect(events).toHaveLength(1);
    expect(client.kernel.counters.get('consent_denied')).toBe(0);
    expect(stateOf(client).consent).toBe('denied');
    expect(stateOf(client).consentMode).toBe('full');
  });

  it('init 未传 consent 时不覆盖 options.consent（granted 保留）', () => {
    const { client } = setup({ consent: 'granted' });
    expect(stateOf(client).consent).toBe('granted');
  });

  it('init({ consent }) 覆盖 createClient({ consent })：granted → denied', () => {
    const { client, events } = setup({ consent: 'granted' }, 'denied');
    client.track('task_complete');
    expect(events).toHaveLength(0);
    expect(client.kernel.counters.get('consent_denied')).toBe(1);
  });

  it('init({ consent }) 覆盖 createClient({ consent })：denied → granted', () => {
    const { client, events } = setup({ consent: 'denied' }, 'granted');
    client.track('task_complete');
    expect(events).toHaveLength(1);
    expect(client.kernel.counters.get('consent_denied')).toBe(0);
  });
});
