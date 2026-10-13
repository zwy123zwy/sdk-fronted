/**
 * C08-AC-01 的映射口径与契约同步守卫。
 *
 * `monitor/reason-codes.ts` 里的第 1/2 节原因码清单是硬编码的；本用例把它与
 * **机器可读的权威** `docs/contracts/schemas/builtin-events/sdk_health.schema.json`
 * 的两个 `patternProperties` 做集合与顺序的双向比对。任一侧漂移（例如
 * CR-001 新增 `prewrite_commit_lost`、或后续新增原因码忘了同步）都会立刻失败。
 */
import { describe, expect, test } from 'vitest';
import sdkHealthSchema from '../../../../docs/contracts/schemas/builtin-events/sdk_health.schema.json';
import { COUNT_REASON_CODES, DROP_REASON_CODES } from './reason-codes';

/** 从 Schema 的 metrics.patternProperties 里取出 `^<prefix>(...)$` 模式。 */
function patternOf(prefix: 'drop_' | 'count_'): string {
  const patterns = Object.keys(sdkHealthSchema.properties.metrics.patternProperties);
  const found = patterns.find((pattern) => pattern.startsWith(`^${prefix}`));
  if (found === undefined) {
    throw new Error(`Schema 缺少 ^${prefix} 的 patternProperties`);
  }
  return found;
}

/** 拆出 `^drop_(a|b|c)$` 里的原因码并按 Schema 顺序返回。 */
function alternativesOf(pattern: string, prefix: 'drop_' | 'count_'): readonly string[] {
  const head = `^${prefix}(`;
  expect(pattern.startsWith(head), pattern).toBe(true);
  expect(pattern.endsWith(')$'), pattern).toBe(true);
  return pattern.slice(head.length, -2).split('|');
}

describe('原因码清单与冻结 Schema 同步（C08-F1）', () => {
  test('drop_ 清单与 Schema 的 patternProperties 完全一致（含顺序）', () => {
    expect(alternativesOf(patternOf('drop_'), 'drop_')).toEqual([...DROP_REASON_CODES]);
  });

  test('count_ 清单与 Schema 的 patternProperties 完全一致（含顺序）', () => {
    expect(alternativesOf(patternOf('count_'), 'count_')).toEqual([...COUNT_REASON_CODES]);
  });

  test('CR-001 的 prewrite_commit_lost 在第 1 节清单内', () => {
    expect(DROP_REASON_CODES).toContain('prewrite_commit_lost');
  });

  test('全部合成指标键满足 fieldKey 格式且不超过 64 字符', () => {
    const keys = [
      ...DROP_REASON_CODES.map((code) => `drop_${code}`),
      ...COUNT_REASON_CODES.map((code) => `count_${code}`),
    ];
    for (const key of keys) {
      expect(key, key).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
      expect(key.length, key).toBeLessThanOrEqual(64);
    }
  });

  test('第 1/2 节清单内部没有重复项，且互不重叠', () => {
    expect(new Set(DROP_REASON_CODES).size).toBe(DROP_REASON_CODES.length);
    expect(new Set(COUNT_REASON_CODES).size).toBe(COUNT_REASON_CODES.length);
    const countCodes = new Set<string>(COUNT_REASON_CODES);
    const overlap = DROP_REASON_CODES.filter((code) => countCodes.has(code));
    expect(overlap).toEqual([]);
  });
});
