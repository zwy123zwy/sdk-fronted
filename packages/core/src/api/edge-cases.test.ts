/**
 * C01 公共 API 的边界与分支用例（T12）。
 *
 * 这些用例覆盖公共 API 的异常输入、生命周期边界与加载桩回放的全部命令分支，
 * 让 `packages/core/src/**` 的覆盖率阈值（行 ≥90%、分支 ≥80%）稳定达标。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KernelEvent } from '../kernel';
import {
  STATE_CAPABILITY,
  STUB_BRIDGE_CAPABILITY,
  createClient,
  createSdk,
  createUuid,
  readLocation,
  truncate,
} from './index';
import type { ClientOptions, ClientState, DiagnosticsRecord, StubCommand } from './index';
function collect(): KernelEvent[] {
  return [];
}

function clientWith(sink: KernelEvent[], options: ClientOptions = {}): ReturnType<typeof createClient> {
  return createClient({ debug: false, ...options, onEvent: (event) => sink.push(event) });
}

function stateOf(client: ReturnType<typeof createClient>): ClientState {
  const capability = client.kernel.getCapability(STATE_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('未注册状态能力');
  return (capability as () => ClientState)();
}

/** 加载桩交接（内部能力，不是公共 API 方法）。 */
function stubBridge(client: ReturnType<typeof createClient>): (command: StubCommand) => void {
  const capability = client.kernel.getCapability(STUB_BRIDGE_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('未注册加载桩交接能力');
  return capability as (command: StubCommand) => void;
}

describe('C01 公共 API 边界', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createSdk 返回可用实例且与 createClient 相互独立', () => {
    const sdk = createSdk();
    const events: KernelEvent[] = [];
    const stop = sdk.onEvent((event) => events.push(event));

    sdk.init({ appId: 'app-sdk' });
    sdk.track('task_complete', { dimensions: { task_id: 't-1' } });
    sdk.track('page_view');

    expect(events.map((event) => event['event_name'])).toEqual(['task_complete', 'page_view']);
    expect(stateOf(sdk).app_id).toBe('app-sdk');

    // 注销后再上报不再进 sink
    stop();
    sdk.track('task_complete');
    expect(events).toHaveLength(2);

    const other = createClient({ debug: false });
    other.init({ appId: 'app-other' });
    expect(stateOf(other).app_id).toBe('app-other');
    expect(stateOf(sdk).app_id).toBe('app-sdk');

    sdk.destroy();
    other.destroy();
  });

  it('onDiagnostics 可注册与注销', () => {
    const records: DiagnosticsRecord[] = [];
    const client = clientWith(collect());
    const stop = client.onDiagnostics((record) => records.push(record));
    client.init({ appId: 'app-a' });

    client.track('sdk_health');
    expect(records).toHaveLength(1);

    stop();
    client.track('sdk_health');
    expect(records).toHaveLength(1);
    client.destroy();
  });

  it('captureError 支持字符串、对象、数字与空值', () => {
    const sink = collect();
    const client = clientWith(sink);
    client.init({ appId: 'app-a' });

    client.captureError('字符串错误');
    client.captureError(new TypeError('类型错误'));

    const circular: Record<string, unknown> = { name: 'circular' };
    circular['self'] = circular;
    client.captureError(circular);

    client.captureError(404);
    client.captureError(undefined);

    expect(sink.map((event) => event['event_name'])).toEqual(['web_js_error', 'web_js_error', 'web_js_error', 'web_js_error']);
    expect(sink[0]?.['dimensions']).toMatchObject({ message: '字符串错误' });
    expect(sink[1]?.['dimensions']).toMatchObject({ error_type: 'TypeError', message: '类型错误' });
    // 循环引用无法 JSON 序列化：退化为类型名，绝不抛错
    expect(sink[2]?.['dimensions']).toMatchObject({ message: 'object' });
    expect(sink[3]?.['dimensions']).toMatchObject({ message: '404' });
    // undefined 不是有效错误：整条丢弃并计数
    expect(client.kernel.counters.get('invalid_args')).toBe(1);
    client.destroy();
  });

  it('captureError 的 dimensions 与 attachment 优先级不被覆盖', () => {
    const sink = collect();
    const client = clientWith(sink);
    client.init({ appId: 'app-a' });

    client.captureError(new Error('boom'), {
      dimensions: { message: '业务消息', source: 'checkout' },
      attachment: '自定义附加文本',
    });

    expect(sink[0]?.['dimensions']).toMatchObject({
      error_type: 'Error',
      message: '业务消息',
      source: 'checkout',
    });
    expect(sink[0]?.['metrics']).toEqual({ count: 1 });
    expect(sink[0]?.['attachment']).toBe('自定义附加文本');
    client.destroy();
  });

  it('log 的非法级别按 info 记录并计数，且支持 attachment', () => {
    const sink = collect();
    const client = clientWith(sink);
    client.init({ appId: 'app-a' });

    (client.log as (level: string, message: string, input?: unknown) => void)('verbose', '文本', {
      attachment: 'detail',
    });

    expect(sink[0]?.['event_name']).toBe('sdk_log');
    expect(sink[0]?.['event_type']).toBe('log');
    expect(sink[0]?.['level']).toBe('info');
    // 事件体没有顶层 message：正文在 dimensions.message
    expect(sink[0]?.['message']).toBeUndefined();
    expect(sink[0]?.['dimensions']).toEqual({ message: '文本' });
    expect(sink[0]?.['attachment']).toBe('detail');
    expect(client.kernel.counters.get('invalid_args')).toBe(1);
    client.destroy();
  });

  it('setUser(hashed) 与 removeContext 的非字符串键被安全处理', () => {
    const client = clientWith(collect());
    client.init({ appId: 'app-a' });

    client.setUser('hashed-user', { hashed: true });
    expect(stateOf(client).user).toEqual({ id: 'hashed-user', hashed: true });

    client.clearUser();
    expect(stateOf(client).user).toBeUndefined();

    client.setContext('tenant', 'acme');
    expect(stateOf(client).contexts).toEqual({ tenant: 'acme' });
    (client.removeContext as (key: unknown) => void)(42);
    expect(stateOf(client).contexts).toEqual({ tenant: 'acme' });
    client.destroy();
  });

  it('init 缺 appId 被拒绝，重复 init 不改变状态，destroy 后 init 计数 destroyed', () => {
    const client = clientWith(collect());

    client.init({});
    expect(client.kernel.counters.get('invalid_args')).toBe(1);
    expect(stateOf(client).initialized).toBe(false);

    client.init({ appId: 'app-a', consent: 'buffer', pageId: '/p' });
    expect(stateOf(client).initialized).toBe(true);
    expect(stateOf(client).consent).toBe('buffer');
    expect(stateOf(client).pageId).toBe('/p');

    client.init({ appId: 'app-b' });
    expect(stateOf(client).app_id).toBe('app-a');

    client.destroy();
    const before = client.kernel.counters.get('destroyed');
    client.init({ appId: 'app-c' });
    expect(client.kernel.counters.get('destroyed')).toBeGreaterThan(before);
    // 销毁后能力注册表已被内核释放，快照不可再读；用内核生命周期状态断言
    expect(client.kernel.lifecycle.isDestroyed()).toBe(true);
  });

  it('未 init 就 flush 是安全的空操作', () => {
    const sink = collect();
    const client = clientWith(sink);
    client.flush();
    expect(sink).toHaveLength(0);
    client.destroy();
  });

  it('未 init 就 destroy 会清空命令队列', () => {
    const sink = collect();
    const client = clientWith(sink);
    client.track('task_complete');
    client.destroy();
    client.init({ appId: 'app-a' });
    client.flush();
    // destroy 立即清空命令队列：未就绪时缓存的 track 不会在 init 后被回放
    expect(sink).toHaveLength(0);
    expect(client.kernel.lifecycle.isDestroyed()).toBe(true);
  });

  it('加载桩回放覆盖全部命令分支（含未知命令）', () => {
    const sink = collect();
    const records: DiagnosticsRecord[] = [];
    const client = clientWith(sink, { debug: (record) => records.push(record) });

    const commands: readonly StubCommand[] = [
      { kind: 'init', args: [{ appId: 'app-a' }], occurredAt: 1 },
      { kind: 'track', name: 'task_complete', args: [{ dimensions: { task_id: 't-1' } }], occurredAt: 2 },
      { kind: 'log', args: ['info', '来自加载桩'], occurredAt: 3 },
      { kind: 'captureError', args: [new Error('首屏错误')], occurredAt: 4 },
      { kind: 'setUser', args: ['user-1', { hashed: false }], occurredAt: 5 },
      { kind: 'setContext', args: ['tenant', 'acme'], occurredAt: 6 },
      { kind: 'setPage', args: ['/task/:id'], occurredAt: 7 },
      { kind: 'setConsent', args: ['denied'], occurredAt: 8 },
      { kind: 'removeContext', args: ['tenant'], occurredAt: 9 },
      { kind: 'clearUser', args: [], occurredAt: 10 },
      { kind: 'flush', args: [], occurredAt: 11 },
      { kind: 'unknown_command', args: [], occurredAt: 12 },
    ];
    const bridge = stubBridge(client);
    for (const command of commands) bridge(command);

    expect(sink.map((event) => event['event_name'])).toEqual(['task_complete', 'sdk_log', 'web_js_error']);
    expect(sink[0]?.['occurred_at']).toBe(2);
    expect(stateOf(client).user).toBeUndefined();
    expect(stateOf(client).contexts).toEqual({});
    expect(stateOf(client).pageId).toBe('/task/:id');
    expect(stateOf(client).consent).toBe('denied');

    // destroy 命令走回放路径
    bridge({ kind: 'destroy', args: [], occurredAt: 13 });
    expect(client.kernel.lifecycle.isDestroyed()).toBe(true);
    // 销毁后再回放被忽略
    bridge({ kind: 'track', name: 'task_complete', args: [], occurredAt: 14 });
    expect(sink).toHaveLength(3);
  });

  it('回放时非法参数的命令被静默丢弃并计数', () => {
    const sink = collect();
    const client = clientWith(sink);

    const bridge = stubBridge(client);
    bridge({ kind: 'init', args: [], occurredAt: 1 });
    expect(client.kernel.counters.get('invalid_args')).toBe(1);

    bridge({ kind: 'init', args: [{ appId: 'app-a' }], occurredAt: 2 });
    bridge({ kind: 'track', name: 'sdk_health', args: [], occurredAt: 3 });
    bridge({ kind: 'track', args: [], occurredAt: 4 });
    bridge({ kind: 'log', args: ['verbose', 'x'], occurredAt: 5 });
    bridge({ kind: 'setUser', args: [''], occurredAt: 6 });
    bridge({ kind: 'setContext', args: ['Bad-Key', 'v'], occurredAt: 7 });
    bridge({ kind: 'setPage', args: [''], occurredAt: 8 });
    bridge({ kind: 'setConsent', args: ['maybe'], occurredAt: 9 });

    expect(client.kernel.counters.get('invalid_event_name')).toBe(2);
    expect(client.kernel.counters.get('invalid_args')).toBeGreaterThanOrEqual(6);
    // log 的非法级别按 info 兜底照常上报，其余非法命令不产生事件
    expect(sink.map((event) => event['event_name'])).toEqual(['sdk_log']);
    client.destroy();
  });

  it('事件出口抛错与调试出口抛错都被吞掉并计数 processor_error', () => {
    const client = createClient({
      onEvent: () => {
        throw new Error('sink 故障');
      },
      debug: () => {
        throw new Error('debug 故障');
      },
    });
    client.init({ appId: 'app-a' });

    client.track('task_complete');
    client.track('sdk_health');
    client.track('task_complete', { metrics: { duration_ms: Number.NaN } });

    expect(client.kernel.counters.get('processor_error')).toBeGreaterThanOrEqual(3);
    client.destroy();
  });

  it('createUuid 在无 crypto.randomUUID 时退化为 Math.random，且仍满足 UUID v4 格式', () => {
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    vi.stubGlobal('crypto', {});
    const fallback = createUuid();
    vi.unstubAllGlobals();
    const native = createUuid();

    expect(fallback).toMatch(pattern);
    expect(native).toMatch(pattern);
    expect(fallback).not.toBe(native);
  });

  it('truncate 不切断代理对', () => {
    const emoji = '\u{1F600}';
    expect(truncate(`${emoji}${emoji}`, 3)).toBe(emoji);
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('', 0)).toBe('');
  });

  it('captureError 的超长 message / attachment 被截断并计数 truncated_dimension', () => {
    const sink = collect();
    const client = clientWith(sink);
    client.init({ appId: 'app-a' });

    client.captureError(new Error('x'.repeat(300)), { attachment: 'y'.repeat(8200) });

    const event = sink[0];
    const dimensions = event?.['dimensions'] as Record<string, string>;
    expect(dimensions['message']).toHaveLength(256);
    expect((event?.['attachment'] as string).length).toBe(8192);
    expect(event?.['truncated']).toEqual(['dimensions.message', 'attachment']);
    expect(client.kernel.counters.get('truncated_dimension')).toBe(2);
    client.destroy();
  });

  it('log 的超长 message 被截断并计数 truncated_dimension', () => {
    const sink = collect();
    const client = clientWith(sink);
    client.init({ appId: 'app-a' });

    client.log('info', 'z'.repeat(300));

    const event = sink[0];
    const dimensions = event?.['dimensions'] as Record<string, string>;
    expect(dimensions['message']).toHaveLength(256);
    expect(event?.['truncated']).toEqual(['dimensions.message']);
    expect(client.kernel.counters.get('truncated_dimension')).toBe(1);
    client.destroy();
  });

  it('readLocation 在无 window 时返回全 undefined，在有 window 时读取 href', () => {
    vi.stubGlobal('window', undefined);
    expect(readLocation()).toEqual({ href: undefined, pageId: undefined });

    vi.stubGlobal('window', { location: { href: 'https://example.test/p' } });
    expect(readLocation()).toEqual({ href: 'https://example.test/p', pageId: undefined });

    vi.stubGlobal('window', { location: { href: 42 } });
    expect(readLocation()).toEqual({ href: undefined, pageId: undefined });

    vi.stubGlobal('window', 7);
    expect(readLocation()).toEqual({ href: undefined, pageId: undefined });
  });

  it('location 注入点优先于 globalThis，并用于事件快照', () => {
    vi.stubGlobal('window', { location: { href: 'https://global.test/' } });
    const sink = collect();
    const client = clientWith(sink, {
      location: { href: 'https://injected.test/p', pageId: '/injected' },
    });
    client.init({ appId: 'app-a' });
    client.track('task_complete');

    expect(sink[0]?.['url']).toBe('https://injected.test/p');
    expect(sink[0]?.['page_id']).toBe('/injected');
    client.destroy();
  });

  it('init 的 debug 与 onEvent 可以覆盖 createClient 的注入点', () => {
    const first: KernelEvent[] = [];
    const second: KernelEvent[] = [];
    const records: DiagnosticsRecord[] = [];
    const client = createClient({ onEvent: (event) => first.push(event), debug: false });

    client.init({ appId: 'app-a', onEvent: (event) => second.push(event), debug: (record) => records.push(record) });
    client.track('task_complete');
    client.track('sdk_health');

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    expect(records).toHaveLength(1);
    client.destroy();
  });
});
