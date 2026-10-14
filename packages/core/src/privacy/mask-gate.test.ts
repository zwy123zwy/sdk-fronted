/**
 * C04-F4 脱敏器的**语义不变对照**与前置门（性能优化）机制守卫。
 *
 * 背景（T20 基准 `tests/bench/c04-privacy.bench.ts`）：脱敏器对 256 字符（C04 的单值上界
 * `MAX_DIMENSION_VALUE_LENGTH`）的实测 P99 超契约目标 0.03 ms，根因是 7 条内置规则各做一次
 * 全串 `String.replace`（全串扫描 + 分配）。优化手段是给每条内置规则加**廉价前置门**：
 * 先按字符类别判「这条规则有没有可能命中」，不命中就跳过昂贵正则。
 *
 * 本文件的作用：
 * 1. **对照**：把「优化后（带前置门）的 `createMasker().apply`」与「无条件按序跑完所有规则的
 *    参考实现」在固定语料上逐条比较——前置门一旦漏判（该跑的正则被跳过），本文件必红；
 * 2. **机制守卫**：每条内置规则都必须带非零前置门（优化存在性，不依赖墙钟，可在单元门禁跑）；
 * 3. 固化既有语义：规则顺序、替换串、幂等、`extra_mask_rules` 的追加语义、内置规则不可整体关闭。
 *
 * 测试数据全部是**格式合法的伪造值**（示例域名、文档号段），不含真实个人信息。
 */
import { describe, expect, it } from 'vitest';

import { createMasker } from './mask';
import { compileMaskPlan, compileMaskRules } from './mask-rules';
import type { GatedCompiledMaskRule } from './mask-rules';
import type { MaskRule } from './types';

/** 伪造样例（与 `mask.test.ts` 同一套）。 */
const FAKE = {
  email: 'alice.smith+tag@example.co.uk',
  mobile: '13800138000',
  idCard: '11010119900307123X',
  bankCard: '6222021234567890123',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
  bearer: 'Bearer abcDEF123.-_',
  ipv4: '192.168.10.24',
} as const;

/**
 * 参考实现（= 优化前的行为）：按编译顺序，**无条件**对每条规则做一次 `String.replace`。
 * 这是语义基准，任何前置门都不得让它与 `createMasker()` 的输出产生差异。
 */
function referenceApply(text: string, extra: readonly MaskRule[] = []): string {
  let output = text;
  for (const rule of compileMaskRules(extra)) {
    output = output.replace(rule.regex, rule.replacement);
  }
  return output;
}

/** 读取前置门（0 = 无门 = 无条件运行）。`gate` 是内部字段，见 `GatedCompiledMaskRule`。 */
function gateOf(rule: GatedCompiledMaskRule): number {
  return rule.gate;
}

/** 确定性 PRNG（mulberry32），保证语料可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 语料 token：覆盖 7 条规则的触发字符与「只差一个字符」的近似触发。 */
const TOKENS: readonly string[] = [
  'a',
  'Z',
  '0',
  '1',
  '9',
  '@',
  '.',
  '-',
  '_',
  '/',
  ':',
  ' ',
  'eyJ',
  'ey',
  'J',
  'earer',
  'B',
  'b',
  'Bearer',
  'bearer',
  'BEARER',
  '***',
  'x'.repeat(64),
  FAKE.email,
  FAKE.mobile,
  FAKE.idCard,
  FAKE.bankCard,
  FAKE.jwt,
  FAKE.bearer,
  FAKE.ipv4,
];

/** 固定语料：所有 token 单条 + 固定种子的随机拼接。 */
function corpus(): readonly string[] {
  const values: string[] = [...TOKENS, '', 'plain text', 'a@b.com', '1'.repeat(17) + 'X'];
  const random = makeRandom(0x5eed);
  for (let index = 0; index < 600; index += 1) {
    const pieces: string[] = [];
    const length = Math.floor(random() * 8);
    for (let piece = 0; piece < length; piece += 1) {
      pieces.push(TOKENS[Math.floor(random() * TOKENS.length)] ?? '');
    }
    values.push(pieces.join(''));
  }
  return values;
}

const EXTRA_RULES: readonly MaskRule[] = [
  { name: 'order_id', pattern: 'ORD\\d{12}', replacement: '<<hidden>>', builtin: false },
  { name: 'tagged', pattern: 'tag_[a-z]+', flags: 'i', replacement: 'T', builtin: false },
];

