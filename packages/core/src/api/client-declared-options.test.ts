/**
 * 「声明了但没读」的公共 API 参数：逐条修复的回归用例（来源：`docs/reports/t33-access-blockers.md` 的 D-09
 * 同族清单 + 本轮发布阻塞点 ⑧）。
 *
 * 缺陷形状统一为：`ClientInitOptions` 里声明了字段，某个入口却**从不读取**它 —— 接入方看起来设了、
 * 实际没设、也不报错（D-09 的 `createClient({ consent })` 是同一族）。
 *
 * 本文件覆盖的处置：
 * - `createClient({ appId })`：构造面生效（`init` 覆盖构造，与 `consent` 同序）；
 * - `init({ env | release })`：init 生效并覆盖构造值，两处都缺省时仍是 `production` / `0.0.0`；
 * - `init({ extra_mask_rules })`：**追加**到构造面的规则集（不覆盖、不关闭内置 7 条、不二次施加）；
 * - `createClient({ endpoint })` / `init({ endpoint })`：core 面无消费点 → **显式拒绝**
 *   （计 `invalid_args` + `dropped: 'field'` 诊断），不再静默忽略；
 * - `createClient({ token })` / `init({ token })`：同 `endpoint` 显式拒绝；诊断记录只带字段名
 *   `token`，**绝不带令牌值**（C01-AC-12 的意图原样保留）。
 *
 * 测试数据全部是格式合法的伪造值（非真实个人信息）。
 */
import { describe, expect, it } from 'vitest';

import { BATCH_HEADER_CAPABILITY, createClient } from './client';
import type { Client, ClientOptions, DiagnosticsRecord, EventSink } from './types';
import type { C04BatchHeader } from '../context';
import type { KernelEvent } from '../kernel';

/** 内置 `cn_mobile` 规则命中的伪造手机号（格式合法、非真实号码）。 */
const FAKE_PHONE = '13800138000';

