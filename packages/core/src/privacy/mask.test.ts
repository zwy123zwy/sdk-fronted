/**
 * C04-AC-07 / C04-AC-08：内置脱敏规则与远程追加规则。
 *
 * AC-07 的「错误信息与维度中的伪造 PII 全部被掩码」既在本文件按字段覆盖，
 * 也有一条经公共 API 的端到端用例（`client-integration.test.ts`）。
 *
 * 测试数据全部是**格式合法的伪造值**（守则：样例不得使用真实个人信息）。
 *
 * 取证顺序：本文件在实现之后编写（补测）。
 */
import { describe, expect, it } from 'vitest';

import { compileMaskRules } from './mask-rules';
import { createMasker } from './mask';
import type { MaskRule } from './types';

/** 伪造样例（格式合法、非真实个人信息）。 */
const FAKE = {
  mobile: '13800138000',
  email: 'alice.smith+tag@example.co.uk',
  idCard: '11010119900307123X',
  bankCard: '6222021234567890123',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
  bearer: 'Bearer abcDEF123.-_',
  ipv4: '192.168.10.24',
} as const;

describe('C04-AC-07 内置脱敏规则的命中与替换', () => {
  const masker = createMasker();

  it('伪造邮箱被替换为 ***@***', () => {
    expect(masker.apply(`contact ${FAKE.email} now`)).toBe('contact ***@*** now');
  });

  it('伪造手机号被替换为 1**********（且不误伤更长的数字串）', () => {
    expect(masker.apply(`phone ${FAKE.mobile} end`)).toBe('phone 1********** end');
    // 边界：手机号前后紧邻数字时不应命中（lookbehind/lookahead 的作用）
    expect(masker.apply(`x${FAKE.mobile}9`)).not.toContain('1**********');
  });

  it('伪造身份证号被替换为 18 个星号（末位 X 也命中）', () => {
    expect(masker.apply(`id ${FAKE.idCard} end`)).toBe('id ****************** end');
  });

  it('伪造银行卡号（13–19 位连续数字）被替换为 ****', () => {
    expect(masker.apply(`card ${FAKE.bankCard} end`)).toBe('card **** end');
  });

  it('eyJ 开头的三段 JWT 被替换为 ***', () => {
    expect(masker.apply(`token ${FAKE.jwt} end`)).toBe('token *** end');
  });

  it('Bearer 令牌被替换为 Bearer ***（大小写均可）', () => {
    expect(masker.apply(`Authorization: ${FAKE.bearer}`)).toBe('Authorization: Bearer ***');
    expect(masker.apply('authorization: bearer abc123')).toBe('authorization: Bearer ***');
  });

  it('IPv4 被替换为 0.0.0.0', () => {
    expect(masker.apply(`from ${FAKE.ipv4} port`)).toBe('from 0.0.0.0 port');
  });

  it('一条文本里的多种 PII 同时被掩码（错误信息形态）', () => {
    const message = `submit failed for ${FAKE.mobile} / ${FAKE.email} / ${FAKE.idCard}`;
    expect(masker.apply(message)).toBe('submit failed for 1********** / ***@*** / ******************');
  });

  it('掩码不会把非 PII 的普通文本改掉', () => {
    const text = 'task_load_complete took 12 ms on /task/123';
    expect(masker.apply(text)).toBe(text);
  });
});

