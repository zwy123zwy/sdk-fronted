/**
 * T10 追加项：用 Ajv 校验 **C01 公共 API 的真实产出**。
 *
 * 背景：T10 首轮只校验契约样例，不校验真实产出；T12 首轮交付的 105 条单测虽然全绿，
 * 但它产出的事件违反 5 处冻结契约（顶层 `app_id`、缺 `event_id`、缺 `schema_version`、
 * `log` 把 `message` 放在事件顶层、`web_js_error` 缺 `source`/`fingerprint`/`metrics.count`）。
 * 本文件让「产出不符合冻结契约」在 `pnpm test:contract` 里直接失败。
 *
 * 校验目标（全部是 `docs/contracts/` 下的冻结 Schema，只读）：
 * - 每个事件体对 `batch.schema.json` 的 `$defs/event`；
 * - `event_name === 'web_js_error'` 的事件**另**对 `builtin-events/web_js_error.schema.json`；
 * - `event_name === 'sdk_log'` 的事件按 `event_type: 'log'` 的要求核对 `level` 必填。
 *
 * 驱动方式：真实入口 + 注入的假 target / 假 location（Node 环境没有 `window`）。
 * 入口与类型边界的设计说明见 `./lib/sdk-runtime.ts` 的文件头注释。
 */
import { describe, expect, it } from 'vitest';
import { asRecord, requireString } from './lib/fs-json';
import { compileContractRegistry } from './lib/schemas';
import { loadCoreModule, type RealClient, type RealCoreModule, type SdkEvent } from './lib/sdk-runtime';

const registry = compileContractRegistry();

/** 注入的假 location：`url` / `page_id` 是调用当时的快照。 */
const FAKE_LOCATION = { href: 'https://example.test/task/42?q=demo', pageId: '/task/:id' };

/** 打印用：失败时把事件与逐条 Ajv 错误一起带进断言消息。 */
const format = (value: unknown): string => JSON.stringify(value, null, 2);

/** 断言事件体通过 `batch.schema.json` 的 `$defs/event`（真实产出的第一层门禁）。 */
const expectEventValid = (event: SdkEvent): void => {
  const outcome = registry.validateFragment('batch', 'event', event);
  expect(
    outcome.errors,
    `事件未通过 batch.schema.json 的 $defs/event：\n${format(event)}\n${outcome.errors.join('\n')}`,
  ).toEqual([]);
  expect(outcome.valid).toBe(true);
};

/** 断言事件体被 `$defs/event` 拒绝，并返回逐条 Ajv 错误（反向对照用）。 */
const expectEventInvalid = (event: unknown, label: string): readonly string[] => {
  const outcome = registry.validateFragment('batch', 'event', event);
  expect(outcome.valid, `${label} 本应被 $defs/event 拒绝，实际却通过：\n${format(event)}`).toBe(false);
  expect(outcome.errors.length).toBeGreaterThan(0);
  return outcome.errors;
};

/** 复制一份并去掉某个键（不用 delete，避免动态删除属性）。 */
const without = (source: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(source).filter(([entryKey]) => entryKey !== key));

/** 起一个收集真实产出的客户端：注入假 target 与假 location，`onEvent` 收到什么就收什么。 */
const startClient = (core: RealCoreModule, initOptions: Record<string, unknown>, target: unknown = null): {
  readonly events: SdkEvent[];
  readonly client: RealClient;
} => {
  const events: SdkEvent[] = [];
  const client = core.createClient({
    // target 为 null 是文档记载的 SSR / Node 路径（原生订阅静默降级）；
    // 需要浏览器形态时传一个最小假 target（见「注入假 target」用例）。
    target,
    location: FAKE_LOCATION,
    onEvent: (event: unknown): void => {
      events.push(asRecord(event, 'C01 产出的事件'));
    },
  });
  client.init(initOptions);
  return { events, client };
};