/** 读取批次头 provider（内核能力 `sdk.batch_header`）。 */
function headerOf(client: Client): () => C04BatchHeader {
  const capability = client.kernel.getCapability(BATCH_HEADER_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('缺少 sdk.batch_header 能力');
  return capability as () => C04BatchHeader;
}

function collector(): { sink: EventSink; events: KernelEvent[] } {
  const events: KernelEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

/** 取首条事件的 `dimensions`。 */
function dimensionsOf(events: KernelEvent[]): Record<string, string> {
  return (events[0]?.['dimensions'] ?? {}) as Record<string, string>;
}

const clients: Client[] = [];
function open(options: ClientOptions): Client {
  const client = createClient(options);
  clients.push(client);
  return client;
}

describe('`createClient({ appId })` 必须被读取（D-09 同族）', () => {
  it('构造面给了 appId：init({}) 不再计 invalid_args、实例完成初始化、批头 app_id 正确', () => {
    const client = open({ appId: 'app-ctor' });
    client.init({});

    expect(client.kernel.counters.get('invalid_args')).toBe(0);
    expect(headerOf(client)().app_id).toBe('app-ctor');
    client.destroy();
  });

  it('两个入口都给时 init 覆盖构造值（与 consent 同序）', () => {
    const client = open({ appId: 'app-ctor' });
    client.init({ appId: 'app-init' });

    expect(headerOf(client)().app_id).toBe('app-init');
    client.destroy();
  });

  it('两处都没有 appId 时仍然拒绝并计 invalid_args（必填未放松）', () => {
    const client = open({});
    client.init({});

    expect(client.kernel.counters.get('invalid_args')).toBe(1);
    expect(headerOf(client)().app_id).toBe('');
    client.destroy();
  });
});

describe('`init({ env | release })` 必须被读取', () => {
  it('init 传入 env/release：批次头采用（此前被静默忽略 → 仍是 production/0.0.0）', () => {
    const client = open({});
    client.init({ appId: 'app-a', env: 'prod-x', release: '9.9.9' });

    const header = headerOf(client)();
    expect(header.env).toBe('prod-x');
    expect(header.release).toBe('9.9.9');
    client.destroy();
  });

  it('构造面可传、init 覆盖；init 未传时保留构造值', () => {
    const client = open({ env: 'ctor-env', release: '1.0.0' });
    client.init({ appId: 'app-a', env: 'init-env' });

    const header = headerOf(client)();
    expect(header.env).toBe('init-env');
    expect(header.release).toBe('1.0.0');
    client.destroy();
  });

  it('两处都缺省时仍是 production / 0.0.0（缺省口径不变）', () => {
    const client = open({});
    client.init({ appId: 'app-a' });

    const header = headerOf(client)();
    expect(header.env).toBe('production');
    expect(header.release).toBe('0.0.0');
    client.destroy();
  });
});

describe('`init({ extra_mask_rules })` 必须生效且只能追加（脱敏保守方向）', () => {
  it('init 传入的规则对之后的事件生效（此前被静默忽略 → 原样上报）', () => {
    const { sink, events } = collector();
    const client = open({ onEvent: sink, consent: 'granted' });
    client.init({
      appId: 'app-a',
      extra_mask_rules: [{ name: 'probe_secret', pattern: 'SECRETVALUE', replacement: '***', builtin: false }],
    });
    client.track('task_complete', { dimensions: { note: 'value=SECRETVALUE' } });

    expect(dimensionsOf(events)['note']).toBe('value=***');
    client.destroy();
  });

  it('内置规则仍不可关闭：init 追加规则后，内置 cn_mobile 依旧脱敏', () => {
    const { sink, events } = collector();
    const client = open({ onEvent: sink, consent: 'granted' });
    client.init({
      appId: 'app-a',
      extra_mask_rules: [{ name: 'probe_secret', pattern: 'SECRETVALUE', replacement: '***', builtin: false }],
    });
    client.track('task_complete', { dimensions: { contact: `call ${FAKE_PHONE}`, note: 'SECRETVALUE' } });

    const dimensions = dimensionsOf(events);
    expect(dimensions['contact']).not.toContain(FAKE_PHONE);
    expect(dimensions['note']).toBe('***');
    client.destroy();
  });

  it('追加而非覆盖：构造面与 init 面的规则同时生效', () => {
    const { sink, events } = collector();
    const client = open({
      onEvent: sink,
      consent: 'granted',
      extra_mask_rules: [{ name: 'ctor_rule', pattern: 'CTORSECRET', replacement: '***', builtin: false }],
    });
    client.init({
      appId: 'app-a',
      extra_mask_rules: [{ name: 'init_rule', pattern: 'INITSECRET', replacement: '***', builtin: false }],
    });
    client.track('task_complete', { dimensions: { note: 'CTORSECRET and INITSECRET' } });

    expect(dimensionsOf(events)['note']).toBe('*** and ***');
    client.destroy();
  });

  it('追加规则不二次施加：替换串再命中同一规则也只施加一次', () => {
    const { sink, events } = collector();
    const client = open({ onEvent: sink, consent: 'granted' });
    // 规则把 `x` 换成 `xx`：单次施加得 `xx`，二次施加会变成 `xxxx`（判别性断言）。
    client.init({
      appId: 'app-a',
      extra_mask_rules: [{ name: 'probe_double', pattern: 'x', replacement: 'xx', builtin: false }],
    });
    client.track('task_complete', { dimensions: { note: 'x' } });

    expect(dimensionsOf(events)['note']).toBe('xx');
    client.destroy();
  });
});

describe('`endpoint` 属装配根：core 面显式拒绝，不静默忽略', () => {
  it('createClient({ endpoint })：计 invalid_args 并留下 field=endpoint 的诊断记录', () => {
    const records: DiagnosticsRecord[] = [];
    const client = open({ endpoint: 'https://collect.example/ingest', debug: (record) => records.push(record) });

    expect(client.kernel.counters.get('invalid_args')).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.reason_code).toBe('invalid_args');
    expect(records[0]?.kind).toBe('init');
    expect(records[0]?.dropped).toBe('field');
    expect(records[0]?.field).toBe('endpoint');
    client.destroy();
  });

  it('init({ endpoint })：同样计 invalid_args 并留下诊断记录', () => {
    const records: DiagnosticsRecord[] = [];
    const client = open({ debug: (record) => records.push(record) });
    client.init({ appId: 'app-a', endpoint: 'https://collect.example/ingest' });

    expect(client.kernel.counters.get('invalid_args')).toBe(1);
    expect(records.map((record) => record.field)).toEqual(['endpoint']);
    // 初始化本身照常完成（拒绝的是这个字段，不是整个 init）。
    expect(headerOf(client)().app_id).toBe('app-a');
    client.destroy();
  });

  it('不传 endpoint 时不计 invalid_args（拒绝判据不误伤正常路径）', () => {
    const client = open({});
    client.init({ appId: 'app-a' });

    expect(client.kernel.counters.get('invalid_args')).toBe(0);
    client.destroy();
  });
});

describe('`token` 属装配根：core 面显式拒绝，且绝不泄漏令牌值', () => {
  it('createClient({ token }) 与 init({ token }) 各计一次 invalid_args、各留一条 field=token 诊断', () => {
    const records: DiagnosticsRecord[] = [];
    const client = open({ token: 'placeholder-write-token-0002', debug: (record) => records.push(record) });
    client.init({ appId: 'app-a', token: 'placeholder-write-token-0002' });

    expect(client.kernel.counters.get('invalid_args')).toBe(2);
    expect(records.map((record) => record.field)).toEqual(['token', 'token']);
    expect(records.map((record) => record.kind)).toEqual(['init', 'init']);
    expect(records.map((record) => record.dropped)).toEqual(['field', 'field']);
    client.destroy();
  });

  it('诊断记录只带字段名、不带令牌值（C01-AC-12 的意图不变）', () => {
    const records: DiagnosticsRecord[] = [];
    const client = open({ token: 'placeholder-write-token-0002', debug: (record) => records.push(record) });
    client.init({ appId: 'app-a', token: 'placeholder-write-token-0002' });

    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain('placeholder-write-token-0002');
    client.destroy();
  });
});
