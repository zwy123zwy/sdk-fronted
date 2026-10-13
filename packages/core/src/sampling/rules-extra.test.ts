/**
 * 事件级规则匹配分支 —— 用例（M4，覆盖率补强）。
 */
import { describe, expect, it } from 'vitest';

import type { SamplingRule } from '../config/types';
import { matchFirstRule, ruleMatches } from './rules';
import type { SamplingEvent } from './types';

function event(overrides: Partial<SamplingEvent> = {}): SamplingEvent {
  return { event_name: 'editor_save', event_type: 'custom', priority: 'normal', occurred_at: 1, ...overrides };
}

describe('ruleMatches 分支', () => {
  it('event_type 命中与不命中', () => {
    const rule: SamplingRule = { match: { event_type: 'perf' }, rate: 1 };
    expect(ruleMatches(rule, event({ event_type: 'perf' }))).toBe(true);
    expect(ruleMatches(rule, event({ event_type: 'custom' }))).toBe(false);
  });

  it('event_name 精确匹配与前缀匹配', () => {
    expect(ruleMatches({ match: { event_name: 'editor_save' }, rate: 1 }, event())).toBe(true);
    expect(ruleMatches({ match: { event_name: 'editor_*' }, rate: 1 }, event())).toBe(true);
    expect(ruleMatches({ match: { event_name: 'viewer_*' }, rate: 1 }, event())).toBe(false);
  });

  it('dimension 命中/不命中/维度非对象', () => {
    const rule: SamplingRule = { match: { dimension: { key: 'tenant', equals: 'acme' } }, rate: 1 };
    expect(ruleMatches(rule, event({ dimensions: { tenant: 'acme' } }))).toBe(true);
    expect(ruleMatches(rule, event({ dimensions: { tenant: 'other' } }))).toBe(false);
    expect(ruleMatches(rule, event({ dimensions: 'not-a-record' }))).toBe(false);
    expect(ruleMatches(rule, event())).toBe(false);
  });

  it('空 match 视为命中（Schema 已禁止空 match，运行时保守命中）', () => {
    expect(ruleMatches({ match: {}, rate: 1 }, event())).toBe(true);
  });
});

describe('matchFirstRule 分支', () => {
  it('空规则列表返回未命中并给缺省采样率 1', () => {
    expect(matchFirstRule([], event())).toEqual({ matched: false, rate: 1, index: -1 });
  });

  it('返回第一条命中的规则下标', () => {
    const rules: readonly SamplingRule[] = [
      { match: { event_type: 'perf' }, rate: 0.5 },
      { match: { event_name: 'editor_*' }, rate: 0.1 },
    ];
    expect(matchFirstRule(rules, event())).toEqual({ matched: true, rate: 0.1, index: 1 });
  });
});
