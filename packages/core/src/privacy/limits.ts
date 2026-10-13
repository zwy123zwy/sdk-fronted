/**
 * 长度工具（C04-F4 / F6）。
 *
 * 两条口径必须分清：
 * - **字符串长度按 UTF-16 码元**（`String.length`），与 `event-standard.md` 第 4 节一致，
 *   且截断复用 C01 已验证的 `truncate()`（不切断代理对）；
 * - **字节数按 UTF-8**（`utf8Bytes`），用于 `attachment` 的 8 KB 与单条事件体的 16 KB
 *   （口径由编排方 2026-10-13 裁定：不含批次头与 `common`）。
 *
 * 用例见 `limits.test.ts`（含 UTF-8 字节口径与代理对安全）。
 */
import { truncate } from '../api/values';

/**
 * UTF-8 字节数。
 *
 * 实现：ASCII 快速路径（每码元 1 字节）避免为纯 ASCII 文本分配编码器；
 * 含非 ASCII 时用 `TextEncoder`（标准内置，不引入依赖）。孤立的代理项会被编码为
 * U+FFFD（3 字节），这是 `TextEncoder` 的标准行为，也符合「不产生孤立代理项」的目标。
 */
export function utf8Bytes(text: string): number {
  let asciiBytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) {
      asciiBytes = -1;
      break;
    }
    asciiBytes += 1;
  }
  if (asciiBytes >= 0) return asciiBytes;
  const scope = globalThis as { TextEncoder?: new () => { encode(input?: string): Uint8Array } };
  const Encoder = scope.TextEncoder;
  if (Encoder !== undefined) return new Encoder().encode(text).length;
  // 无 TextEncoder 的极端环境：按 UTF-8 规则手工计数
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 按 UTF-16 码元截断且不切断代理对；复用 C01 的实现（`packages/core/src/api/values.ts`），
 * 保证 C01 的 Schema 兜底与 C04 的通用截断语义**完全一致**（幂等，不双重计数）。
 */
export function truncateUtf16Safe(text: string, maxLength: number): string {
  return truncate(text, maxLength);
}
