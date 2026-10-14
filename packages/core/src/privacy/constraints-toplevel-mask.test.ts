/**
 * 第四处「脱敏同族」缺口（C04 处理器侧）：`constrainEvent` 的最后一道阶梯
 * `clampAllStringValues()` 把**全部顶层字符串字段**截到 256，却**从不过 masker**。
 *
 * 于是顶层声明字段里 `page_id` / `view_id` / `level` 等（既不在 `dimensions`/`context` 里，
 * 也不被 `clampUrl` / `clampAttachment` 覆盖）属于「只截断、从不脱敏」；未声明的顶层字符串
 * 字段同样如此。守卫一（`tests/security/guard-truncate-before-mask.test.ts`）判的是
 * 「先截断后脱敏」，本处**压根没有 `masker.apply`**，所以按定义抓不到 —— 形状不同、根因同族。
 *
 * 修复口径：顶层字符串字段与 `dimensions`/`context`/`attachment`/`url` 走**同一个 masker**
 * （单一脱敏权威），且顺序仍是**先脱敏、再截断**（截断在前会把敏感值切成不再匹配规则的残片）。
 * `url` / `attachment` 已由各自函数用同一个 masker 脱敏，本通道**跳过**它们，避免接入方
 * 追加规则被二次施加。
 *
 * 2026-10-14 收口：脱敏只作用于**载荷/自由文本**字段。Schema 关死取值的**协议字段**
 * （`event_id`/`event_name`/`event_type`/`priority`/`level`，清单与取法见 `protocol-fields.ts`）
 * **排除在脱敏之外** —— 否则接入方追加一条恰好命中它们的规则就能弄坏协议语义（去重失效、
 * 必要事件判定错乱、枚举离开契约词汇表）。`page_id`/`view_id`（路由上下文，可能含个人信息）
 * 与未声明字段**继续脱敏**。
 *
 * 本文件在修复前先写（旧实现下断言级失败），修复后转绿。
 * 测试数据全部是格式合法的伪造值（非真实个人信息）。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { C04_LIMITS } from './constants';
import { constrainEvent } from './constraints';
import { utf8Bytes } from './limits';
import { createMasker } from './mask';
import { PRIVACY_REASON_CODES } from './reason-codes';
import type { MaskRule } from './types';

/** 伪造样本（格式合法、非真实个人信息）。 */
const FAKE_PHONE = '13800138000';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
const FAKE_EMAIL = 'alice.smith+tag@example.co.uk';

function makeCounter() {
  const counts = new Map<string, number>();
  return {
    count: (reason: string, delta = 1): void => {
      counts.set(reason, (counts.get(reason) ?? 0) + delta);
    },
    get: (reason: string): number => counts.get(reason) ?? 0,
  };
}

/** 构造一条最小合法事件（只含 `$defs/event` 必填字段）。 */
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

/** 运行一次约束处理。 */
function run(event: KernelEvent, rules: readonly MaskRule[] = []) {
  const counter = makeCounter();
  const result = constrainEvent({
    event,
    limits: C04_LIMITS,
    masker: createMasker(rules),
    count: counter.count,
  });
  return { counter, result, event: result.event };
}

/** 读取一个字符串字段（类型收窄，顺带钉住字段仍是字符串）。 */
function textOf(event: KernelEvent, key: string): string {
  const value = event[key];
  if (typeof value !== 'string') throw new Error(`${key} 不是字符串`);
  return value;
}

/** 会**自匹配**的追加规则（`x` → `xx`）：用来证明某个值只被脱敏通道施加了一次。 */
const DOUBLING_RULE: MaskRule = {
  name: 'doubling_probe',
  pattern: 'x',
  replacement: 'xx',
  builtin: false,
};

/**
 * 会命中**协议字段取值**的追加规则（模拟「接入方加一条脱敏规则就弄坏协议语义」）：
 * `(custom|normal|info|task_complete|sdk_health)` 覆盖 `event_type`/`priority`/`level`/`event_name`。
 */
const HOSTILE_PROTOCOL_RULE: MaskRule = {
  name: 'hostile_protocol_probe',
  pattern: '(custom|normal|info|task_complete|sdk_health)',
  replacement: '***',
  builtin: false,
};

/**
 * 会命中 **UUID 形态**的追加规则：同时命中 `event_id`（协议字段，不得改写）与 `view_id`
 * （载荷字段，必须继续脱敏）—— 用来证明判别力来自**协议语义**而不是「长得像什么」。
 */
