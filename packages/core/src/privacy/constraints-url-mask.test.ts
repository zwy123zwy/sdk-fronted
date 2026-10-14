/**
 * 第四处同类缺陷（C04 处理器侧）：`constrainEvent` 的 `clampUrl` 只按长度截断 `url`，
 * **不过 masker** —— 正确性被押在"创建侧都先 `sanitizeUrl`"上。任何插件/未来调用点直接写
 * `event['url']` 就会把原文（含查询参数里的令牌、userinfo 里的凭据）送到线上。
 *
 * 修复口径（纵深防御）：处理器侧的 url 路径与 `dimensions`/`context`/`attachment` 一样，
 * 用**同一个** masker 对整条 url 文本脱敏，再做 2048 长度截断（先脱敏、后截断）。
 *
 * 本文件在修复前先写（旧实现下断言级失败），修复后转绿。
 * 测试数据全部是格式合法的伪造值。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { C04_LIMITS, MAX_URL_LENGTH } from './constants';
import { constrainEvent } from './constraints';
import { createMasker } from './mask';
import { PRIVACY_REASON_CODES } from './reason-codes';

const FAKE_PHONE = '13800138000';
const FAKE_EMAIL = 'alice.smith+tag@example.co.uk';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

function makeCounter() {
  const counts = new Map<string, number>();
  return {
    count: (reason: string, delta = 1): void => {
      counts.set(reason, (counts.get(reason) ?? 0) + delta);
    },
    get: (reason: string): number => counts.get(reason) ?? 0,
  };
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

function run(event: KernelEvent) {
  const counter = makeCounter();
  const result = constrainEvent({ event, limits: C04_LIMITS, masker: createMasker(), count: counter.count });
  return { counter, result, event: result.event };
}

function urlOf(event: KernelEvent): string {
  const value = event['url'];
  if (typeof value !== 'string') throw new Error('url 不是字符串');
  return value;
}

describe('C04 处理器侧：url 必须过 masker（纵深防御）', () => {
  it('直接写入的 url：路径里的手机号与查询参数里的 JWT 都被脱敏', () => {
    const { event } = run(makeEvent({ url: `https://a.example/task/${FAKE_PHONE}?token=${FAKE_JWT}` }));
    const url = urlOf(event);
    expect(url).not.toContain(FAKE_PHONE);
    expect(url).not.toContain(FAKE_JWT);
    expect(url).not.toMatch(/\d{4}/);
    expect(url).toContain('https://a.example/task/');
  });

  it('userinfo（authority 里的凭据）也被脱敏 —— 只脱敏路径/查询的实现会漏掉这里', () => {
    const { event } = run(makeEvent({ url: `https://${FAKE_EMAIL}@a.example/p?tab=detail` }));
    const url = urlOf(event);
    expect(url).not.toContain(FAKE_EMAIL);
    expect(url).toContain('***@***');
    expect(url).toContain('?tab=detail');
  });

  it('先脱敏、再截断：2048 长度上限仍生效并记录 truncated 路径', () => {
    const { counter, event } = run(makeEvent({ url: `https://a.example/${'a'.repeat(4096)}` }));
    const url = urlOf(event);
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(event['truncated']).toContain('url');
    expect(counter.get(PRIVACY_REASON_CODES.truncatedDimension)).toBeGreaterThanOrEqual(1);
  });

  it('对已脱敏的 url 再脱敏一次是不动点（内置规则幂等，二次施加无副作用）', () => {
    const once = run(makeEvent({ url: `https://a.example/task/${FAKE_PHONE}?token=${FAKE_JWT}&tab=detail` })).event;
    const twice = constrainEvent({
      event: once,
      limits: C04_LIMITS,
      masker: createMasker(),
      count: () => undefined,
    }).event;
    expect(urlOf(twice)).toBe(urlOf(once));
  });

  it('普通域名 url 原样保留（脱敏不误伤 host）', () => {
    const { event } = run(makeEvent({ url: 'https://a.example/task/123?tab=detail' }));
    expect(urlOf(event)).toBe('https://a.example/task/123?tab=detail');
  });

  it('规则命中的 host（IPv4 字面量）按内置 ipv4 规则脱敏（整串脱敏的预期后果）', () => {
    const { event } = run(makeEvent({ url: 'http://192.168.10.24:8080/app' }));
    expect(urlOf(event)).not.toContain('192.168.10.24');
  });
});
