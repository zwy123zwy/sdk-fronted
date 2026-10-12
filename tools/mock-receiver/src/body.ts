/**
 * 请求体读取与流式解压（RR-04、M01-AC-04）。
 *
 * - 压缩后超过 256 KB 直接 413，不做完解压。
 * - gzip 流式解压，累计解压量达到 1 MB 立即销毁流并返回 413（防 gzip 炸弹）。
 * - `br` 等其他编码返回 `unsupported_encoding`（400）。
 */
import type { IncomingMessage } from 'node:http';
import { createGunzip } from 'node:zlib';
import { MAX_COMPRESSED_BYTES, MAX_DECOMPRESSED_BYTES } from './validate.js';

export interface ReadBodyOptions {
  /** 压缩后上限（默认 256 KB，仅 gzip 使用）。 */
  maxCompressedBytes?: number;
  /** 解压后上限（默认 1 MB）。 */
  maxDecompressedBytes?: number;
  /** 未压缩请求体的上限（默认取解压后上限）。 */
  maxRawBytes?: number;
  /**
   * 超限时是否销毁请求流。服务端建议保留默认值 false：
   * 直接销毁会让还在发送的客户端收到 ECONNRESET，拿不到 413 响应。
   */
  destroyOnExceed?: boolean;
  /** 每次解压量变化时回调，用于测试断言中止位置。 */
  onDecompressed?: (bytes: number) => void;
}

export type ReadBodyFailure = {
  ok: false;
  status: 400 | 413;
  error: 'invalid_json' | 'payload_too_large' | 'unsupported_encoding';
  message: string;
};

export type ReadBodyResult = { ok: true; text: string; bytes: number } | ReadBodyFailure;

/** 读取请求体。`encoding` 为 `content-encoding` 请求头的原始值。 */
export function readBody(
  stream: IncomingMessage,
  encoding: string | undefined,
  options: ReadBodyOptions = {},
): Promise<ReadBodyResult> {
  const maxCompressed = options.maxCompressedBytes ?? MAX_COMPRESSED_BYTES;
  const maxDecompressed = options.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const maxRaw = options.maxRawBytes ?? maxDecompressed;
  const destroyOnExceed = options.destroyOnExceed ?? false;
  /** 中止读取：默认只停止累计，让仍在发送的客户端拿到 413 而不是 ECONNRESET。 */
  const abortRead = (): void => {
    if (destroyOnExceed) stream.destroy();
    else stream.resume();
  };
  const normalized = (encoding ?? 'identity').trim().toLowerCase();

  if (normalized !== 'identity' && normalized !== '' && normalized !== 'gzip') {
    return Promise.resolve({
      ok: false,
      status: 400,
      error: 'unsupported_encoding',
      message: `unsupported Content-Encoding: ${normalized}`,
    });
  }

  return new Promise<ReadBodyResult>((resolve) => {
    let settled = false;
    const finish = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    stream.on('error', () => {
      finish({ ok: false, status: 400, error: 'invalid_json', message: 'request stream error' });
    });

    if (normalized !== 'gzip') {
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxRaw) {
          finish({
            ok: false,
            status: 413,
            error: 'payload_too_large',
            message: `body exceeds ${String(maxRaw)} bytes`,
          });
          abortRead();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => {
        finish({ ok: true, text: Buffer.concat(chunks).toString('utf8'), bytes });
      });
      return;
    }

    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let compressedBytes = 0;
    let decompressedBytes = 0;

    stream.on('data', (chunk: Buffer) => {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > maxCompressed) {
        finish({
          ok: false,
          status: 413,
          error: 'payload_too_large',
          message: `compressed body exceeds ${String(maxCompressed)} bytes`,
        });
        gunzip.destroy();
        abortRead();
        return;
      }
      gunzip.write(chunk);
    });
    stream.on('end', () => {
      gunzip.end();
    });
    gunzip.on('data', (chunk: Buffer) => {
      const next = decompressedBytes + chunk.byteLength;
      if (next > maxDecompressed) {
        // 精确记到上限为止：超出的字节不再累计，立即中止（M01-AC-04）。
        decompressedBytes = maxDecompressed;
        options.onDecompressed?.(decompressedBytes);
        finish({
          ok: false,
          status: 413,
          error: 'payload_too_large',
          message: `decompressed body exceeds ${String(maxDecompressed)} bytes`,
        });
        gunzip.destroy();
        abortRead();
        return;
      }
      chunks.push(chunk);
      decompressedBytes = next;
      options.onDecompressed?.(decompressedBytes);
    });
    gunzip.on('end', () => {
      options.onDecompressed?.(decompressedBytes);
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8'), bytes: decompressedBytes });
    });
    gunzip.on('error', () => {
      finish({ ok: false, status: 400, error: 'invalid_json', message: 'gzip decode failed' });
    });
  });
}
