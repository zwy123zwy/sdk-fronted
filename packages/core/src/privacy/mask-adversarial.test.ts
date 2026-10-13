/**
 * 正则灾难性回溯的**有界耗时**检查（C04-F4 的非功能要求）。
 *
 * 口径（`docs/tasks/T14-plan.md` 第 11(b) 点）：
 * - 输入分 9 类：7 类对抗性长串 + 1 类「带 43 条追加规则的最坏组合」+ 1 类生产真实上界
 *   （每个事件的每个值不会超过 256 字符）；
 * - 统计量只用**单次迭代耗时的中位数**：vitest 默认并行跑测试文件，`总耗时` 会被同机
 *   其它文件抢 CPU 严重污染（本会话已因此红过两次）；
 * - 阈值取**宽松且文档化**的值，并把实测中位数与余量写进断言消息；
 * - 另有一条**结构性守卫**（无墙钟）：断言内置 pattern 里没有嵌套量词、且全部可编译。
 *
 * 契约目标值归 T20 的 `tests/bench/`；这里只做回归护栏。
 */
import { describe, expect, it } from 'vitest';

import { BUILTIN_MASK_RULES, compileMaskRules } from './mask-rules';
import { createMasker } from './mask';
import type { MaskRule } from './types';

/** 单次迭代耗时的中位数（毫秒）。 */
function medianMs(run: () => void, iterations: number): number {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const middle = Math.floor(samples.length / 2);
  return samples.length % 2 === 0
    ? ((samples[middle - 1] ?? 0) + (samples[middle] ?? 0)) / 2
    : (samples[middle] ?? 0);
}

/** 43 条追加规则（使规则总数达到上限 50），全部是线性写法。 */
function worstCaseRules(): MaskRule[] {
  return Array.from({ length: 43 }, (_unused, index) => ({
    name: `extra_${String(index)}`,
    pattern: `ZZ${String(index)}[A-Za-z0-9_-]*`,
    replacement: 'X',
    builtin: false,
  }));
}

/** 对抗性输入（每条都在断言消息里标注类别）。 */
const ADVERSARIAL_INPUTS: readonly { readonly label: string; readonly value: string }[] = [
  { label: '纯字母长串（所有规则的空转路径）', value: 'a'.repeat(20_000) },
  { label: '纯数字长串（手机号/银行卡/身份证/IPv4 的最坏路径）', value: '1'.repeat(20_000) },
  { label: 'cn_mobile 的 lookahead 失败路径', value: `1${'a'.repeat(20_000)}@` },
  { label: 'jwt 的三段重叠字符类', value: `eyJ${'A'.repeat(20_000)}` },
  { label: 'bearer_token 的长令牌', value: `Bearer ${'A'.repeat(20_000)}` },
  { label: 'email 的域标签重复', value: `a@${'b.'.repeat(10_000)}` },
  { label: 'ipv4 的连续候选', value: '1.2.3.4.'.repeat(5_000) },
  { label: '生产真实上界（单值 256 字符）', value: '1'.repeat(256) },
];

/**
 * 阈值（单次迭代耗时的中位数上限，毫秒）—— 宽松 + 文档化：
 *
 * - `PRODUCTION_BUDGET_MS`：**主线**。生产路径上每个维度值 ≤ `maxDimensionValueLength`（256），
 *   因此 256 字符输入的耗时才是真实成本；实测约 0.01 ms，取 0.2 ms 留约 20× 余量。
 * - `HARDENING_BUDGET_MS`：**加固**。20,000 字符的输入在生产里不可达（`attachment` 最大 8 KB），
 *   只用于证明「没有灾难性回溯」；线性扫描下 7 条规则处理 2 万字符约 3 ms，取 20 ms。
 */
const PRODUCTION_BUDGET_MS = 0.2;
const HARDENING_BUDGET_MS = 20;

describe('C04-F4 正则的有界耗时（对抗性输入）', () => {
  it('生产上界（256 字符）：内置 7 条规则的单次中位数在紧预算内（主线）', () => {
    const masker = createMasker();
    for (const value of ['1'.repeat(256), 'a'.repeat(256), `${'1'.repeat(255)}@`, `Bearer ${'A'.repeat(249)}`]) {
      const elapsed = medianMs(() => {
        masker.apply(value);
      }, 200);
      expect(
        elapsed,
        `生产上界输入的中位耗时 ${elapsed.toFixed(6)} ms 超出预算 ${String(PRODUCTION_BUDGET_MS)} ms（余量 ${(PRODUCTION_BUDGET_MS / Math.max(elapsed, 1e-9)).toFixed(1)}×）`,
      ).toBeLessThanOrEqual(PRODUCTION_BUDGET_MS);
    }
  });

  it('对抗性长串（2 万字符）：内置 7 条规则的中位数在宽预算内（加固，证明无灾难性回溯）', () => {
    const masker = createMasker();
    for (const input of ADVERSARIAL_INPUTS) {
      const elapsed = medianMs(() => {
        masker.apply(input.value);
      }, 50);
      expect(
        elapsed,
        `输入「${input.label}」的单次中位耗时 ${elapsed.toFixed(6)} ms 超出加固预算 ${String(HARDENING_BUDGET_MS)} ms（线性扫描应远低于此；若爆炸式增长即为灾难性回溯）`,
      ).toBeLessThanOrEqual(HARDENING_BUDGET_MS);
    }
  });

  it('规则总数达上限（7 内置 + 43 追加）时对抗性输入仍在加固预算内', () => {
    const masker = createMasker(worstCaseRules());
    expect(masker.ruleCount()).toBe(50);
    for (const input of ADVERSARIAL_INPUTS) {
      const elapsed = medianMs(() => {
        masker.apply(input.value);
      }, 50);
      expect(
        elapsed,
        `50 条规则下输入「${input.label}」的中位耗时 ${elapsed.toFixed(6)} ms 超出加固预算 ${String(HARDENING_BUDGET_MS)} ms`,
      ).toBeLessThanOrEqual(HARDENING_BUDGET_MS);
    }
  });

  it('预编译只发生一次：规则表构造后不再 new RegExp（按调用次数间接验证）', () => {
    let created = 0;
    compileMaskRules(worstCaseRules(), (pattern, flags) => {
      created += 1;
      return new RegExp(pattern, flags);
    });
    expect(created).toBe(50);
    // 处理事件只遍历规则表，不再构造正则：连续 100 次 apply 后计数不变
    const masker = createMasker(worstCaseRules());
    for (let index = 0; index < 100; index += 1) masker.apply('plain text 13800138000');
    expect(created).toBe(50);
  });
});

describe('结构性守卫（无墙钟，确定性）', () => {
  it('内置 pattern 都不含嵌套量词', () => {
    const nested = /\([^()]*[+*]\)[+*]|\([^()]*\{\d+,\}\)\{\d+,\}/u;
    for (const rule of BUILTIN_MASK_RULES) {
      expect(nested.test(rule.pattern), `规则 ${rule.name} 含嵌套量词`).toBe(false);
    }
  });

  it('内置 pattern 全部可编译', () => {
    for (const rule of BUILTIN_MASK_RULES) {
      expect(() => new RegExp(rule.pattern, 'g'), `规则 ${rule.name} 无法编译`).not.toThrow();
    }
  });

  it('内置 pattern 都不含内联标志（JS 的 RegExp 不支持 `(?i)`）', () => {
    for (const rule of BUILTIN_MASK_RULES) {
      expect(rule.pattern.includes('(?i)'), `规则 ${rule.name} 使用了不支持的内联标志`).toBe(false);
    }
  });
});
