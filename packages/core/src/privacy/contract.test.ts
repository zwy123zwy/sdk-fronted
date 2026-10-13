/**
 * C04 的契约自证（Ajv 2020-12 对**真实** Schema）。
 *
 * 口径（T10 的教训：不得「自证代替真证」）：直接 `import` `docs/contracts/schemas/batch.schema.json`，
 * 不复制、不手写子集校验器；用 `$defs/event` 校验**每一条**「富化 + 脱敏 + 截断」后的产出，
 * 并用**负向对照**证明校验器并非空转。
 *
 * 覆盖：
 * - 正向：正常事件、掩码后的事件、截断到上限的事件、context 事件；
 * - 负向（每一条都断言 Ajv 判 false）：非法维度键未丢弃、NaN 指标、超长附件、300 字符值、
 *   60 个维度键、未声明字段（非空转对照）；
 * - 批次头：C04 的 `header()` 产出 + 最小批次整体过 Schema；`clock_offset` 越界必须判 false。
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import { createBatchHeaderProvider } from '../context/header';
import { createClockCalibration } from '../context/clock';
import { createSessionTracker } from '../context/session';
import type { ContextStoragePort } from '../context/ports';
import type { KernelEvent } from '../kernel';
import { C04_LIMITS } from './constants';
import { constrainEvent } from './constraints';
import { createMasker } from './mask';
import { utf8Bytes } from './limits';

/** 真实 Schema 的 Ajv 实例（2020-12；非严格模式以兼容元数据字段）。 */
function createValidator(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

/** 只用 `$defs/event` 校验一条事件（与 T17 的 monitor 契约测试同一形态）。 */
function compileEventValidator() {
  const ajv = createValidator();
  // 把**真实**的批次 Schema 注册进实例，再按 `$id` 引用它的 `$defs/event`：
  // 这样校验的是契约文件本身，而不是复制出来的子集。
  const batchId = batchSchema.$id;
  ajv.addSchema(batchSchema, batchId);
  return ajv.compile({ $ref: `${batchId}#/$defs/event` });
}

/** 组装一个最小合法批次，把事件放进去。 */
function makeBatch(events: readonly KernelEvent[], header: Record<string, unknown>): Record<string, unknown> {
  return { ...header, batch_id: '00000000-0000-4000-8000-0000000000aa', sent_at: 1_700_000_000_000, events };
}

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

/** 跑一次约束处理（不关心计数）。 */
function constrain(event: KernelEvent): KernelEvent {
  return constrainEvent({ event, limits: C04_LIMITS, masker: createMasker(), count: () => undefined }).event;
}

/** 内存存储。 */
function memoryStorage(): ContextStoragePort {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

/** C04 的批次头（已授权场景，保证 device_id_persistent 为 true）。 */
function makeHeader(overrides: { clockOffsetMs?: number } = {}): Record<string, unknown> {
  const session = createSessionTracker({
    createId: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
      };
    })(),
    now: () => 1_700_000_000_000,
    state: 'granted',
    mode: 'essential_only',
    persistentStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    limits: { sessionIdleMs: 1_800_000 },
  });
  session.touch(1_700_000_000_000);
  const clock = createClockCalibration();
  if (overrides.clockOffsetMs !== undefined) {
    clock.noteServerTime({
      serverTimeMs: 1_700_000_000_000 + overrides.clockOffsetMs,
      clientSentAtMs: 1_700_000_000_000 - 50,
      clientReceivedAtMs: 1_700_000_000_000 + 50,
    });
  }
  const provider = createBatchHeaderProvider({
    appId: 'app-a',
    sdkName: '@web-report-sdk/browser',
    sdkVersion: '0.0.0',
    session: () => session.current(),
    user: () => undefined,
    consent: () => 'granted',
    clock: () => clock.current(),
  });
  return provider() as unknown as Record<string, unknown>;
}

describe('C04 契约自证：真实 batch.schema.json 的正向校验', () => {
  it('普通事件、掩码后的事件、截断到上限的事件都通过 $defs/event', () => {
    const validate = compileEventValidator();
    const cases: KernelEvent[] = [
      makeEvent({ page_id: '/task/:id', view_id: '00000000-0000-4000-8000-000000000002', url: 'https://a.example/p' }),
      constrain(makeEvent({ dimensions: { contact: 'mail a@b.com or 13800138000' } })),
      constrain(makeEvent({ dimensions: { title: 'x'.repeat(300) }, attachment: 'a'.repeat(10_240) })),
      constrain(makeEvent({ context: { tenant: 'acme', note: 'y'.repeat(300) } })),
      constrain(
        makeEvent({
          dimensions: Object.fromEntries(Array.from({ length: 60 }, (_unused, index) => [`k${String(index).padStart(2, '0')}`, 'v'])),
          metrics: Object.fromEntries(Array.from({ length: 60 }, (_unused, index) => [`m${String(index).padStart(3, '0')}`, index])),
        }),
      ),
    ];
    for (const [index, event] of cases.entries()) {
      const valid = validate(event);
      expect(validate.errors ?? [], `第 ${String(index)} 条事件未通过：${JSON.stringify(validate.errors)}`).toEqual([]);
      expect(valid, `第 ${String(index)} 条事件未通过`).toBe(true);
    }
  });

  it('C04 的批次头 + 事件组装成批次后通过 batch.schema.json', () => {
    const ajv = createValidator();
    const validate = ajv.compile(batchSchema);
    const event = constrain(makeEvent({ dimensions: { ok: 'v' } }));
    const batch = makeBatch([event], makeHeader());
    const valid = validate(batch);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(valid).toBe(true);
  });
});

