/**
 * 端上脱敏（C04-F4）。
 *
 * 语义：**替换而非丢弃** —— 每条规则把命中片段替换为配置的替换串，事件继续发送；
 * 命中本身只计数（原因码见 `reason-codes.ts`）。
 *
 * 性能口径：规则表由 `compileMaskPlan` 在配置到达时**预编译一次**；`apply()` 只做
 * `String.prototype.replace` 遍历，**不再 new RegExp**。预编译的 `g` 正则可安全跨事件复用：
 * `replace` 在返回前会把 `lastIndex` 复位为 0（含回调抛错的路径）。
 *
 * 前置门（性能）：7 条内置规则对同一文本各做一次全串 `replace`（全串扫描 + 分配），
 * 在 C04 允许的单值上界 256 字符上是热路径的主要成本（T20 实测 P99 超 0.03 ms 契约目标）。
 * 因此先对文本做**一趟**特征扫描（`scanMaskFeatures`），再按每条内置规则所需的特征位
 * 判「这条规则有没有可能命中」：判否即跳过该正则。门只做**必要条件**判断，判是仍由正则
 * 决定命中，因此命中集合、替换串与规则顺序都与优化前逐字一致（对照见 `mask-gate.test.ts`）。
 *
 * 门的正确性依赖「已见特征 ⊇ 当前文本特征」：命中片段被**非空**替换串取代，替换串引入的
 * 特征位由每条规则的 `added` 在命中后并入，因此不会出现「前面的替换让后面的门误判为否」。
 * 追加规则没有门（`gate === 0`），无条件运行。
 *
 * `gate` / `added` **不在公共 `CompiledMaskRule` 里**——它们是本优化的实现细节，不是脱敏器
 * 对外语义（否则换一种优化就成了破坏性变更）。本文件用内部类型 `GatedCompiledMaskRule`
 * 读取门信息：不需要 `as`，也不污染公共类型；改优化方式只需改 `mask-rules.ts` 的内部类型。
 *
 * 用例见 `mask.test.ts`（AC-07/AC-08）与 `mask-adversarial.test.ts`（有界耗时）。
 */
import { compileMaskPlan, scanMaskFeatures } from './mask-rules';
import type { MaskRule, Masker } from './types';

/**
 * 前置门判定：规则所需的特征位在当前文本上全部出现才运行其正则。
 *
 * `gate === 0` 表示无门（追加规则），必须运行。
 * **变异验证点**：把本函数改成 `return true` 即退化为优化前的行为（基准应回到超标）。
 */
function gatePasses(gate: number, features: number): boolean {
  return gate === 0 || (features & gate) === gate;
}

/** 创建脱敏器。规则表在创建时编译一次。 */
export function createMasker(rules: readonly MaskRule[] = []): Masker {
  // 内部类型：带 `gate` / `added`（公共 `CompiledMaskRule` 里没有这两个字段）。
  const compiled = compileMaskPlan(rules);
  return {
    apply(text: string): string {
      if (compiled.length === 0) return text;
      let output = text;
      let features = scanMaskFeatures(text);
      for (const rule of compiled) {
        if (!gatePasses(rule.gate, features)) continue;
        const next = output.replace(rule.regex, rule.replacement);
        if (next !== output) {
          features |= rule.added;
          output = next;
        }
      }
      return output;
    },
    ruleCount(): number {
      return compiled.length;
    },
  };
}
