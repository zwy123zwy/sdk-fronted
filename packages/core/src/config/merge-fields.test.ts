/**
 * C03-F1 三级合并：逐字段组与 overrides/runtime 覆盖 —— 用例（M4，覆盖率补强）。
 */
import { describe, expect, it } from 'vitest';

import { createBuiltinConfig } from './defaults';
import { mergeConfig, resolveConsentMode } from './merge';
import type { EffectiveConfig } from './types';

const NOW = 1_793_000_000_000;

function baseInput(builtin: EffectiveConfig): Parameters<typeof mergeConfig>[0] {
  return {
    builtin,
    remote: undefined,
    runtime: undefined,
    configVersion: undefined,
    publishedAt: undefined,
    source: 'builtin',
    consentMode: undefined,
    sessionRandom: 0.5,
    sdkVersion: '1.0.0',
  };
}

describe('C03-F1 逐字段组合并', () => {
  it('remote 各字段组 + overrides.patch + runtime 覆盖（含「运行时只能关插件」）', () => {
    const builtin = createBuiltinConfig('essential_only');
    const remote: Record<string, unknown> = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 5,
      published_at: NOW,
      sampling: {
        session_rate: 0.25,
        allow_users: ['u1'],
        rules: [{ match: { event_name: 'editor_*' }, rate: 0.5 }],
      },
      kill_switch: { all: false, sdk_versions: ['>=1.0.0'], plugins: ['http'] },
      plugins: { http: { enabled: true, options: { mode: 'xhr' } }, perf: { enabled: false } },
      privacy: {
        consent_mode: 'buffer',
        url_query_allowlist: ['a'],
        sensitive_headers: ['x-a'],
        extra_mask_rules: [{ name: 'n', pattern: 'p', flags: 'i', replacement: 'r' }],
      },
      endpoints: { ingest: 'https://i.example.com' },
      transport: {
        max_batch_events: 7,
        max_batch_bytes: 2048,
        idle_flush_ms: 300,
        max_wait_ms: 2000,
        replay_batches_per_second: 0.5,
      },
      overrides: [
        { when: { sdk_versions: ['>=0.0.1'] }, patch: { sampling: { session_rate: 0.9 } } },
        {
          when: { session_bucket: [0, 100] },
          patch: { transport: { max_batch_events: 9 }, plugins: { error: { enabled: false } } },
        },
        { when: { session_bucket: [100, 200] }, patch: { sampling: { session_rate: 0.01 } } },
      ],
    };
    const result = mergeConfig({
      ...baseInput(builtin),
      remote,
      runtime: { transport: { idle_flush_ms: 999 }, debug: true, plugins: { http: false, error: true } },
      configVersion: 5,
      publishedAt: NOW,
      source: 'remote',
      consentMode: 'essential_only',
    });

    expect(result.config.sampling.session_rate).toBe(0.9);
    expect(result.config.sampling.allow_users).toEqual(['u1']);
    expect(result.config.sampling.rules[0]?.rate).toBe(0.5);
    expect(result.config.kill_switch.sdk_versions).toEqual(['>=1.0.0']);
    expect(result.config.kill_switch.plugins).toEqual(['http']);
    // remote 开启 http，runtime 关闭 → 关闭生效
    expect(result.config.plugins.http.enabled).toBe(false);
    // override patch 关闭 error；runtime 试图开启 → 被忽略
    expect(result.config.plugins.error.enabled).toBe(false);
    expect(result.config.plugins.perf.enabled).toBe(false);
    expect(result.config.privacy.consent_mode).toBe('buffer');
    expect(result.config.privacy.url_query_allowlist).toEqual(['a']);
    expect(result.config.privacy.sensitive_headers).toEqual(['x-a']);
    expect(result.config.privacy.extra_mask_rules[0]).toEqual({
      name: 'n',
      pattern: 'p',
      flags: 'i',
      replacement: 'r',
    });
    expect(result.config.endpoints.ingest).toBe('https://i.example.com');
    expect(result.config.transport).toEqual({
      max_batch_events: 9,
      max_batch_bytes: 2048,
      idle_flush_ms: 999,
      max_wait_ms: 2000,
      replay_batches_per_second: 0.5,
    });
    expect(result.config.debug).toBe(true);
    expect(result.config.applied_overrides).toBe(2);
  });

  it('runtime 关闭插件时保留 options；remote 非对象字段一律保持 base', () => {
    const builtin = createBuiltinConfig('essential_only');
    const remote: Record<string, unknown> = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 6,
      published_at: NOW,
      plugins: { http: { enabled: true, options: { keep: true } } },
      sampling: 'not-an-object',
      kill_switch: 42,
      privacy: ['nope'],
      endpoints: null,
      transport: 'nope',
    };
    const result = mergeConfig({
      ...baseInput(builtin),
      remote,
      runtime: { plugins: { http: false } },
      configVersion: 6,
      publishedAt: NOW,
      source: 'remote',
    });

    expect(result.config.plugins.http).toEqual({ enabled: false, options: { keep: true } });
    expect(result.config.sampling).toEqual(builtin.sampling);
    expect(result.config.kill_switch).toEqual(builtin.kill_switch);
    expect(result.config.privacy.url_query_allowlist).toEqual([]);
    expect(result.config.endpoints).toEqual({});
    expect(result.config.transport).toEqual({});
  });

  it('插件设置非法时忽略该插件；空 options 与非对象 options 都按缺省处理', () => {
    const builtin = createBuiltinConfig('essential_only');
    const remote: Record<string, unknown> = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 7,
      published_at: NOW,
      plugins: {
        error: 'bad',
        perf: { enabled: true, options: 5 },
        route: { options: {} },
        http: { enabled: true },
      },
    };
    const result = mergeConfig({ ...baseInput(builtin), remote, configVersion: 7, source: 'remote' });
    expect(result.config.plugins.error.enabled).toBe(true);
    expect(result.config.plugins.perf).toEqual({ enabled: true });
    expect(result.config.plugins.route.enabled).toBe(true);
    expect(result.config.plugins.http.enabled).toBe(true);
  });

  it('resolveConsentMode：远程缺失/非法/合法三分支', () => {
    expect(resolveConsentMode(undefined, 'buffer')).toEqual({ mode: 'buffer', rejected: false });
    expect(resolveConsentMode(undefined, undefined)).toEqual({ mode: 'essential_only', rejected: false });
    expect(resolveConsentMode(undefined, 'full')).toEqual({ mode: 'full', rejected: false });
    expect(resolveConsentMode('full', undefined)).toEqual({ mode: 'essential_only', rejected: true });
    expect(resolveConsentMode('essential_only', 'full')).toEqual({ mode: 'essential_only', rejected: false });
  });
});
