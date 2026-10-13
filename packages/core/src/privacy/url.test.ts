/**
 * C04-AC-06：URL 查询参数白名单 + URL 脱敏。
 *
 * AC-06 原文：URL 带查询参数 `tab`、`token`、`phone`，白名单只有 `tab` → 上报的 `url` 只保留 `tab`。
 *
 * 口径补充（`remote-config.md` 5.4）：白名单为空时删除**全部**查询参数；
 * 路径与保留的参数值也要过脱敏规则；结果不超过 2048 字符。
 *
 * 测试数据全部是格式合法的伪造值。
 *
 * 取证顺序：`parseUrlParts` 的用例是「实现后补测」；`sanitizeUrl` 的语义用例在
 * **实现前先写**（当时的 `sanitizeUrl` 是原样返回的接口桩，这些用例因此红过）。
 */
import { describe, expect, it } from 'vitest';

import { MAX_URL_LENGTH } from './constants';
import { createMasker } from './mask';
import { parseUrlParts, sanitizeUrl } from './url';

describe('URL 拆解（parseUrlParts）', () => {
  it('拆出 origin / pathname / query / hash', () => {
    expect(parseUrlParts('https://a.example/p?tab=1&token=x#frag')).toEqual({
      origin: 'https://a.example',
      pathname: '/p',
      query: [
        ['tab', '1'],
        ['token', 'x'],
      ],
      hash: 'frag',
    });
  });

  it('相对 URL 的 origin 为空串，pathname 为路径', () => {
    expect(parseUrlParts('/a/b?x=1')).toEqual({
      origin: '',
      pathname: '/a/b',
      query: [['x', '1']],
      hash: undefined,
    });
  });

  it('保留重复键与出现顺序', () => {
    expect(parseUrlParts('https://a.example/p?k=1&k=2').query).toEqual([
      ['k', '1'],
      ['k', '2'],
    ]);
  });

  it('无查询参数时 query 为空数组；无 hash 时 hash 为 undefined', () => {
    expect(parseUrlParts('https://a.example/p')).toEqual({
      origin: 'https://a.example',
      pathname: '/p',
      query: [],
      hash: undefined,
    });
  });
});

describe('C04-AC-06 URL 查询参数白名单', () => {
  const masker = createMasker();

  it('白名单只有 tab 时只保留 tab（AC-06 原文场景）', () => {
    const input = 'https://a.example/p?tab=1&token=x&phone=13800138000';
    expect(sanitizeUrl(input, ['tab'], masker)).toBe('https://a.example/p?tab=1');
  });

  it('白名单为空时删除全部查询参数', () => {
    expect(sanitizeUrl('https://a.example/p?a=1&b=2', [], masker)).toBe('https://a.example/p');
  });

  it('无查询参数时 URL 原样保留（不含末尾问号）', () => {
    expect(sanitizeUrl('https://a.example/p', ['tab'], masker)).toBe('https://a.example/p');
  });

  it('保留的参数值的出现顺序与原始一致，重复键都保留', () => {
    const input = 'https://a.example/p?tab=b&x=1&tab=a';
    expect(sanitizeUrl(input, ['tab'], masker)).toBe('https://a.example/p?tab=b&tab=a');
  });

  it('保留的参数值里的伪造 PII 仍会被掩码', () => {
    const input = 'https://a.example/p?tab=13800138000';
    expect(sanitizeUrl(input, ['tab'], masker)).toBe('https://a.example/p?tab=1**********');
  });

  it('URL 路径里的伪造 PII 会被掩码（5.4 的规则作用范围含 URL 路径）', () => {
    const input = 'https://a.example/u/alice.smith+tag@example.co.uk/p?tab=1';
    expect(sanitizeUrl(input, ['tab'], masker)).toBe('https://a.example/u/***@***/p?tab=1');
  });

  it('井号片段被丢弃（片段不进入上报 URL）', () => {
    expect(sanitizeUrl('https://a.example/p?tab=1#secret', ['tab'], masker)).toBe('https://a.example/p?tab=1');
  });

  it('结果长度被截断到 2048（AC 之外的 Schema 兜底）', () => {
    const long = `https://a.example/p?tab=${'a'.repeat(4000)}`;
    const output = sanitizeUrl(long, ['tab'], masker);
    expect(output.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(output.length).toBe(MAX_URL_LENGTH);
  });

  it('相对 URL 也能被处理（SSR/注入场景）', () => {
    expect(sanitizeUrl('/a/b?token=x&tab=1', ['tab'], masker)).toBe('/a/b?tab=1');
  });
});