describe('C04 契约自证：负向对照（证明校验器有判别力）', () => {
  const validate = compileEventValidator();

  it('非空转对照：多一个未声明字段的事件必须判 false', () => {
    const invalid = makeEvent({ not_a_field: 'x' });
    expect(validate(invalid)).toBe(false);
    // 同一校验器对合法事件必须判 true（否则「一律 false」也能通过本用例）
    expect(validate(makeEvent())).toBe(true);
  });

  it('未丢弃的非法维度键（Title/1abc）判 false', () => {
    expect(validate(makeEvent({ dimensions: { Title: 'v' } }))).toBe(false);
    expect(validate(makeEvent({ dimensions: { '1abc': 'v' } }))).toBe(false);
  });

  it('未剔除的 NaN / Infinity 在**序列化后**判 false（Ajv 对原生 NaN 无能为力，这正是 SDK 必须剔除的原因）', () => {
    // 重要口径：JSON Schema 的 `type: number` 在 JS 里对 `NaN` 返回 true（`typeof NaN === 'number'`），
    // 因此 Ajv 直接吃对象时**发现不了** NaN —— 这正是契约要求「SDK 序列化前必须剔除并计数」的原因。
    expect(validate(makeEvent({ metrics: { value: Number.NaN } }))).toBe(true);
    // 序列化会把 NaN/Infinity 变成 null，此时校验器必然拒绝（而 null 进 metrics 是接收方无法解释的数据）。
    const nan = JSON.parse(JSON.stringify(makeEvent({ metrics: { value: Number.NaN } }))) as KernelEvent;
    const inf = JSON.parse(JSON.stringify(makeEvent({ metrics: { value: Number.POSITIVE_INFINITY } }))) as KernelEvent;
    expect(validate(nan)).toBe(false);
    expect(validate(inf)).toBe(false);
    // 因此 C04 必须把非有限值**剔除**：约束后的产出既不含 NaN，序列化后也不含 null。
    const constrained = constrain(makeEvent({ metrics: { good: 1, bad: Number.NaN } }));
    expect(constrained['metrics']).toEqual({ good: 1 });
    const serialized = JSON.parse(JSON.stringify(constrained)) as KernelEvent;
    expect(validate(serialized)).toBe(true);
    expect(JSON.stringify(constrained)).not.toContain('null');
  });

  it('未截断的超长附件（10 KB）判 false，截断后判 true', () => {
    expect(validate(makeEvent({ attachment: 'a'.repeat(10_240) }))).toBe(false);
    expect(validate(constrain(makeEvent({ attachment: 'a'.repeat(10_240) })))).toBe(true);
  });

  it('未截断的 300 字符维度值判 false，截断后判 true', () => {
    expect(validate(makeEvent({ dimensions: { title: 'x'.repeat(300) } }))).toBe(false);
    expect(validate(constrain(makeEvent({ dimensions: { title: 'x'.repeat(300) } })))).toBe(true);
  });

  it('未裁剪的 60 个维度键 / 60 个指标键判 false，裁剪后判 true', () => {
    const dimensions = Object.fromEntries(Array.from({ length: 60 }, (_unused, index) => [`k${String(index).padStart(2, '0')}`, 'v']));
    const metrics = Object.fromEntries(Array.from({ length: 60 }, (_unused, index) => [`m${String(index).padStart(3, '0')}`, index]));
    expect(validate(makeEvent({ dimensions }))).toBe(false);
    expect(validate(makeEvent({ metrics }))).toBe(false);
    expect(validate(constrain(makeEvent({ dimensions, metrics })))).toBe(true);
  });

  it('clock_offset 越界（±24h 之外）的批次头判 false，钳制后判 true', () => {
    const ajv = createValidator();
    const validateBatch = ajv.compile(batchSchema);
    const event = makeEvent();
    const outOfRange = { ...makeHeader(), clock_offset: 86_400_001 };
    expect(validateBatch(makeBatch([event], outOfRange))).toBe(false);
    // C04 的校准器会把偏移钳制回 ±24h
    const clamped = makeHeader({ clockOffsetMs: 10 * 86_400_000 });
    expect(clamped['clock_offset']).toBe(86_400_000);
    expect(validateBatch(makeBatch([event], clamped))).toBe(true);
  });

  it('未取得同意时 device_id_persistent 必须为 false 而不是缺省 true', () => {
    const session = createSessionTracker({
      createId: () => '00000000-0000-4000-8000-0000000000ff',
      now: () => 1_700_000_000_000,
      state: 'unknown',
      mode: 'essential_only',
      persistentStorage: memoryStorage(),
      sessionStorage: memoryStorage(),
      limits: { sessionIdleMs: 1_800_000 },
    });
    session.touch(1_700_000_000_000);
    const provider = createBatchHeaderProvider({
      appId: 'app-a',
      sdkName: '@web-report-sdk/core',
      sdkVersion: '0.0.0',
      session: () => session.current(),
      user: () => undefined,
      consent: () => 'unknown',
      clock: () => ({ offsetMs: 0, calibrated: false }),
    });
    const header = provider() as unknown as Record<string, unknown>;
    expect(header['device_id_persistent']).toBe(false);
    expect(header['consent']).toBe('unknown');
  });
});

describe('C04 的长度口径自证', () => {
  it('截断后的附件字节数 ≤ 8 KB，且事件体字节数 ≤ 16 KB', () => {
    const event = constrain(makeEvent({ attachment: 'a'.repeat(10_240) }));
    expect(utf8Bytes(event['attachment'] as string)).toBeLessThanOrEqual(C04_LIMITS.maxAttachmentBytes);
    expect(utf8Bytes(JSON.stringify(event))).toBeLessThanOrEqual(C04_LIMITS.maxEventBodyBytes);
  });
});