describe('C04-AC-09 内置规则不可被配置整体关闭（哨兵）', () => {
  /** 契约 5.4：内置项不可删除、不可关闭；远程只能追加。 */
  it('空追加规则时内置 7 条全部生效', () => {
    const masker = createMasker([]);
    expect(masker.ruleCount()).toBe(7);
    expect(masker.apply('a@b.com')).toBe('***@***');
  });

  it('追加规则试图「覆盖」内置 email 时，内置规则仍然生效且追加规则照样生效', () => {
    const masker = createMasker([
      { name: 'email_override', pattern: 'a@b\\.com', replacement: 'LEAKED', builtin: false },
    ]);
    expect(masker.ruleCount()).toBe(8);
    // 若内置 email 被跳过，下面的结果会是 'LEAKED'（或原样保留）——必须仍然是掩码形态
    expect(masker.apply('contact a@b.com now')).toBe('contact ***@*** now');
  });

  it('追加规则存在时内置规则不被跳过（顺序：内置在前）', () => {
    const masker = createMasker([{ name: 'order', pattern: 'ORD\\d{12}', replacement: 'X', builtin: false }]);
    expect(masker.ruleCount()).toBe(8);
    expect(masker.apply('mail a@b.com ORD123456789012')).toBe('mail ***@*** X');
  });

  it('同名追加规则不会替换内置规则（只追加）', () => {
    const masker = createMasker([{ name: 'email', pattern: 'ZZZ', replacement: 'Q', builtin: false }]);
    expect(masker.ruleCount()).toBe(8);
    expect(masker.apply('a@b.com')).toBe('***@***');
    expect(masker.apply('ZZZ')).toBe('Q');
  });
});

describe('C04-AC-08 远程追加的脱敏规则', () => {
  it('追加规则 ORD\\d{12} 命中后使用配置的 replacement', () => {
    const extra: MaskRule[] = [
      {
        name: 'order_id',
        pattern: 'ORD\\d{12}',
        replacement: '<<hidden>>',
        builtin: false,
      },
    ];
    const masker = createMasker(extra);
    expect(masker.apply('order ORD123456789012 ok')).toBe('order <<hidden>> ok');
  });

  it('未命中追加规则时文本保持不变', () => {
    const extra: MaskRule[] = [{ name: 'order_id', pattern: 'ORD\\d{12}', replacement: '<<hidden>>', builtin: false }];
    const masker = createMasker(extra);
    expect(masker.apply('order ORD123 ok')).toBe('order ORD123 ok');
  });

  it('追加规则与内置规则同时生效，且内置规则先执行', () => {
    const extra: MaskRule[] = [{ name: 'order_id', pattern: 'ORD\\d{12}', replacement: '<<hidden>>', builtin: false }];
    const masker = createMasker(extra);
    expect(masker.apply(`${FAKE.email} ORD123456789012`)).toBe('***@*** <<hidden>>');
  });

  it('追加规则缺省 replacement 时回退为 ***', () => {
    const masker = createMasker([{ name: 'order_id', pattern: 'ORD\\d{12}', builtin: false }]);
    expect(masker.apply('ORD123456789012')).toBe('***');
  });

  it('非法正则的追加规则被丢弃，其余规则仍然生效（不抛错）', () => {
    const extra: MaskRule[] = [
      { name: 'broken', pattern: '([', replacement: 'X', builtin: false },
      { name: 'order_id', pattern: 'ORD\\d{12}', replacement: '<<hidden>>', builtin: false },
    ];
    const masker = createMasker(extra);
    expect(masker.apply('ORD123456789012')).toBe('<<hidden>>');
    // 7 条内置 + 1 条合法追加（非法那条被丢弃）
    expect(masker.ruleCount()).toBe(8);
  });

  it('规则总数被 50 上限截断，且内置 7 条永远在最前', () => {
    const many: MaskRule[] = Array.from({ length: 60 }, (_unused, index) => ({
      name: `rule_${String(index)}`,
      pattern: `ZZZ${String(index)}`,
      replacement: 'X',
      builtin: false,
    }));
    const compiled = compileMaskRules(many);
    expect(compiled.length).toBe(50);
    expect(compiled.slice(0, 7).every((rule) => rule.builtin)).toBe(true);
  });

  it('flags 里已含 g 时不会出现重复标志（构造期不抛错）', () => {
    const masker = createMasker([{ name: 'tagged', pattern: 'ORD\\d{12}', flags: 'gi', replacement: 'X', builtin: false }]);
    expect(masker.apply('ord123456789012')).toBe('X');
  });
});