describe('产出校验：C01 公共 API 的真实事件产出', () => {
  it('产出校验：track() 产出的事件通过 batch.schema.json 的 $defs/event', async () => {
    const core = await loadCoreModule();
    const { events, client } = startClient(core, {
      appId: 'app-a',
      env: 'production',
      // 运行期字典（K01 生成物形态）：声明 priority 与 schema_version
      dictionary: {
        task_complete: {
          priority: 'critical',
          schema_version: 2,
          dimensions: { task_id: { type: 'placeholder', required: true } },
          metrics: { duration_ms: { type: 0, required: true } },
        },
      },
    });

    client.track('task_complete', {
      dimensions: { task_id: 't-1', tenant: 'acme' },
      metrics: { duration_ms: 12 },
      attachment: 'detail',
    });
    client.track('task_complete', {
      dimensions: { task_id: 't-2', tenant: 'acme' },
      metrics: { duration_ms: 7 },
    });
    client.track('unregistered_event', { dimensions: { key: 'v' }, metrics: { value: 1 } });
    client.flush();
    client.destroy();

    expect(events.map((event) => event['event_name'])).toEqual([
      'task_complete',
      'task_complete',
      'unregistered_event',
    ]);
    // 字典声明的 priority / schema_version 生效；未登记事件取默认值 1 / normal
    expect(events.map((event) => event['priority'])).toEqual(['critical', 'critical', 'normal']);
    expect(events.map((event) => event['schema_version'])).toEqual([2, 2, 1]);
    // 事件体不得出现批次头字段（T12 首轮 5 处违反的第 1 处）
    for (const event of events) {
      expect(Object.prototype.hasOwnProperty.call(event, 'app_id')).toBe(false);
      expectEventValid(event);
    }
  });

  it('产出校验：log() 产出的 sdk_log 事件通过 $defs/event，且 event_type 为 log 时 level 必填', async () => {
    const core = await loadCoreModule();
    const { events, client } = startClient(core, { appId: 'app-a' });

    client.log('warn', '磁盘将满', { dimensions: { disk: 'root' }, metrics: { free_mb: 12 } });
    client.flush();
    client.destroy();

    expect(events).toHaveLength(1);
    const log = asRecord(events[0], 'sdk_log 事件');
    expect(log['event_name']).toBe('sdk_log');
    expect(log['event_type']).toBe('log');
    expect(log['level']).toBe('warn');
    // 正文在 dimensions.message，事件体没有顶层 message（T12 首轮 5 处违反的第 4 处）
    expect(log['message']).toBeUndefined();
    expect(asRecord(log['dimensions'], 'sdk_log.dimensions')['message']).toBe('磁盘将满');
    expectEventValid(log);

    // 反向对照：level 是 event_type 为 log 时的必填字段，删掉后必须被拒
    const errors = expectEventInvalid(without(log, 'level'), '缺少 level 的 sdk_log');
    expect(errors.join('\n')).toContain('level');
  });

  it('产出校验：captureError() 产出的 web_js_error 同时通过 $defs/event 与内置事件 Schema', async () => {
    const core = await loadCoreModule();
    const { events, client } = startClient(core, { appId: 'app-a' });

    client.captureError(new TypeError('无法读取属性 x'), {
      dimensions: { source: 'manual' },
      metrics: { count: 3, line: 12, column: 4 },
      attachment: 'at foo (https://example.test/app.js:1:1)',
    });
    client.captureError('字符串形式的错误');
    client.flush();
    client.destroy();

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event['event_name']).toBe('web_js_error');
      // 第一层：批次 Schema 的事件体
      expectEventValid(event);
      // 第二层：内置事件 Schema（dimensions 必填 4 键、metrics.count 必填）
      const outcome = registry.validate('web_js_error', event);
      expect(
        outcome.errors,
        `事件未通过内置 web_js_error Schema：\n${format(event)}\n${outcome.errors.join('\n')}`,
      ).toEqual([]);
      expect(outcome.valid).toBe(true);
    }

    const first = asRecord(events[0], 'web_js_error 事件');
    expect(first['event_type']).toBe('error');
    expect(first['priority']).toBe('normal');
    expect(first['schema_version']).toBe(1);
    const dimensions = asRecord(first['dimensions'], 'web_js_error.dimensions');
    for (const key of ['error_type', 'message', 'source', 'fingerprint']) {
      expect(typeof dimensions[key], `dimensions.${key} 必须是字符串`).toBe('string');
    }
    expect(asRecord(first['metrics'], 'web_js_error.metrics')['count']).toBe(3);
  });

  it('产出校验：超长正文被截断后（truncated 路径）仍通过 $defs/event 与内置事件 Schema', async () => {
    const core = await loadCoreModule();
    const { events, client } = startClient(core, { appId: 'app-a' });

    // 维度值上限 256、attachment 上限 8192（batch.schema.json / web_js_error.schema.json）
    client.log('error', 'x'.repeat(400), { attachment: 'a'.repeat(9000) });
    client.captureError(new Error('y'.repeat(400)), { attachment: 'b'.repeat(9000) });
    client.flush();
    client.destroy();

    expect(events.map((event) => event['event_name'])).toEqual(['sdk_log', 'web_js_error']);
    for (const event of events) {
      expectEventValid(event);
      expect(registry.validate('web_js_error', event).valid).toBe(event['event_name'] === 'web_js_error');
      // 截断必须被记录（C04-F6 语义的路径列表），且长度确实落在 Schema 上限内
      expect(event['truncated']).toEqual(expect.arrayContaining(['dimensions.message', 'attachment']));
      expect(requireString(event, 'attachment', '事件').length).toBeLessThanOrEqual(8192);
      const dimensions = asRecord(event['dimensions'], '事件 dimensions');
      expect(requireString(dimensions, 'message', '事件 dimensions').length).toBeLessThanOrEqual(256);
    }
  });

  it('产出校验：init 之前入队、init 时回放的事件（命令队列路径）同样通过 $defs/event', async () => {
    const core = await loadCoreModule();
    const events: SdkEvent[] = [];
    const client = core.createClient({
      target: null,
      location: FAKE_LOCATION,
      onEvent: (event: unknown): void => {
        events.push(asRecord(event, 'C01 产出的事件'));
      },
    });

    // init 之前调用 → 进入命令队列（C01-F2），此时还没有任何产出
    client.track('queued_event', { dimensions: { from: 'queue' } });
    client.log('error', '入队日志');
    client.captureError(new Error('入队错误'));
    expect(events).toEqual([]);

    client.init({ appId: 'app-a' });
    client.flush();
    client.destroy();

    expect(events.map((event) => event['event_name'])).toEqual(['queued_event', 'sdk_log', 'web_js_error']);
    for (const event of events) {
      expectEventValid(event);
    }
  });

  it('产出校验：注入假 target 的两个实例产出的事件都通过 $defs/event，且互不串号', async () => {
    const core = await loadCoreModule();
    // 最小假 target：只提供 C02 全局注册表需要的那两个方法
    const listeners = new Map<string, unknown>();
    const fakeTarget = {
      addEventListener: (type: string, handler: unknown): void => {
        listeners.set(type, handler);
      },
      removeEventListener: (type: string): void => {
        listeners.delete(type);
      },
    };

    const eventsA: SdkEvent[] = [];
    const eventsB: SdkEvent[] = [];
    const clientA = core.createClient({
      target: fakeTarget,
      location: FAKE_LOCATION,
      onEvent: (event: unknown): void => {
        eventsA.push(asRecord(event, '实例 A 产出的事件'));
      },
    });
    const clientB = core.createClient({
      target: fakeTarget,
      location: { href: 'https://example.test/b', pageId: '/b' },
      onEvent: (event: unknown): void => {
        eventsB.push(asRecord(event, '实例 B 产出的事件'));
      },
    });

    clientA.init({ appId: 'app-a' });
    clientB.init({ appId: 'app-b' });
    clientA.track('page_view', { dimensions: { route: '/a' } });
    clientB.track('page_view', { dimensions: { route: '/b' } });
    clientA.flush();
    clientB.flush();
    clientA.destroy();
    clientB.destroy();

    expect(eventsA.map((event) => event['page_id'])).toEqual(['/task/:id']);
    expect(eventsB.map((event) => event['page_id'])).toEqual(['/b']);
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    for (const event of [...eventsA, ...eventsB]) {
      expectEventValid(event);
    }
  });
});

