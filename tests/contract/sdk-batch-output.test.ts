/**
 * T10 追加项：用 Ajv 校验 **C06 批次组装器的真实批次产出**。
 *
 * 与 T15 的关系：T15 在自己的单测里也用 Ajv 校验组装结果，但那是**包内**自证，
 * 仓库级的契约门禁（`pnpm test:contract`）看不到它。本文件不复制一套判定逻辑——
 * 它编译的是**同一份冻结 Schema**（`docs/contracts/schemas/batch.schema.json`，
 * 经 `compileContractRegistry()` 登记的同一份文件），补足的是
 * 「仓库级契约门禁能独立抓住产出违规」以及 T15 未覆盖的组合
 * （同一批次同时含 `critical` 与 `normal`、含 `sdk_log` / `web_js_error`）。
 *
 * 输入不是手写事件，而是 **C01 公共 API 的真实产出**，再经 C06 组装器，
 * 因此这条链路校验的是 C01 → C06 的真实数据流。
 */
import { describe, expect, it } from 'vitest';
import { asArray, asRecord } from './lib/fs-json';
import { compileContractRegistry } from './lib/schemas';
import {
  loadCoreModule,
  loadTransportModule,
  type RealAssemblerOptions,
  type RealBatchAssembler,
  type RealClient,
  type RealTransportModule,
  type SdkEvent,
} from './lib/sdk-runtime';

const registry = compileContractRegistry();

const FAKE_LOCATION = { href: 'https://example.test/task/42?q=demo', pageId: '/task/:id' };
const SENT_AT = 1700000000000;
const BATCH_ID = 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e';

const format = (value: unknown): string => JSON.stringify(value, null, 2);

/** 固定批次头（真实批次头由 C04/C07 提供；这里作为注入的假来源，只求字段合法）。 */
const buildHeader = (): Record<string, unknown> => ({
  protocol_version: 1,
  app_id: 'app-a',
  env: 'production',
  release: '1.0.0',
  sdk_name: '@web-report-sdk/browser',
  sdk_version: '0.0.0',
  device_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  session_id: '9c858901-8a57-4791-81fe-4c455b099bc9',
  clock_offset: 0,
});

/** 组装器，`now` / `createId` 固定以保证可复现。 */
const createAssembler = (transport: RealTransportModule): RealBatchAssembler => {
  const options: RealAssemblerOptions = {
    header: { header: buildHeader },
    now: () => SENT_AT,
    createId: () => BATCH_ID,
  };
  return transport.createBatchAssembler(options);
};

/** 线上报文：`JSON.stringify` 会丢掉 undefined 字段，接收方看到的就是这个对象。 */
const toWire = (batch: unknown): unknown => JSON.parse(JSON.stringify(batch)) as unknown;

/** 断言批次（内存对象与线上 JSON 两种形态）通过完整的 `batch.schema.json`。 */
const expectBatchValid = (batch: unknown): void => {
  for (const [label, payload] of [
    ['内存对象', batch],
    ['线上 JSON', toWire(batch)],
  ] as const) {
    const outcome = registry.validate('batch', payload);
    expect(
      outcome.errors,
      `${label}未通过 batch.schema.json：\n${format(batch)}\n${outcome.errors.join('\n')}`,
    ).toEqual([]);
    expect(outcome.valid).toBe(true);
  }
};

/** 断言批次（线上 JSON 形态）被完整 `batch.schema.json` 拒绝，返回逐条 Ajv 错误。 */
const expectBatchInvalid = (batch: unknown, label: string): readonly string[] => {
  const outcome = registry.validate('batch', toWire(batch));
  expect(outcome.valid, `${label} 本应被 batch.schema.json 拒绝，实际却通过：\n${format(batch)}`).toBe(false);
  expect(outcome.errors.length).toBeGreaterThan(0);
  return outcome.errors;
};

/** 驱动真实 C01 产出事件，交给 `drive` 调用公共 API。 */
const collectEvents = async (
  initOptions: Record<string, unknown>,
  drive: (client: RealClient) => void,
): Promise<readonly SdkEvent[]> => {
  const core = await loadCoreModule();
  const events: SdkEvent[] = [];
  const client = core.createClient({
    // Node 环境没有 window；null 是文档记载的「原生订阅静默降级」路径。
    target: null,
    location: FAKE_LOCATION,
    onEvent: (event: unknown): void => {
      events.push(asRecord(event, 'C01 产出的事件'));
    },
  });
  // Q5 一致性修正（2026-10-13）后同意缺省为 `unknown`（+ `essential_only` 会拦下非必要事件），
  // 因此这里显式注入 `granted`；调用方可用 `consent` 覆盖以验证同意相关行为。
  client.init({ consent: 'granted', ...initOptions });
  drive(client);
  client.flush();
  client.destroy();
  return events;
};

