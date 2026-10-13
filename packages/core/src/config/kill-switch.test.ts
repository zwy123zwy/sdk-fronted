/**
 * C03-F5 kill switch 与 semver 子集 —— fail-first 用例（M0）。
 * 覆盖：C03-AC-14（`sdk_versions` 命中进入已销毁态并计 `killed`；`plugins` 只卸载目标插件并恢复 hook）。
 * semver 语法边界见 `remote-config.md` 5.1（CR-003）。
 *
 * M0 说明：`kill-switch.ts` 是桩实现（恒不命中、不生效、范围恒"支持"），本文件预期断言级失败。
 */
import { describe, expect, it } from 'vitest';

import { createKernel, definePlugin } from '../kernel';
import type { Kernel, KernelEvent } from '../kernel';
import { applyKillSwitch, evaluateKillSwitch, isSupportedSemverRange, matchesSemverRange } from './kill-switch';
import { createBuiltinConfig } from './defaults';
import type { EffectiveConfig } from './types';

function makeEvent(name: string): KernelEvent {
  return { event_name: name, priority: 'normal', occurred_at: 1 };
}

function withKillSwitch(config: EffectiveConfig, kill: EffectiveConfig['kill_switch']): EffectiveConfig {
  return { ...config, kill_switch: kill };
}

describe('kill switch：semver 范围子集（remote-config.md 5.1 / CR-003）', () => {
  it('精确与比较符', () => {
    expect(matchesSemverRange('2.3.1', '2.3.1')).toBe(true);
    expect(matchesSemverRange('2.3.2', '2.3.1')).toBe(false);
    expect(matchesSemverRange('2.3.2', '>2.3.1')).toBe(true);
    expect(matchesSemverRange('2.3.1', '>2.3.1')).toBe(false);
    expect(matchesSemverRange('2.3.1', '>=2.3.1')).toBe(true);
    expect(matchesSemverRange('2.3.0', '<2.3.1')).toBe(true);
    expect(matchesSemverRange('2.3.1', '<=2.3.1')).toBe(true);
  });

  it('空格合取与 || 析取', () => {
    expect(matchesSemverRange('2.3.1', '>=2.3.0 <2.3.2')).toBe(true);
    expect(matchesSemverRange('2.3.3', '>=2.3.0 <2.3.2')).toBe(false);
    expect(matchesSemverRange('1.5.0', '^1.0.0 || >=2.0.0')).toBe(true);
    expect(matchesSemverRange('2.5.0', '^1.0.0 || >=2.0.0')).toBe(true);
    expect(matchesSemverRange('3.0.0', '^1.0.0 || >=2.0.0')).toBe(true);
  });

  it('脱字符 ^ 与波浪号 ~', () => {
    expect(matchesSemverRange('1.9.9', '^1.2.3')).toBe(true);
    expect(matchesSemverRange('2.0.0', '^1.2.3')).toBe(false);
    expect(matchesSemverRange('0.2.9', '^0.2.3')).toBe(true);
    expect(matchesSemverRange('0.3.0', '^0.2.3')).toBe(false);
    expect(matchesSemverRange('1.2.9', '~1.2.3')).toBe(true);
    expect(matchesSemverRange('1.3.0', '~1.2.3')).toBe(false);
  });

  it('通配 1.2.x / 1.x / *', () => {
    expect(matchesSemverRange('1.2.7', '1.2.x')).toBe(true);
    expect(matchesSemverRange('1.3.0', '1.2.x')).toBe(false);
    expect(matchesSemverRange('1.9.9', '1.x')).toBe(true);
    expect(matchesSemverRange('2.0.0', '1.x')).toBe(false);
    expect(matchesSemverRange('9.9.9', '*')).toBe(true);
  });

  it('预发布按 semver §11 比较、+build 忽略', () => {
    expect(matchesSemverRange('1.2.3-beta.1', '<1.2.3')).toBe(true);
    expect(matchesSemverRange('1.2.3+build.5', '1.2.3')).toBe(true);
  });

  it('不支持的语法必须被识别为不支持（连字符区间、范围中的预发布）', () => {
    expect(isSupportedSemverRange('1.2.3 - 2.0.0')).toBe(false);
    expect(isSupportedSemverRange('>=1.2.3-beta.1')).toBe(false);
    expect(isSupportedSemverRange('>=1.2.0 <2.0.0')).toBe(true);
    expect(isSupportedSemverRange('^1.2.3')).toBe(true);
  });
});

describe('C03-F5 kill switch 生效', () => {
  it('C03-AC-14a sdk_versions 命中当前版本：进入已销毁态，之后的事件计 killed', () => {
    const config = withKillSwitch(createBuiltinConfig('essential_only'), {
      all: false,
      sdk_versions: ['>=0.3.0 <0.3.2'],
      plugins: [],
    });
    const decision = evaluateKillSwitch(config, '0.3.1');
    expect(decision.all).toBe(true);

    const kernel: Kernel = createKernel({ target: null });
    kernel.init();
    kernel.start();
    applyKillSwitch(kernel, decision, () => undefined);
    kernel.report(makeEvent('page_view'));

    expect(kernel.counters.get('killed')).toBeGreaterThan(0);
    // 不得误计为 destroyed（kill switch 用 pause('killed')，不是 kernel.destroy()）
    expect(kernel.counters.get('destroyed')).toBe(0);
  });

  it('C03-AC-14b plugins: ["http"] 只卸载 HTTP 插件并恢复其 hook', () => {
    const kernel: Kernel = createKernel({ target: null });
    const target = { ping: (): string => 'original' };
    kernel.registerPlugin(
      definePlugin({
        id: 'http',
        install: (context) => {
          context.hook(target, 'ping', () => () => 'hooked');
        },
      }),
    );
    kernel.registerPlugin(definePlugin({ id: 'error', install: () => undefined }));
    kernel.registerPlugin(definePlugin({ id: 'perf', install: () => undefined }));
    kernel.applyPluginConfig({ http: true, error: true, perf: true });
    expect(target.ping()).toBe('hooked');

    applyKillSwitch(kernel, { all: false, plugins: ['http'] }, () => undefined);

    expect(kernel.plugins.isInstalled('http')).toBe(false);
    expect(kernel.plugins.isInstalled('error')).toBe(true);
    expect(kernel.plugins.isInstalled('perf')).toBe(true);
    expect(target.ping()).toBe('original');
  });
});
