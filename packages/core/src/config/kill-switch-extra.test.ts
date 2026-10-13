/**
 * kill switch：求值与生效的边界 —— 用例（M4，覆盖率补强）。
 */
import { describe, expect, it } from 'vitest';

import { createKernel } from '../kernel';
import { createBuiltinConfig } from './defaults';
import { applyKillSwitch, evaluateKillSwitch, matchesSemverRange } from './kill-switch';

describe('kill-switch 求值边界', () => {
  it('all: true 直接全局命中；插件清单原样带出', () => {
    const config = {
      ...createBuiltinConfig('essential_only'),
      kill_switch: { all: true, sdk_versions: [], plugins: ['http' as const] },
    };
    expect(evaluateKillSwitch(config, '9.9.9')).toEqual({ all: true, plugins: ['http'] });
  });

  it('版本非法 / 范围不支持 → 不命中', () => {
    expect(matchesSemverRange('not-a-version', '>=1.0.0')).toBe(false);
    expect(matchesSemverRange('1.2.3', '1.2.3 - 2.0.0')).toBe(false);
    expect(matchesSemverRange('1.2.3', '')).toBe(false);
  });

  it('脱字符 0.0.x 与波浪号的上界', () => {
    expect(matchesSemverRange('0.0.4', '^0.0.3')).toBe(false);
    expect(matchesSemverRange('0.0.3', '^0.0.3')).toBe(true);
    expect(matchesSemverRange('1.2.4', '~1.2.3')).toBe(true);
    expect(matchesSemverRange('1.3.0', '~1.2.3')).toBe(false);
  });

  it('未知比较符形式（如 =1.2.3）视为不支持', () => {
    expect(matchesSemverRange('1.2.3', '=1.2.3')).toBe(false);
  });
});

describe('kill-switch 生效边界', () => {
  it('全局 kill 清空预启动队列并逐条计 killed，且调用 stopRuntime', () => {
    const kernel = createKernel({ target: null });
    kernel.init();
    kernel.start();
    kernel.report({ event_name: 'a_event', priority: 'normal', occurred_at: 1 });
    kernel.report({ event_name: 'b_event', priority: 'normal', occurred_at: 2 });
    expect(kernel.prestartQueue.size()).toBe(2);

    let stopped = false;
    applyKillSwitch(kernel, { all: true, plugins: [] }, () => {
      stopped = true;
    });

    expect(stopped).toBe(true);
    expect(kernel.prestartQueue.size()).toBe(0);
    expect(kernel.counters.get('killed')).toBe(2);
  });

  it('插件级 kill 对未安装/未注册插件是幂等空操作', () => {
    const kernel = createKernel({ target: null });
    expect(() => {
      applyKillSwitch(kernel, { all: false, plugins: ['http', 'unknown'] }, () => undefined);
    }).not.toThrow();
    expect(kernel.counters.get('killed')).toBe(0);
  });
});
