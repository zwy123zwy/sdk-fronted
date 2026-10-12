/**
 * C01-F4 类型化事件的**反向**类型用例（C01-AC-09）。
 *
 * 本文件只做类型检查，不参与运行时；它是「未登记事件名、缺必填字段、类型错误、
 * 枚举取值错误、多出字段都必须让 `tsc` 报错」的可执行规格。写法：在每个必须报错的位置加
 * `@ts-expect-error`（仓库 ESLint 允许带说明的 `@ts-expect-error`，`ts-ignore` 被禁止）。
 *
 * 字典形状与 K01（T22）生成物一致：`FieldSpec<值类型, 字面量 required>`，
 * 可选字段写成带 `?` 的属性 + `required: false`。
 */
import { createClient } from '@web-report-sdk/core';
import type { FieldSpec } from '@web-report-sdk/core';

/** 手写的 K01 生成物形状。 */
export type FixtureDictionary = {
  readonly task_complete: {
    readonly priority: 'critical';
    readonly schema_version: 3;
    readonly dimensions: {
      readonly task_id: FieldSpec<string, true>;
      readonly tenant: FieldSpec<string, true>;
      readonly channel?: FieldSpec<'web' | 'app', false>;
      readonly retried?: FieldSpec<boolean, false>;
    };
    readonly metrics: {
      readonly duration_ms: FieldSpec<number, true>;
      readonly retry_count?: FieldSpec<number, false>;
    };
  };
  readonly page_view: {
    readonly priority: 'normal';
    readonly schema_version: 1;
    readonly dimensions: {
      readonly route?: FieldSpec<string, false>;
    };
    readonly metrics: Record<string, never>;
  };
};

/** 只做类型检查的壳：`client` 的每个调用都在编译期被校验。 */
export function typeOnlyChecks(): void {
  const client = createClient<FixtureDictionary>();

  // 正向：登记的事件名 + 正确的字段名/类型/枚举取值/必填字段，编译通过
  client.track('task_complete', {
    dimensions: { task_id: 't-1', tenant: 'acme', channel: 'web', retried: true },
    metrics: { duration_ms: 12, retry_count: 1 },
  });
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme' } });
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme' }, metrics: { duration_ms: 12 } });
  client.track('page_view', { dimensions: { route: '/task/:id' } });
  client.track('page_view');
  client.init({ appId: 'app-a' });

  // 反向 1：未登记的事件名
  // @ts-expect-error 未登记的事件名必须报错
  client.track('not_registered');

  // 反向 2：缺少 required: true 的字段
  // @ts-expect-error 缺少必填维度 tenant
  client.track('task_complete', { dimensions: { task_id: 't-1', channel: 'web' } });

  // @ts-expect-error 缺少必填指标 duration_ms
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme' }, metrics: { retry_count: 1 } });

  // 反向 3：字段类型错误
  // @ts-expect-error 维度值必须是字符串
  client.track('task_complete', { dimensions: { task_id: 123, tenant: 'acme' } });

  // @ts-expect-error boolean 维度不能传字符串
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme', retried: 'yes' } });

  // @ts-expect-error 指标值必须是数字
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme' }, metrics: { duration_ms: 'slow' } });

  // 反向 4：enum 取值不在字面量联合内
  // @ts-expect-error channel 只接受 'web' | 'app'
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme', channel: 'desktop' } });

  // 反向 5：多出未声明的字段
  // @ts-expect-error 未声明的维度字段必须报错
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme', extra_field: 'x' } });

  // @ts-expect-error 未声明的指标字段必须报错
  client.track('task_complete', { dimensions: { task_id: 't-1', tenant: 'acme' }, metrics: { extra_metric: 2 } });

  // 反向 6：事件名必须是字符串
  // @ts-expect-error 事件名必须是字符串
  client.track(42);

  client.destroy();
}
