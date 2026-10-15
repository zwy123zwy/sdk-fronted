/**
 * C01 公共 API 与命令队列的验收用例（T12）。
 * 用例编号对应 `tests/acceptance/C01.md` 的 C01-AC-01 至 C01-AC-12（AC-06/07/08 见 loading-stub.test.ts）。
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createCounters, createGlobalRegistry } from '../kernel';
import type { KernelEvent } from '../kernel';
import { STATE_CAPABILITY, createClient, createCommandQueue } from './index';
import type { ClientOptions, ClientState, DiagnosticsRecord } from './index';

type TestClient = ReturnType<typeof createClient>;

/** 读取实例的只读状态快照（走内核能力，不占用公共 API 方法）。 */
function stateOf(client: TestClient): ClientState {
  const capability = client.kernel.getCapability(STATE_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('未注册状态能力');
  return (capability as () => ClientState)();
}

/** 测试用事件出口：收集送入管线的输出事件（C06 传输层接入前的替身）。 */
function createSink(): KernelEvent[] {
  return [];
}

function makeClient(sink: KernelEvent[], options: ClientOptions = {}): TestClient {
  // 缺省关掉调试输出，避免用例互相污染控制台；默认 console sink 由 C01-AC-12 单独覆盖。
  return createClient({ debug: false, ...options, onEvent: (event) => sink.push(event) });
}

function firstEvent(sink: KernelEvent[]): KernelEvent {
  const event = sink[0];
  if (event === undefined) throw new Error('sink 中没有事件');
  return event;
}

/** 销毁后必须逐个计数 destroyed 的公共方法（C01-AC-03 / C02-AC-14）。 */
const ORDERED_METHODS = [
  'init',
  'track',
  'log',
  'captureError',
  'setUser',
  'clearUser',
  'setContext',
  'removeContext',
  'setPage',
  'setConsent',
  'flush',
  'destroy',
] as const;

/**
 * 逐个调用全部公共方法（独立语句；`no-confusing-void-expression` 禁止把调用结果放进表达式）。
 * 返回值类型由 `expectTypeOf` 在编译期断言（见 C01-AC-01）。
 */
function callAll(client: TestClient): void {
  client.init({ appId: 'app-a', consent: 'granted' });
  client.track('task_complete');
  client.log('info', 'hello');
  client.captureError(new Error('x'));
  client.setUser('user-1');
  client.clearUser();
  client.setContext('key', 'value');
  client.removeContext('key');
  client.setPage('/page');
  client.setConsent('granted');
  client.flush();
  client.destroy();
}

describe('C01 公共 API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('C01-AC-01 全部公共方法参数合法时同步返回 undefined 且能力生效', () => {
    const sink = createSink();
    const client = makeClient(sink);

    // 每个公共方法都同步返回 undefined：编译期逐个断言
    // （不用 `expectTypeOf(client.init)`，那会把方法从对象上摘下来触发 unbound-method）
    expectTypeOf<ReturnType<TestClient['init']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['track']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['log']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['captureError']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['setUser']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['clearUser']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['setContext']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['removeContext']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['setPage']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['setConsent']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['flush']>>().toEqualTypeOf<undefined>();
    expectTypeOf<ReturnType<TestClient['destroy']>>().toEqualTypeOf<undefined>();

    client.init({ appId: 'app-a', consent: 'granted', env: 'production', release: '1.0.0' });
    client.track('task_complete', { dimensions: { task_id: 't-1' }, metrics: { duration_ms: 12 } });
    client.log('warn', '磁盘将满', { dimensions: { disk: 'root' } });
    // captureError 的 dimensions 只接受 web_js_error 的 4 个内置键
    client.captureError(new Error('boom'), { dimensions: { source: 'checkout' } });
    client.setUser('user-1', { hashed: false });
    client.setContext('tenant', 'acme');
    client.setPage('/task/:id');
    client.setConsent('granted');
    client.flush();
    client.removeContext('tenant');
    client.clearUser();

    expect(sink.map((event) => event['event_name'])).toEqual(['task_complete', 'sdk_log', 'web_js_error']);
    // 事件体只含 $defs/event 允许的键
    for (const event of sink) {
      expect(typeof event['event_id']).toBe('string');
      expect(event['schema_version']).toBeGreaterThanOrEqual(1);
      expect(Object.prototype.hasOwnProperty.call(event, 'app_id')).toBe(false);
    }
    expect(client.kernel.counters.get('invalid_args')).toBe(0);
    expect(client.kernel.counters.get('destroyed')).toBe(0);

    client.destroy();
  });

  it('C01-AC-02 处理器抛错时不冒泡到业务并计数 processor_error', () => {
    const sink = createSink();
    const client = makeClient(sink);
    client.init({ appId: 'app-a', consent: 'granted' });
    client.kernel.registerProcessor('enrich', () => {
      throw new Error('处理器内部错误');
    });

    expect(() => {
      client.track('task_complete');
    }).not.toThrow();
    expect(client.kernel.counters.get('processor_error')).toBe(1);
  });

  it('C01-AC-03 销毁后调用全部公共方法不抛错且计数 destroyed', () => {
    const client = makeClient(createSink());
    client.init({ appId: 'app-a', consent: 'granted' });
    client.destroy();

    expect(() => {
      callAll(client);
    }).not.toThrow();
    // 首次 destroy 本身不计数（只记账「销毁后仍有调用」），其余 12 个方法各计数一次以上
    expect(client.kernel.counters.get('destroyed')).toBeGreaterThanOrEqual(ORDERED_METHODS.length - 1);
  });

  it('C01-AC-03 销毁后每个公共方法都单独计数 destroyed', () => {
    const client = makeClient(createSink());
    client.init({ appId: 'app-a', consent: 'granted' });
    client.destroy();
    const baseline = client.kernel.counters.get('destroyed');

    /** 调用一个方法并断言 destroyed 计数增加。 */
    const expectCounted = (label: string, call: () => void): void => {
      const before = client.kernel.counters.get('destroyed');
      expect(() => {
        call();
      }, label).not.toThrow();
      expect(client.kernel.counters.get('destroyed'), label).toBeGreaterThan(before);
    };

    expectCounted('init', () => {
      client.init({ appId: 'app-a', consent: 'granted' });
    });
    expectCounted('track', () => {
      client.track('task_complete');
    });
    expectCounted('log', () => {
      client.log('info', 'hello');
    });
    expectCounted('captureError', () => {
      client.captureError(new Error('x'));
    });
    expectCounted('setUser', () => {
      client.setUser('user-1');
    });
    expectCounted('clearUser', () => {
      client.clearUser();
    });
    expectCounted('setContext', () => {
      client.setContext('key', 'value');
    });
    expectCounted('removeContext', () => {
      client.removeContext('key');
    });
    expectCounted('setPage', () => {
      client.setPage('/page');
    });
    expectCounted('setConsent', () => {
      client.setConsent('granted');
    });
    expectCounted('flush', () => {
      client.flush();
    });
    expectCounted('destroy', () => {
      client.destroy();
    });

    expect(client.kernel.counters.get('destroyed')).toBeGreaterThanOrEqual(baseline + ORDERED_METHODS.length);
  });

  it('C01-AC-10 两个实例的上下文、队列与配置互相隔离', () => {
    const sinkA = createSink();
    const sinkB = createSink();
    const clientA = makeClient(sinkA, { appId: 'app-a' });
    const clientB = makeClient(sinkB, { appId: 'app-b' });

    // 初始化前各自的调用进入各自的命令队列
    clientA.track('task_complete', { dimensions: { tenant: 'a' } });
    clientA.setContext('tenant', 'a');
    clientB.track('task_complete', { dimensions: { tenant: 'b' } });
    clientB.setContext('tenant', 'b');

    clientA.init({ appId: 'app-a', consent: 'granted' });
    clientA.flush();

    expect(sinkB).toHaveLength(0);
    expect(sinkA).toHaveLength(1);
    expect(stateOf(clientA).app_id).toBe('app-a');

    clientB.init({ appId: 'app-b', consent: 'granted' });
    clientB.flush();

    expect(sinkA).toHaveLength(1);
    expect(sinkB).toHaveLength(1);
    expect(stateOf(clientB).app_id).toBe('app-b');

    // 销毁一个实例不影响另一个实例
    clientA.destroy();
    expect(clientB.kernel.counters.get('destroyed')).toBe(0);
    expect(() => {
      clientB.track('task_complete');
    }).not.toThrow();

    clientB.destroy();
  });

  it('C01-AC-10 两个实例的用户、上下文与同意状态互相隔离', () => {
    const clientA = makeClient(createSink(), { appId: 'app-a' });
    const clientB = makeClient(createSink(), { appId: 'app-b' });

    clientA.init({ appId: 'app-a', consent: 'granted' });
    // clientB 刻意不传 consent：本用例同时守住「未设置时初始态为 unknown」（Q5）与实例隔离。
    clientB.init({ appId: 'app-b' });
    clientA.setUser('user-a');
    clientB.setUser('user-b');
    clientA.setContext('tenant', 'a');
    clientB.setContext('tenant', 'b');
    clientA.setConsent('denied');
    clientA.setPage('/a');

    expect(stateOf(clientA).user?.id).toBe('user-a');
    expect(stateOf(clientB).user?.id).toBe('user-b');
    expect(stateOf(clientA).contexts).toEqual({ tenant: 'a' });
    expect(stateOf(clientB).contexts).toEqual({ tenant: 'b' });
    expect(stateOf(clientA).consent).toBe('denied');
    // 2026-10-13 负责人签字的 Q5 一致性修正：未设置同意时，初始态是 `unknown`（原为 `granted`）。
    // Q5 原文：「初始化时为 `unknown`，接入方可以在初始化参数中传入已知状态」。
    expect(stateOf(clientB).consent).toBe('unknown');
    expect(stateOf(clientA).pageId).toBe('/a');
    expect(stateOf(clientB).pageId).toBeUndefined();
    expect(stateOf(clientA).app_id).toBe('app-a');
    expect(stateOf(clientB).app_id).toBe('app-b');

    clientA.destroy();
    clientB.destroy();
  });

  it('C01-AC-10 两个实例共享同一注册表时，同一原生事件只注册一次监听', () => {
    const target = new EventTarget();
    const sinkA = createSink();
    const sinkB = createSink();
    // 页面上共享一份全局注册表；计数器仍各实例独立（内核不共享 counters）
    const registry = createGlobalRegistry({ counters: createCounters(), target });
    const clientA = makeClient(sinkA, { target, registry });
    const clientB = makeClient(sinkB, { target, registry });

    expect(clientA.kernel.registry).toBe(registry);
    expect(clientB.kernel.registry).toBe(registry);
    expect(clientA.kernel.counters).not.toBe(clientB.kernel.counters);

    // 两个实例各自订阅同一原生事件，再加一个同实例内的重复订阅者
    registry.listen(target, 'visibilitychange', () => undefined);
    registry.listen(target, 'visibilitychange', () => undefined);

    expect(registry.stats().nativeListeners).toBe(1);

    clientA.init({ appId: 'app-a', consent: 'granted' });
    clientB.init({ appId: 'app-b', consent: 'granted' });

    let handledA = 0;
    let handledB = 0;
    clientA.kernel.registerProcessor('enrich', (event) => {
      if (event['event_name'] === 'page_view') handledA += 1;
      return event;
    });
    clientB.kernel.registerProcessor('enrich', (event) => {
      if (event['event_name'] === 'page_view') handledB += 1;
      return event;
    });
    clientA.track('page_view');
    clientB.track('page_view');

    expect(handledA).toBe(1);
    expect(handledB).toBe(1);
    expect(sinkA).toHaveLength(1);
    expect(sinkB).toHaveLength(1);
    // 跨实例也只有一份原生监听
    expect(registry.stats().nativeListeners).toBe(1);

    // 销毁 A 释放共享注册表；B 的订阅随之失效（共享注册表由页面上层持有并重建）
    clientA.destroy();
    expect(registry.stats().nativeListeners).toBe(0);
    expect(clientB.kernel.counters.get('destroyed')).toBe(0);
    clientB.destroy();
  });

  it('C01-AC-10 不传注册表时每个实例各自一份（实例间互不影响）', () => {
    const target = new EventTarget();
    const clientA = makeClient(createSink(), { target });
    const clientB = makeClient(createSink(), { target });

    expect(clientA.kernel.registry).not.toBe(clientB.kernel.registry);
    clientA.kernel.registry.listen(target, 'visibilitychange', () => undefined);
    clientB.kernel.registry.listen(target, 'visibilitychange', () => undefined);
    expect(clientA.kernel.registry.stats().nativeListeners).toBe(1);
    expect(clientB.kernel.registry.stats().nativeListeners).toBe(1);

    clientA.destroy();
    expect(clientA.kernel.registry.stats().nativeListeners).toBe(0);
    expect(clientB.kernel.registry.stats().nativeListeners).toBe(1);
    clientB.destroy();
  });
});

