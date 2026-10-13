// @vitest-environment node
/**
 * C07-AC-19 的真实 gzip 往返。
 *
 * 这个文件固定跑在 **node** 环境（per-file docblock）：happy-dom 自己**没有**
 * 实现 `CompressionStream`，vitest 的 happy-dom 环境里能看到它只是因为 Node 全局
 * 泄漏进了测试全局——不能依赖。Node 24 内置 `CompressionStream`/`DecompressionStream`，
 * 因此这里用真实实现做往返验证；真实**浏览器**的压缩行为归 T29。
 */
import { describe, expect, test } from 'vitest';
import { createCompressor, shouldCompress } from './compress';

describe('C07-AC-19 真实 gzip', () => {
  test('CompressionStream 在 node 环境可用（前置事实）', () => {
    expect(typeof CompressionStream).toBe('function');
    expect(typeof DecompressionStream).toBe('function');
  });

  test('AC-19 压缩结果可被 DecompressionStream 还原为原 JSON', async () => {
    const compressor = createCompressor();
    expect(compressor.available()).toBe(true);
    const text = JSON.stringify({ events: Array.from({ length: 200 }, () => ({ id: 'x'.repeat(50) })) });
    expect(text.length).toBeGreaterThan(4 * 1024);
    const bytes = await compressor.compress(text);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThan(text.length);

    const restored = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(restored).toBe(text);
  });

  test('AC-19 阈值决策：3 KB 不压缩、6 KB 压缩', () => {
    const compressor = createCompressor();
    expect(shouldCompress('a'.repeat(3 * 1024), compressor)).toBe(false);
    expect(shouldCompress('a'.repeat(6 * 1024), compressor)).toBe(true);
  });

  test('AC-19 能力不可用（显式 null）时 available=false、compress 抛错', async () => {
    const compressor = createCompressor(null);
    expect(compressor.available()).toBe(false);
    await expect(compressor.compress('x')).rejects.toThrow('CompressionStream unavailable');
  });
});
