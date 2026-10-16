/**
 * 正则灾难性回溯的**有界耗时**检查（C04-F4 的非功能要求）。
 *
 * 口径（`docs/tasks/T14-plan.md` 第 11(b) 点）：
 * - 输入分 9 类：7 类对抗性长串 + 1 类「带 43 条追加规则的最坏组合」+ 1 类生产真实上界
 *   （每个事件的每个值不会超过 256 字符）；
 * - 统计量用**单次迭代的 CPU 时间**（`process.cpuUsage`，见 `cpuMsPerCall`）：vitest 默认并行
 *   跑测试文件，**墙钟**会被同机其它文件抢 CPU 严重污染（本会话已因此红过两次；2026-10-16 实测
 *   双套件并行时同一输入墙钟中位数 23–32 ms，而 CPU 时间稳定在 7.5–8.3 ms）；
 * - 阈值取**宽松且文档化**的值，并把实测耗时与余量写进断言消息；
 * - 另有一条**结构性守卫**（无墙钟）：断言内置 pattern 里没有嵌套量词、且全部可编译。
 *
 * 契约目标值归 T20 的 `tests/bench/`；这里只做回归护栏。
 */
import { describe, expect, it } from 'vitest';

import { BUILTIN_MASK_RULES, compileMaskRules } from './mask-rules';
import { createMasker } from './mask';
import type { MaskRule } from './types';

/** 进程累计的 CPU 时间（微秒）。 */
interface CpuUsage {
  readonly user: number;
  readonly system: number;
}

/**
 * Node 全局能力的最小声明：`packages/core/tsconfig.json` 的 `types` 为空（本包零运行时依赖），
 * 所以这里只声明测试真正用到的那一个 Node 能力，不做 `any` 转换、不关闭任何检查。
 */
declare const process: {
  /** 传入起点时返回相对起点的增量。 */
  cpuUsage(start?: CpuUsage): CpuUsage;
};

/**
 * 单次迭代的 **CPU 时间**（毫秒）—— 不读墙钟。
 *
 * 为什么必须换成 CPU 时间（2026-10-16 实测）：`unit` project 共 145 个文件，10 核机上
 * `pnpm test` 跑到约 6× 超订（user 58 s / wall 9.5 s），此时**墙钟度量的已经不是代码，
 * 而是「被抢占多久」**。同一份对抗性输入（email 域标签重复）：
 *
 * | 度量 | 空闲 | 单套件并行 | 双套件并行 |
 * | --- | --- | --- | --- |
 * | 墙钟中位数 | 3.1 ms | 10–23 ms | 23–32 ms（4/4 红） |
 * | CPU 时间 | 3.1 ms | 7.5–8.3 ms | 7.5–8.3 ms（稳定） |
 *
 * 被抢占的等待时间只加在墙钟上，不加在 CPU 时间上；而「无灾难性回溯」是关于**计算量**的
 * 命题，CPU 时间才是它的正确度量。阈值与迭代次数都保持不变（没有放宽任何判据）。
 *
 * 统计量用**块内求和再平均**而不是中位数：CPU 时间可加，整块求和能把
 * `process.cpuUsage` 的 µs 级分辨率误差摊平；中位数在并行抢占下会被整体抬高。
 */
function cpuMsPerCall(run: () => void, iterations: number): number {
  const start = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) run();
  const delta = process.cpuUsage(start);
  return (delta.user + delta.system) / 1000 / iterations;
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
 * 阈值（单次迭代的 **CPU 时间** 上限，毫秒）—— 宽松 + 文档化：
 *
 * - `PRODUCTION_BUDGET_MS`：**主线**。生产路径上每个维度值 ≤ `maxDimensionValueLength`（256），
 *   因此 256 字符输入的耗时才是真实成本；实测 0.006 ms（空闲）～0.020 ms（双套件并行），
 *   取 0.2 ms 留 ≥ 10× 余量。
 * - `HARDENING_BUDGET_MS`：**加固**。20,000 字符的输入在生产里不可达（`attachment` 最大 8 KB），
 *   只用于证明「没有灾难性回溯」；实测最贵的两条输入（email 域标签重复、cn_mobile 失败路径）
 *   在 50 条规则下 CPU 时间 3.1 ms（空闲）～8.3 ms（双套件并行），取 20 ms 留 2.4× 余量。
 *   **注意**：这个余量是对「CPU 时间」成立的；并行超订只会抬高墙钟，因此不能用墙钟判据
 *   （见 `cpuMsPerCall` 的实测表）。
 */
const PRODUCTION_BUDGET_MS = 0.2;
const HARDENING_BUDGET_MS = 20;

describe('C04-F4 正则的有界耗时（对抗性输入）', () => {
  it('生产上界（256 字符）：内置 7 条规则的单次 CPU 耗时在紧预算内（主线）', () => {
    const masker = createMasker();
    for (const value of ['1'.repeat(256), 'a'.repeat(256), `${'1'.repeat(255)}@`, `Bearer ${'A'.repeat(249)}`]) {
      // 2000 次迭代让整块的 CPU 时间达到约 12 ms，远高于 `process.cpuUsage` 的分辨率
      const elapsed = cpuMsPerCall(() => {
        masker.apply(value);
      }, 2000);
      expect(
        elapsed,
        `生产上界输入的单次 CPU 耗时 ${elapsed.toFixed(6)} ms 超出预算 ${String(PRODUCTION_BUDGET_MS)} ms（余量 ${(PRODUCTION_BUDGET_MS / Math.max(elapsed, 1e-9)).toFixed(1)}×）`,
      ).toBeLessThanOrEqual(PRODUCTION_BUDGET_MS);
    }
  });

  it('对抗性长串（2 万字符）：内置 7 条规则的单次 CPU 耗时在宽预算内（加固，证明无灾难性回溯）', () => {
    const masker = createMasker();
    for (const input of ADVERSARIAL_INPUTS) {
      // 15 次迭代：整块 CPU 时间约 105 ms（最贵输入约 7 ms/次），远高于 `process.cpuUsage` 的分辨率。
      // 迭代数不能大：本用例自身的 CPU 工作量在 8–20× 超订下会被放大成墙钟——
      // 50 次迭代（约 350 ms CPU）在实测 `loadavg` 65 时撞上 vitest 的 5 s 默认超时
      // （`Error: Test timed out in 5000ms`），那是**另一个**失败面、与断言无关；
      // 这里靠减少用例自身的工作量解决，而不是调大超时或放宽预算。
      const elapsed = cpuMsPerCall(() => {
        masker.apply(input.value);
      }, 15);
      expect(
        elapsed,
        `输入「${input.label}」的单次 CPU 耗时 ${elapsed.toFixed(6)} ms 超出加固预算 ${String(HARDENING_BUDGET_MS)} ms（线性扫描应远低于此；若爆炸式增长即为灾难性回溯）`,
      ).toBeLessThanOrEqual(HARDENING_BUDGET_MS);
    }
  });

  it('规则总数达上限（7 内置 + 43 追加）时对抗性输入仍在加固预算内', () => {
    const masker = createMasker(worstCaseRules());
    expect(masker.ruleCount()).toBe(50);
    for (const input of ADVERSARIAL_INPUTS) {
      // 同上：15 次迭代（整块约 110 ms CPU），避免在超订下撞 5 s 默认超时
      const elapsed = cpuMsPerCall(() => {
        masker.apply(input.value);
      }, 15);
      expect(
        elapsed,
        `50 条规则下输入「${input.label}」的单次 CPU 耗时 ${elapsed.toFixed(6)} ms 超出加固预算 ${String(HARDENING_BUDGET_MS)} ms`,
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
