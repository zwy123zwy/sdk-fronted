/**
 * C04-AC-01 / C04-AC-02：会话与设备标识。
 *
 * - AC-02：模拟 31 分钟无活动后再上报 → `session_id` 变化；29 分钟时不变；
 * - AC-01 的一部分：批次头含 `device_id`、`session_id`（字段级断言在 `header.test.ts`）；
 * - Q5：未取得同意时**不生成持久化设备标识**，只用内存中的会话标识；
 *   `denied` 时清除；`granted`（或初始化参数声明已授权的 `full`）才持久化。
 *
 * 空闲判定**不持久化** `last_activity_at`（避免同意前落盘；编排方 2026-10-13 同意）：
 * 刷新即重新计时。
 *
 * 取证顺序：本文件在**实现前先写**（当时 `createSessionTracker` 是返回空串的接口桩，
 * 除「未授权时不写持久化存储」外的用例全部红过）。
 */
import { describe, expect, it } from 'vitest';

import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import { DEVICE_ID_KEY } from './constants';
import type { ContextStoragePort } from './ports';
import { createSessionTracker } from './session';

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

/** 内存存储（测试替身；不触碰真实 localStorage/sessionStorage）。 */
function memoryStorage(seed: Record<string, string> = {}): ContextStoragePort & { readonly dump: () => Record<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

const start = 1_700_000_000_000;

/** 创建追踪器；`authorized` 决定是否注入持久化存储（模拟同意后的装配）。 */
function tracker(
  options: {
    authorized?: boolean;
    now?: number;
    sessionStorageSeed?: Record<string, string>;
    persistentSeed?: Record<string, string>;
  } = {},
) {
  let nowMs = options.now ?? start;
  const persistent = memoryStorage(options.persistentSeed ?? {});
  const session = memoryStorage(options.sessionStorageSeed ?? {});
  const instance = createSessionTracker({
    // 已授权场景需要显式同意状态：缺省 `unknown` + `essential_only` 时不得持久化设备标识（Q5）。
    state: options.authorized === true ? 'granted' : 'unknown',
    createId: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        const suffix = counter.toString(16).padStart(12, '0');
        return `00000000-0000-4000-8000-${suffix}`;
      };
    })(),
    now: () => nowMs,
    // 持久化存储总是注入（否则运行期「后来同意」就无法开始持久化）；
    // 是否真的落盘由 tracker 内部的授权判定（state × mode）控制。
    persistentStorage: persistent,
    sessionStorage: session,
    limits: { sessionIdleMs: 1_800_000 },
  });
  return {
    instance,
    persistent,
    session,
    advance: (deltaMs: number) => {
      nowMs += deltaMs;
    },
  };
}

