/**
 * C01-F4 类型化事件（C01-AC-09）：校验 `track` 的事件名与字段。
 *
 * 正向用例（本文件）：登记的事件名、正确的字段名/类型/枚举取值/必填字段编译通过，
 * 并保留字面量类型；反向用例见 `packages/browser/src/typed-events.fixture.ts`
 * （用 `@ts-expect-error` 把「必须报错」固定下来）。
 *
 * 字典形状与 K01（T22）生成物一致：`FieldSpec<值类型, 字面量 required>` +
 * 可选字段写成带 `?` 的属性。
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { createClient, defineEventDictionary } from './index';
import type { DimensionFields, EventRequestOf, FieldSpec, MetricFields } from './index';

/** K01 生成物形状的测试字典（类型用声明表达，值用于运行期取 priority/schema_version）。 */
type TestDictionary = {
  readonly task_complete: {
    readonly priority: 'critical';
    readonly schema_version: 3;
    readonly dimensions: {
      readonly task_id: FieldSpec<string, true>;
      readonly tenant: FieldSpec<string, true>;
      readonly channel?: FieldSpec<'web' | 'app', false>;
    };
    readonly metrics: {
      readonly duration_ms: FieldSpec<number, true>;
      readonly retry_count?: FieldSpec<number, false>;
    };
  };
  readonly sdk_log: {
    readonly priority: 'normal';
    readonly schema_version: 1;
    readonly dimensions: Record<string, never>;
    readonly metrics: Record<string, never>;
  };
};

/** 运行期字典（供 schema_version / priority 取值使用）。 */
export const TEST_DICTIONARY: TestDictionary = defineEventDictionary({
  task_complete: {
    priority: 'critical',
    schema_version: 3,
    dimensions: {
      task_id: { type: 'task-1', required: true },
      tenant: { type: 'acme', required: true },
    },
    metrics: {
      duration_ms: { type: 0, required: true },
    },
  },
  sdk_log: {
    priority: 'normal',
    schema_version: 1,
    dimensions: {},
    metrics: {},
  },
});

/** 便利写法字典（`required` 字面量由 `const` 类型参数保留）。 */
const CONVENIENCE_DICTIONARY = defineEventDictionary({
  user_signup: {
    priority: 'normal',
    schema_version: 1,
    dimensions: {
      plan: { type: 'free', required: true },
      source: { type: 'landing', required: false },
    },
    metrics: {},
  },
});
type ConvenienceDictionary = typeof CONVENIENCE_DICTIONARY;

type TaskDimensions = DimensionFields<TestDictionary['task_complete']>;
type TaskMetrics = MetricFields<TestDictionary['task_complete']>;
type TaskRequest = EventRequestOf<TestDictionary, 'task_complete'>;
type SignupDimensions = DimensionFields<ConvenienceDictionary['user_signup']>;