describe('C04-F4 前置门与参考实现逐条等价（语义不变对照）', () => {
  it('内置 7 条规则下，带前置门的 apply 与无前置门的参考实现逐条一致', () => {
    const masker = createMasker();
    const mismatches: string[] = [];
    for (const value of corpus()) {
      const actual = masker.apply(value);
      const expected = referenceApply(value);
      if (actual !== expected) mismatches.push(`${JSON.stringify(value)}：${actual} !== ${expected}`);
    }
    expect(mismatches, `前置门改变了处理结果（共 ${String(mismatches.length)} 条）：\n${mismatches.slice(0, 5).join('\n')}`).toEqual(
      [],
    );
  });

  it('含追加规则时，带前置门的 apply 与参考实现逐条一致（追加规则不得被门跳过）', () => {
    const masker = createMasker(EXTRA_RULES);
    const mismatches: string[] = [];
    for (const value of corpus()) {
      const actual = masker.apply(value);
      const expected = referenceApply(value, EXTRA_RULES);
      if (actual !== expected) mismatches.push(`${JSON.stringify(value)}：${actual} !== ${expected}`);
    }
    expect(mismatches, `追加规则下的前置门差异（共 ${String(mismatches.length)} 条）`).toEqual([]);
  });

  it('脱敏是幂等的（apply(apply(x)) === apply(x)）', () => {
    const masker = createMasker(EXTRA_RULES);
    for (const value of corpus()) {
      const once = masker.apply(value);
      expect(masker.apply(once), `未幂等：${JSON.stringify(value)}`).toBe(once);
    }
  });

  it('每条内置规则都带非零前置门（优化机制守卫，不依赖墙钟）', () => {
    // 门是内部字段：从内部 `compileMaskPlan` 读，而不是从公共的 `CompiledMaskRule`。
    const compiled = compileMaskPlan([]);
    expect(compiled).toHaveLength(7);
    for (const rule of compiled) {
      expect(gateOf(rule), `内置规则 ${rule.name} 缺少前置门（性能优化未生效）`).toBeGreaterThan(0);
    }
  });

  it('追加规则没有前置门（语义未知，必须无条件运行）', () => {
    const compiled = compileMaskPlan(EXTRA_RULES);
    for (const rule of compiled) {
      if (!rule.builtin) expect(gateOf(rule), `追加规则 ${rule.name} 不应带前置门`).toBe(0);
    }
  });

  it('公共规则表与内部计划逐条同源（公共面只有规则本身，门是内部数据）', () => {
    // 「gate/added 不在公共类型里」由类型层与 `scripts/api-check.mjs` 的报告验证；
    // 这里验证公共 `compileMaskRules` 与内部 `compileMaskPlan` 产出逐条一致。
    const plan = compileMaskPlan(EXTRA_RULES);
    const publicRules = compileMaskRules(EXTRA_RULES);
    expect(publicRules).toHaveLength(plan.length);
    plan.forEach((rule, index) => {
      const publicRule = publicRules[index];
      expect(publicRule?.name).toBe(rule.name);
      expect(publicRule?.replacement).toBe(rule.replacement);
      expect(publicRule?.regex.source).toBe(rule.regex.source);
      expect(publicRule?.regex.flags).toBe(rule.regex.flags);
      expect(publicRule?.builtin).toBe(rule.builtin);
      expect(rule.gate).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('C04-F4 前置门不得改变既有语义（顺序 / 替换串 / 追加 / 不可关闭）', () => {
  it('同一文本里多条规则命中时按契约顺序（内置在前）替换', () => {
    const masker = createMasker(EXTRA_RULES);
    expect(masker.apply(`${FAKE.email} ${FAKE.mobile} ORD123456789012`)).toBe(
      '***@*** 1********** <<hidden>>',
    );
  });

  it('替换串与契约 5.4 表格逐字一致', () => {
    const masker = createMasker();
    expect(masker.apply(`c ${FAKE.email}`)).toBe('c ***@***');
    expect(masker.apply(`c ${FAKE.mobile}`)).toBe('c 1**********');
    expect(masker.apply(`c ${FAKE.idCard}`)).toBe('c ******************');
    expect(masker.apply(`c ${FAKE.bankCard}`)).toBe('c ****');
    expect(masker.apply(`c ${FAKE.jwt}`)).toBe('c ***');
    expect(masker.apply(`c ${FAKE.bearer}`)).toBe('c Bearer ***');
    expect(masker.apply(`c ${FAKE.ipv4}`)).toBe('c 0.0.0.0');
  });

  it('内置规则不可被整体关闭：空追加仍是 7 条且照常命中', () => {
    const masker = createMasker([]);
    expect(masker.ruleCount()).toBe(7);
    expect(masker.apply(FAKE.email)).toBe('***@***');
  });

  it('lookbehind/lookahead 边界语义不变（前后紧邻数字时不命中手机号）', () => {
    const masker = createMasker();
    expect(masker.apply(`x${FAKE.mobile}9`)).not.toContain('1**********');
    expect(masker.apply(`x${FAKE.mobile} `)).toContain('1**********');
  });
});
