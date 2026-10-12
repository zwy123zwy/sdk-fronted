/**
 * K01-F4：生成 TypeScript 类型声明。
 *
 * 契约 `dictionary-compat.md`“类型包生成（K01-F4）”：
 * - 只对 `active` 状态的事件生成其**最新版本**的类型；
 * - 必填字段为必需属性，`enum` 生成字面量联合类型，`boolean` 维度生成 `boolean`
 *   （SDK 在序列化时把它写成字符串）；
 * - 事件名携带投递等级（`priority`）与 `schema_version` 字面量类型；
 * - 生成结果只包含类型声明，运行时零代码。
 *
 * 形状按与 T12（C01 公共 API）的跨任务约定：`EventRegistry` / `EventDefinitions`
 * 是「事件名 -> 事件定义」的映射，字段用 `FieldSpec<TValue>` 描述类型与必填性，
 * 供 `createClient<TDefinitions>()` / `track<TName>(name, input)` 推导。
 *
 * 生成文件的形状（示例）：
 * ```ts
 * export interface TaskSubmitCompleteEntry {
 *   readonly priority: 'normal';
 *   readonly schema_version: 1;
 *   readonly dimensions: {
 *     task_type: FieldSpec<'label' | 'review', true>;
 *     result?: FieldSpec<string, false>;
 *   };
 *   readonly metrics: {
 *     duration_ms: FieldSpec<number, true>;
 *     item_count?: FieldSpec<number, false>;
 *   };
 * }
 * export interface EventRegistry { task_submit_complete: TaskSubmitCompleteEntry }
 * export type EventDefinitions = EventRegistry;
 * ```
 * `EventPayload<Name>` 是从同一份定义推导出的"可直接传给 SDK"的负载类型。
 */
import type { EventDefinition, FieldDefinition } from './definitions.js';

/** 生成文件的头部说明。 */
const FILE_HEADER = `/**
 * 由 @web-report-sdk/event-registry（K01）生成，请勿手工修改。
 * 事件定义来源：接入方仓库的 events/*.json；
 * 元模型见 docs/contracts/schemas/event-definition.schema.json（0.2）。
 *
 * 只对 active 事件的最新版本生成类型，本文件只含类型声明，运行时零代码。
 * 事件名、priority、schema_version、enum 取值都是字面量类型，不会被宽化。
 */`;

/** 生成文件里的公共类型工具声明。 */
const TYPE_PRELUDE = `/** 一个字段的规格：值类型 + 是否必填。 */
export interface FieldSpec<TValue, TRequired extends boolean> {
  readonly type: TValue;
  readonly required: TRequired;
}

/** 一组字段名 -> 字段规格的映射。 */
export type FieldSpecMap = Record<string, FieldSpec<unknown, boolean>>;

/** 取值类型为 TRequired 的字段名（供 EventPayload 推导负载）。 */
export type RequiredFieldNames<TFields extends FieldSpecMap> = {
  // 用 NonNullable 去掉可选属性带来的 undefined，否则可选字段会被误判为必填
  [Name in keyof TFields]: NonNullable<TFields[Name]> extends FieldSpec<unknown, true> ? Name : never;
}[keyof TFields];

/** 取值类型可为空的字段名。 */
export type OptionalFieldNames<TFields extends FieldSpecMap> = Exclude<keyof TFields, RequiredFieldNames<TFields>>;

/** 只保留必填字段，且去掉 FieldSpec 包装（得到可直接传值的形状）。 */
export type PickRequired<TFields extends FieldSpecMap> = {
  [Name in RequiredFieldNames<TFields>]: NonNullable<TFields[Name]> extends FieldSpec<infer TValue, boolean>
    ? TValue
    : never;
};

/** 只保留可选字段，且去掉 FieldSpec 包装。 */
export type PickOptional<TFields extends FieldSpecMap> = {
  [Name in OptionalFieldNames<TFields>]?: NonNullable<TFields[Name]> extends FieldSpec<infer TValue, boolean>
    ? TValue
    : never;
};

/** 某个事件的 dimensions 负载。 */
export type DimensionsPayload<Name extends EventName> = PickRequired<EventEntry<Name>['dimensions']> &
  PickOptional<EventEntry<Name>['dimensions']>;

/** 某个事件的 metrics 负载。 */
export type MetricsPayload<Name extends EventName> = PickRequired<EventEntry<Name>['metrics']> &
  PickOptional<EventEntry<Name>['metrics']>;

/** 业务代码传给 SDK 的事件负载：dimensions 与 metrics 分别对应字段的 kind。 */
export interface EventPayloadShape<Dimensions, Metrics> {
  dimensions: Dimensions;
  metrics: Metrics;
}

/** 某个事件的负载类型。 */
export type EventPayload<Name extends EventName> = EventPayloadShape<DimensionsPayload<Name>, MetricsPayload<Name>>;

/** 事件名 -> 事件定义（对 T12 的 createClient<TDefinitions>() 暴露的字典形状）。 */
export type EventDefinitions = EventRegistry;

/** 事件名 -> 类型条目。 */
export type EventEntry<Name extends EventName> = EventRegistry[Name];

/** 已登记的事件名（active 事件的最新版本）。 */
export type EventName = keyof EventRegistry;`;

