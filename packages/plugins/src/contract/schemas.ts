/**
 * C05 契约自证共用件：用**真实** `docs/contracts/schemas/builtin-events/*.json` 做校验。
 *
 * 口径（T18-plan §7，沿用 T10/T14 的既有做法）：
 * - 直接 `import` 真实 Schema，**不复制**到测试目录（避免副本漂移）；
 * - 校验对象是**单个事件体**（`batch.schema.json $defs/event` 那一层）；
 * - 必须同时有**负向对照**与**非空转对照**（"故意构造的合法样本必须被接受"）。
 */
import Ajv2020 from 'ajv/dist/2020';

import httpSchema from '../../../../docs/contracts/schemas/builtin-events/web_http.schema.json';
import jsErrorSchema from '../../../../docs/contracts/schemas/builtin-events/web_js_error.schema.json';
import longTaskSchema from '../../../../docs/contracts/schemas/builtin-events/web_long_task.schema.json';
import vitalsSchema from '../../../../docs/contracts/schemas/builtin-events/web_vitals.schema.json';

/** 真实 Schema 的 Ajv 实例（2020-12；非严格模式以兼容元数据字段）。 */
function createValidator(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

/** 合法 UUID v4（Schema 的 `$defs/uuid` 用 pattern 校验版本位与变体位）。 */
export const EVENT_ID = '00000000-0000-4000-8000-000000000001';

/** 合法时间戳（Schema 的 `$defs/timestamp` 范围 1577836800000–4102444800000）。 */
export const OCCURRED_AT = 1_700_000_000_000;

/** 每个内置事件 Schema 的编译入口。 */
export function compileJsError(): ReturnType<Ajv2020['compile']> {
  return createValidator().compile(jsErrorSchema);
}

export function compileVitals(): ReturnType<Ajv2020['compile']> {
  return createValidator().compile(vitalsSchema);
}

export function compileLongTask(): ReturnType<Ajv2020['compile']> {
  return createValidator().compile(longTaskSchema);
}

export function compileHttp(): ReturnType<Ajv2020['compile']> {
  return createValidator().compile(httpSchema);
}

/** 把被测产出的**事件体**补上 Schema 要求的公共字段（时间/标识由内核与投递层补）。 */
export function withEnvelope(event: Readonly<Record<string, unknown>>, eventType: string): Record<string, unknown> {
  return {
    event_id: EVENT_ID,
    event_type: eventType,
    schema_version: 1,
    occurred_at: OCCURRED_AT,
    ...event,
  };
}

/** 合法样本：`web_js_error`（正向对照）。 */
export function validJsError(): Record<string, unknown> {
  return withEnvelope(
    {
      event_name: 'web_js_error',
      priority: 'normal',
      dimensions: {
        error_type: 'TypeError',
        message: 'cannot read properties of undefined',
        source: 'window_error',
        fingerprint: 'fp-0001',
      },
      metrics: { count: 1, line: 12, column: 5 },
      attachment: 'at handler (app.js:12:5)',
    },
    'error',
  );
}

/** 合法样本：`web_vitals`（正向对照）。 */
export function validVitals(): Record<string, unknown> {
  return withEnvelope(
    {
      event_name: 'web_vitals',
      priority: 'normal',
      dimensions: { metric_name: 'LCP', rating: 'good' },
      metrics: { value: 1200, delta: 1200 },
    },
    'perf',
  );
}

/** 合法样本：`web_long_task`（正向对照；注意**没有** `dimensions`）。 */
export function validLongTask(): Record<string, unknown> {
  return withEnvelope(
    {
      event_name: 'web_long_task',
      priority: 'normal',
      metrics: { duration_ms: 120, start_time_ms: 340 },
    },
    'perf',
  );
}

/** 合法样本：`web_http`（正向对照）。 */
export function validHttp(): Record<string, unknown> {
  return withEnvelope(
    {
      event_name: 'web_http',
      priority: 'normal',
      dimensions: { method: 'GET', url_template: '/api/task/:id', status_class: '2xx' },
      metrics: { status: 200, duration_ms: 42 },
    },
    'http',
  );
}
