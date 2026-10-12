/**
 * C06-F3 批次组装与字段提升的验收用例（C06-AC-09）。
 *
 * 组装结果序列化成线上 JSON 后，用 `docs/contracts/schemas/batch.schema.json` 经
 * Ajv 2020-12（`ajv` 8.20.0，根目录开发依赖）真实校验；不再自写关键字子集校验器，
 * 避免与契约语义漂移。契约 Schema 未使用 `format` 关键字，因此不需要 `ajv-formats`。
 */
import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, test, vi } from 'vitest';
import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import type { BatchHeader, QueueEvent } from './types';
import { createBatchAssembler } from './assembler';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 默认 strict 模式即可编译冻结契约（无未知关键字告警）；allErrors 让失败信息完整。
const ajv = new Ajv2020({ allErrors: true });
const validateBatchSchema = ajv.compile(batchSchema);

/** 模拟线上报文：JSON.stringify 会丢掉 undefined 字段，接收方看到的就是这个对象。 */
function toWire(batch: unknown): unknown {
  return JSON.parse(JSON.stringify(batch)) as unknown;
}

/** 用契约 Schema 校验批次；失败时把 Ajv 的错误列表带进断言消息。 */
function expectSchemaValid(batch: unknown): void {
  const payload = toWire(batch);
  const valid = validateBatchSchema(payload);
  expect(valid, JSON.stringify(validateBatchSchema.errors)).toBe(true);
}

const START = 1793000000000;
const BATCH_ID = 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e';

const HEADER: BatchHeader = {
  protocol_version: 1,
  app_id: 'demo-app',
  env: 'staging',
  release: '1.4.0',
  sdk_name: 'web-report-sdk',
  sdk_version: '0.1.0',
  device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
  device_id_persistent: true,
  session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
  clock_offset: 0,
  clock_calibrated: true,
};

let seq = 0;

interface EventOverrides {
  readonly page_id?: string | undefined;
  readonly view_id?: string | undefined;
  readonly url?: string | undefined;
  readonly sample_rate?: number | undefined;
  readonly context?: Record<string, string> | undefined;
  readonly priority?: 'normal' | 'critical' | undefined;
}

