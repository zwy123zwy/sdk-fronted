/**
 * C07-F8 压缩：只有「序列化后超过 4 KB 且浏览器支持 `CompressionStream`」时才 gzip。
 *
 * 能力探测注入化（`CompressorPort`），因此"支持/不支持"两条分支都能确定性测试，
 * **不依赖运行环境里恰好存在该全局**（happy-dom 没有 `CompressionStream`，
 * vitest 的 happy-dom 环境里能看到它只是因为 Node 全局泄漏）。
 */
import { COMPRESS_THRESHOLD_BYTES } from './constants';
import type { CompressorPort } from './types';

type CompressionStreamCtor = new (format: string) => ReadableWritablePair<Uint8Array, BufferSource>;

function resolveCtor(
  explicit: CompressionStreamCtor | null | undefined,
): CompressionStreamCtor | null {
  if (explicit === null) return null;
  if (explicit !== undefined) return explicit;
  const candidate = (globalThis as { CompressionStream?: CompressionStreamCtor | undefined })
    .CompressionStream;
  return candidate ?? null;
}

/** 创建压缩器；`explicit` 传 `null` 表示强制不可用（测试"不支持"分支）。 */
export function createCompressor(explicit?: CompressionStreamCtor | null): CompressorPort {
  return {
    available(): boolean {
      return resolveCtor(explicit) !== null;
    },

    async compress(text: string): Promise<Uint8Array<ArrayBuffer>> {
      const ctor = resolveCtor(explicit);
      if (ctor === null) throw new Error('CompressionStream unavailable');
      const stream = new Blob([text]).stream().pipeThrough(new ctor('gzip'));
      const buffer = await new Response(stream).arrayBuffer();
      return new Uint8Array(buffer);
    },
  };
}

/** 是否需要压缩（契约：序列化后 > 4 KB 且能力可用）。 */
export function shouldCompress(body: string, compressor: CompressorPort): boolean {
  if (body.length <= COMPRESS_THRESHOLD_BYTES) return false;
  return compressor.available();
}
