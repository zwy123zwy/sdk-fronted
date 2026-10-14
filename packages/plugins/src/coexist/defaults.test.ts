/**
 * C05-AC-20 共存模式默认配置：错误、性能、HTTP 插件默认关闭；可由远程配置**逐个开启**。
 *
 * 裁定（T18-plan §1 与 §13-④）：共存模式在**初始化参数**中声明。
 * 初始化时处于共存模式 → 相关插件默认关闭，之后可由远程配置逐个开启；
 * 不处于共存模式 → 走 C03 的内建默认表（error/perf/route 开、http 关）。
 * 两种缺省不同是**有意**的（共存模式面向「已有 APM、先不重复采集」的接入方）。
 */
import { describe, expect, it } from 'vitest';

import { BUILTIN_DEFAULTS, COEXISTENCE_DEFAULTS, COLLECTOR_IDS, resolvePluginDefaults } from './index';

describe('C05-AC-20 共存模式下三类插件默认关闭且可远程开启', () => {
  it('共存模式默认关闭 error / perf / http', () => {
    const resolved = resolvePluginDefaults({ apmCoexistence: true });
    expect(resolved['error']).toBe(false);
    expect(resolved['perf']).toBe(false);
    expect(resolved['http']).toBe(false);
  });

  it('非共存模式走 C03 的内建默认表（error/perf/route 开、http 关）', () => {
    const resolved = resolvePluginDefaults({ apmCoexistence: false });
    expect(resolved['error']).toBe(true);
    expect(resolved['perf']).toBe(true);
    expect(resolved['route']).toBe(true);
    expect(resolved['http']).toBe(false);
  });

  it('共存模式下可由远程配置逐个开启，且不开启未声明的插件', () => {
    const resolved = resolvePluginDefaults(
      { apmCoexistence: true },
      { error: { enabled: true }, perf: { enabled: false } },
    );
    expect(resolved['error'], '远程配置显式开启 error').toBe(true);
    expect(resolved['perf'], '远程配置显式关闭 perf').toBe(false);
    expect(resolved['http'], '未声明的插件保持共存模式缺省（关闭）').toBe(false);
  });

  it('非空转对照：两份缺省表本身不同，且都覆盖全部采集插件 id', () => {
    expect(BUILTIN_DEFAULTS).not.toEqual(COEXISTENCE_DEFAULTS);
    for (const id of COLLECTOR_IDS) {
      expect(Object.keys(BUILTIN_DEFAULTS)).toContain(id);
      expect(Object.keys(COEXISTENCE_DEFAULTS)).toContain(id);
    }
    // 判别力：如果实现一律返回同一张表，下面这条必须红
    expect(resolvePluginDefaults({ apmCoexistence: true })).not.toEqual(
      resolvePluginDefaults({ apmCoexistence: false }),
    );
  });
});
