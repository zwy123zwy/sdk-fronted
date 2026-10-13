/**
 * 默认拉取端口（T13）。
 *
 * 契约 `remote-config.md` 第 1 节：`GET {config_endpoint}/v1/config/{app_id}/{env}.json`，
 * 带上次响应的 `ETag`（`If-None-Match`），超时用 `AbortController`。
 * 模块顶层不访问 `fetch`，只在调用时解析 `globalThis.fetch`。
 */
import type { ConfigFetchPort, ConfigFetchRequest, ConfigFetchResponse } from './types';

/** 构造拉取 URL（路径拼接；`app_id`/`env` 由调用方保证存在）。 */
export function buildConfigUrl(configEndpoint: string, appId: string, env: string): string {
  const base = configEndpoint.endsWith('/') ? configEndpoint.slice(0, -1) : configEndpoint;
  return `${base}/v1/config/${appId}/${env}.json`;
}

/** 默认拉取端口工厂。传入 `fetchImpl` 时直接使用（测试注入）。 */
export function createFetchPort(options: {
  readonly timeoutMs: number;
  readonly fetchImpl?: ((request: ConfigFetchRequest) => Promise<ConfigFetchResponse>) | undefined;
}): ConfigFetchPort {
  const injected = options.fetchImpl;
  if (injected !== undefined) return injected;

  return async (request: ConfigFetchRequest): Promise<ConfigFetchResponse> => {
    const scope = globalThis as { fetch?: typeof fetch };
    const fetchFn = scope.fetch;
    if (fetchFn === undefined) throw new Error('config fetch unavailable: globalThis.fetch is missing');

    const abortable = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (abortable !== undefined) {
      timer = setTimeout(() => {
        abortable.abort();
      }, options.timeoutMs);
    }

    const headers: Record<string, string> = {};
    if (request.etag !== undefined) headers['If-None-Match'] = request.etag;
    const init: RequestInit = abortable === undefined ? { method: 'GET', headers } : { method: 'GET', headers, signal: abortable.signal };

    try {
      const response = await fetchFn(request.url, init);
      const etagHeader = response.headers.get('ETag');
      const etag = etagHeader === null ? undefined : etagHeader;
      const body = response.status === 304 ? '' : await response.text();
      return { status: response.status, etag, body };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
