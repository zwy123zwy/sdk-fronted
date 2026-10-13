/**
 * 事件级采样规则（T13，C03-F4）。
 *
 * 契约 `remote-config.md` 5.2 / `remote-config.schema.json#$defs/sampling`：
 * 按顺序匹配、第一条命中生效；`event_name` 精确或以 `*` 结尾的前缀；
 * `rate: 0` 表示禁用；最终 `sample_rate` = 会话采样率 × 命中规则采样率。
 */
import type { SamplingRule } from '../config/types';
import type { RuleOutcome, SamplingEvent } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 规则是否命中事件。`match` 里给出的每个条件都必须满足。 */
export function ruleMatches(rule: SamplingRule, event: SamplingEvent): boolean {
  const match = rule.match;

  if (match.event_type !== undefined && event['event_type'] !== match.event_type) return false;

  if (match.event_name !== undefined) {
    const pattern = match.event_name;
    const name = event.event_name;
    if (pattern.endsWith('*')) {
      if (!name.startsWith(pattern.slice(0, -1))) return false;
    } else if (name !== pattern) {
      return false;
    }
  }

  if (match.dimension !== undefined) {
    const dimensions = event['dimensions'];
    if (!isRecord(dimensions) || dimensions[match.dimension.key] !== match.dimension.equals) return false;
  }

  return true;
}

/** 按顺序取第一条命中的规则；无命中时返回 `{ matched: false, rate: 1, index: -1 }`。 */
export function matchFirstRule(rules: readonly SamplingRule[], event: SamplingEvent): RuleOutcome {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule === undefined) continue;
    if (ruleMatches(rule, event)) return { matched: true, rate: rule.rate, index };
  }
  return { matched: false, rate: 1, index: -1 };
}

/** 计算最终 `sample_rate`（会话率 × 规则率）。 */
export function combineSampleRate(sessionRate: number, ruleRate: number): number {
  return sessionRate * ruleRate;
}
