/**
 * 原生 HTTP 引用的捕获与默认传输实现。
 *
 * 任务卡非功能目标：「发送请求必须使用 hook 前保存的原生 `fetch` / `XMLHttpRequest`
 * 引用，不被 C05 的 HTTP 插件采集」。
 *
 * 契约（已裁定，调用点归 T18/C05 在装配根、安装任何插件之前调用一次）：
 * - `captureNativeHttpRefs(target)` **每个 target 只捕获一次**（WeakMap 缓存，幂等）；
 * - 返回对象 **冻结**；
 * - T16 的发送器**只使用注入的引用**，绝不通过 `globalThis.fetch` 间接调用。
 */
import type { NativeHttpRefs, TransportPort, TransportRequest, TransportResponse } from './types';

const captureCache = new WeakMap<object, NativeHttpRefs>();

function readRefs(target: object): NativeHttpRefs {
  const scope = target as {
    readonly fetch?: unknown;
    readonly XMLHttpRequest?: unknown;
    readonly navigator?: { readonly sendBeacon?: unknown } | undefined;
  };
  const fetchRef = scope.fetch;
  const xhrRef = scope.XMLHttpRequest;
  const beaconRef = scope.navigator?.sendBeacon;
  const refs: NativeHttpRefs = {
    ...(typeof fetchRef === 'function' ? { fetch: fetchRef as typeof fetch } : {}),
    ...(typeof xhrRef === 'function' ? { xhr: xhrRef as typeof XMLHttpRequest } : {}),
    ...(typeof beaconRef === 'function'
      ? { sendBeacon: (beaconRef as (url: string, data: BodyInit) => boolean).bind(scope.navigator) }
      : {}),
  };
  return Object.freeze(refs);
}

/**
 * 捕获 hook 前的原生 HTTP 引用。
 * 同一个 `target` 重复调用返回**同一个冻结对象**（幂等，防止第二次调用拿到已被 hook 的引用）。
 */
export function captureNativeHttpRefs(target: object = globalThis): NativeHttpRefs {
  const cached = captureCache.get(target);
  if (cached !== undefined) return cached;
  const refs = readRefs(target);
  captureCache.set(target, refs);
  return refs;
}

/** 特性探测：浏览器是否支持 `fetch` 的 `keepalive`（不支持时降级 XHR，AC-02）。 */
export function supportsFetchKeepalive(): boolean {
  try {
    if (typeof Request !== 'function') return false;
    return 'keepalive' in new Request('data:,');
  } catch {
    return false;
  }
}

function toHeaderRecord(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key !== '') headers[key] = value;
  }
  return headers;
}

function buildRequestInit(request: TransportRequest, signal: AbortSignal | null): RequestInit {
  const init: RequestInit = {
    method: 'POST',
    headers: { ...request.headers },
    body: request.bodyBytes ?? request.body,
    keepalive: request.keepalive,
  };
  if (signal !== null) init.signal = signal;
  return init;
}

/** 基于注入的原生 `fetch` 的传输实现。 */
export function createFetchTransport(refs: NativeHttpRefs): TransportPort {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      const fetchRef = refs.fetch;
      if (fetchRef === undefined) throw new Error('native fetch unavailable');
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer =
        controller === null
          ? null
          : globalThis.setTimeout(() => {
              controller.abort();
            }, request.timeoutMs);
      try {
        const response = await fetchRef(request.url, buildRequestInit(request, controller?.signal ?? null));
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: response.status, headers };
      } finally {
        if (timer !== null) globalThis.clearTimeout(timer);
      }
    },
  };
}

/** 基于注入的原生 `XMLHttpRequest` 的传输实现（keepalive 不可用时的降级通道）。 */
export function createXhrTransport(refs: NativeHttpRefs): TransportPort {
  return {
    send(request: TransportRequest): Promise<TransportResponse> {
      return new Promise<TransportResponse>((resolve, reject) => {
        const Xhr = refs.xhr;
        if (Xhr === undefined) {
          reject(new Error('native XMLHttpRequest unavailable'));
          return;
        }
        const xhr = new Xhr();
        try {
          xhr.open('POST', request.url, true);
          for (const [key, value] of Object.entries(request.headers)) {
            xhr.setRequestHeader(key, value);
          }
          xhr.timeout = request.timeoutMs;
          xhr.onload = (): void => {
            resolve({ status: xhr.status, headers: toHeaderRecord(xhr.getAllResponseHeaders()) });
          };
          xhr.onerror = (): void => {
            reject(new Error('xhr network error'));
          };
          xhr.ontimeout = (): void => {
            reject(new Error('xhr timeout'));
          };
          xhr.send(request.bodyBytes ?? request.body);
        } catch (error) {
          reject(error instanceof Error ? error : new Error('xhr failure'));
        }
      });
    },
  };
}

/**
 * 默认传输：`keepalive` 可用时用原生 `fetch`，否则降级到 `XMLHttpRequest`（C07-F1 / AC-02）。
 */
export function createDefaultTransport(
  refs: NativeHttpRefs,
  keepaliveSupported: () => boolean = supportsFetchKeepalive,
): TransportPort {
  const fetchTransport = refs.fetch === undefined ? null : createFetchTransport(refs);
  const xhrTransport = refs.xhr === undefined ? null : createXhrTransport(refs);
  return {
    send(request: TransportRequest): Promise<TransportResponse> {
      if (fetchTransport !== null && keepaliveSupported()) return fetchTransport.send(request);
      if (xhrTransport !== null) return xhrTransport.send(request);
      if (fetchTransport !== null) return fetchTransport.send(request);
      return Promise.reject(new Error('no transport available'));
    },
  };
}

/** 信标发送器；不可用时返回 null（离开路径会退化为 `fetch keepalive`）。 */
export function createBeaconSender(
  refs: NativeHttpRefs,
): ((url: string, data: Blob) => boolean) | null {
  const beacon = refs.sendBeacon;
  if (beacon === undefined) return null;
  return (url: string, data: Blob): boolean => {
    try {
      return beacon(url, data);
    } catch {
      return false;
    }
  };
}