// 正向量：这些值必须能构造出来（缺必填字段/类型错误会在编译期失败）
const taskDimensions: TaskDimensions = { task_id: 't', tenant: 'x' };
const taskMetrics: TaskMetrics = { duration_ms: 0 };
const signupDimensions: SignupDimensions = { plan: 'free' };
const taskRequest: TaskRequest = { dimensions: { task_id: 't', tenant: 'x' } };
const requiredPartTask: RequiredPart<TaskDimensions, 'task_id' | 'tenant'> = { task_id: 't', tenant: 'x' };
const optionalPartTask: OptionalPart<TaskDimensions, 'channel'> = {};
const requiredPartMetrics: RequiredPart<TaskMetrics, 'duration_ms'> = { duration_ms: 0 };
const optionalPartMetrics: OptionalPart<TaskMetrics, 'retry_count'> = {};
/** 形状用「必填投影 / 可选投影」精确断言（等价于逐字段比对）。 */
type RequiredPart<TShape, TKeys extends keyof TShape> = { [K in TKeys]-?: TShape[K] };
type OptionalPart<TShape, TKeys extends keyof TShape> = { [K in TKeys]?: TShape[K] };
describe('C01 类型化事件', () => {
  it('C01-AC-09 字典字段推导出精确的字段名、类型与必填性', () => {
    // 形状断言用「双向可赋值 + 键集合」表达（比 toEqualTypeOf 的严格恒等更适合交叉类型）；
    // 负向精度（缺必填、类型错误、枚举越界、多出字段）由 fixture 的 @ts-expect-error 覆盖。
    const requiredOnly: { task_id: string; tenant: string } = taskDimensions;
    const withOptional: { channel?: 'web' | 'app' } = taskDimensions;
    const metricsShape: { duration_ms: number; retry_count?: number } = taskMetrics;
    const signupShape: { plan: 'free'; source?: 'landing' } = signupDimensions;
    // 必填/可选投影逐项断言（用可赋值表达；负向精度由 fixture 的 @ts-expect-error 覆盖）
    const requiredProjection: { task_id: string; tenant: string } = requiredPartTask;
    const optionalProjection: { channel?: 'web' | 'app' } = optionalPartTask;
    const metricRequiredProjection: { duration_ms: number } = requiredPartMetrics;
    const metricOptionalProjection: { retry_count?: number } = optionalPartMetrics;
    expect([
      requiredProjection.task_id,
      optionalProjection.channel,
      metricRequiredProjection.duration_ms,
      metricOptionalProjection.retry_count,
    ]).toEqual(['t', undefined, 0, undefined]);
    const roundTrip: TaskDimensions = { task_id: 't', tenant: 'x', channel: 'web' };
    const metricsRoundTrip: TaskMetrics = { duration_ms: 1 };
    const signupRoundTrip: SignupDimensions = { plan: 'free' };

    expect([requiredOnly.task_id, withOptional.channel, metricsShape.duration_ms]).toEqual(['t', undefined, 0]);
    expect([signupShape.plan, roundTrip.tenant, metricsRoundTrip.duration_ms, signupRoundTrip.plan]).toEqual([
      'free',
      'x',
      1,
      'free',
    ]);
    expectTypeOf(taskRequest['dimensions']).toEqualTypeOf<TaskDimensions | undefined>();
    expectTypeOf(taskRequest['priority']).toEqualTypeOf<'normal' | 'critical' | undefined>();

    expect(Object.keys(TEST_DICTIONARY)).toEqual(['task_complete', 'sdk_log']);
    expect(Object.keys(CONVENIENCE_DICTIONARY)).toEqual(['user_signup']);
  });

  it('C01-AC-09 已登记事件名与正确字段的调用编译通过，并按定义取 priority/schema_version', () => {
    const events: Record<string, unknown>[] = [];
    const client = createClient<TestDictionary>({
      onEvent: (event) => events.push({ ...event }),
      dictionary: TEST_DICTIONARY,
    });
    client.init({ appId: 'app-a', consent: 'granted' });

    client.track('task_complete', {
      dimensions: { task_id: 't-1', tenant: 'acme', channel: 'web' },
      metrics: { duration_ms: 12, retry_count: 1 },
    });
    client.track('task_complete', { dimensions: { task_id: 't-2', tenant: 'acme' }, metrics: { duration_ms: 30 } });

    expect(events.map((event) => event['event_name'])).toEqual(['task_complete', 'task_complete']);
    expect(events[0]?.['priority']).toBe('critical');
    expect(events[0]?.['schema_version']).toBe(3);
    expect(events[0]?.['dimensions']).toEqual({ task_id: 't-1', tenant: 'acme', channel: 'web' });
    expect(events[0]?.['metrics']).toEqual({ duration_ms: 12, retry_count: 1 });
    // 事件体不含批次头字段 app_id
    expect(Object.prototype.hasOwnProperty.call(events[0] ?? {}, 'app_id')).toBe(false);
    expect(client.kernel.counters.get('invalid_event_name')).toBe(0);
    expect(client.kernel.counters.get('invalid_args')).toBe(0);
    client.destroy();
  });

  it('C01-AC-09 显式 priority 覆盖字典声明', () => {
    const events: Record<string, unknown>[] = [];
    const client = createClient<TestDictionary>({
      onEvent: (event) => events.push({ ...event }),
      dictionary: TEST_DICTIONARY,
    });
    client.init({ appId: 'app-a', consent: 'granted' });

    client.track('task_complete', {
      dimensions: { task_id: 't-1', tenant: 'acme' },
      metrics: { duration_ms: 1 },
      priority: 'normal',
    });

    expect(events[0]?.['priority']).toBe('normal');
    expect(events[0]?.['schema_version']).toBe(3);
    client.destroy();
  });

  it('C01-AC-09 未登记事件走宽松路径：schema_version 1、priority normal', () => {
    const events: Record<string, unknown>[] = [];
    const client = createClient({ onEvent: (event) => events.push({ ...event }) });
    client.init({ appId: 'app-a', consent: 'granted' });

    client.track('any_event_name', { dimensions: { any_key: 'v' }, metrics: { any_metric: 1 } });

    expect(events[0]?.['schema_version']).toBe(1);
    expect(events[0]?.['priority']).toBe('normal');
    expect(client.kernel.counters.get('invalid_event_name')).toBe(0);
    client.destroy();
  });

  it('C01-AC-09 运行时仍按命名规则拒绝非法事件名与保留前缀', () => {
    const events: string[] = [];
    const client = createClient({ onEvent: (event) => events.push(event.event_name) });
    client.init({ appId: 'app-a', consent: 'granted' });

    client.track('single');
    client.track('sdk_health');

    expect(events).toEqual([]);
    expect(client.kernel.counters.get('invalid_event_name')).toBe(2);
    client.destroy();
  });

  it('C01-AC-09 便利写法字典在运行期可用', () => {
    const events: Record<string, unknown>[] = [];
    const client = createClient<ConvenienceDictionary>({
      onEvent: (event) => events.push({ ...event }),
      dictionary: CONVENIENCE_DICTIONARY,
    });
    client.init({ appId: 'app-a', consent: 'granted' });
    client.track('user_signup', { dimensions: { plan: 'free', source: 'landing' } });

    expect(events[0]?.['dimensions']).toEqual({ plan: 'free', source: 'landing' });
    expect(events[0]?.['schema_version']).toBe(1);
    client.destroy();
  });
});
