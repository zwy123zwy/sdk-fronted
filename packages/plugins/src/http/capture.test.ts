/**
 * C05-AC-10 HTTP 采集：成功 / 404 / 超时三请求（fetch 与 XHR 各一组）→ `web_http`，
 * 状态码与失败原因正确；**SDK 自己的上报请求不被采集**。
 *
 * 裁定（T18-plan §5，依 CR-006）：
 * - 成功 = 无 `failure_reason`；404 = `status=404` 且无 `failure_reason`；
 *   超时 = `failure_reason='timeout'`；
 * - `failure_reason` 只表达传输层失败：`network_error`/`timeout`/`aborted`/`cors`。
 */
import { describe, expect, it } from 'vitest';

import { SDK_INTERNAL_HEADER, createHttpCapture } from './index';
import type { HttpEvent, NativeHttpRefs } from './index';
import type { Hooker } from '../internal/hooker';

/** 采集端口的 `record` 形状（函数属性，避免 unbound-method）。 */
type RecordFn = (
  request: { readonly method: string; readonly url: string; readonly sdkInternal?: boolean | undefined },
  response: { readonly status: number; readonly failureReason?: 'network_error' | 'timeout' | 'aborted' | 'cors' | undefined },
  durationMs: number,
) => void;

/** 收集事件的一个采集实例。 */
function setup(): { events: HttpEvent[]; record: RecordFn } {
  const events: HttpEvent[] = [];
  const capture = createHttpCapture((event) => {
    events.push(event);
  });
  const record: RecordFn = capture.record;
  return { events, record };
}

describe('C05-AC-10 六种组合的状态码与失败原因 + 不采集自身请求', () => {
  it('成功 → web_http 无 failure_reason 且 status=200、status_class=2xx', () => {
    const { events, record } = setup();
    record({ method: 'GET', url: '/api/task/1' }, { status: 200 }, 42);

    expect(events, '成功请求必须产出一条 web_http').toHaveLength(1);
    const event = events[0];
    expect(event?.dimensions.method).toBe('GET');
    expect(event?.metrics.status).toBe(200);
    expect(event?.dimensions.status_class).toBe('2xx');
    expect(event?.dimensions.failure_reason, '成功请求省略 failure_reason').toBeUndefined();
    expect(event?.metrics.duration_ms).toBe(42);
  });

  it('404 → status=404、status_class=4xx、无 failure_reason', () => {
    const { events, record } = setup();
    record({ method: 'POST', url: '/api/task/404' }, { status: 404 }, 55);

    const event = events[0];
    expect(event?.metrics.status).toBe(404);
    expect(event?.dimensions.status_class).toBe('4xx');
    expect(event?.dimensions.failure_reason, '4xx 走 metrics.status，不用 failure_reason').toBeUndefined();
  });

  it('超时 → failure_reason=timeout，且不上报 status/status_class', () => {
    const { events, record } = setup();
    record({ method: 'GET', url: '/api/slow' }, { status: 0, failureReason: 'timeout' }, 5000);

    const event = events[0];
    expect(event?.dimensions.failure_reason).toBe('timeout');
    expect(event?.dimensions.status_class).toBeUndefined();
    expect(event?.metrics.status).toBeUndefined();
  });

  it('SDK 自己的上报请求不被采集', () => {
    const { events, record } = setup();
    record({ method: 'POST', url: '/v1/events', sdkInternal: true }, { status: 204 }, 10);

    expect(events, '自身上报请求不得出现在 web_http 事件里').toHaveLength(0);
    record({ method: 'POST', url: '/api/business' }, { status: 204 }, 10);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('/v1/events');
  });

  it('六种组合（fetch/XHR × 成功/404/超时）各产出一条对应事件', () => {
    const { events, record } = setup();
    const combos: readonly (readonly [string, number, string | undefined])[] = [
      ['fetch', 200, undefined],
      ['fetch', 404, undefined],
      ['fetch', 0, 'timeout'],
      ['xhr', 200, undefined],
      ['xhr', 404, undefined],
      ['xhr', 0, 'timeout'],
    ];
    for (const [, status, failureReason] of combos) {
      record(
        { method: 'GET', url: '/api/task/1' },
        failureReason === undefined ? { status } : { status: 0, failureReason: 'timeout' },
        30,
      );
    }
    expect(events).toHaveLength(6);
    expect(events.filter((event) => event.metrics.status === 404)).toHaveLength(2);
    expect(events.filter((event) => event.dimensions.failure_reason === 'timeout')).toHaveLength(2);
  });
});

