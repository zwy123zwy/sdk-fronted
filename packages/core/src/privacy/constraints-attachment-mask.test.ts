/**
 * `attachment` 必须与 `dimensions` / `context` 走**同一个** masker（C04-F4 / C04-F6，
 * 缺陷修复：此前 `clampAttachment` 只做 8 KB 字节截断、完全不脱敏，导致错误栈等
 * attachment 路径把手机号、邮箱、令牌原样送到接收方，违反 `tests/acceptance/C05.md` AC-01）。
 *
 * 覆盖：
 * - 手机号 / 邮箱 / JWT / Bearer 令牌出现在 `attachment` 中 → 原始值不再出现；
 * - `attachment` 与 `dimensions` 的脱敏结果一致（同一权威，含接入方追加规则）；
 * - 8 KB（UTF-8 字节）截断语义保留，且顺序为「先脱敏、再截断」。
 *
 * 测试数据全部是格式合法的伪造值。
 *
 * 取证顺序：本文件在实现修复前先写（当时 `attachment` 只截断不脱敏，值断言全部红过）。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { C04_LIMITS } from './constants';
import { constrainEvent } from './constraints';
import { createMasker } from './mask';
import { PRIVACY_REASON_CODES } from './reason-codes';
import { utf8Bytes } from './limits';
import type { MaskRule } from './types';

/** 计数替身。 */
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

function attachmentOf(event: KernelEvent): string {
  const value = event['attachment'];
  if (typeof value !== 'string') throw new Error('attachment 不是字符串');
  return value;
}

/** 伪造样本（格式合法、非真实个人信息）。 */
const FAKE_PHONE = '13800138000';
const FAKE_EMAIL = 'alice.smith+tag@example.co.uk';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
const FAKE_BEARER = 'Bearer abcDEF123.-_';

describe('C04 attachment 脱敏（与 dimensions/context 同一 masker）', () => {
  it('attachment 中的手机号被脱敏，原始值不再出现', () => {
    const { event } = run(makeEvent({ attachment: `TypeError: 手机号 ${FAKE_PHONE} 校验失败` }));
    const attachment = attachmentOf(event);
    expect(attachment).not.toContain(FAKE_PHONE);
    expect(attachment).toContain('1**********');
  });

  it('attachment 中的邮箱被脱敏，原始值不再出现', () => {
    const { event } = run(makeEvent({ attachment: `TypeError: user ${FAKE_EMAIL} not found` }));
    const attachment = attachmentOf(event);
    expect(attachment).not.toContain(FAKE_EMAIL);
    expect(attachment).toContain('***@***');
  });

  it('attachment 中的 JWT 被脱敏，原始值不再出现', () => {
    const { event } = run(makeEvent({ attachment: `fetch failed with token ${FAKE_JWT}` }));
    expect(attachmentOf(event)).not.toContain(FAKE_JWT);
  });

  it('attachment 中的 Bearer 令牌（含 Authorization 形态的栈文本）被脱敏', () => {
    const { event } = run(makeEvent({ attachment: `at send (x.js:1:1)\nAuthorization: ${FAKE_BEARER}` }));
    const attachment = attachmentOf(event);
    expect(attachment).not.toContain('abcDEF123.-_');
    expect(attachment).toContain('Bearer ***');
  });

  it('同一 masker 实例同时作用于 dimensions 与 attachment：相同输入得到相同结果', () => {
    const message = `token ${FAKE_JWT} phone ${FAKE_PHONE}`;
    const { event } = run(makeEvent({ dimensions: { message }, attachment: message }));
    const dimensions = event['dimensions'] as Record<string, string>;
    expect(attachmentOf(event)).toBe(dimensions['message']);
  });

  it('接入方追加的远程规则（extra_mask_rules）同样作用于 attachment', () => {
    const custom: MaskRule = {
      name: 'fake_trace_id',
      pattern: 'trace-[0-9a-f]{8}',
      replacement: 'trace-***',
      builtin: false,
    };
    const text = 'stack trace trace-0badc0de / token ' + FAKE_JWT;
    const { event } = run(makeEvent({ attachment: text }), [custom]);
    const attachment = attachmentOf(event);
    expect(attachment).not.toContain('trace-0badc0de');
    expect(attachment).toContain('trace-***');
    expect(attachment).not.toContain(FAKE_JWT);
  });

  it('短 attachment（未触截断）也必须脱敏 —— 此前该路径直接早退', () => {
    const { counter, event } = run(makeEvent({ attachment: `phone ${FAKE_PHONE}` }));
    expect(attachmentOf(event)).not.toContain(FAKE_PHONE);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedAttachment)).toBe(0);
  });

  it('超过 8 KB 的 attachment 仍被截断到 8 KB（UTF-8 字节）并记录 truncated 路径', () => {
    const { counter, event } = run(makeEvent({ attachment: 'a'.repeat(10_240) }));
    const attachment = attachmentOf(event);
    expect(utf8Bytes(attachment)).toBeLessThanOrEqual(C04_LIMITS.maxAttachmentBytes);
    expect(utf8Bytes(attachment)).toBeGreaterThan(C04_LIMITS.maxAttachmentBytes - 4);
    expect(event['truncated']).toContain('attachment');
    expect(counter.get(PRIVACY_REASON_CODES.truncatedAttachment)).toBe(1);
  });

  it('顺序为先脱敏、再截断：跨越 8 KB 边界的敏感值不留下可识别的片段', () => {
    // 8 KB 边界正好落在手机号中间（8187 + 1 + 11 = 8199 字节 > 8192）：
    // 若先截断，会留下 "1380" 这样的数字残片（模式已不匹配）；先脱敏则不会。
    const attachment = `${'a'.repeat(8187)} ${FAKE_PHONE}`;
    const { counter, event } = run(makeEvent({ attachment }));
    const result = attachmentOf(event);
    expect(utf8Bytes(result)).toBeLessThanOrEqual(C04_LIMITS.maxAttachmentBytes);
    expect(result).not.toContain(FAKE_PHONE);
    expect(result).not.toMatch(/\d{4}/);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedAttachment)).toBe(1);
  });

  it('非字符串 attachment 原样保留（不崩溃、不误计数）', () => {
    const { counter, event } = run(makeEvent({ attachment: 42 }));
    expect(event['attachment']).toBe(42);
    expect(counter.get(PRIVACY_REASON_CODES.truncatedAttachment)).toBe(0);
  });
});