describe('产出校验：C06 批次组装器的真实批次产出', () => {
  it('产出校验：同一批次同时含 critical 与 normal 事件时通过完整 batch.schema.json', async () => {
    const transport = await loadTransportModule();
    const events = await collectEvents(
      {
        appId: 'app-a',
        dictionary: {
          task_complete: { priority: 'critical', schema_version: 2, dimensions: {}, metrics: {} },
        },
      },
      (client) => {
        client.track('task_complete', { dimensions: { task_id: 't-1' }, metrics: { duration_ms: 12 } });
        client.track('page_view', { dimensions: { route: '/task/42' } });
      },
    );

    expect(events.map((event) => event['priority'])).toEqual(['critical', 'normal']);
    expect(events.map((event) => event['schema_version'])).toEqual([2, 1]);

    const batch = createAssembler(transport).assemble(events);
    expectBatchValid(batch);

    // 两个事件来自同一假 location，page_id / url 取值相同 → 被提升到批次 common
    expect(asArray(batch['events'], 'batch.events')).toHaveLength(2);
    expect(asRecord(batch['common'], 'batch.common')['page_id']).toBe('/task/:id');
    // C04（T14）落地后 URL 经过脱敏：查询参数不在白名单里的一律删除
    // （本用例没有配置 `url_query_allowlist`，因此 `?q=demo` 被删除）。
    // 见 `packages/core/README.md` 第 28 节与 `docs/contracts/remote-config.md` 5.4。
    expect(asRecord(batch['common'], 'batch.common')['url']).toBe('https://example.test/task/42');
    expect(batch['batch_id']).toBe(BATCH_ID);
    expect(batch['sent_at']).toBe(SENT_AT);
  });

  it('产出校验：含 sdk_log 与 web_js_error 的批次通过完整 batch.schema.json（T15 未覆盖的组合）', async () => {
    const transport = await loadTransportModule();
    const events = await collectEvents({ appId: 'app-a' }, (client) => {
      client.log('info', '启动完成');
      client.captureError(new TypeError('无法读取属性 x'), { metrics: { count: 2, line: 3 } });
    });

    expect(events.map((event) => event['event_name'])).toEqual(['sdk_log', 'web_js_error']);

    const batch = createAssembler(transport).assemble(events);
    expectBatchValid(batch);

    // 批次内的每个事件仍然各自通过 $defs/event；web_js_error 另通过内置事件 Schema
    for (const item of asArray(batch['events'], 'batch.events')) {
      const event = asRecord(item, 'batch.events[i]');
      expect(registry.validateFragment('batch', 'event', event).valid).toBe(true);
      if (event['event_name'] === 'web_js_error') {
        expect(registry.validate('web_js_error', event).valid).toBe(true);
      }
      if (event['event_type'] === 'log') {
        expect(event['level']).toBe('info');
      }
    }
  });

  it('产出校验：四条真实事件（critical + normal + sdk_log + web_js_error）同批组装后通过完整 batch.schema.json', async () => {
    const transport = await loadTransportModule();
    const events = await collectEvents(
      {
        appId: 'app-a',
        dictionary: {
          task_complete: { priority: 'critical', schema_version: 3, dimensions: {}, metrics: {} },
        },
      },
      (client) => {
        client.track('task_complete', { dimensions: { task_id: 't-9' }, metrics: { duration_ms: 3 } });
        client.track('page_view', { dimensions: { route: '/task/9' } });
        client.log('warn', '磁盘将满', { dimensions: { disk: 'root' } });
        client.captureError('字符串错误');
      },
    );

    expect(events).toHaveLength(4);
    const batch = createAssembler(transport).assemble(events);
    expectBatchValid(batch);
    expect(asArray(batch['events'], 'batch.events')).toHaveLength(4);
  });
});

describe('反向对照：C06 组装路径上的契约违反会被仓库级门禁拒绝', () => {
  it('反向对照：缺 event_id / schema_version、event_id 非 UUID、event_type 越界的事件经组装后批次校验失败', async () => {
    const transport = await loadTransportModule();
    const assembler = createAssembler(transport);

    // 注：C06 的 projectEvent 只输出契约声明的事件字段，因此顶层 app_id 这类
    // 「多字段」违反在这里会被组装器本身丢掉，不会进入批次——它由
    // sdk-core-output.test.ts 直接在 C01 产出一层抓住（那才是它出现的位置）。
    // 这里构造的是能穿到批次里、必须由 batch.schema.json 抓住的违反。
    const defective: readonly Record<string, unknown>[] = [
      {
        event_id: 'not-a-uuid',
        event_name: 'task_complete',
        event_type: 'bogus',
        schema_version: 1,
        occurred_at: SENT_AT,
      },
      {
        // 模拟 T12 首轮缺 event_id / schema_version 的产出
        event_name: 'task_complete',
        event_type: 'custom',
        occurred_at: SENT_AT,
        priority: 'normal',
      },
    ];
    const batch = assembler.assemble(defective);
    const errors = expectBatchInvalid(batch, '含历史违反事件的批次');
    const joined = errors.join('\n');
    expect(joined).toContain('event_id');
    expect(joined).toContain('event_type');
    expect(joined).toContain('schema_version');
    expect(joined).toContain('priority');
    // 错误必须定位到事件数组里的具体位置
    expect(joined).toContain('events/0');
    expect(joined).toContain('events/1');
  });

  it('反证：同一组装器产出的合法批次通过校验，说明上一条的失败来自数据本身', async () => {
    const transport = await loadTransportModule();
    const events = await collectEvents({ appId: 'app-a' }, (client) => {
      client.track('page_view', { dimensions: { route: '/a' } });
    });
    const batch = createAssembler(transport).assemble(events);
    expectBatchValid(batch);
    expect(registry.validate('batch', toWire(batch)).valid).toBe(true);
  });
});
