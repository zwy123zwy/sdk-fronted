/**
 * 第三处同类缺陷（C01 公共 API 侧）：`clampAndTrack` 的 dimensions 调用点
 * （log `message` 256；captureError `error_type` 128 / `message` 256 / `source` 32 /
 * `fingerprint` 64）**先截断、后脱敏**，跨界敏感值被切成不匹配规则的残片。
 *
 * 取证样本：`'a'.repeat(limit - 6) + FAKE_PHONE` —— 旧顺序下截断点落在手机号中间，
 * 残留 `138001`（6 位数字）这样的残片；新顺序先整体脱敏再截断，不残留。
 *
 * 本文件在修复前先写（旧顺序下断言级失败），修复后转绿。
 * 测试数据全部是格式合法的伪造值。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { createClient } from './index';

const FAKE_PHONE = '13800138000';

/** 跨界样本：截断点落在手机号中间（`limit + 5` 个码元）。 */
function straddling(limit: number): string {
  return `${'a'.repeat(limit - 6)}${FAKE_PHONE}`;
}

function setup() {
  const sink: KernelEvent[] = [];
  const client = createClient({ debug: false, onEvent: (event) => sink.push(event) });
  client.init({ appId: 'app-a', consent: 'granted' });
  return { client, sink };
}

function dimensionsOf(sink: KernelEvent[]): Record<string, string> {
  return (sink[0]?.['dimensions'] ?? {}) as Record<string, string>;
}

describe('C01 公共 API：dimensions 值不得先于脱敏被截断', () => {
  it('log 的 dimensions.message：跨界手机号被整体脱敏，不残留数字残片，长度上限仍为 256', () => {
    const { client, sink } = setup();
    client.log('error', straddling(256));

    const message = dimensionsOf(sink)['message'] ?? '';
    expect(message).toHaveLength(256);
    expect(message).not.toContain(FAKE_PHONE);
    expect(message, '残片（旧顺序下为 138001）不得存活').not.toMatch(/\d{4}/);
    client.destroy();
  });

  it('captureError 的 dimensions.message：跨界手机号被整体脱敏，长度上限仍为 256', () => {
    const { client, sink } = setup();
    client.captureError(new Error(straddling(256)));

    const message = dimensionsOf(sink)['message'] ?? '';
    expect(message).toHaveLength(256);
    expect(message).not.toContain(FAKE_PHONE);
    expect(message).not.toMatch(/\d{4}/);
    client.destroy();
  });

  it.each([
    ['error_type', 128],
    ['source', 32],
    ['fingerprint', 64],
  ] as const)('captureError 的 dimensions.%s：跨界手机号被整体脱敏，长度上限仍为 %i', (key, limit) => {
    const { client, sink } = setup();
    client.captureError(new Error('boom'), { dimensions: { [key]: straddling(limit) } });

    const value = dimensionsOf(sink)[key] ?? '';
    expect(value).toHaveLength(limit);
    expect(value).not.toContain(FAKE_PHONE);
    expect(value).not.toMatch(/\d{4}/);
    client.destroy();
  });
});