/** 生成类型声明文本。 */
export function toGeneratedTypes(events: readonly EventDefinition[]): string {
  const latestActive = latestActiveEvents(events);
  const entryBlocks = latestActive.map(renderEntryInterface);
  const dictionary = renderDictionary(latestActive);
  return [FILE_HEADER, '', TYPE_PRELUDE, '', ...entryBlocks, dictionary, ''].join('\n');
}

/** 只保留 active 事件的最新版本，按事件名升序。 */
export function latestActiveEvents(events: readonly EventDefinition[]): EventDefinition[] {
  const latest = new Map<string, EventDefinition>();
  for (const event of events) {
    if (event.status !== 'active') continue;
    const current = latest.get(event.eventName);
    if (current === undefined || event.schemaVersion > current.schemaVersion) {
      latest.set(event.eventName, event);
    }
  }
  return [...latest.values()].sort((left, right) => (left.eventName < right.eventName ? -1 : 1));
}

/** 把字段类型映射成 TypeScript 值类型。 */
export function fieldValueTypeText(field: FieldDefinition): string {
  switch (field.type) {
    case 'enum': {
      const values = field.enum_values ?? [];
      return values.length > 0 ? values.map((value) => `'${escapeText(value)}'`).join(' | ') : 'string';
    }
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
    default:
      return 'string';
  }
}

/** 字段对应的事件定义类型条目名。 */
export function entryTypeName(eventName: string): string {
  return `${pascalCase(eventName)}Entry`;
}

/** 某个分组（dimensions / metrics）的规格对象类型文本。 */
export function fieldSpecGroupText(
  fields: readonly FieldDefinition[],
  kind: 'dimension' | 'metric',
  indent = '  ',
): string {
  const group = fields.filter((field) => field.kind === kind);
  const emptyNote = kind === 'dimension' ? '没有 dimension 字段' : '没有 metric 字段';
  if (group.length === 0) return `Record<never, never> /* ${emptyNote} */`;
  const body = group
    .map((field) => {
      const optional = field.required ? '' : '?';
      return `${indent}  ${field.name}${optional}: FieldSpec<${fieldValueTypeText(field)}, ${String(field.required)}>;`;
    })
    .join('\n');
  return `{\n${body}\n${indent}}`;
}

/** 渲染一个事件的类型条目接口。 */
function renderEntryInterface(event: EventDefinition): string {
  const typeName = entryTypeName(event.eventName);
  const lines: string[] = [];
  lines.push(`/** 事件 ${event.eventName}：${event.description} */`);
  lines.push(`export interface ${typeName} {`);
  lines.push(`  readonly priority: '${event.priority}';`);
  lines.push(`  readonly schema_version: ${String(event.schemaVersion)};`);
  lines.push(`  readonly dimensions: ${fieldSpecGroupText(event.fields, 'dimension')};`);
  lines.push(`  readonly metrics: ${fieldSpecGroupText(event.fields, 'metric')};`);
  lines.push('}');
  return lines.join('\n');
}

/** 渲染事件名字典。 */
function renderDictionary(events: readonly EventDefinition[]): string {
  if (events.length === 0) {
    return [
      '/** 注册表为空：没有 active 状态的事件定义。 */',
      'export interface EventRegistry {}',
    ].join('\n');
  }
  const lines = ['/** 事件名 -> 事件定义（字面量键）。 */', 'export interface EventRegistry {'];
  for (const event of events) {
    lines.push(`  '${escapeText(event.eventName)}': ${entryTypeName(event.eventName)};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** 事件名 -> 合法 TypeScript 标识符前缀。 */
export function pascalCase(eventName: string): string {
  const parts = eventName
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`);
  const joined = parts.join('');
  return joined === '' ? 'Event' : joined;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