function makeEvent(overrides: EventOverrides = {}): QueueEvent {
  seq += 1;
  const event: QueueEvent = {
    event_id: `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    event_name: 'web_pageview',
    event_type: 'pageview',
    schema_version: 1,
    occurred_at: START + seq,
    priority: overrides.priority ?? 'normal',
  };
  if (overrides.page_id !== undefined) event['page_id'] = overrides.page_id;
  if (overrides.view_id !== undefined) event['view_id'] = overrides.view_id;
  if (overrides.url !== undefined) event['url'] = overrides.url;
  if (overrides.sample_rate !== undefined) event['sample_rate'] = overrides.sample_rate;
  if (overrides.context !== undefined) event['context'] = overrides.context;
  event['metrics'] = { load_time_ms: 812 };
  return event;
}

function makeAssembler(header: BatchHeader = HEADER) {
  return createBatchAssembler({
    header: { header: () => header },
    now: () => START + 1000,
    createId: () => BATCH_ID,
  });
}

describe('C06-F3 批次组装与字段提升', () => {
  test('C06-AC-09 page_id 相同提升到 common，url 不同保留在事件体，批次通过 batch.schema.json 校验', () => {
    const assembler = makeAssembler();
    const events = [
      makeEvent({
        page_id: '/list',
        view_id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a',
        sample_rate: 1,
        url: 'https://app.example.com/list',
      }),
      makeEvent({
        page_id: '/list',
        view_id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a',
        sample_rate: 1,
        url: 'https://app.example.com/list?page=2',
      }),
    ];

    const batch = assembler.assemble(events);

    expect(batch.common).toEqual({
      page_id: '/list',
      view_id: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a',
      sample_rate: 1,
    });
    expect(batch.events[0]).not.toHaveProperty('page_id');
    expect(batch.events[0]?.['url']).toBe('https://app.example.com/list');
    expect(batch.events[1]?.['url']).toBe('https://app.example.com/list?page=2');
    expectSchemaValid(batch);
  });

  test('C06-AC-09 全部提升、部分提升、不提升三种形态都通过 Ajv 校验', () => {
    const assembler = makeAssembler();
    const viewId = 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a';

    const fullyPromoted = assembler.assemble([
      makeEvent({
        page_id: '/list',
        view_id: viewId,
        url: 'https://app.example.com/list',
        sample_rate: 0.5,
        context: { app: 'demo' },
      }),
      makeEvent({
        page_id: '/list',
        view_id: viewId,
        url: 'https://app.example.com/list',
        sample_rate: 0.5,
        context: { app: 'demo' },
      }),
    ]);

    const partiallyPromoted = assembler.assemble([
      makeEvent({ page_id: '/list', url: 'https://app.example.com/list' }),
      makeEvent({ page_id: '/list', url: 'https://app.example.com/detail' }),
    ]);

    const notPromoted = assembler.assemble([
      makeEvent({ page_id: '/list' }),
      makeEvent({ page_id: '/detail' }),
    ]);

    expectSchemaValid(fullyPromoted);
    expectSchemaValid(partiallyPromoted);
    expectSchemaValid(notPromoted);

    expect(Object.keys(fullyPromoted.common ?? {})).toHaveLength(5);
    expect(partiallyPromoted.common).toEqual({ page_id: '/list' });
    expect(partiallyPromoted.events[0]?.['url']).toBe('https://app.example.com/list');
    expect(notPromoted.common).toBeUndefined();
  });

  test('C06-AC-09 提升不改变语义：common 与事件体合并后与提升前一致', () => {
    const assembler = makeAssembler();
    const events = [
      makeEvent({ page_id: '/list', context: { app: 'demo' }, sample_rate: 1 }),
      makeEvent({ page_id: '/list', context: { app: 'demo' }, sample_rate: 1 }),
    ];

    const batch = assembler.assemble(events);

    batch.events.forEach((event, index) => {
      expect({ ...batch.common, ...event }).toEqual(events[index]);
    });
    expectSchemaValid(batch);
  });

  test('C06-AC-09 所有事件取值完全相同时五个字段全部提升', () => {
    const assembler = makeAssembler();
    const viewId = 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a';
    const events = [
      makeEvent({
        page_id: '/list',
        view_id: viewId,
        url: 'https://app.example.com/list',
        sample_rate: 0.5,
        context: { app: 'demo' },
      }),
      makeEvent({
        page_id: '/list',
        view_id: viewId,
        url: 'https://app.example.com/list',
        sample_rate: 0.5,
        context: { app: 'demo' },
      }),
    ];

    const batch = assembler.assemble(events);

    expect(Object.keys(batch.common ?? {}).sort()).toEqual([
      'context',
      'page_id',
      'sample_rate',
      'url',
      'view_id',
    ]);
    expectSchemaValid(batch);
  });

  test('C06-AC-09 取值不同或缺失时不提升', () => {
    const assembler = makeAssembler();
    const events = [
      makeEvent({ page_id: '/list', context: { app: 'demo' } }),
      makeEvent({ page_id: '/detail', context: { app: 'demo' } }),
    ];

    const batch = assembler.assemble(events);

    expect(batch.common ?? {}).not.toHaveProperty('page_id');
    expect(batch.events[0]).toHaveProperty('page_id');
    expectSchemaValid(batch);
  });

  test('C06-F3 context 深比较：键数或取值不同都不提升', () => {
    const assembler = makeAssembler();

    const differentValue = assembler.assemble([
      makeEvent({ context: { app: 'demo' } }),
      makeEvent({ context: { app: 'other' } }),
    ]);
    expect(differentValue.common ?? {}).not.toHaveProperty('context');
    expect(differentValue.events[0]).toHaveProperty('context');
    expectSchemaValid(differentValue);

    const differentKeys = assembler.assemble([
      makeEvent({ context: { app: 'demo' } }),
      makeEvent({ context: { app: 'demo', env: 'staging' } }),
    ]);
    expect(differentKeys.common ?? {}).not.toHaveProperty('context');
    expectSchemaValid(differentKeys);

    const sameKeysDifferentOrder = assembler.assemble([
      makeEvent({ context: { app: 'demo', env: 'staging' } }),
      makeEvent({ context: { env: 'staging', app: 'demo' } }),
    ]);
    expect(sameKeysDifferentOrder.common ?? {}).toHaveProperty('context');
    expectSchemaValid(sameKeysDifferentOrder);
  });

  test('C06-F3 批次头来自注入的 BatchHeaderSource，batch_id 与 sent_at 由组装器生成', () => {
    const assembler = makeAssembler();

    const batch = assembler.assemble([makeEvent({ priority: 'critical' })]);

    expect(batch).toMatchObject({
      protocol_version: 1,
      app_id: HEADER.app_id,
      env: HEADER.env,
      release: HEADER.release,
      sdk_name: HEADER.sdk_name,
      sdk_version: HEADER.sdk_version,
      device_id: HEADER.device_id,
      session_id: HEADER.session_id,
      clock_offset: 0,
      batch_id: BATCH_ID,
      sent_at: START + 1000,
    });
    expect(batch.events).toHaveLength(1);
    expectSchemaValid(batch);
  });

  test('C06-F3 空事件数组抛错（批次 minItems 为 1）', () => {
    const assembler = makeAssembler();

    expect(() => assembler.assemble([])).toThrow();
  });

  test('C06-F3 Ajv 校验是有效门禁：缺必填头字段或出现未声明字段都判为非法', () => {
    const assembler = makeAssembler();
    const batch = assembler.assemble([makeEvent({ page_id: '/list' })]);
    const valid = JSON.parse(JSON.stringify(batch)) as Record<string, unknown>;
    expect(validateBatchSchema(valid)).toBe(true);

    const missingHeader: Record<string, unknown> = { ...valid };
    delete missingHeader['clock_offset'];
    expect(validateBatchSchema(missingHeader)).toBe(false);

    const unknownBatchField: Record<string, unknown> = { ...valid, unexpected_batch_field: 'x' };
    expect(validateBatchSchema(unknownBatchField)).toBe(false);

    const firstEvent = (valid['events'] as Record<string, unknown>[])[0];
    const unknownEventField: Record<string, unknown> = {
      ...valid,
      events: [{ ...firstEvent, unexpected_event_field: 'x' }],
    };
    expect(validateBatchSchema(unknownEventField)).toBe(false);
  });

  test('C06-F3 组装结果只包含契约声明的事件字段，且通过 Ajv 校验', () => {
    const assembler = makeAssembler();
    const event = makeEvent({ page_id: '/list' });
    event['unexpected_field'] = 'x';

    const batch = assembler.assemble([event]);

    expect(batch.events[0]).not.toHaveProperty('unexpected_field');
    expectSchemaValid(batch);
  });

  test('C06-F3 缺省 batch_id 使用 crypto.randomUUID，sent_at 使用当前时间', () => {
    const assembler = createBatchAssembler({ header: { header: () => HEADER } });

    const batch = assembler.assemble([makeEvent()]);

    expect(batch.batch_id).toMatch(UUID_V4_PATTERN);
    expect(Number.isInteger(batch.sent_at)).toBe(true);
    expectSchemaValid(batch);
  });

  test('C06-F3 运行环境没有 crypto.randomUUID 时退回 Math.random 实现', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      const assembler = createBatchAssembler({ header: { header: () => HEADER } });

      const batch = assembler.assemble([makeEvent(), makeEvent()]);

      expect(batch.batch_id).toMatch(UUID_V4_PATTERN);
      expectSchemaValid(batch);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
