/**
 * C08-F4 调试模式门禁用例：
 * - C08-AC-08：非生产环境 + URL 参数 → 开启；
 * - C08-AC-09：生产环境 + 非白名单用户 + 同样的 URL 参数 → 不开启；
 * - 生产环境 + 白名单用户 → 开启；未携带参数 → 不开启。
 *
 * 门禁只判定「是否允许输出」，不接触任何令牌；输出侧由 tracer 的字段白名单保证。
 */
import { describe, expect, test } from 'vitest';
import { DEBUG_QUERY_PARAM, DEFAULT_PRODUCTION_ENVS, resolveDebugMode } from './gate';

describe('resolveDebugMode（C08-F4）', () => {
  test('AC-08：非生产环境通过 URL 参数开启', () => {
    const decision = resolveDebugMode({ env: 'staging', search: `?${DEBUG_QUERY_PARAM}=1` });
    expect(decision.requested).toBe(true);
    expect(decision.allowed).toBe(true);
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toBe('allowed_non_production');
  });

  test('AC-09：生产环境 + 非白名单用户使用同样的 URL 参数不开启', () => {
    const decision = resolveDebugMode({
      env: 'production',
      search: `?${DEBUG_QUERY_PARAM}=1`,
      user: 'u1',
      allowUsers: ['u2'],
    });
    expect(decision.requested).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('production_user_not_allowlisted');
  });

  test('生产环境 + 白名单用户可开启', () => {
    const decision = resolveDebugMode({
      env: 'production',
      search: `?${DEBUG_QUERY_PARAM}=true`,
      user: 'u2',
      allowUsers: ['u2'],
    });
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toBe('allowed_allowlisted_user');
  });

  test('已哈希的 user_id 同样可命中白名单', () => {
    const decision = resolveDebugMode({
      env: 'production',
      search: `?${DEBUG_QUERY_PARAM}=1`,
      hashedUser: 'h1',
      allowUsers: ['h1'],
    });
    expect(decision.enabled).toBe(true);
  });

  test('没有 URL 参数时不开启（缺省静默，与 C01 的 debug 选项一致）', () => {
    const decision = resolveDebugMode({ env: 'development', search: '' });
    expect(decision.requested).toBe(false);
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('not_requested');
  });

  test('参数显式关闭（0/false/off）时不开启', () => {
    for (const value of ['0', 'false', 'off', 'FALSE', 'Off']) {
      const decision = resolveDebugMode({ env: 'staging', search: `?${DEBUG_QUERY_PARAM}=${value}` });
      expect(decision.enabled, value).toBe(false);
      expect(decision.reason, value).toBe('not_requested');
    }
  });

  test('接受完整 URL、裸查询串与无值参数', () => {
    expect(
      resolveDebugMode({ env: 'staging', search: 'https://app.example.com/?wr_debug=1' }).enabled,
    ).toBe(true);
    expect(resolveDebugMode({ env: 'staging', search: 'wr_debug=1' }).enabled).toBe(true);
    expect(resolveDebugMode({ env: 'staging', search: '?x=1&wr_debug&y=2' }).enabled).toBe(true);
  });

  test('env 缺失时保守处理：仅白名单用户可开启', () => {
    expect(resolveDebugMode({ search: `?${DEBUG_QUERY_PARAM}=1` }).enabled).toBe(false);
    expect(
      resolveDebugMode({ search: `?${DEBUG_QUERY_PARAM}=1`, user: 'u1', allowUsers: ['u1'] }).enabled,
    ).toBe(true);
  });

  test('自定义生产环境名与参数名', () => {
    expect(resolveDebugMode({ env: 'prod', search: `?${DEBUG_QUERY_PARAM}=1` }).enabled).toBe(false);
    expect(
      resolveDebugMode({ env: 'qa', search: '?my_debug=1', paramName: 'my_debug' }).enabled,
    ).toBe(true);
    expect(DEFAULT_PRODUCTION_ENVS).toContain('production');
  });
});
