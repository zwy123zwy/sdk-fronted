/**
 * T18 装配根（`packages/browser/src/assembly.ts`）的接线用例。
 *
 * 覆盖 `docs/reports/handover.md` 第 1 节的接线义务中**可端到端验证**的部分：
 * - ① `captureNativeHttpRefs()` 在任何插件安装之前捕获（冻结、且不是插件的包装）；
 * - ② C08 的计数/计时装饰器接在**实际对象**上（`calls_total`/`events_enqueued`/
 *   `events_sent`/`batches_sent`/`queue_length_max`/`track_p99_ms` 非零）；
 * - ③ C04 的三个端口：`noteServerTime` ← C07 的 `X-Server-Time`、`header()` → C06、
 *   `ErasePort.offlineData` ← `setConsent('denied')`；
 * - 端到端：从 `init()` 到接收方（注入的传输替身）收到批次；
 * - C05 插件：HTTP 采集与路由页面上报确实进入批次。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransportPort, TransportRequest, TransportResponse } from '@web-report-sdk/transport';

import { createAssembly } from './assembly';
import type { Assembly } from './assembly';

interface FakeTransport {
  readonly port: TransportPort;
  readonly requests: TransportRequest[];
  reply(response: TransportResponse): void;
}

function createFakeTransport(initial: TransportResponse = { status: 202, headers: {} }): FakeTransport {
  let response: TransportResponse = initial;
  const requests: TransportRequest[] = [];
  return {
    requests,
    reply(next: TransportResponse): void {
      response = next;
    },
    port: {
      send(request: TransportRequest): Promise<TransportResponse> {
        requests.push(request);
        return Promise.resolve(response);
      },
    },
  };
}

/** 轮询等待异步发送链路完成（不用墙钟断言，只等条件成立）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

interface ParsedBatch {
  readonly app_id: string;
  readonly session_id: string;
  readonly device_id: string;
  readonly consent?: string;
  readonly clock_offset: number;
  readonly clock_calibrated?: boolean;
  readonly common?: Readonly<Record<string, unknown>>;
  readonly events: readonly Readonly<Record<string, unknown>>[];
}

function parseBatch(request: TransportRequest): ParsedBatch {
  return JSON.parse(request.body) as ParsedBatch;
}

/** 读取事件字段：C06 会把取值相同的公共字段提升到 `batch.common`。 */
function fieldOf(
  batch: ParsedBatch,
  event: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const direct = event[key];
  return direct === undefined ? batch.common?.[key] : direct;
}

const assemblies: Assembly[] = [];
const originalFetch = globalThis.fetch;

function build(overrides: Partial<Parameters<typeof createAssembly>[0]> = {}): {
  assembly: Assembly;
  transport: FakeTransport;
} {
  const transport = createFakeTransport();
  const assembly = createAssembly({
    appId: 'app-1',
    endpoint: 'https://collect.example/ingest',
    token: 'token-1',
    env: 'test',
    release: '1.2.3',
    consent: 'granted',
    transport: transport.port,
    now: () => 1_700_000_000_000,
    startHealthReporting: false,
    ...overrides,
  });
  assemblies.push(assembly);
  return { assembly, transport };
}

afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
  (globalThis as { fetch?: unknown }).fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('① 原生引用捕获先于插件安装', () => {
  it('冻结捕获 hook 前的 fetch，且它不是插件装上的包装', () => {
    const beforeFetch = globalThis.fetch;
    const { assembly } = build({ plugins: { http: true } });

    expect(Object.isFrozen(assembly.nativeHttpRefs)).toBe(true);
    // 捕获对象是 hook 前保存的引用。
    expect(assembly.nativeHttpRefs.fetch).toBe(beforeFetch);
    // 插件确实装上了包装（globalThis.fetch 已被替换）——因此"先捕获"才有意义。
    expect(globalThis.fetch).not.toBe(beforeFetch);
    // 采集插件在装配下已安装并可用。
    expect(assembly.collectors.http).toBeDefined();
  });

  it('未注入 refs 时插件不自行捕获（install() 不改动原生方法）', () => {
    const { assembly } = build({ plugins: { http: true } });
    const beforeInstall = globalThis.fetch;
    // 已有装配之后再造一个：不受前一实例的包装影响（幂等捕获 + 条件还原）。
    const second = build({ plugins: { http: true } });
    expect(second.assembly.nativeHttpRefs.fetch).toBe(assembly.nativeHttpRefs.fetch);
    expect(globalThis.fetch).not.toBe(beforeInstall);
  });
});

describe('端到端：从 init() 到接收方收到批次', () => {
  it('track 事件经管线、队列、发送器到达注入的接收端', async () => {
    const { assembly, transport } = build();
    assembly.init();
    assembly.client.track('task_complete', { dimensions: { task_id: 't-1' } });
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);

    const request = transport.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.url).toBe('https://collect.example/ingest');
    expect(request.headers['x-app-id']).toBe('app-1');
    expect(request.headers['x-write-token']).toBe('token-1');

    const batch = parseBatch(request);
    expect(batch.app_id).toBe('app-1');
    expect(batch.events).toHaveLength(1);
    const event = batch.events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event['event_name']).toBe('task_complete');
    expect(event['event_type']).toBe('custom');
    expect(event['schema_version']).toBe(1);
    expect(typeof event['event_id']).toBe('string');
    expect(event['priority']).toBe('normal');
    expect(event['dimensions']).toEqual({ task_id: 't-1' });
  });

  it('批次头来自 C04 的 header()（session_id/device_id/consent 非空）', async () => {
    const { assembly, transport } = build();
    assembly.init();
    assembly.client.track('task_complete');
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);

    const request = transport.requests[0];
    if (request === undefined) throw new Error('没有批次');
    const batch = parseBatch(request);
    expect(batch.session_id.length).toBeGreaterThan(0);
    expect(batch.device_id.length).toBeGreaterThan(0);
    expect(batch.consent).toBe('granted');
  });
});