const HOSTILE_UUID_RULE: MaskRule = {
  name: 'hostile_uuid_probe',
  pattern: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  replacement: '***',
  builtin: false,
};

describe('C04 顶层字符串字段必须过同一个 masker（守卫一抓不到的同族缺口）', () => {
  it('page_id 里的伪造手机号被脱敏，原始值不再出现', () => {
    const { counter, event } = run(makeEvent({ page_id: `/task/${FAKE_PHONE}` }));
    const pageId = textOf(event, 'page_id');
    expect(pageId).not.toContain(FAKE_PHONE);
    expect(pageId).not.toMatch(/\d{4}/);
    expect(pageId).toContain('/task/');
    // 脱敏不是截断：不产生截断计数。
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimension)).toBe(0);
  });

  it('view_id 里的伪造 JWT 被脱敏，原始值不再出现', () => {
    const { event } = run(makeEvent({ view_id: `view-${FAKE_JWT}` }));
    const viewId = textOf(event, 'view_id');
    expect(viewId).not.toContain(FAKE_JWT);
    expect(viewId).toContain('view-');
  });

  it('level 是 Schema 枚举协议字段：被排除清单跳过（脱敏会产出枚举外的值）', () => {
    // 口径变更（2026-10-14 收口）：此前把 level 当作「声明字段」一并脱敏；协议字段排除清单
    // 落地后，level 属闭集枚举（debug/info/warn/error），改写即离开契约词汇表 → 不脱敏。
    const { event } = run(makeEvent({ level: 'info' }), [HOSTILE_PROTOCOL_RULE]);
    expect(textOf(event, 'level')).toBe('info');
  });

  it('未声明的顶层字符串字段同样被脱敏（异常输入不构成绕过路径）', () => {
    const { event } = run(makeEvent({ raw_query_string: `q=${FAKE_EMAIL}&p=${FAKE_PHONE}` }));
    const raw = textOf(event, 'raw_query_string');
    expect(raw).not.toContain(FAKE_EMAIL);
    expect(raw).not.toContain(FAKE_PHONE);
    expect(raw).toContain('q=');
  });

  it('短事件（未触发 16 KB 阶梯）就必须脱敏 —— 旧实现的盲区', () => {
    // 旧实现里这些字段只在 clampAllStringValues 跑到时才被「截断」，而该函数**只在事件体
    // 超过 16 KB 时**才被调用：长度不足 256 的敏感值此前会原样发出。
    const { event } = run(makeEvent({ page_id: `/task/${FAKE_PHONE}`, view_id: `v-${FAKE_JWT}` }));
    expect(JSON.stringify(event)).not.toContain(FAKE_PHONE);
    expect(JSON.stringify(event)).not.toContain(FAKE_JWT);
  });

  it('与 dimensions 是同一个 masker：相同文本得到相同结果', () => {
    const message = `token ${FAKE_JWT} phone ${FAKE_PHONE}`;
    const { event } = run(makeEvent({ page_id: message, dimensions: { message } }));
    const dimensions = event['dimensions'] as Record<string, string>;
    expect(textOf(event, 'page_id')).toBe(dimensions['message']);
  });

  it('接入方追加的远程规则（extra_mask_rules）同样作用于顶层字段', () => {
    const custom: MaskRule = {
      name: 'fake_trace_id',
      pattern: 'trace-[0-9a-f]{8}',
      replacement: 'trace-***',
      builtin: false,
    };
    const { event } = run(makeEvent({ page_id: `route/trace-0badc0de/${FAKE_PHONE}` }), [custom]);
    const pageId = textOf(event, 'page_id');
    expect(pageId).not.toContain('trace-0badc0de');
    expect(pageId).toContain('trace-***');
    expect(pageId).not.toContain(FAKE_PHONE);
  });

  it('顺序为先脱敏、再截断：跨 256 边界的敏感值不留下可识别残片', () => {
    // 手机号正好跨越 256 边界（250 + 11 + 50 = 311 字符）；用未声明的大字段把事件体顶到
    // 16 KB 以上，触发 clampAllStringValues 的真实截断路径。
    // 若截断在前，会留下 "1380" 这样的数字残片（模式已不匹配，却仍可识别）；先脱敏则不会。
    const pageId = `${'a'.repeat(250)}${FAKE_PHONE}${'b'.repeat(50)}`;
    const { result, event } = run(makeEvent({ page_id: pageId, debug_blob: 'B'.repeat(20_000) }));
    expect(result.dropped).toBe(false);
    const clamped = textOf(event, 'page_id');
    expect(clamped).toHaveLength(256);
    expect(clamped).not.toContain(FAKE_PHONE);
    expect(clamped).not.toMatch(/\d{4}/);
  });

  it('未命中任何规则时不写入（保持「已合规事件零写入」）', () => {
    const event = makeEvent({
      page_id: '/task/:id',
      view_id: '00000000-0000-4000-8000-000000000002',
      level: 'info',
    });
    const before = JSON.stringify(event);
    const { counter, event: out } = run(event);
    expect(JSON.stringify(out)).toBe(before);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimension)).toBe(0);
    expect(out['truncated']).toBeUndefined();
  });
});

