/**
 * C08-AC-07 的「可测量定义」：自监控流量占业务流量的比例。
 *
 * 体积口径与 C06 的体积估算约定一致（按 UTF-16 码元的 JSON 长度），
 * 不涉及任何墙钟。计数口径是「窗口内 sdk_health 事件数 / 业务事件数」。
 */
import { describe, expect, test } from 'vitest';
import { jsonSize, measureTrafficShare } from './traffic';

describe('measureTrafficShare', () => {
  test('jsonSize 按 JSON 的 UTF-16 码元长度计', () => {
    expect(jsonSize({ a: 1 })).toBe(7);
    expect(jsonSize('ab')).toBe(4);
    expect(jsonSize(undefined)).toBe(0);
  });

  test('计数比与体积比', () => {
    const share = measureTrafficShare([{ a: 1 }], [{ b: 2 }, { c: 3 }]);
    expect(share.healthEvents).toBe(1);
    expect(share.businessEvents).toBe(2);
    expect(share.countRatio).toBe(0.5);
    expect(share.byteRatio).toBeCloseTo(0.5);
  });

  test('业务流量为空时的比值：无流量记 0，有自监控记 Infinity', () => {
    expect(measureTrafficShare([], []).countRatio).toBe(0);
    expect(measureTrafficShare([], []).byteRatio).toBe(0);
    expect(measureTrafficShare([{ a: 1 }], []).countRatio).toBe(Number.POSITIVE_INFINITY);
    expect(measureTrafficShare([{ a: 1 }], []).byteRatio).toBe(Number.POSITIVE_INFINITY);
  });
});
