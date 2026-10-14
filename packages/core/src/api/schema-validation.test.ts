/**
 * C01 契约自证（本次返工的核心验收）：把公共 API 实际产出的事件用 Ajv（draft 2020-12）
 * 对着**冻结的契约 Schema** 校验。
 *
 * - `docs/contracts/schemas/batch.schema.json`：批次格式；其 `$defs/event` 是
 *   `additionalProperties: false`，本次返工修的 5 处违反都在这里被抓住。
 * - `docs/contracts/schemas/builtin-events/web_js_error.schema.json`：内置错误事件的
 *   完整字段约束（`dimensions` 必填 4 键、`metrics.count` 必填）。
 *
 * 同时用一个「故意不合法」的事件反向确认校验器确实在生效（避免出现空校验）。
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import webJsErrorSchema from '../../../../docs/contracts/schemas/builtin-events/web_js_error.schema.json';
import { createClient, createLocationSource, createUuid } from './index';
import type { KernelEvent } from '../kernel';

/** 契约 Schema 的 Ajv 实例（2020-12；非严格模式以兼容元数据字段）。 */
function createValidator(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

/** 组装一个最小合法批次，把事件放进去。 */
function makeBatch(events: readonly KernelEvent[], appId = 'app-a'): Record<string, unknown> {
  return {
    protocol_version: 1,
    app_id: appId,
    env: 'production',
    release: '1.0.0',
    sdk_name: '@web-report-sdk/browser',
    sdk_version: '0.0.0',
    device_id: createUuid(),
    session_id: createUuid(),
    batch_id: createUuid(),
    sent_at: Date.now(),
    clock_offset: 0,
    events,
  };
}

/** 用 Ajv 校验批次，失败时把错误打进断言信息便于定位。 */
function expectValidBatch(events: readonly KernelEvent[], appId = 'app-a'): void {
  const ajv = createValidator();
  const validate = ajv.compile(batchSchema);
  const batch = makeBatch(events, appId);
  const valid = validate(batch);
  expect(validate.errors ?? [], JSON.stringify(validate.errors ?? [], null, 2)).toEqual([]);
  expect(valid).toBe(true);
}

describe('C01 契约自证（Ajv 2020-12）', () => {
  it('track / log / captureError 产出的事件通过 batch.schema.json 校验', () => {
    const events: KernelEvent[] = [];
    const client = createClient({
      onEvent: (event) => events.push(event),
      dictionary: {
        task_complete: {
          priority: 'critical',
          schema_version: 2,
          dimensions: { task_id: { type: 'placeholder', required: true } },
          metrics: { duration_ms: { type: 0, required: true } },
        },
      },
    });
    client.init({ appId: 'app-a', consent: 'granted', pageId: '/task/:id' });

    client.track('task_complete', {
      dimensions: { task_id: 't-1', tenant: 'acme' },
      metrics: { duration_ms: 12, retry_count: 1 },
      attachment: 'detail',
    });
    client.track('any_unregistered_event', { dimensions: { key: 'v' }, metrics: { value: 1 } });
    client.log('warn', '磁盘将满', { dimensions: { disk: 'root' } });
    client.captureError(new Error('boom'), { dimensions: { source: 'manual' } });
    client.flush();

    expect(events).toHaveLength(4);
    expect(events.map((event) => event['event_name'])).toEqual([
      'task_complete',
      'any_unregistered_event',
      'sdk_log',
      'web_js_error',
    ]);
    // 事件体不得出现批次头字段
    for (const event of events) {
      expect(Object.prototype.hasOwnProperty.call(event, 'app_id')).toBe(false);
      expect(event['event_id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(event['schema_version']).toBeGreaterThanOrEqual(1);
      expect(['normal', 'critical']).toContain(event['priority']);
    }
    // 字典声明的 priority 与 schema_version 生效
    expect(events[0]?.['priority']).toBe('critical');
    expect(events[0]?.['schema_version']).toBe(2);
    // 未登记事件取默认值
    expect(events[1]?.['schema_version']).toBe(1);
    expect(events[1]?.['priority']).toBe('normal');

    expectValidBatch(events);
    client.destroy();
  });

  it('web_js_error 事件单独通过内置事件 Schema（dimensions 4 键 + metrics.count）', () => {
    const events: KernelEvent[] = [];
    const client = createClient({ onEvent: (event) => events.push(event) });
    client.init({ appId: 'app-a', consent: 'granted' });

    client.captureError(new TypeError('无法读取属性'), { metrics: { count: 3, line: 12, column: 4 } });
    client.flush();

    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.['event_name']).toBe('web_js_error');
    expect(event?.['event_type']).toBe('error');
    expect(event?.['priority']).toBe('normal');
    expect(event?.['schema_version']).toBe(1);
    expect(event?.['dimensions']).toMatchObject({
      error_type: 'TypeError',
      message: '无法读取属性',
      source: 'manual',
    });
    expect(typeof (event?.['dimensions'] as Record<string, unknown>)['fingerprint']).toBe('string');
    expect(event?.['metrics']).toEqual({ count: 3, line: 12, column: 4 });

    const ajv = createValidator();
    const validate = ajv.compile(webJsErrorSchema);
    const valid = validate(event);
    expect(validate.errors ?? [], JSON.stringify(validate.errors ?? [], null, 2)).toEqual([]);
    expect(valid).toBe(true);

    // 同一批事件也通过批次 Schema
    expectValidBatch(events);
    client.destroy();
  });

  it('同一输入在不同实例上产出的事件都能通过校验（多实例）', () => {
    const eventsA: KernelEvent[] = [];
    const eventsB: KernelEvent[] = [];
    const clientA = createClient({ onEvent: (event) => eventsA.push(event) });
    const clientB = createClient({ onEvent: (event) => eventsB.push(event) });
    // 位置**显式注入**，不依赖 happy-dom 的环境默认 URL（那是跨用例共享的环境全局状态：
    // 默认 URL 一变，事件里的 `url`/`page_id` 就跟着变，本用例的输入就不再自洽）。
    // 两个实例给**不同**的 URL，顺带让"实例间的位置/上下文串味"变成可被断言抓住的失败。
    clientA.init({
      appId: 'app-a',
      consent: 'granted',
      location: createLocationSource('https://app.example/a?utm_source=probe', '/a'),
    });
    clientB.init({
      appId: 'app-b',
      consent: 'granted',
      location: createLocationSource('https://app.example/b?utm_source=probe', '/b'),
    });

    clientA.track('page_view', { dimensions: { route: '/a' } });
    clientB.track('page_view', { dimensions: { route: '/b' } });
    clientA.flush();
    clientB.flush();

    // 实例隔离：A 的事件只能看到 A 的位置，B 的只能看到 B 的。
    expect(eventsA.map((event) => event['page_id'])).toEqual(['/a']);
    expect(eventsB.map((event) => event['page_id'])).toEqual(['/b']);
    expect(eventsA.map((event) => event['url'])).toEqual(['https://app.example/a']);
    expect(eventsB.map((event) => event['url'])).toEqual(['https://app.example/b']);

    expectValidBatch(eventsA, 'app-a');
    expectValidBatch(eventsB, 'app-b');
    clientA.destroy();
    clientB.destroy();
  });

  it('校验器确实生效：带 app_id 或缺少 event_id 的事件被拒绝', () => {
    const ajv = createValidator();
    const validate = ajv.compile(batchSchema);
    const bad = makeBatch([
      {
        event_name: 'task_complete',
        event_type: 'custom',
        schema_version: 1,
        priority: 'normal',
        occurred_at: Date.now(),
        app_id: 'app-a',
      },
    ]);
    expect(validate(bad)).toBe(false);
    expect((validate.errors ?? []).length).toBeGreaterThan(0);
  });
});
