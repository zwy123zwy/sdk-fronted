/**
 * C04-AC-03 / C04-AC-04：页面归属（C04-F2）。
 *
 * - AC-03：在页面 A 上报后立即切换路由到 B，再发送批次 → A 的事件 `page_id`/`view_id`
 *          仍为 A 的值；B 的事件使用新的 `view_id`（因此**入队当时**快照是唯一正确的实现）；
 * - AC-04：路由 `/task/123` → `page_id` 为路由模板 `/task/:id`。
 *          编排方 2026-10-13 裁定：**优先用已公开的 `setPage`**，C04 不做模板推导，
 *          因此本文件验证的是「`setPage` 的值被原样使用」+「非法/超长输入的处理」。
 *
 * 取证顺序：本文件在 `createPageTracker` 实现前先写（当时是返回全 `undefined` 的接口桩，
 * 除「初始为空」外的用例全部红过），之后实现转绿。
 */
import { describe, expect, it } from 'vitest';

import batchSchema from '../../../../docs/contracts/schemas/batch.schema.json';
import type { KernelEvent } from '../kernel';
import { createPageTracker } from './page';
import type { ContextSnapshot } from '../privacy/types';

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

/** 递增的 UUID 生成器（确定性测试）。 */
function idFactory() {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };
}

function makeEvent(extra: Record<string, unknown> = {}): KernelEvent {
  return {
    event_id: '00000000-0000-4000-8000-0000000000ff',
    event_name: 'task_complete',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: 1_700_000_000_000,
    priority: 'normal',
    ...extra,
  };
}

function makeTracker(options: { pageId?: string; url?: string } = {}) {
  return createPageTracker({
    createId: idFactory(),
    ...(options.pageId === undefined ? {} : { pageId: options.pageId }),
    ...(options.url === undefined ? {} : { url: options.url }),
  });
}

/** 把快照装到一个事件上（模拟客户端在入队时的快照）。 */
function attach(snapshot: ContextSnapshot): KernelEvent {
  const event = makeEvent();
  if (snapshot.page_id !== undefined) event['page_id'] = snapshot.page_id;
  if (snapshot.view_id !== undefined) event['view_id'] = snapshot.view_id;
  if (snapshot.url !== undefined) event['url'] = snapshot.url;
  return event;
}

describe('C04-AC-04 setPage 的原样使用（不做模板推导）', () => {
  it('setPage("/task/:id") 后 page_id 就是 /task/:id', () => {
    const tracker = makeTracker();
    tracker.setPage('/task/:id');
    expect(tracker.snapshot().page_id).toBe('/task/:id');
  });

  it('setPage 的真实路径也被原样使用（C04 不把 /task/123 猜成模板）', () => {
    const tracker = makeTracker();
    tracker.setPage('/task/123');
    expect(tracker.snapshot().page_id).toBe('/task/123');
  });

  it('setPage 只取路径：去掉 ?query 与 #hash', () => {
    const tracker = makeTracker();
    tracker.setPage('/task/:id?tab=detail#top');
    expect(tracker.snapshot().page_id).toBe('/task/:id');
  });

  it('超长 page_id 被截断到 256（Schema maxLength）', () => {
    const tracker = makeTracker();
    tracker.setPage(`/${'a'.repeat(300)}`);
    expect(tracker.snapshot().page_id?.length).toBe(256);
  });

  it('初始化参数的 pageId 生效，setPage 覆盖它', () => {
    const tracker = makeTracker({ pageId: '/initial' });
    expect(tracker.snapshot().page_id).toBe('/initial');
    tracker.setPage('/later');
    expect(tracker.snapshot().page_id).toBe('/later');
  });
});