describe('反向对照：T12 首轮的历史契约违反逐个被拒（证明门禁不是空转）', () => {
  const baseEvent = (): Record<string, unknown> => ({
    event_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    event_name: 'task_complete',
    event_type: 'custom',
    schema_version: 1,
    occurred_at: 1700000000000,
    priority: 'normal',
  });

  /** 四处「事件体字段」层面的历史违反（第 5 处属内置事件 Schema，见下一个用例）。 */
  const eventLevelViolations: readonly {    readonly name: string;
    /** 与违规事件同形、但修好该处违反的合法事件：用来排除「Schema 本身写坏导致全拒」。 */
    readonly clean: Record<string, unknown>;
    readonly event: Record<string, unknown>;
    readonly expected: string;
  }[] = [
    {
      name: '事件体带顶层 app_id（app_id 只属批次头）',
      clean: baseEvent(),
      event: { ...baseEvent(), app_id: 'app-a' },
      expected: 'app_id',
    },
    {
      name: '缺必填 event_id',
      clean: baseEvent(),
      event: without(baseEvent(), 'event_id'),
      expected: 'event_id',
    },
    {
      name: '缺必填 schema_version',
      clean: baseEvent(),
      event: without(baseEvent(), 'schema_version'),
      expected: 'schema_version',
    },
    {
      name: 'log 事件把 message 放在事件顶层',
      clean: { ...baseEvent(), event_name: 'sdk_log', event_type: 'log', level: 'warn' },
      event: { ...baseEvent(), event_name: 'sdk_log', event_type: 'log', level: 'warn', message: '磁盘将满' },
      expected: 'message',
    },
  ];

  // 标题里不写 `$defs`：Vitest 的 `it.each` 会把 `$xxx` 当属性占位符渲染成 undefined
  it.each([...eventLevelViolations])('$name 被 batch.schema.json 的事件体片段拒绝', ({ clean, event, expected }) => {
    // 先确认同形的合法事件能通过，排除 schema 本身写坏导致的全拒
    expectEventValid(clean);
    const errors = expectEventInvalid(event, expected);
    expect(errors.join('\n')).toContain(expected);
  });

  it('反向对照：把历史违反注入「真实产出的事件」后，同一断言必须失败', async () => {
    const core = await loadCoreModule();
    const { events, client } = startClient(core, { appId: 'app-a' });
    client.track('task_complete', { dimensions: { task_id: 't-1' } });
    client.flush();
    client.destroy();

    // 真实产出的键集合（不带任何构造痕迹）本身必须通过
    const real = asRecord(events[0], '真实产出的事件');
    expectEventValid(real);

    // 在真实事件上逐条注入 T12 首轮的历史违反：同一个断言必须全部拦住
    const injected: readonly { readonly label: string; readonly broken: Record<string, unknown>; readonly expected: string }[] = [
      { label: '加顶层 app_id', broken: { ...real, app_id: 'app-a' }, expected: 'app_id' },
      { label: '删掉 event_id', broken: without(real, 'event_id'), expected: 'event_id' },
      { label: '删掉 schema_version', broken: without(real, 'schema_version'), expected: 'schema_version' },
    ];
    for (const { label, broken, expected } of injected) {
      const errors = expectEventInvalid(broken, `真实产出事件（${label}）`);
      expect(errors.join('\n'), `${label} 的错误信息里应提到 ${expected}`).toContain(expected);
    }

    // 反向的 log 事件（真实 sdk_log 加上顶层 message）
    const logs: SdkEvent[] = [];
    const logClient = core.createClient({
      target: null,
      location: FAKE_LOCATION,
      onEvent: (event: unknown): void => {
        logs.push(asRecord(event, 'sdk_log 事件'));
      },
    });
    logClient.init({ appId: 'app-a' });
    logClient.log('warn', '磁盘将满');
    logClient.flush();
    logClient.destroy();
    const realLog = asRecord(logs[0], '真实 sdk_log 事件');
    expectEventValid(realLog);
    const errors = expectEventInvalid({ ...realLog, message: '磁盘将满' }, '真实 sdk_log 事件（加顶层 message）');
    expect(errors.join('\n')).toContain('message');
  });

  it('captureError 的 web_js_error 缺 source / fingerprint / metrics.count 被内置事件 Schema 拒绝', () => {
    const defect: Record<string, unknown> = {
      ...baseEvent(),
      event_name: 'web_js_error',
      event_type: 'error',
      dimensions: { error_type: 'TypeError', message: 'boom' },
      metrics: {},
    };

    // 这一处违反在 `$defs/event` 层面看不出来（它不认识 web_js_error 的字段语义），
    // 正是必须叠加内置事件 Schema 的原因。
    expect(registry.validateFragment('batch', 'event', defect).valid).toBe(true);

    const outcome = registry.validate('web_js_error', defect);
    expect(outcome.valid).toBe(false);
    const joined = outcome.errors.join('\n');
    expect(joined).toContain('source');
    expect(joined).toContain('fingerprint');
    expect(joined).toContain('count');
  });

  it('门禁确实在比较真实结构：空对象与错类型的必填字段都被拒', () => {
    expectEventInvalid({}, '空对象');
    expectEventInvalid({ ...baseEvent(), occurred_at: 'not-a-number' }, 'occurred_at 类型错误');
    expectEventInvalid({ ...baseEvent(), event_id: 'not-a-uuid' }, 'event_id 不是 UUID v4');
    expectEventInvalid({ ...baseEvent(), event_type: 'bogus' }, 'event_type 不在枚举内');
  });

  it('校验器指向的确实是冻结契约片段：片段名写错时 Ajv 编译期报错', () => {
    expect(() => registry.validateFragment('batch', 'no_such_fragment', {})).toThrow(/no_such_fragment/u);
  });
});
