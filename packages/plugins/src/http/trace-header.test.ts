/**
 * C05-AC-12 追踪头注入：配置的追踪白名单只含同源 → **只有同源请求**被注入链路追踪头。
 *
 * 裁定（T18-plan §4，依 CR-006）：
 * - 头名用 W3C Trace Context：`traceparent`（必需）/ `tracestate`（可选）；
 * - **值由接入方注入**（`TraceContextProvider`）；未提供则**不注入**（不伪造）；
 * - 白名单外一律不注入；**不做"尽力而为"的降级注入**；远程配置只能收紧。
 */
import { describe, expect, it } from 'vitest';

import { createHttpCapture, isSameOriginOrAllowed, narrowScope, resolveTraceHeaders } from './index';
import type { HttpEvent, NativeHttpRefs, TraceContextProvider, TraceScope } from './index';
import type { Hooker } from '../internal/hooker';

const ORIGIN = 'https://app.example.com';
/** 接入方提供的追踪上下文（伪造值，格式合法且不含真实信息）。 */
const provider: TraceContextProvider = () => ({
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  tracestate: 'vendor=fake',
});

describe('C05-AC-12 仅同源请求注入追踪头', () => {
  it('白名单只含同源时：同源请求注入 traceparent，第三方请求不注入（不是空值）', () => {
    const scope: TraceScope = { origin: ORIGIN, allowlist: [ORIGIN] };

    expect(isSameOriginOrAllowed(`${ORIGIN}/api/task/1`, scope)).toBe(true);
    expect(isSameOriginOrAllowed('https://third-party.example.com/collect', scope)).toBe(false);

    const sameOrigin = resolveTraceHeaders({ url: `${ORIGIN}/api/task/1`, method: 'GET' }, scope, provider);
    expect(sameOrigin?.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    const thirdParty = resolveTraceHeaders(
      { url: 'https://third-party.example.com/collect', method: 'GET' },
      scope,
      provider,
    );
    expect(thirdParty, '白名单外的请求必须完全不注入（undefined，而不是空字符串）').toBeUndefined();
  });

  it('未提供 provider 时不注入该头（SDK 不自造 traceparent）', () => {
    const scope: TraceScope = { origin: ORIGIN, allowlist: [ORIGIN] };
    expect(
      resolveTraceHeaders({ url: `${ORIGIN}/api/task/1`, method: 'POST' }, scope, undefined),
    ).toBeUndefined();
  });

  it('远程配置只能收紧注入范围，不能把新域加进白名单', () => {
    const base: TraceScope = { origin: ORIGIN, allowlist: [ORIGIN, 'https://apm.example.com'] };
    const remote: TraceScope = { origin: ORIGIN, allowlist: [ORIGIN, 'https://attacker.example.com'] };
    const narrowed = narrowScope(base, remote);

    expect(narrowed.allowlist).toContain(ORIGIN);
    expect(narrowed.allowlist).not.toContain('https://attacker.example.com');
    expect(narrowed.allowlist.length).toBeLessThanOrEqual(base.allowlist.length);
  });
});

/** 成对恢复的注册表（与 C02 `GlobalRegistry.hook` 同构）。 */
function createHooker(): Hooker {
  return {
    hook<T extends object, K extends keyof T>(
      target: T,
      key: K,
      wrapper: (original: T[K]) => T[K],
    ): () => void {
      const saved = target[key];
      const wrapped = wrapper(saved);
      target[key] = wrapped;
      return (): void => {
        if (target[key] === wrapped) target[key] = saved;
      };
    },
  };
}

describe('C05-AC-12 真实包装链路上只给同源请求注入追踪头', () => {
  it('同源请求收到 traceparent，第三方请求完全没有该头（不是空值）', async () => {
    const events: HttpEvent[] = [];
    const received: { readonly url: unknown; readonly headers?: unknown }[] = [];
    const holder: NativeHttpRefs = {
      fetch: (...args: readonly unknown[]): Promise<unknown> => {
        received.push({
          url: args[0],
          headers: (args[1] as { readonly headers?: unknown } | undefined)?.headers,
        });
        return Promise.resolve({ status: 200 });
      },
    };
    const scope: TraceScope = { origin: ORIGIN, allowlist: [ORIGIN] };
    const capture = createHttpCapture(
      (event) => {
        events.push(event);
      },
      {
        refs: holder,
        hooker: createHooker(),
        options: { traceScope: scope, traceContextProvider: provider },
      },
    );

    await holder.fetch(`${ORIGIN}/api/task/1`);
    await holder.fetch('https://third-party.example.com/collect');

    const sameOrigin = JSON.stringify(received[0]?.headers ?? null);
    expect(sameOrigin, '同源请求必须注入 traceparent').toContain('traceparent');
    expect(sameOrigin).toContain('4bf92f3577b34da6a3ce929d0e0e4736');

    const thirdParty = JSON.stringify(received[1]?.headers ?? null);
    expect(thirdParty, '第三方请求不得注入 traceparent').not.toContain('traceparent');

    // 两个请求都被正常采集（注入逻辑不得影响采集本身）
    expect(events).toHaveLength(2);
    // 未被允许注入的请求仍然照常采集（只是没有头）
    expect(capture.traceHeadersFor({ url: 'https://third-party.example.com/x', method: 'GET' })).toBeUndefined();
    expect(capture.traceHeadersFor({ url: `${ORIGIN}/x`, method: 'GET' })?.traceparent).toContain('4bf92f35');
  });

  it('未配置追踪范围时不注入（SDK 不擅自加头）', async () => {
    const received: unknown[] = [];
    const holder: NativeHttpRefs = {
      fetch: (...args: readonly unknown[]): Promise<unknown> => {
        received.push(args[1]);
        return Promise.resolve({ status: 200 });
      },
    };
    createHttpCapture(() => undefined, { refs: holder, hooker: createHooker() });
    await holder.fetch(`${ORIGIN}/api/task/1`);
    expect(JSON.stringify(received[0] ?? null)).not.toContain('traceparent');
  });
});