describe('view_id 的生命周期', () => {
  it('实例创建时就有 view_id（UUID v4 形态）', () => {
    const snapshot = makeTracker().snapshot();
    expect(snapshot.view_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('同一页面重复 setPage 不轮换 view_id', () => {
    const tracker = makeTracker();
    tracker.setPage('/a');
    const first = tracker.snapshot().view_id;
    tracker.setPage('/a');
    expect(tracker.snapshot().view_id).toBe(first);
  });

  it('页面变化时轮换 view_id', () => {
    const tracker = makeTracker();
    tracker.setPage('/a');
    const first = tracker.snapshot().view_id;
    tracker.setPage('/b');
    expect(tracker.snapshot().view_id).not.toBe(first);
  });

  it('noteLocation（导航通知）使 view_id 轮换', () => {
    const tracker = makeTracker({ url: 'https://a.example/a' });
    const first = tracker.snapshot().view_id;
    tracker.noteLocation('https://a.example/b');
    expect(tracker.snapshot().view_id).not.toBe(first);
    expect(tracker.snapshot().url).toBe('https://a.example/b');
  });

  it('noteLocation 的显式 view_id 优先（接管场景）', () => {
    const tracker = makeTracker();
    tracker.noteLocation('https://a.example/a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(tracker.snapshot().view_id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
});

describe('C04-AC-03 入队快照的时序', () => {
  it('页面 A 入队的事件保留 A 的 page_id 与 view_id；B 的事件用新 view_id', () => {
    const tracker = makeTracker();
    tracker.setPage('/a');
    expect(tracker.snapshot().page_id).toBe('/a');
    const snapshotA = tracker.snapshot();
    const eventA = attach(snapshotA);

    // 立即切到 B，再发送批次
    tracker.setPage('/b');
    const snapshotB = tracker.snapshot();
    const eventB = attach(snapshotB);

    expect(eventA['page_id']).toBe('/a');
    expect(eventA['view_id']).toBe(snapshotA.view_id);
    expect(eventB['view_id']).not.toBe(eventA['view_id']);
    expect(eventB['page_id']).toBe('/b');
    // 快照是值拷贝：A 的字段不被后续变化污染
    expect(snapshotA.view_id).toBe(eventA['view_id']);
  });

  it('enrich 只补缺失字段，不覆盖入队快照', () => {
    const tracker = makeTracker();
    tracker.setPage('/b');
    const event = attach({ page_id: '/a', view_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', url: 'https://a.example/a', context: undefined });
    const enriched = tracker.enrich(event);
    expect(enriched['page_id']).toBe('/a');
    expect(enriched['view_id']).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(enriched['url']).toBe('https://a.example/a');
  });

  it('enrich 为缺失字段补齐当前页面归属', () => {
    const tracker = makeTracker();
    tracker.setPage('/current');
    tracker.noteLocation('https://a.example/current');
    const enriched = tracker.enrich(makeEvent());
    expect(enriched['page_id']).toBe('/current');
    expect(enriched['url']).toBe('https://a.example/current');
    expect(typeof enriched['view_id']).toBe('string');
  });

  it('isSamePage 反映当前 page_id（重复设置不轮换的判定基础）', () => {
    const tracker = makeTracker();
    tracker.setPage('/a');
    expect(tracker.isSamePage('/a')).toBe(true);
    expect(tracker.isSamePage('/b')).toBe(false);
  });
});

/**
 * `view_id` 的**格式校验**（上轮遗留：排除清单生效后非 uuid 的显式值不再被兜底脱敏）。
 *
 * `view_id` 在 `batch.schema.json` 里是 `$ref uuid`，且已进 C04 的协议字段排除清单
 * （UUID 结构上不可能含 PII → 不脱敏）。于是 `noteLocation(url, explicitViewId)`
 * 允许显式传入的**任意**值不再被兜底改写，会带着一个注定过不了 `$defs/uuid` 的值上报。
 * 口径：非 uuid 的显式值**按未传入处理**（丢弃 + 退回 SDK 自动生成的合法 uuid，
 * 与 `normalizePageId` 丢弃非法 `page_id` 的先例一致）；**不**截断/改写成"像 uuid"的标识符。
 */
describe('view_id 格式校验：显式值必须过 $defs/uuid，否则按未传入处理', () => {
  const VALID_VIEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  /** 非 uuid 的显式值（全部是格式合法的伪造数据，不含真实个人信息）。 */
  const INVALID_EXPLICIT_VIEW_IDS: readonly (readonly [string, string])[] = [
    ['PII 形态的路径', '/user/13800138000'],
    ['非 uuid 短串', 'abc'],
    ['空串', ''],
    ['超长串', 'x'.repeat(300)],
    ['被截断的 uuid 前缀', '00000000-0000-4000-8000'],
    ['v1 uuid（是 uuid，但过不了 Schema 的 v4 + variant 约束）', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
  ];

  it('显式传入合法 uuid → 原样采用（接管场景），并更新 url', () => {
    const tracker = makeTracker({ url: 'https://a.example/a' });
    tracker.noteLocation('https://a.example/b', VALID_VIEW_ID);
    expect(tracker.snapshot().view_id).toBe(VALID_VIEW_ID);
    expect(tracker.snapshot().url).toBe('https://a.example/b');
  });

  it.each(INVALID_EXPLICIT_VIEW_IDS)(
    '显式传入%s → 不得进入事件，退回自动生成的合法 uuid（URL 变化时照常轮换）',
    (_label, bad) => {
      const tracker = makeTracker({ url: 'https://a.example/a' });
      const before = tracker.snapshot().view_id;
      tracker.noteLocation('https://a.example/b', bad);
      const after = tracker.snapshot().view_id;
      expect(after).not.toBe(bad);
      expect(after).toMatch(SCHEMA_UUID_PATTERN);
      expect(after).not.toBe(before);
    },
  );

  it.each(INVALID_EXPLICIT_VIEW_IDS)('非法显式值%s不会出现在 enrich 后的事件体里', (_label, bad) => {
    const tracker = makeTracker();
    tracker.noteLocation('https://a.example/a', bad);
    expect(tracker.enrich(makeEvent())['view_id']).toMatch(SCHEMA_UUID_PATTERN);
  });

  it('非法显式值等价于「未传入」：同一 URL 下不轮换，仍是自动生成的合法 uuid', () => {
    const tracker = makeTracker({ url: 'https://a.example/a' });
    const before = tracker.snapshot().view_id;
    tracker.noteLocation('https://a.example/a', '/user/13800138000');
    expect(tracker.snapshot().view_id).toBe(before);
    expect(tracker.snapshot().view_id).toMatch(SCHEMA_UUID_PATTERN);
  });

  it('未显式传入 → 由 SDK 生成合法 uuid（回归）', () => {
    const tracker = makeTracker({ url: 'https://a.example/a' });
    const first = tracker.snapshot().view_id;
    expect(first).toMatch(SCHEMA_UUID_PATTERN);
    tracker.noteLocation('https://a.example/b');
    expect(tracker.snapshot().view_id).toMatch(SCHEMA_UUID_PATTERN);
    expect(tracker.snapshot().view_id).not.toBe(first);
  });

  it('漂移锁定：接受判定与真实 Schema 的 $defs/uuid.pattern 逐样本一致', () => {
    const samples = [
      VALID_VIEW_ID,
      '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa',
      'abc',
      '',
    ];
    for (const sample of samples) {
      const tracker = makeTracker({ url: 'https://a.example/a' });
      tracker.noteLocation('https://a.example/a', sample);
      const accepted = tracker.snapshot().view_id === sample;
      expect(accepted, sample).toBe(SCHEMA_UUID_PATTERN.test(sample));
    }
  });
});