describe('C01 命令队列', () => {
  it('C01-AC-04 未就绪时的调用按顺序回放并使用调用当时的 occurred_at、page_id、url', () => {
    const before = Date.now();
    const sink = createSink();
    const client = makeClient(sink);

    vi.stubGlobal('window', { location: { href: 'https://a.example/p/1' } });
    client.track('task_t0');
    vi.stubGlobal('window', { location: { href: 'https://a.example/p/2' } });
    client.track('task_t1');
    client.setUser('user-1');
    vi.stubGlobal('window', { location: { href: 'https://a.example/p/3' } });
    client.track('task_t2');
    const after = Date.now();

    client.init({ appId: 'app-a', consent: 'granted', pageId: '/p/current' });
    client.flush();

    expect(sink.map((event) => event['event_name'])).toEqual(['task_t0', 'task_t1', 'task_t2']);
    // url 必须是调用当时的值（回放时页面已经不在 p/1、p/2）
    expect(sink.map((event) => event['url'])).toEqual([
      'https://a.example/p/1',
      'https://a.example/p/2',
      'https://a.example/p/3',
    ]);
    // page_id 取生效中的手动页面（init 时设置）；url 与 occurred_at 是调用当时的快照，
    // 两者在回放时可能已经不同，这正是 C01-AC-04 要保证的部分。
    expect(sink.map((event) => event['page_id'])).toEqual(['/p/current', '/p/current', '/p/current']);

    const occurredAt: number[] = sink.map((event) => event['occurred_at']);
    expect(occurredAt).toEqual([...occurredAt].sort((left, right) => left - right));
    for (const value of occurredAt) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(before);
      expect(value).toBeLessThanOrEqual(after);
    }
    expect(stateOf(client).user?.id).toBe('user-1');
  });

  it('C01-AC-04 就绪后设置的页面标识会出现在之后的事件上', () => {
    const sink = createSink();
    const client = makeClient(sink, { appId: 'app-a' });
    client.init({ appId: 'app-a', consent: 'granted' });
    client.setPage('/task/:id');
    client.track('task_complete');
    client.flush();

    expect(sink).toHaveLength(1);
    expect(sink[0]?.['page_id']).toBe('/task/:id');
  });

  it('C01-AC-05 命令队列只保留最早 200 次调用并计数 command_queue_overflow', () => {
    const sink = createSink();
    const client = makeClient(sink);

    for (let index = 0; index < 250; index += 1) {
      client.track(`queue_event_${String(index)}`);
    }

    expect(client.kernel.counters.get('command_queue_overflow')).toBe(50);
    client.init({ appId: 'app-a', consent: 'granted' });
    client.flush();

    expect(sink).toHaveLength(200);
    expect(sink[0]?.['event_name']).toBe('queue_event_0');
    expect(sink[199]?.['event_name']).toBe('queue_event_199');
  });

  it('C01-AC-05 命令队列上限为 200 条且溢出时丢弃新到达的命令', () => {
    const queue = createCommandQueue();
    let rejected = 0;
    for (let index = 0; index < 250; index += 1) {
      const result = queue.push({
        kind: 'track',
        name: `queue_event_${String(index)}`,
        eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        occurredAt: index,
      });
      if (result.status === 'rejected') rejected += 1;
    }

    expect(queue.capacity()).toBe(200);
    expect(queue.size()).toBe(200);
    expect(rejected).toBe(50);
    expect(queue.shift()?.name).toBe('queue_event_0');
    expect(queue.shift()?.name).toBe('queue_event_1');
    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.shift()).toBeUndefined();
  });
});

