/**
 * 端上脱敏（C04-F4）。
 *
 * 语义：**替换而非丢弃** —— 每条规则把命中片段替换为配置的替换串，事件继续发送；
 * 命中本身只计数（原因码见 `reason-codes.ts`）。
 *
 * 性能口径：规则表由 `compileMaskRules` 在配置到达时**预编译一次**；`apply()` 只做
 * `String.prototype.replace` 遍历，**不再 new RegExp**。预编译的 `g` 正则可安全跨事件复用：
 * `replace` 在返回前会把 `lastIndex` 复位为 0（含回调抛错的路径）。
 *
 * 用例见 `mask.test.ts`（AC-07/AC-08）与 `mask-adversarial.test.ts`（有界耗时）。
 */
import { compileMaskRules } from './mask-rules';
import type { CompiledMaskRule } from './mask-rules';
import type { MaskRule, Masker } from './types';

/** 创建脱敏器。规则表在创建时编译一次。 */
export function createMasker(rules: readonly MaskRule[] = []): Masker {
  const compiled: readonly CompiledMaskRule[] = compileMaskRules(rules);
  return {
    apply(text: string): string {
      let output = text;
      for (const rule of compiled) {
        output = output.replace(rule.regex, rule.replacement);
      }
      return output;
    },
    ruleCount(): number {
      return compiled.length;
    },
  };
}