describe('C04 新增顶层脱敏通道不改变既有 url/attachment/dimensions 语义', () => {
  it('url 与 attachment 仍各自只施加一次脱敏（不被顶层通道二次施加追加规则）', () => {
    const { event } = run(makeEvent({ url: 'https://a.example/x', attachment: 'x', raw_note: 'x' }), [DOUBLING_RULE]);
    // 一次施加：'x'→'xx'（url 里的 'example' 也含 x，因此是 exxample）；二次施加会变成 exxxxample。
    expect(textOf(event, 'url')).toBe('https://a.exxample/xx');
    expect(textOf(event, 'attachment')).toBe('xx');
    // 顶层通道覆盖的非协议字段同样只施加一次。
    expect(textOf(event, 'raw_note')).toBe('xx');
  });

  it('dimensions / context 的值不被顶层通道二次施加追加规则', () => {
    const { event } = run(makeEvent({ dimensions: { a: 'x' }, context: { b: 'x' } }), [DOUBLING_RULE]);
    expect((event['dimensions'] as Record<string, string>)['a']).toBe('xx');
    expect((event['context'] as Record<string, string>)['b']).toBe('xx');
  });

  it('256 / 16 KB 阶梯语义不变：未声明大字段被截到 256、敏感值先脱敏，事件体回到 16 KB 以内', () => {
    const { result, event } = run(makeEvent({ debug_blob: `phone ${FAKE_PHONE} ${'B'.repeat(20_000)}` }));
    expect(result.dropped).toBe(false);
    const blob = textOf(event, 'debug_blob');
    expect(blob).toHaveLength(256);
    expect(blob).not.toContain(FAKE_PHONE);
    expect(utf8Bytes(JSON.stringify(event))).toBeLessThanOrEqual(16_384);
  });
});

describe('C04 协议字段不可被接入方配置破坏（排除清单的行为钉子）', () => {
  it('追加规则命中协议字段取值时，协议字段不被改写、枚举值仍在枚举内', () => {
    const { event } = run(makeEvent({ level: 'info' }), [HOSTILE_PROTOCOL_RULE, HOSTILE_UUID_RULE]);
    // event_id 是去重的唯一依据：被改写 → 去重失效。
    expect(textOf(event, 'event_id')).toBe('00000000-0000-4000-8000-000000000001');
    // event_name 参与「必要事件」判定：被改写 → 同意门错乱。
    expect(textOf(event, 'event_name')).toBe('task_complete');
    // 枚举字段被改写 → 离开 Schema 词汇表。
    expect(textOf(event, 'event_type')).toBe('custom');
    expect(textOf(event, 'priority')).toBe('normal');
    expect(textOf(event, 'level')).toBe('info');
  });

  it('同一条 UUID 追加规则下，view_id（载荷里的 uuid 形态）仍被脱敏', () => {
    const { event } = run(makeEvent({ view_id: '00000000-0000-4000-8000-0000000000ff' }), [HOSTILE_UUID_RULE]);
    expect(textOf(event, 'view_id')).toBe('***');
  });

  it('同一条规则下，page_id 里的伪造手机号仍被脱敏（排除清单没有放过该脱敏的）', () => {
    const { event } = run(makeEvent({ page_id: `/user/${FAKE_PHONE}` }), [HOSTILE_PROTOCOL_RULE, HOSTILE_UUID_RULE]);
    const pageId = textOf(event, 'page_id');
    expect(pageId).not.toContain(FAKE_PHONE);
    expect(pageId).toContain('1**********');
    expect(pageId).toContain('/user/');
  });

  it('未声明的顶层字段仍继续脱敏（不因排除清单被放过）', () => {
    const { event } = run(makeEvent({ raw_note: `info phone ${FAKE_PHONE}` }), [HOSTILE_PROTOCOL_RULE]);
    const note = textOf(event, 'raw_note');
    expect(note).not.toContain(FAKE_PHONE);
    expect(note).not.toContain('info');
    expect(note).toContain('phone');
  });
});
