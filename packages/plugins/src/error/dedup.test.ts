/**
 * C05-AC-03：同一错误 1 秒内抛出 100 次 → 按 `fingerprint` 去重，
 * 上报次数受控，`metrics.count` 记录总次数，并计数 `filtered_by_plugin`。
 *
 * 本文件验证**去重与计数原语**（`createDeduplicator`）的窗口语义；
 * 端到端的「100 次 → 一条 count=100 的事件 + filtered_by_plugin」在 `capture.test.ts`。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEDUP_WINDOW_MS,
  createDeduplicator,
  normalizeError,
  normalizeMessage,
} from './index';

describe('C05-AC-03 同指纹去重且 count 记总次数（窗口聚合）', () => {
  it('缺省窗口为 1000 ms（与 AC 的「1 秒内」一致）', () => {
    expect(DEFAULT_DEDUP_WINDOW_MS).toBe(1000);
  });

  it('同一指纹 100 次只开启一个窗口，结算时 count 为 100', () => {
    const dedup = createDeduplicator<string>();
    let started = 0;
    for (let index = 0; index < 100; index += 1) {
      if (dedup.observe('fingerprint-a', 'payload', 1_700_000_000_000 + index).started) {
        started += 1;
      }
    }
    expect(started, '同一指纹只应开启一次窗口').toBe(1);
    expect(dedup.count('fingerprint-a'), 'count 记录窗口内总次数').toBe(100);

    const settled = dedup.take('fingerprint-a');
    expect(settled?.count).toBe(100);
    expect(settled?.payload).toBe('payload');
    expect(dedup.count('fingerprint-a'), '结算后窗口清空').toBe(0);
  });

  it('判别力对照：100 个**不同**指纹必须开启 100 个窗口（证明去重不是一律压制）', () => {
    const dedup = createDeduplicator<string>();
    let started = 0;
    for (let index = 0; index < 100; index += 1) {
      if (dedup.observe(`fingerprint-${String(index)}`, 'payload', 1_700_000_000_000).started) {
        started += 1;
      }
    }
    expect(started).toBe(100);
    expect(dedup.size()).toBe(100);
  });

  it('窗口未到期不结算，到期后 due 才包含该指纹', () => {
    const dedup = createDeduplicator<string>({ windowMs: 1000 });
    const start = 1_700_000_000_000;
    dedup.observe('fp', 'payload', start);
    expect(dedup.due(start + 999), '未满 1 秒不得结算').toEqual([]);
    expect(dedup.due(start + 1000), '满 1 秒必须到期').toEqual(['fp']);
  });

  it('takeAll 按首次出现时间升序结算全部未到期窗口', () => {
    const dedup = createDeduplicator<string>();
    dedup.observe('second', 'b', 200);
    dedup.observe('first', 'a', 100);
    dedup.observe('second', 'b', 201);
    const settled = dedup.takeAll();
    expect(settled.map((entry) => entry.fingerprint)).toEqual(['first', 'second']);
    expect(settled[1]?.count).toBe(2);
  });
});

describe('C05-AC-03 指纹稳定（去重的前提）', () => {
  it('同一错误两次归一化得到同一 fingerprint，且不含易变部分', () => {
    const first = normalizeError({
      message: 'TypeError: request 12345 failed at https://api.example.com/v1/task?id=999',
      source: 'window_error',
      errorType: 'TypeError',
      line: 12,
      column: 5,
    });
    const second = normalizeError({
      message: 'TypeError: request 67890 failed at https://api.example.com/v1/task?id=111',
      source: 'window_error',
      errorType: 'TypeError',
      line: 12,
      column: 5,
    });
    expect(first.dimensions.fingerprint).toBe(second.dimensions.fingerprint);
    expect(first.dimensions.fingerprint.length).toBeGreaterThan(0);

    // 归一化必须剥离数字与 URL 查询参数
    expect(normalizeMessage('request 12345 failed?id=999')).not.toContain('12345');
    expect(normalizeMessage('request 12345 failed?id=999')).not.toContain('999');
  });

  it('不同 error_type / source / 行号得到不同指纹（判别力：不是恒定值）', () => {
    const base = { message: 'boom', source: 'window_error', errorType: 'TypeError' } as const;
    const a = normalizeError({ ...base, line: 1 }).dimensions.fingerprint;
    const b = normalizeError({ ...base, line: 2 }).dimensions.fingerprint;
    const c = normalizeError({ ...base, errorType: 'RangeError', line: 1 }).dimensions.fingerprint;
    const d = normalizeError({ ...base, source: 'unhandled_rejection', line: 1 }).dimensions.fingerprint;
    expect(new Set([a, b, c, d]).size, '四个不同输入的指纹必须互不相同').toBe(4);
  });
});
