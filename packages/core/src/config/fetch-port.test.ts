/**
 * C03-F2 默认拉取端口与 URL 构造 —— 用例（M4，覆盖率补强）。
 * 只验证端口自身的逻辑（URL、条件请求头、304、缺失 fetch），真实网络归 T29。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConfigUrl, createFetchPort } from './fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeResponse(status: number, etag: string | null, body: string): Response {
  return {
    status,
    headers: new Headers(etag === null ? {} : { ETag: etag }),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('buildConfigUrl', () => {
  it('拼接 /v1/config/{app}/{env}.json，并兼容结尾斜杠', () => {
    expect(buildConfigUrl('https://c.example.com', 'demo-app', 'production')).toBe(
      'https://c.example.com/v1/config/demo-app/production.json',
    );
    expect(buildConfigUrl('https://c.example.com/', 'demo-app', 'production')).toBe(
      'https://c.example.com/v1/config/demo-app/production.json',
    );
  });
});

describe('createFetchPort', () => {
  it('注入实现优先', async () => {
    const port = createFetchPort({
      timeoutMs: 1000,
      fetchImpl: () => Promise.resolve({ status: 200, etag: '"e"', body: 'injected' }),
    });
    await expect(port({ url: 'https://x/y', etag: undefined })).resolves.toEqual({
      status: 200,
      etag: '"e"',
      body: 'injected',
    });
  });

  it('默认实现：带 If-None-Match 且读取 ETag/正文；304 不读正文', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      return Promise.resolve(seen.length === 1 ? fakeResponse(200, '"v1"', 'body-text') : fakeResponse(304, null, 'ignored'));
    });
    const port = createFetchPort({ timeoutMs: 1000 });

    const first = await port({ url: 'https://x/y', etag: '"v0"' });
    expect(first).toEqual({ status: 200, etag: '"v1"', body: 'body-text' });
    expect(seen[0]?.headers['If-None-Match']).toBe('"v0"');

    const second = await port({ url: 'https://x/y', etag: '"v1"' });
    expect(second.status).toBe(304);
    expect(second.body).toBe('');
  });

  it('缺省 fetch 不可用时 reject（不抛同步异常）', async () => {
    vi.stubGlobal('fetch', undefined);
    const port = createFetchPort({ timeoutMs: 1000 });
    await expect(port({ url: 'https://x/y', etag: undefined })).rejects.toThrow(/fetch/);
  });
});
