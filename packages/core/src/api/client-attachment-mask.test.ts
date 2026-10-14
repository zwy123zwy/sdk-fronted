/**
 * 第二处同类缺陷（C01 公共 API 侧）：`clampAndTrack` 在**脱敏之前**把 attachment
 * 预截断到 8192 个 UTF-16 码元，跨界敏感值被切成不匹配任何规则的残片后原样上线。
 *
 * 取证样本：`'a'.repeat(8188) + '13800138000'`（8199 码元 > 8192）——
 * 旧顺序下截断发生在 index 8192，手机号只剩 `1380`，掩码规则 `1[3-9]\\d{9}` 不再命中，
 * 残片一路送到接收方。
 *
 * 本文件在修复前先写（旧顺序下断言级失败），修复后转绿。
 * 测试数据全部是格式合法的伪造值。
 */
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { createMasker } from '../privacy';
import { createClient, truncate } from './index';

/** 跨界样本：手机号正好被旧的 8192 码元预截断切开。 */
const STRADDLING = `${'a'.repeat(8188)}13800138000`;
const FAKE_PHONE = '13800138000';

function setup() {
  const sink: KernelEvent[] = [];
  const client = createClient({ debug: false, onEvent: (event) => sink.push(event) });
  client.init({ appId: 'app-a', consent: 'granted' });
  return { client, sink };
}

function attachmentOf(sink: KernelEvent[]): string {
  const value = sink[0]?.['attachment'];
  if (typeof value !== 'string') throw new Error('attachment 不是字符串');
  return value;
}

describe('C01 公共 API：attachment 不得先于脱敏被截断', () => {
  it('captureError：跨界手机号被整体脱敏，不残留 4 位数字残片', () => {
    const { client, sink } = setup();
    client.captureError(new Error('boom'), { attachment: STRADDLING });

    const attachment = attachmentOf(sink);
    expect(attachment).not.toContain(FAKE_PHONE);
    expect(attachment, '残片（旧顺序下为 1380）不得存活').not.toMatch(/\d{4}/);
    client.destroy();
  });

  it('log：跨界手机号被整体脱敏，不残留 4 位数字残片', () => {
    const { client, sink } = setup();
    client.log('error', 'boom', { attachment: STRADDLING });

    const attachment = attachmentOf(sink);
    expect(attachment).not.toContain(FAKE_PHONE);
    expect(attachment).not.toMatch(/\d{4}/);
    client.destroy();
  });

  it('captureError / log 的 attachment 仍受 8192 字节预算约束', () => {
    const { client, sink } = setup();
    client.captureError(new Error('boom'), { attachment: STRADDLING });
    expect(attachmentOf(sink).length).toBeLessThanOrEqual(8192);
    client.destroy();

    const second = setup();
    second.client.log('error', 'boom', { attachment: STRADDLING });
    expect(attachmentOf(second.sink).length).toBeLessThanOrEqual(8192);
    second.client.destroy();
  });

  it('未触截断的 attachment 同样经同一 masker 脱敏（回归）', () => {
    const { client, sink } = setup();
    client.captureError(new Error('boom'), { attachment: `phone ${FAKE_PHONE}` });

    const attachment = attachmentOf(sink);
    expect(attachment).not.toContain(FAKE_PHONE);
    expect(attachment).toContain('1**********');
    client.destroy();
  });

  it('超长路径上 masker 被施加两次（客户端收口 + 隐私处理器）不改变内置规则的结果', () => {
    const { client, sink } = setup();
    client.captureError(new Error('boom'), { attachment: STRADDLING });

    // 客户端先脱敏再截断，隐私处理器随后再脱敏一次；对内置规则两次施加与一次等价（幂等）。
    const expected = truncate(createMasker().apply(STRADDLING), 8192);
    expect(attachmentOf(sink)).toBe(expected);
    client.destroy();
  });
});
