/**
 * C04-AC-20：内置敏感请求头与内置脱敏规则清单，与 `remote-config.md` 5.4 逐项一致。
 *
 * 本文件刻意把契约清单**独立抄写成 fixture**（不从实现里读），这样实现的清单被改动时
 * 用例才会红 —— 若两边都从同一处读，改动就无人发现（T10「自证代替真证」的教训）。
 *
 * 另含编译期/运行期的**非空转对照**与 `mask.ts` 关于预编译 `g` 正则可跨事件复用的断言。
 *
 * 取证顺序（如实标注）：本文件在实现之后编写（补测），失败均标注为「补测」。
 */
import { describe, expect, it } from 'vitest';

import { createMasker } from './mask';
import { BUILTIN_MASK_RULES, BUILTIN_SENSITIVE_HEADERS, MASK_RULE_BUDGET } from './mask-rules';
import { MAX_EXTRA_MASK_RULES, MAX_MASK_RULES_TOTAL } from './constants';

/** 契约 `remote-config.md` 5.4 的内置敏感请求头（独立抄写；不区分大小写）。 */
const CONTRACT_SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-write-token',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
];

/** 契约 5.4 的内置脱敏规则：名称 + 匹配内容 + 替换串（独立抄写）。 */
const CONTRACT_MASK_RULES: readonly { name: string; replacement: string }[] = [
  { name: 'email', replacement: '***@***' },
  { name: 'cn_mobile', replacement: '1**********' },
  { name: 'cn_id_card', replacement: '******************' },
  { name: 'bank_card', replacement: '****' },
  { name: 'jwt', replacement: '***' },
  { name: 'bearer_token', replacement: 'Bearer ***' },
  { name: 'ipv4', replacement: '0.0.0.0' },
];

/**
 * 内置规则的 pattern 源串（独立抄写）。
 *
 * 用途：断言实现里的 pattern 逐字等于这里的字符串。这样「有人顺手放宽了某条规则」
 * （例如把 `{1,64}` 改成 `*`）会让本用例变红。
 */
const CONTRACT_PATTERNS: Readonly<Record<string, string>> = {
  email: '[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,4}\\.[A-Za-z]{2,24}',
  cn_mobile: '(?<!\\d)1[3-9]\\d{9}(?!\\d)',
  cn_id_card: '(?<!\\d)\\d{17}[\\dXx](?!\\d)',
  bank_card: '(?<!\\d)\\d{13,19}(?!\\d)',
  jwt: 'eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*',
  bearer_token: '[Bb]earer\\s+[A-Za-z0-9._~+/-]+=*',
  ipv4: '(?<!\\d)\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?!\\d)',
};

describe('C04-AC-20 内置清单与 remote-config.md 5.4 逐项一致', () => {
  it('内置敏感请求头与契约清单逐项一致（顺序与取值）', () => {
    expect([...BUILTIN_SENSITIVE_HEADERS]).toEqual([...CONTRACT_SENSITIVE_HEADERS]);
  });

  it('内置脱敏规则的名称与替换串逐项一致', () => {
    expect(BUILTIN_MASK_RULES.map((rule) => ({ name: rule.name, replacement: rule.replacement }))).toEqual([
      ...CONTRACT_MASK_RULES,
    ]);
  });

  it('内置脱敏规则的 pattern 源串逐字一致（防止被顺手放宽）', () => {
    for (const rule of BUILTIN_MASK_RULES) {
      expect(rule.pattern, `规则 ${rule.name} 的 pattern 与契约口径不符`).toBe(CONTRACT_PATTERNS[rule.name]);
    }
  });

  it('每条内置规则都有可执行的样本，且样本确实被掩码（非空转对照）', () => {
    const masker = createMasker();
    for (const rule of BUILTIN_MASK_RULES) {
      const masked = masker.apply(rule.sample);
      expect(masked, `规则 ${rule.name} 的样本未被掩码`).toBe(rule.sampleMasked);
      expect(masked, `规则 ${rule.name} 的样本掩码前后相同，等于没生效`).not.toBe(rule.sample);
    }
  });

  it('规则的书写顺序与契约表格一致（重叠命中时先到者生效）', () => {
    expect(BUILTIN_MASK_RULES.map((rule) => rule.name)).toEqual(CONTRACT_MASK_RULES.map((rule) => rule.name));
  });

  it('算术前提 7 + 40 ≤ 50 被固定住（防止以后改大内置规则数而无人发现）', () => {
    expect(MASK_RULE_BUDGET.builtin).toBe(7);
    expect(MASK_RULE_BUDGET.extra).toBe(MAX_EXTRA_MASK_RULES);
    expect(MASK_RULE_BUDGET.total).toBe(MAX_MASK_RULES_TOTAL);
    expect(
      MASK_RULE_BUDGET.builtin + MASK_RULE_BUDGET.extra,
      '内置规则数 + 追加上限必须 ≤ 总数上限（remote-config.md 5.4）',
    ).toBeLessThanOrEqual(MASK_RULE_BUDGET.total);
    // 同时把「运行时实际注册的内置条数」钉在 7：常量与实现漂移时本行会红。
    expect(BUILTIN_MASK_RULES.length).toBe(MASK_RULE_BUDGET.builtin);
  });

  it('内置规则里没有嵌套量词（结构性回溯守卫，无墙钟）', () => {
    // 启发式：`(…+)+`、`(…*)*`、`(…{n,}){m,}` 这类嵌套量词是灾难性回溯的主要来源。
    const nested = /\([^()]*[+*]\)[+*]|\([^()]*\{\d+,\}\)\{\d+,\}/u;
    for (const rule of BUILTIN_MASK_RULES) {
      expect(nested.test(rule.pattern), `规则 ${rule.name} 含嵌套量词：${rule.pattern}`).toBe(false);
    }
  });

  it('预编译的 g 正则可跨事件/跨次复用（replace 会复位 lastIndex）', () => {
    // 这个断言把 `mask.ts` 注释里的论断钉住：将来若有人把 replace 换成 exec/test，
    // 连续两次调用的结果会不一致，本用例立即变红。
    const masker = createMasker();
    const text = 'mail a@b.com then c@d.org';
    const first = masker.apply(text);
    const second = masker.apply(text);
    expect(first).toBe('mail ***@*** then ***@***');
    expect(second).toBe(first);

    // 更直接的一层：同一个规则对象连续 replace 两次，第二次必须仍然命中。
    const compiled = new RegExp('a', 'g');
    expect('a-a-a'.replace(compiled, 'X')).toBe('X-X-X');
    expect(compiled.lastIndex, 'replace 返回后 lastIndex 必须复位为 0').toBe(0);
    expect('a-a-a'.replace(compiled, 'X')).toBe('X-X-X');
  });
});