describe('C01 参数校验与调试输出', () => {
  it('C01-AC-11 非法事件名、非对象维度与 NaN 指标被静默丢弃并计数原因码', () => {
    const sink = createSink();
    const client = makeClient(sink);
    client.init({ appId: 'app-a', consent: 'granted' });

    // 非法事件名（含保留前缀）：整条丢弃
    client.track('1bad-name');
    client.track('sdk_health');
    expect(client.kernel.counters.get('invalid_event_name')).toBe(2);
    expect(sink).toHaveLength(0);

    // 非对象维度：丢弃该字段，事件仍然发出（故意传非法类型，验证运行时静默丢弃）
    const looseTrack = (name: string, input?: { dimensions?: unknown; metrics?: unknown }): void => {
      (client.track as (n: string, i?: unknown) => void)(name, input);
    };
    looseTrack('task_complete', { dimensions: 'not-an-object' });
    expect(client.kernel.counters.get('invalid_args')).toBe(1);
    expect(sink).toHaveLength(1);
    expect(firstEvent(sink)['dimensions']).toBeUndefined();

    // NaN 指标：丢弃该字段，其他指标保留
    client.track('task_complete', { metrics: { duration_ms: Number.NaN, size_bytes: 12 } });
    expect(client.kernel.counters.get('non_finite_metric')).toBe(1);
    expect(sink).toHaveLength(2);
    expect(sink[1]?.['metrics']).toEqual({ size_bytes: 12 });

    // 非法参数（枚举取值、类型、键名格式）静默丢弃：
    // 这里故意用类型系统不接受的值，验证运行时的静默丢弃（C01-F6）
    const loose = client as unknown as {
      log(level: string, message: string): undefined;
      setConsent(state: string): undefined;
      setPage(pageId: string): undefined;
      setUser(id: string): undefined;
      setContext(key: string, value: string): undefined;
    };
    loose.log('verbose', 'hello');
    loose.setConsent('maybe');
    loose.setPage('');
    loose.setUser('');
    loose.setContext('Bad-Key', 'v');
    // 2026-10-13 契约一致性迁移：非法**键名**归 C04 的 `invalid_field_key`（不再是 `invalid_args`）。
    expect(client.kernel.counters.get('invalid_args')).toBe(5);
    expect(client.kernel.counters.get('invalid_field_key')).toBe(1);
    client.destroy();
  });

  it('C01-AC-12 可注入的调试 sink 收到包含原因码的结构化记录且不含令牌', () => {
    const records: DiagnosticsRecord[] = [];
    const sink = createSink();
    const client = makeClient(sink, {
      token: 'top-secret-token',
      debug: (record) => records.push(record),
    });
    client.init({ appId: 'app-a', consent: 'granted', token: 'top-secret-token' });

    client.track('sdk_health');
    client.track('task_complete', { metrics: { duration_ms: Number.NaN } });
    const looseTrack = (name: string, input?: { dimensions?: unknown }): void => {
      (client.track as (n: string, i?: unknown) => void)(name, input);
    };
    looseTrack('task_complete', { dimensions: 'nope' });

    // 2026-10-15（编排方裁决 A）：`token` 属装配根字段（消费点是 `AssemblyOptions.token`），
    // 在 core 的构造/init 面改为**显式拒绝** —— 计 `invalid_args` 并发
    // `dropped: 'field'` / `field: 'token'` 诊断，不再静默忽略。因此序列多了两条前导
    // `invalid_args`（createClient 一次、init 一次）。**「token 值绝不出现」的意图与断言原样保留**
    // （见本用例最后一行）：诊断记录只带字段名 `token`，不带值。
    expect(records.map((record) => record.reason_code)).toEqual([
      'invalid_args',
      'invalid_args',
      'invalid_event_name',
      'non_finite_metric',
      'invalid_args',
    ]);
    expect(records[0]?.kind).toBe('init');
    expect(records[0]?.dropped).toBe('field');
    expect(records[0]?.field).toBe('token');
    expect(records[1]?.kind).toBe('init');
    expect(records[1]?.field).toBe('token');
    expect(records[2]?.event_name).toBe('sdk_health');
    expect(records[2]?.kind).toBe('track');
    expect(records[2]?.dropped).toBe('event');
    expect(records[3]?.dropped).toBe('field');
    expect(records[3]?.field).toBe('metrics.duration_ms');
    expect(JSON.stringify(records)).not.toContain('top-secret-token');
    client.destroy();
  });

  it('C01-AC-12 显式开启调试（debug: true）后控制台输出原因码且不含令牌', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = createClient({ debug: true, onEvent: () => undefined });
      client.init({ appId: 'app-a', consent: 'granted', token: 'top-secret-token' });

      client.track('sdk_health');
      client.track('task_complete', { metrics: { duration_ms: Number.NaN } });

      const lines: string[] = warn.mock.calls.map((call) => JSON.stringify(call));
      // 同上裁决：`init({ token })` 现在先产生一条字段级拒绝告警（`field=token`），因此行数为 3。
      // 逐行精确对应，不改宽为"包含任意原因码"；token 值仍不得出现（最后一行）。
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('invalid_args');
      expect(lines[0]).toContain('field=token');
      expect(lines[1]).toContain('invalid_event_name');
      expect(lines[1]).toContain('sdk_health');
      expect(lines[2]).toContain('non_finite_metric');
      expect(lines[2]).toContain('metrics.duration_ms');
      expect(lines.join('\n')).not.toContain('top-secret-token');
      client.destroy();
    } finally {
      warn.mockRestore();
    }
  });

  it('C01-AC-12 缺省调试输出静默（C08-AC-09：不因 URL 参数自动开启调试）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const client = createClient({ onEvent: () => undefined });
      client.init({ appId: 'app-a', consent: 'granted' });
      client.track('sdk_health');
      client.track('task_complete', { metrics: { duration_ms: Number.NaN } });
      expect(warn).not.toHaveBeenCalled();
      client.destroy();
    } finally {
      warn.mockRestore();
    }
  });

  it('C01-AC-12 输出 sink 与调试 sink 抛错都不影响业务调用', () => {
    const client = createClient({
      onEvent: () => {
        throw new Error('sink 故障');
      },
      debug: () => {
        throw new Error('debug sink 故障');
      },
    });

    expect(() => {
      client.init({ appId: 'app-a', consent: 'granted' });
      client.track('task_complete');
      client.track('task_complete', { metrics: { duration_ms: Number.NaN } });
      client.flush();
      client.destroy();
    }).not.toThrow();
  });
});
