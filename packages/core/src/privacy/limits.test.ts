/**
 * 长度口径与代理对安全（C04-F6 的支撑工具；C04-AC-14 的底层保证）。
 *
 * 两条口径必须分清（`event-standard.md` 第 4 节 + 编排方 2026-10-13 的 16 KB 裁定）：
 * - 字符串长度按 **UTF-16 码元**（`String.length`），截断不得切断代理对；
 * - 字节数按 **UTF-8**（`attachment` 的 8 KB 与单条事件体的 16 KB）。
 *
 * 取证顺序：`truncateUtf16Safe` 的用例是「实现后补测」；`utf8Bytes` 的准确语义用例
 * 在**实现前先写**（当时的 `utf8Bytes` 是按码元近似的桩，这些用例因此红过）。
 */
import { describe, expect, it } from 'vitest';

import { truncateUtf16Safe, utf8Bytes } from './limits';

/** 判断字符串里是否含孤立代理项（AC-14 的核心断言）。 */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe('truncateUtf16Safe（按 UTF-16 码元截断、不切断代理对）', () => {
  it('未超长时原样返回', () => {
    expect(truncateUtf16Safe('abc', 3)).toBe('abc');
    expect(truncateUtf16Safe('abc', 10)).toBe('abc');
  });

  it('纯 ASCII 超长时按码元截断', () => {
    expect(truncateUtf16Safe('abcdef', 4)).toBe('abcd');
  });

  it('截断位置落在代理对中间时不产生孤立代理项（AC-14）', () => {
    // 255 个 'a' + 1 个 emoji（2 个码元）→ 上限 256 会把 emoji 切成一半
    const value = `${'a'.repeat(255)}😀`;
    expect(value.length).toBe(257);
    const cut = truncateUtf16Safe(value, 256);
    expect(cut.length).toBe(255);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(hasLoneSurrogate(value)).toBe(false);
  });

  it('上限正好落在代理对之后时保留整个 emoji', () => {
    const value = `${'a'.repeat(254)}😀`;
    const cut = truncateUtf16Safe(value, 256);
    expect(cut).toBe(value);
    expect(hasLoneSurrogate(cut)).toBe(false);
  });

  it('全是 emoji 时也不会切断', () => {
    const value = '😀'.repeat(10); // 20 个码元
    const cut = truncateUtf16Safe(value, 5);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut).toBe('😀😀');
  });
});

describe('utf8Bytes（UTF-8 字节数；8 KB / 16 KB 的口径基础）', () => {
  it('ASCII 字符 1 字节', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('')).toBe(0);
  });

  it('中文按 3 字节计（不是 1 个码元）', () => {
    expect(utf8Bytes('中')).toBe(3);
    expect(utf8Bytes('中文')).toBe(6);
  });

  it('emoji（代理对）按 4 字节计', () => {
    expect(utf8Bytes('😀')).toBe(4);
  });

  it('混合文本的字节数等于各部分之和', () => {
    expect(utf8Bytes('a中😀')).toBe(1 + 3 + 4);
  });

  it('码元数不同的两条字符串，字节数也不同（证明不是按 String.length 计的近似）', () => {
    expect(utf8Bytes('中')).not.toBe('中'.length);
    expect(utf8Bytes('中')).toBe(3);
  });
});