describe('C04-AC-02 会话生命周期（30 分钟空闲轮换）', () => {
  it('首次 touch 生成 UUID v4 形态的 session_id', () => {
    const { instance } = tracker();
    const first = instance.touch(start);
    expect(first.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('29 分钟无活动后 session_id 不变', () => {
    const { instance, advance } = tracker();
    const first = instance.touch(start);
    advance(29 * 60 * 1000);
    const second = instance.touch(start + 29 * 60 * 1000);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('31 分钟无活动后 session_id 变化', () => {
    const { instance, advance } = tracker();
    const first = instance.touch(start);
    advance(31 * 60 * 1000);
    const second = instance.touch(start + 31 * 60 * 1000);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('正好 30 分钟不轮换（边界为「超过才轮换」）', () => {
    const { instance, advance } = tracker();
    const first = instance.touch(start);
    advance(30 * 60 * 1000);
    expect(instance.touch(start + 30 * 60 * 1000).sessionId).toBe(first.sessionId);
  });

  it('持续活动时 session_id 长期不变', () => {
    const { instance, advance } = tracker();
    const first = instance.touch(start);
    for (let index = 1; index <= 10; index += 1) {
      advance(10 * 60 * 1000);
      expect(instance.touch(start + index * 10 * 60 * 1000).sessionId).toBe(first.sessionId);
    }
  });

  it('current() 不刷新活动时间（空闲轮换只由 touch 推进）', () => {
    const { instance, advance } = tracker();
    const first = instance.touch(start);
    advance(31 * 60 * 1000);
    expect(instance.current().sessionId).toBe(first.sessionId);
  });
});

describe('C04-F1 / Q5 设备标识的持久化策略', () => {
  it('未授权时不写任何持久化存储（AC-10 的「不写入持久化设备标识」）', () => {
    const { instance, persistent } = tracker({ authorized: false });
    instance.touch(start);
    expect(persistent.dump()).toEqual({});
  });

  it('未授权时 batch 头的 device_id_persistent 为 false', () => {
    const { instance } = tracker({ authorized: false });
    expect(instance.touch(start).deviceIdPersistent).toBe(false);
  });

  it('授权后 device_id 写入持久化存储，且第二次调用复用同一值', () => {
    const { instance, persistent } = tracker({ authorized: true });
    const first = instance.touch(start);
    expect(first.deviceIdPersistent).toBe(true);
    expect(Object.keys(persistent.dump())).toHaveLength(1);
    expect(instance.touch(start + 1000).deviceId).toBe(first.deviceId);
  });

  it('授权状态下设备标识可跨实例读回（页面刷新后稳定）', () => {
    const shared = memoryStorage();
    const create = (): ReturnType<typeof createSessionTracker> =>
      createSessionTracker({
        createId: () => '11111111-1111-4111-8111-111111111111',
        now: () => start,
        state: 'granted',
        persistentStorage: shared,
        sessionStorage: memoryStorage(),
        limits: { sessionIdleMs: 1_800_000 },
      });
    const first = create().touch(start);
    // 第二次调用 createId 仍返回同一常量，因此这里的相等性来自「读回存储」而不是生成器
    const second = create().touch(start);
    expect(second.deviceId).toBe(first.deviceId);
    expect(first.deviceId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('会话轮换时设备标识不变（只有 session_id 变）', () => {
    const { instance, advance } = tracker({ authorized: true });
    const first = instance.touch(start);
    advance(31 * 60 * 1000);
    const second = instance.touch(start + 31 * 60 * 1000);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.deviceId).toBe(first.deviceId);
  });

  it('onConsentChange(denied) 后清除设备标识并停止持久化（AC-12）', () => {
    const { instance, persistent } = tracker({ authorized: true });
    instance.touch(start);
    instance.onConsentChange('denied', 'essential_only');
    expect(persistent.dump()).toEqual({});
    const after = instance.touch(start + 1000);
    expect(after.deviceIdPersistent).toBe(false);
    expect(persistent.dump()).toEqual({});
  });

  it('purge() 清空持久化存储', () => {
    const { instance, persistent } = tracker({ authorized: true });
    instance.touch(start);
    instance.purge();
    expect(persistent.dump()).toEqual({});
  });

  it('onConsentChange(granted) 后才开始持久化（此前既不读也不写）', () => {
    const { instance, persistent } = tracker({
      authorized: false,
      persistentSeed: { wr_device_id: '22222222-2222-4222-8222-222222222222' },
    });
    const before = instance.touch(start);
    // 未授权：既不读取既有标识（否则等于沿用旧标识符），也不写入
    expect(before.deviceId).not.toBe('22222222-2222-4222-8222-222222222222');
    expect(before.deviceIdPersistent).toBe(false);
    expect(persistent.dump()).toEqual({ wr_device_id: '22222222-2222-4222-8222-222222222222' });

    instance.onConsentChange('granted', 'essential_only');
    const after = instance.touch(start + 1000);
    expect(after.deviceIdPersistent).toBe(true);
    // 授权后：内存里的标识与持久化存储保持一致（不出现两套标识）
    expect(persistent.dump()['wr_device_id']).toBe(after.deviceId);
    // 授权后重新创建的实例读回同一标识（跨页面稳定）
    const reopened = createSessionTracker({
      createId: () => '33333333-3333-4333-8333-333333333333',
      now: () => start,
      state: 'granted',
      persistentStorage: persistent,
      sessionStorage: memoryStorage(),
      limits: { sessionIdleMs: 1_800_000 },
    });
    expect(reopened.touch(start).deviceId).toBe(after.deviceId);
  });
});

/**
 * `device_id` 的**格式校验**（与 `view_id` 同族）。
 *
 * `batch.schema.json` 把 `device_id` 声明为 `$ref #/$defs/uuid`，且它在 C04 的协议字段排除
 * 清单里（UUID 结构上不可能含 PII → 不脱敏）。此前 `ensureDevice` 只要从注入的
 * `persistentStorage` 里读到**任意非空串**就当成 `device_id` 使用（判据 `stored.length > 0`）：
 * localStorage 被第三方脚本写坏、或旧版本残留非 uuid 值，都会让**每一批**过不了 `$defs/uuid`
 * （影响面比 `view_id` 更大：`view_id` 只毁一条事件，`device_id` 毁一整批）。
 *
 * 口径（与 `noteLocation` 的显式 `view_id` 同族）：非 `$defs/uuid` 的存储值**丢弃**，改由
 * `createId()` 生成合法 uuid；并把新值**覆盖写回**持久化存储（否则每次启动都重新生成，
 * 「同一设备」语义会漂移）。`''` 与「键不存在」同样按未存储处理，与旧行为一致。
 */
describe('device_id 格式校验：存储值必须过 $defs/uuid，否则丢弃并覆盖写回', () => {
  const VALID_DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  /** 非 uuid 的存储值（全部是格式合法的伪造数据，不含真实个人信息）。 */
  const INVALID_STORED_DEVICE_IDS: readonly (readonly [string, string])[] = [
    ['PII 形态的路径', '/user/13800138000'],
    ['非 uuid 短串', 'abc'],
    ['空串', ''],
    ['超长串', 'x'.repeat(300)],
    ['被截断的 uuid 前缀', '00000000-0000-4000-8000'],
    ['v1 uuid（是 uuid，但过不了 Schema 的 v4 + variant 约束）', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
  ];

  /** 用同一持久化存储重建实例；注入一个**不同**的生成器以区分「读回」与「新生成」。 */
  function reopen(storage: ContextStoragePort, generatedId: string) {
    return createSessionTracker({
      createId: () => generatedId,
      now: () => start,
      state: 'granted',
      persistentStorage: storage,
      sessionStorage: memoryStorage(),
      limits: { sessionIdleMs: 1_800_000 },
    });
  }

  it('存储里是合法 uuid → 原样采用（回归）', () => {
    const { instance, persistent } = tracker({
      authorized: true,
      persistentSeed: { [DEVICE_ID_KEY]: VALID_DEVICE_ID },
    });
    const state = instance.touch(start);
    expect(state.deviceId).toBe(VALID_DEVICE_ID);
    expect(state.deviceIdPersistent).toBe(true);
    expect(persistent.dump()[DEVICE_ID_KEY]).toBe(VALID_DEVICE_ID);
  });

  it.each(INVALID_STORED_DEVICE_IDS)('存储里是%s → 不采用该值，生成合法 uuid 并覆盖写回', (_label, bad) => {
    const { instance, persistent } = tracker({ authorized: true, persistentSeed: { [DEVICE_ID_KEY]: bad } });
    const state = instance.touch(start);
    expect(state.deviceId).not.toBe(bad);
    expect(state.deviceId).toMatch(SCHEMA_UUID_PATTERN);
    // 覆盖写回：被污染的存储值不再残留（否则每批都还要再判一次、且每次启动都可能变）
    expect(persistent.dump()[DEVICE_ID_KEY]).toBe(state.deviceId);
  });

  it.each(INVALID_STORED_DEVICE_IDS)('存储里是%s → 覆盖写回的值被后续实例复用（同一设备语义不漂移）', (_label, bad) => {
    const { instance, persistent } = tracker({ authorized: true, persistentSeed: { [DEVICE_ID_KEY]: bad } });
    const first = instance.touch(start).deviceId;
    const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const reopened = reopen(persistent, otherId);
    // 读回的是覆盖写回后的值，而不是新生成器的值 → 污染被清掉且没有被反复重新生成
    expect(reopened.touch(start).deviceId).toBe(first);
    expect(reopened.touch(start).deviceId).not.toBe(otherId);
    expect(reopened.touch(start).deviceId).toMatch(SCHEMA_UUID_PATTERN);
  });

  it('存储里没有该键 → 生成合法 uuid 并写回（回归）', () => {
    const { instance, persistent } = tracker({ authorized: true });
    const state = instance.touch(start);
    expect(state.deviceId).toMatch(SCHEMA_UUID_PATTERN);
    expect(persistent.dump()[DEVICE_ID_KEY]).toBe(state.deviceId);
  });

  it('漂移锁定：采用判定与真实 Schema 的 $defs/uuid.pattern 逐样本一致', () => {
    const samples = [
      VALID_DEVICE_ID,
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa',
      'abc',
      '',
    ];
    for (const sample of samples) {
      const { instance } = tracker({ authorized: true, persistentSeed: { [DEVICE_ID_KEY]: sample } });
      const accepted = instance.touch(start).deviceId === sample;
      expect(accepted, sample).toBe(SCHEMA_UUID_PATTERN.test(sample));
    }
  });
});