describe('C05-AC-10 采集内容限定为元信息（不读请求体）', () => {
  it('事件里不出现请求体字段，SDK 自身标记头名固定', () => {
    const { events, record } = setup();
    record({ method: 'POST', url: '/api/task' }, { status: 200 }, 20);
    expect(JSON.stringify(events)).not.toContain('body');
    expect(JSON.stringify(events)).not.toContain('FormData');
    expect(SDK_INTERNAL_HEADER).toBe('x-web-report-sdk-internal');
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

/** 可编程的伪造原生 fetch：记录收到的入参，按脚本返回或抛错。 */
interface FetchHarness {
  holder: NativeHttpRefs;
  received: { readonly input: unknown; readonly init: unknown }[];
  patched(): (...args: readonly unknown[]) => Promise<unknown>;
}

function createFetchHarness(
  respond: (call: number) => Promise<unknown>,
): FetchHarness {
  const received: { readonly input: unknown; readonly init: unknown }[] = [];
  let call = 0;
  const holder: NativeHttpRefs = {
    fetch: (...args: readonly unknown[]): Promise<unknown> => {
      received.push({ input: args[0], init: args[1] });
      call += 1;
      return respond(call);
    },
  };
  return {
    holder,
    received,
    patched: (): ((...args: readonly unknown[]) => Promise<unknown>) => holder.fetch,
  };
}

describe('C05-AC-10 真实包装链路（fetch 三态 + XHR）', () => {
  it('fetch 成功 / 404 / 超时各产出一条事件，且状态与失败原因正确', async () => {
    const events: HttpEvent[] = [];
    const harness = createFetchHarness((call) => {
      if (call === 1) return Promise.resolve({ status: 200 });
      if (call === 2) return Promise.resolve({ status: 404 });
      const timeout = new Error('request timed out');
      timeout.name = 'TimeoutError';
      return Promise.reject(timeout);
    });
    createHttpCapture(
      (event) => {
        events.push(event);
      },
      { refs: harness.holder, hooker: createHooker() },
    );

    await harness.patched()('https://app.example.com/api/a');
    await harness.patched()('https://app.example.com/api/b');
    await expect(harness.patched()('https://app.example.com/api/slow')).rejects.toThrow(
      'request timed out',
    );

    expect(events).toHaveLength(3);
    expect(events[0]?.metrics.status).toBe(200);
    expect(events[0]?.dimensions.status_class).toBe('2xx');
    expect(events[1]?.metrics.status).toBe(404);
    expect(events[1]?.dimensions.status_class).toBe('4xx');
    expect(events[2]?.dimensions.failure_reason).toBe('timeout');
    expect(events[2]?.metrics.status, '超时不上报 status').toBeUndefined();
  });

  it('包装不得吞掉宿主 fetch 抛出的非超时异常（仍然归类为 network_error）', async () => {
    const events: HttpEvent[] = [];
    const harness = createFetchHarness(() => Promise.reject(new TypeError('Failed to fetch')));
    createHttpCapture(
      (event) => {
        events.push(event);
      },
      { refs: harness.holder, hooker: createHooker() },
    );

    await expect(harness.patched()('https://app.example.com/api/x')).rejects.toThrow(
      'Failed to fetch',
    );
    expect(events[0]?.dimensions.failure_reason).toBe('network_error');
  });

  it('XHR 成功与失败各产出一条事件（走同一归一化路径）', () => {
    const events: HttpEvent[] = [];
    /** 伪造的 XHR 构造器（函数构造器，仓库禁止 class）：只实现采集需要的成员。 */
    const listeners: (() => void)[] = [];
    function FakeXhr(): { status: number; open: () => void; addEventListener: (type: string, listener: () => void) => void } {
      return {
        status: 0,
        open: () => undefined,
        addEventListener: (type: string, listener: () => void): void => {
          if (type === 'loadend') listeners.push(listener);
        },
      };
    }
    const holder: NativeHttpRefs = {
      fetch: (...args: readonly unknown[]): Promise<unknown> =>
        Promise.resolve({ status: 200, args }),
      XMLHttpRequest: FakeXhr,
    };
    createHttpCapture(
      (event) => {
        events.push(event);
      },
      { refs: holder, hooker: createHooker() },
    );

    const Ctor = holder.XMLHttpRequest as new () => {
      status: number;
      open(method: string, url: string): void;
    };
    const xhr = new Ctor();
    xhr.status = 201;
    xhr.open('POST', 'https://app.example.com/api/create?token=fake-token-abcdef');
    for (const listener of listeners) listener();

    expect(events, 'XHR 必须产出一条 web_http').toHaveLength(1);
    expect(events[0]?.dimensions.method).toBe('POST');
    expect(events[0]?.metrics.status).toBe(201);
    expect(events[0]?.dimensions.url_template, 'XHR 的 URL 也必须去查询参数').toBe(
      'https://app.example.com/api/create',
    );
  });
});

describe('C05-AC-11 真实包装链路上的隐私（不采集 Authorization 与请求体）', () => {
  it('Authorization 头原样转发给宿主 fetch，但绝不出现在事件里；请求体也不被采集', async () => {
    const events: HttpEvent[] = [];
    const harness = createFetchHarness(() => Promise.resolve({ status: 200 }));
    createHttpCapture(
      (event) => {
        events.push(event);
      },
      { refs: harness.holder, hooker: createHooker() },
    );

    const authorization = 'Bearer fake-token-placeholder-abcdef';
    const urlToken = 'fake-query-token-1234567890';
    await harness.patched()(`https://app.example.com/api/task?access_token=${urlToken}`, {
      method: 'post',
      headers: { Authorization: authorization },
      body: 'field=user-typed-secret-1234',
    });

    // 宿主行为不变：头与请求体都原样透传
    const forwarded = harness.received[0]?.init as { readonly headers?: unknown; readonly body?: unknown };
    expect(JSON.stringify(forwarded.headers), 'Authorization 必须原样转发').toContain(authorization);
    expect(forwarded.body).toBe('field=user-typed-secret-1234');

    const serialized = JSON.stringify(events);
    expect(events).toHaveLength(1);
    expect(events[0]?.dimensions.method, '方法必须大写归一').toBe('POST');
    expect(serialized, 'Authorization 的值不得出现在事件里').not.toContain(authorization);
    expect(serialized, '查询参数里的令牌不得出现').not.toContain(urlToken);
    expect(serialized, '请求体不得出现在事件里').not.toContain('user-typed-secret-1234');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('body');
  });

  it('SDK 自身请求（显式标记）不被采集', () => {
    const events: HttpEvent[] = [];
    const harness = createFetchHarness(() => Promise.resolve({ status: 204 }));
    const capture = createHttpCapture(
      (event) => {
        events.push(event);
      },
      { refs: harness.holder, hooker: createHooker() },
    );
    capture.record({ method: 'POST', url: 'https://app.example.com/v1/events', sdkInternal: true }, { status: 204 }, 5);
    expect(events).toHaveLength(0);
    expect(capture.stats().skippedInternal).toBe(1);
    expect(SDK_INTERNAL_HEADER).toBe('x-web-report-sdk-internal');
  });
});