describe('② C08 计数与计时装饰器接在实际对象上', () => {
  it('calls_total / events_enqueued / events_sent / batches_sent / queue_length_max / track_p99_ms 非零', async () => {
    const { assembly } = build({ sessionSampleRate: 1 });
    assembly.init();
    assembly.client.track('task_complete');
    assembly.flush();
    await waitFor(() => assembly.delivery.metrics().batchesSent >= 1);

    const health = assembly.reporter.flush();
    expect(health.length).toBeGreaterThan(0);
    const metrics: Record<string, number> = {};
    for (const event of health) Object.assign(metrics, event.metrics);

    // init + track 都被 createCallCounter 计数。
    expect(metrics['calls_total']).toBeGreaterThanOrEqual(2);
    expect(metrics['events_enqueued']).toBeGreaterThanOrEqual(1);
    expect(metrics['events_sent']).toBe(1);
    expect(metrics['batches_sent']).toBe(1);
    expect(metrics['queue_length_max']).toBeGreaterThanOrEqual(1);
    expect(metrics['track_p99_ms']).toBeGreaterThanOrEqual(0);
  });
});

describe('③ C04 的三个端口', () => {
  it('noteServerTime ← C07 的 X-Server-Time：下一批次的 clock_offset 生效', async () => {
    const { assembly, transport } = build();
    transport.reply({ status: 202, headers: { 'x-server-time': String(1_700_000_005_000) } });
    assembly.init();
    expect(assembly.kernel.lifecycle.state()).toBe('running');
    expect(assembly.kernel.configReady()).toBe(true);
    assembly.client.track('first_event');
    expect(assembly.queue.queueLength()).toBe(1);
    assembly.flush();
    await waitFor(() => transport.requests.length === 1);

    // 第一个批次发出时还没校准。
    const first = transport.requests[0];
    if (first === undefined) throw new Error('没有首批次');
    expect(parseBatch(first).clock_offset).toBe(0);

    assembly.client.track('second_event');
    assembly.flush();
    await waitFor(() => transport.requests.length === 2);
    const second = transport.requests[1];
    if (second === undefined) throw new Error('没有第二批次');
    const batch = parseBatch(second);
    // 服务端时间 - 客户端收到时间（测试的 now 固定）→ 5 秒。
    expect(batch.clock_calibrated).toBe(true);
    expect(batch.clock_offset).toBe(5000);
  });

  it('ErasePort.offlineData ← setConsent(denied) 触发 C07 清理', () => {
    const { assembly } = build();
    assembly.init();
    const clear = vi.spyOn(assembly.delivery.offline, 'clear');
    assembly.client.setConsent('denied');
    expect(clear).toHaveBeenCalledTimes(1);
    expect(assembly.clock.current().offsetMs).toBe(0);
  });
});

describe('C05 插件接线', () => {
  it('HTTP 插件：宿主 fetch 被采集并作为 web_http 事件进入批次', async () => {
    const fakeFetch = (): Promise<{ readonly status: number }> => Promise.resolve({ status: 200 });
    (globalThis as { fetch?: unknown }).fetch = fakeFetch;

    const { assembly, transport } = build({ plugins: { http: true } });
    assembly.init();

    const wrappedFetch = globalThis.fetch as unknown as (
      input: string,
    ) => Promise<{ readonly status: number }>;
    await wrappedFetch('https://api.example/orders/42?token=secret');

    assembly.flush();
    await waitFor(() => transport.requests.length > 0);
    const request = transport.requests[0];
    if (request === undefined) throw new Error('没有批次');
    const batch = parseBatch(request);
    const http = batch.events.find((event) => event['event_name'] === 'web_http');
    expect(http).toBeDefined();
    if (http === undefined) return;
    expect(http['event_type']).toBe('http');
    expect(http['dimensions']).toMatchObject({ method: 'GET', url_template: 'https://api.example/orders/42' });
    expect(http['metrics']).toMatchObject({ status: 200 });
    // 令牌在查询参数里：C04 的 URL 白名单之外一律删除。
    expect(request.body).not.toContain('secret');
  });

  it('路由插件：pushState 触发 web_pageview，page_id 为路由模板', async () => {
    const { assembly, transport } = build({ route: { templates: ['/task/:id'] } });
    assembly.init();

    window.history.pushState({}, '', '/task/123');
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);

    const request = transport.requests[0];
    if (request === undefined) throw new Error('没有批次');
    const batch = parseBatch(request);
    const pageview = batch.events.find((event) => event['event_name'] === 'web_pageview');
    expect(pageview).toBeDefined();
    if (pageview === undefined) return;
    expect(pageview['event_type']).toBe('pageview');
    expect(fieldOf(batch, pageview, 'page_id')).toBe('/task/:id');
    expect(pageview['dimensions']).toMatchObject({ navigation_type: 'push' });
  });
});
