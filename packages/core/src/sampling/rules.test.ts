/**
 * C03-F4 事件级规则 —— fail-first 用例（M0）。
 * 覆盖：C03-AC-13（`editor_*` 前缀匹配、`legacy_click_track` 的 `rate: 0`、critical 豁免、
 * 最终 `sample_rate = 会话率 × 规则率`；未命中计 `sampled_out_rule`）。
 *
 * M0 说明：`rules.ts`/`processor.ts` 是桩实现（恒不命中、不注册处理器），本文件预期断言级失败。
 */
import { describe, expect, it } from 'vitest';

import { createKernel } from '../kernel';
import type { ConfigReader, EffectiveConfig, ResolvedSampling, SamplingRule } from '../config/types';
import { createBuiltinConfig } from '../config/defaults';
import { combineSampleRate, matchFirstRule, ruleMatches } from './rules';
import { createSamplingProcessor } from './processor';
import { createSessionSampling } from './session';
import type { SessionStorePort } from './types';

const SAMPLE_RATE_FIELD = 'sample_rate';

function memoryStore(): SessionStorePort {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
  };
}


function readerWith(sampling: ResolvedSampling): ConfigReader {
  const config: EffectiveConfig = { ...createBuiltinConfig('essential_only'), sampling };
  return { current: () => config, subscribe: () => () => undefined };
}

const editorRule: SamplingRule = { match: { event_name: 'editor_*' }, rate: 0.1 };
const legacyRule: SamplingRule = { match: { event_name: 'legacy_click_track' }, rate: 0 };

describe('C03-F4 规则匹配（纯函数）', () => {
  it('event_name 精确匹配与前缀（`*` 结尾）匹配', () => {
    expect(ruleMatches(editorRule, { event_name: 'editor_save', priority: 'normal', occurred_at: 1 })).toBe(true);
    expect(ruleMatches(editorRule, { event_name: 'viewer_save', priority: 'normal', occurred_at: 1 })).toBe(false);
    expect(
      ruleMatches(
        { match: { event_name: 'legacy_click_track' }, rate: 0 },
        { event_name: 'legacy_click_track', priority: 'normal', occurred_at: 1 },
      ),
    ).toBe(true);
  });

  it('按顺序取第一条命中的规则；rate: 0 保留为禁用语义', () => {
    const outcome = matchFirstRule(
      [editorRule, legacyRule],
      { event_name: 'editor_save', priority: 'normal', occurred_at: 1 },
    );
    expect(outcome.matched).toBe(true);
    expect(outcome.rate).toBe(0.1);
    expect(outcome.index).toBe(0);

    const disabled = matchFirstRule(
      [editorRule, legacyRule],
      { event_name: 'legacy_click_track', priority: 'normal', occurred_at: 1 },
    );
    expect(disabled.matched).toBe(true);
    expect(disabled.rate).toBe(0);
    expect(disabled.index).toBe(1);
  });

  it('最终 sample_rate = 会话采样率 × 规则采样率', () => {
    expect(combineSampleRate(0.5, 0.1)).toBeCloseTo(0.05);
    expect(combineSampleRate(1, 1)).toBe(1);
  });
});

describe('C03-F4 采样处理器（管线 sample 段）', () => {
  it('C03-AC-13 前缀规则生效、rate:0 计 disabled_by_rule、critical 豁免、sample_rate 正确', () => {
    const sampling: ResolvedSampling = { session_rate: 1, allow_users: [], rules: [editorRule, legacyRule] };
    const config = readerWith(sampling);
    const kernel = createKernel({ target: null });
    const session = createSessionSampling({ config, random: () => 0, storage: memoryStore(), storeKey: 'rules-1' });
    const dispose = createSamplingProcessor({ kernel, config, session, random: () => 0 });
    expect(kernel.pipeline.size('sample')).toBeGreaterThanOrEqual(1);

    const editor = kernel.pipeline.process({ event_name: 'editor_save', priority: 'normal', occurred_at: 1 });
    expect(editor.status).toBe('processed');
    expect(editor.event[SAMPLE_RATE_FIELD]).toBeCloseTo(0.1);

    const disabled = kernel.pipeline.process({ event_name: 'legacy_click_track', priority: 'normal', occurred_at: 1 });
    expect(disabled.status).toBe('stopped');
    expect(disabled.reason).toBe('disabled_by_rule');
    expect(kernel.counters.get('disabled_by_rule')).toBeGreaterThan(0);

    const critical = kernel.pipeline.process({ event_name: 'legacy_click_track', priority: 'critical', occurred_at: 1 });
    expect(critical.status).toBe('processed');
    expect(critical.event[SAMPLE_RATE_FIELD]).toBe(1);

    dispose();
  });

  it('C03-AC-13 规则未命中（0.1 的概率没中）：计 sampled_out_rule', () => {
    const config = readerWith({ session_rate: 1, allow_users: [], rules: [editorRule] });
    const kernel = createKernel({ target: null });
    const session = createSessionSampling({ config, random: () => 0, storage: memoryStore(), storeKey: 'rules-2' });
    const dispose = createSamplingProcessor({ kernel, config, session, random: () => 0.99 });
    expect(kernel.pipeline.size('sample')).toBeGreaterThanOrEqual(1);

    const outcome = kernel.pipeline.process({ event_name: 'editor_save', priority: 'normal', occurred_at: 1 });
    expect(outcome.status).toBe('stopped');
    expect(outcome.reason).toBe('sampled_out_rule');
    expect(kernel.counters.get('sampled_out_rule')).toBeGreaterThan(0);

    dispose();
  });
});
