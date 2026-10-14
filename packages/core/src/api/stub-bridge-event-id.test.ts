/**
 * C01-F3 加载桩交接（`STUB_BRIDGE_CAPABILITY` → `acceptStubCommand`）的 `eventId` 格式校验
 * —— 与 `view_id` / `device_id` 同族的第三处「受 Schema 形态约束（`$ref uuid`）的字段接受了
 * 未经校验的外部输入」。
 *
 * `StubCommand.eventId` 此前被 `acceptStubCommand` 原样放进 `QueuedCommand.eventId`
 * （`command.eventId ?? createUuid()`），再经 `makeEvent` 变成事件体的 `event_id`。
 * `event_id` 在 `batch.schema.json` 里是 required + `$ref #/$defs/uuid`，且同属协议字段排除
 * 清单（不脱敏）→ 非 uuid 值不会被任何兜底改写，会产出**注定被接收方拒绝**的事件。
 *
 * 口径（与 `noteLocation` 的显式 `view_id` 同族）：非 `$defs/uuid` 的 `eventId` **丢弃**，
 * 回落 `createUuid()` 生成新的合法 uuid；**事件本身不丢**（不制造「静默丢弃」），并计
 * `invalid_args` + 发出一条 `dropped: 'field'`、`field: 'event_id'` 的诊断记录，使其可观测。
 * 合法 uuid 原样保留（`event_id` 是去重的唯一依据，能保留就必须保留）。
 *
 * 取证顺序：本文件在实现前先写（当时非 uuid 的 `eventId` 原样进入事件体，两组「非法」用例红）。
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import type { KernelEvent } from '../kernel';
import { STUB_BRIDGE_CAPABILITY, createClient, createUuid } from './index';
import type { DiagnosticsRecord, StubCommand } from './types';

/** 取出真实 Schema 的 `$defs/uuid.pattern`（形态判据的唯一权威，不手写副本）。 */
function schemaUuidPattern(schema: unknown): string {
  const root = typeof schema === 'object' && schema !== null ? (schema as Record<string, unknown>) : {};
  const defs = root['$defs'];
  const uuid = typeof defs === 'object' && defs !== null ? (defs as Record<string, unknown>)['uuid'] : undefined;
  const pattern = typeof uuid === 'object' && uuid !== null ? (uuid as Record<string, unknown>)['pattern'] : undefined;
  if (typeof pattern !== 'string') throw new Error('batch.schema.json 缺少 $defs/uuid.pattern');
  return pattern;
}

/** `$defs/uuid` 的形态（v4 + variant `[89ab]`，小写）。 */
const SCHEMA_UUID_PATTERN = new RegExp(schemaUuidPattern(batchSchema));

/** 组装一个最小合法批次，把事件放进去（与 `schema-validation.test.ts` 同口径）。 */
function makeBatch(events: readonly KernelEvent[]): Record<string, unknown> {
  return {
    protocol_version: 1,
    app_id: 'app-a',
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

/** 用真实批次 Schema（Ajv 2020-12）校验；失败时把错误打进断言信息。 */
function expectValidBatch(events: readonly KernelEvent[]): void {
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(batchSchema);
  const valid = validate(makeBatch(events));
  expect(validate.errors ?? [], JSON.stringify(validate.errors ?? [], null, 2)).toEqual([]);
  expect(valid).toBe(true);
}

/** 加载桩交接：主包通过内部能力（不是公共 API）回放缓存命令。 */
function stubBridge(client: ReturnType<typeof createClient>): (command: StubCommand) => void {
  const capability = client.kernel.getCapability(STUB_BRIDGE_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('未注册加载桩交接能力');
  return capability as (command: StubCommand) => void;
}

/** 建实例 + 回放 `init`（已授权，事件立刻出口）；返回交接入口与观测数组。 */
function createStubClient(): {
  readonly client: ReturnType<typeof createClient>;
  readonly events: KernelEvent[];
  readonly records: DiagnosticsRecord[];
  readonly bridge: (command: StubCommand) => void;
} {
  const events: KernelEvent[] = [];
  const records: DiagnosticsRecord[] = [];
  const client = createClient({
    onEvent: (event) => events.push(event),
    debug: (record) => records.push(record),
  });
  const bridge = stubBridge(client);
  bridge({ kind: 'init', args: [{ appId: 'app-a', consent: 'granted' }] });
  return { client, events, records, bridge };
}

function trackCommand(eventId: string): StubCommand {
  return { kind: 'track', name: 'task_complete', eventId, occurredAt: Date.now(), args: [{}] };
}

const VALID_EVENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** 非 uuid 的 stub `eventId`（全部是格式合法的伪造数据，不含真实个人信息）。 */
const INVALID_EVENT_IDS: readonly (readonly [string, string])[] = [
  ['PII 形态的路径', '/user/13800138000'],
  ['非 uuid 短串', 'abc'],
  ['空串', ''],
  ['超长串', 'x'.repeat(300)],
  ['被截断的 uuid 前缀', '00000000-0000-4000-8000'],
  ['v1 uuid（是 uuid，但过不了 Schema 的 v4 + variant 约束）', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
];

describe('STUB_BRIDGE 的 eventId 格式校验：非 $defs/uuid 不得进入事件体', () => {
  it('stub 传合法 uuid → 原样保留为事件 event_id（回归）', () => {
    const { client, events, bridge } = createStubClient();
    bridge(trackCommand(VALID_EVENT_ID));
    client.flush();

    expect(events).toHaveLength(1);
    expect(events[0]?.['event_id']).toBe(VALID_EVENT_ID);
    expectValidBatch(events);
    client.destroy();
  });

  it.each(INVALID_EVENT_IDS)('stub 传%s → 事件不丢，但 event_id 回落到新生成的合法 uuid', (_label, bad) => {
    const { client, events, records, bridge } = createStubClient();
    const before = records.length;
    bridge(trackCommand(bad));
    client.flush();

    // 不制造「静默丢弃」：事件本身照常产出（不是 undefined / 空串 / 消失）
    expect(events).toHaveLength(1);
    const eventId = events[0]?.['event_id'];
    expect(eventId).not.toBe(bad);
    expect(eventId).toMatch(SCHEMA_UUID_PATTERN);
    // 不产出「注定被拒」的批次（Ajv 对着冻结的 batch.schema.json 校验）
    expectValidBatch(events);

    // 可观测：计 invalid_args 并留下 field=event_id 的诊断记录
    const dropped = records.slice(before).filter((record) => record.field === 'event_id');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]?.reason_code).toBe('invalid_args');
    expect(dropped[0]?.dropped).toBe('field');
    expect(dropped[0]?.kind).toBe('track');

    client.destroy();
  });

  it('漂移锁定：接受判定与真实 Schema 的 $defs/uuid.pattern 逐样本一致', () => {
    const samples = [
      VALID_EVENT_ID,
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
      'dddddddd-dddd-4ddd-7ddd-dddddddddddd',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddddd',
      'abc',
      '',
    ];
    for (const sample of samples) {
      const { client, events, bridge } = createStubClient();
      bridge(trackCommand(sample));
      client.flush();
      const accepted = events[0]?.['event_id'] === sample;
      expect(accepted, sample).toBe(SCHEMA_UUID_PATTERN.test(sample));
      client.destroy();
    }
  });
});
