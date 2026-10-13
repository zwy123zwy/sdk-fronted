/**
 * C03-F1 三级配置合并与 `consent_mode` 合并 —— fail-first 用例（M0）。
 * 覆盖：C03-AC-01、C03-AC-02、C03-AC-21、C03-AC-22。
 *
 * M0 说明：`merge.ts` 当前是桩实现（只返回 builtin），本文件预期**断言级失败**，
 * 用于证明断言本身有判别力。实现落地后必须转绿。
 */
import { describe, expect, it } from 'vitest';

import { createBuiltinConfig } from './defaults';
import { mergeConfig, resolveConsentMode } from './merge';
import type { EffectiveConfig } from './types';

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

describe('C03-F1 三级合并', () => {
  it('C03-AC-01 三级都设置 transport.max_batch_events 时取运行时覆盖，且生效配置带远程 config_version', () => {
    const builtin: EffectiveConfig = {
      ...createBuiltinConfig('essential_only'),
      transport: { max_batch_events: 30 },
    };
    const remote = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 42,
      published_at: 1_793_000_000_000,
      transport: { max_batch_events: 20 },
    };
    const result = mergeConfig({
      ...baseInput(builtin),
      remote,
      runtime: { transport: { max_batch_events: 5 } },
      configVersion: 42,
      publishedAt: 1_793_000_000_000,
      source: 'remote',
    });

    expect(result.config.transport.max_batch_events).toBe(5);
    expect(result.config.config_version).toBe(42);
  });

  it('C03-AC-02 运行时覆盖开启远程已关闭的插件、修改采样率都被忽略', () => {
    const builtin = createBuiltinConfig('essential_only');
    const remote = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 43,
      published_at: 1_793_000_000_000,
      plugins: { http: { enabled: false } },
      sampling: { session_rate: 0.5 },
    };
    const result = mergeConfig({
      ...baseInput(builtin),
      remote,
      runtime: { plugins: { http: true }, debug: true },
      configVersion: 43,
      source: 'remote',
    });

    expect(result.config.plugins.http.enabled).toBe(false);
    expect(result.config.sampling.session_rate).toBe(0.5);
    // `debug` 是允许被运行时覆盖的字段之一
    expect(result.config.debug).toBe(true);
  });
});

describe('C03-F1 / D002 consent_mode 合并', () => {
  it('C03-AC-21 初始化 buffer + 远程 full：生效 buffer，计 config_consent_mode_rejected，其它字段照常生效', () => {
    const builtin = createBuiltinConfig('buffer');
    const remote = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 44,
      published_at: 1_793_000_000_000,
      privacy: { consent_mode: 'full' },
      plugins: { perf: { enabled: false } },
    };
    const result = mergeConfig({
      ...baseInput(builtin),
      remote,
      configVersion: 44,
      source: 'remote',
      consentMode: 'buffer',
    });

    expect(result.config.privacy.consent_mode).toBe('buffer');
    expect(result.consentModeRejected).toBe(true);
    expect(result.config.plugins.perf.enabled).toBe(false);
  });

  it('C03-AC-22 初始化 full + 远程 essential_only：生效 essential_only', () => {
    const builtin = createBuiltinConfig('essential_only');
    const remote = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 45,
      published_at: 1_793_000_000_000,
      privacy: { consent_mode: 'essential_only' },
      plugins: { perf: { enabled: false } },
    };
    const result = mergeConfig({
      ...baseInput(builtin),
      remote,
      configVersion: 45,
      source: 'remote',
      consentMode: 'full',
    });

    expect(result.config.privacy.consent_mode).toBe('essential_only');
    // 加强断言：证明远程层确实被消费，而不是「恰好等于默认值」
    expect(result.config.plugins.perf.enabled).toBe(false);
  });

  it('resolveConsentMode：远程非法值一律忽略并计数', () => {
    expect(resolveConsentMode('full', 'buffer')).toEqual({ mode: 'buffer', rejected: true });
    expect(resolveConsentMode('always', 'essential_only')).toEqual({ mode: 'essential_only', rejected: true });
    expect(resolveConsentMode('buffer', 'full')).toEqual({ mode: 'buffer', rejected: false });
  });
});
