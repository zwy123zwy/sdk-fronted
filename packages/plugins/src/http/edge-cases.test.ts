/**
 * C05-F4 HTTP 插件的边界分支用例（补齐 `status_class` / `failure_reason` / 降级与恢复）。
 */
import { describe, expect, it } from 'vitest';

import { createInlineHooker } from '../internal/hooker';
import {
  captureNativeHttpRefs,
  classifyFailure,
  createHttpCapture,
  createHttpPlugin,
  isSameOriginOrAllowed,
  narrowScope,
  resolveTraceHeaders,
  statusClassOf,
} from './index';
import type { HttpEvent, NativeHttpRefs, TraceScope } from './index';

/** 造一个容器 + 采集实例。 */
function setup(respond: () => Promise<unknown>): {
  holder: NativeHttpRefs;
  events: HttpEvent[];
  capture: ReturnType<typeof createHttpCapture>;
} {
  const events: HttpEvent[] = [];
  const holder: NativeHttpRefs = {
    fetch: (): Promise<unknown> => respond(),
  };
  const capture = createHttpCapture((event) => events.push(event), {
    refs: holder,
    hooker: createInlineHooker(),
    now: () => 1_700_000_000_000,
  });
  return { holder, events, capture };
}

describe('C05-AC-10 status_class 与 failure_reason 的取值边界', () => {
  it('五个状态码分类逐一正确，越界状态码不产生 status_class', () => {
    expect(statusClassOf(100)).toBe('1xx');
    expect(statusClassOf(199)).toBe('1xx');
    expect(statusClassOf(200)).toBe('2xx');
    expect(statusClassOf(301)).toBe('3xx');
    expect(statusClassOf(404)).toBe('4xx');
    expect(statusClassOf(503)).toBe('5xx');
    expect(statusClassOf(599)).toBe('5xx');
    expect(statusClassOf(99)).toBeUndefined();
    expect(statusClassOf(600)).toBeUndefined();
    expect(statusClassOf(0)).toBeUndefined();
  });

  it('四种传输层失败按名称/消息归类', () => {
    const abort = new Error('aborted'); abort.name = 'AbortError';
    expect(classifyFailure(abort)).toBe('aborted');
    const timeout = new Error('timed out'); timeout.name = 'TimeoutError';
    expect(classifyFailure(timeout)).toBe('timeout');
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('network_error');
    expect(classifyFailure(new TypeError('CORS request blocked'))).toBe('cors');
    expect(classifyFailure('a string error')).toBe('network_error');
  });

  it('record 支持 request_bytes / response_bytes，并在超时请求上不上报 status_class', () => {
    const { events, capture } = setup(() => Promise.resolve({ status: 200 }));
    capture.record(
      { method: 'GET', url: 'https://app.example.com/api/x' },
      { status: 200, requestBytes: 12, responseBytes: 34 },
      7,
    );
    expect(events[0]?.metrics.request_bytes).toBe(12);
    expect(events[0]?.metrics.response_bytes).toBe(34);

    capture.record({ method: 'GET', url: 'https://app.example.com/api/y' }, { status: 0, failureReason: 'aborted' }, 3);
    expect(events[1]?.dimensions.failure_reason).toBe('aborted');
    expect(events[1]?.dimensions.status_class).toBeUndefined();
    expect(events[1]?.metrics.duration_ms).toBe(3);
  });

  it('卸载后原生 fetch 被恢复，且不再记录；重复卸载幂等', async () => {
    const { holder, events, capture } = setup(() => Promise.resolve({ status: 200 }));
    const patched = holder.fetch;
    capture.uninstall();
    expect(holder.fetch, '卸载必须恢复原生引用').not.toBe(patched);
    await holder.fetch('https://app.example.com/api/x');
    expect(events).toHaveLength(0);
    expect(() => {
      capture.uninstall();
    }).not.toThrow();
  });

  it('没有可包装的容器时静默降级（不抛错、record 仍可用）', () => {
    const events: HttpEvent[] = [];
    const capture = createHttpCapture((event) => events.push(event));
    expect(() => {
      capture.record({ method: 'GET', url: '/api/x' }, { status: 200 }, 1);
    }).not.toThrow();
    expect(events).toHaveLength(1);
    expect(capture.stats().captured).toBe(1);
  });

  it('createHttpPlugin 暴露 perf/http 无关的插件形状，install 后可用', () => {
    const events: HttpEvent[] = [];
    const plugin = createHttpPlugin((event) => events.push(event));
    plugin.install(undefined as never);
    plugin.capture.record({ method: 'POST', url: '/api/x' }, { status: 201 }, 2);
    expect(plugin.id).toBe('http');
    expect(events).toHaveLength(1);
  });

  it('captureNativeHttpRefs 在宿主有 fetch 时返回 globalThis，否则 undefined', () => {
    const refs = captureNativeHttpRefs();
    expect(typeof globalThis.fetch).toBe('function');
    expect(refs).toBe(globalThis as unknown as NativeHttpRefs);
  });
});

describe('C05-AC-12 追踪范围的边界', () => {
  it('非法 URL 不注入；裸域名白名单项与带尾斜杠的项都能匹配', () => {
    const scope: TraceScope = { origin: 'https://app.example.com', allowlist: ['apm.example.com/', 'https://other.example.com/'] };
    expect(isSameOriginOrAllowed('not a url with spaces', scope)).toBe(false);
    expect(isSameOriginOrAllowed('https://apm.example.com/collect', scope)).toBe(true);
    expect(isSameOriginOrAllowed('https://other.example.com/collect', scope)).toBe(true);
    expect(isSameOriginOrAllowed('https://evil.example.com/collect', scope)).toBe(false);
    expect(isSameOriginOrAllowed('https://app.example.com/anything', scope)).toBe(true);
  });

  it('provider 返回空 traceparent 时视为无上下文，不注入空值', () => {
    const scope: TraceScope = { origin: 'https://app.example.com', allowlist: [] };
    expect(
      resolveTraceHeaders({ url: 'https://app.example.com/x', method: 'GET' }, scope, () => ({ traceparent: '' })),
    ).toBeUndefined();
  });

  it('tracestate 为空字符串时只注入 traceparent', () => {
    const scope: TraceScope = { origin: 'https://app.example.com', allowlist: [] };
    const headers = resolveTraceHeaders({ url: 'https://app.example.com/x', method: 'GET' }, scope, () => ({
      traceparent: '00-abc-def-01',
      tracestate: '',
    }));
    expect(headers).toEqual({ traceparent: '00-abc-def-01' });
  });

  it('narrowScope 保留两侧交集（收紧），不引入新域', () => {
    const base: TraceScope = { origin: 'https://app.example.com', allowlist: ['apm.example.com', 'https://keep.example.com'] };
    const remote: TraceScope = { origin: 'https://app.example.com', allowlist: ['https://apm.example.com', 'https://new.example.com'] };
    const narrowed = narrowScope(base, remote);
    expect(narrowed.allowlist).toEqual(['https://apm.example.com']);
    expect(narrowed.origin).toBe(base.origin);
  });
});
