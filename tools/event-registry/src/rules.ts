/**
 * K01-F5：导出接收方可用的运行期校验规则 JSON。
 *
 * 契约 `dictionary-compat.md`“运行期校验（接收方，可选）”只给出建议，没有冻结规则文件的
 * Schema。这里给出工具自带的规则 Schema：它约束导出物的结构，导出物本身又是
 * JSON Schema 2020-12 风格的字段声明，接收方可以直接做运行期校验（RR-22）。
 *
 * 版本保留策略：每个事件保留最近 3 个 `schema_version`（K01-AC-10）。
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import type {
  EventDefinition,
  EventPriority,
  EventStatus,
  FieldDefinition,
  FieldKind,
  FieldTypeName,
  Sensitivity,
} from './definitions.js';

/** 默认保留的版本数（契约建议：至少保留最近 3 个 schema_version）。 */
export const DEFAULT_KEEP_VERSIONS = 3;

/** 规则文件的 Schema 标识。 */
export const RUNTIME_RULES_SCHEMA_ID = 'urn:web-report-sdk:k01:runtime-validation-rules:1';

/** 规则文件中一个字段的声明。 */
export interface RuntimeFieldRule {
  name: string;
  kind: FieldKind;
  type: FieldTypeName;
  required: boolean;
  description: string;
  sensitivity: Sensitivity;
  enum_values?: readonly string[];
  max_length?: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
}

/** 规则文件中一个版本的声明。 */
export interface RuntimeVersionRule {
  schema_version: number;
  status: EventStatus;
  fields: readonly RuntimeFieldRule[];
  change_note?: string;
  replaces_version?: number;
}

/** 规则文件中的一个事件。 */
export interface RuntimeEventRule {
  event_name: string;
  priority: EventPriority;
  versions: readonly RuntimeVersionRule[];
}

/** 导出的运行期校验规则。 */
export interface RuntimeRules {
  export_version: 1;
  schema_id: string;
  registry_name: string;
  generated_at: number;
  keep_versions: number;
  retention: { keep_versions: number; note: string };
  events: readonly RuntimeEventRule[];
}

/** 工具自带的规则 Schema（JSON Schema 2020-12）。 */
export const RUNTIME_RULES_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: RUNTIME_RULES_SCHEMA_ID,
  title: 'K01 导出的运行期校验规则（K01-F5）',
  type: 'object',
  required: ['export_version', 'schema_id', 'registry_name', 'generated_at', 'keep_versions', 'retention', 'events'],
  additionalProperties: false,
  properties: {
    export_version: { const: 1 },
    schema_id: { const: RUNTIME_RULES_SCHEMA_ID },
    registry_name: { type: 'string', minLength: 1, maxLength: 128 },
    generated_at: { type: 'integer', minimum: 0 },
    keep_versions: { type: 'integer', minimum: 1, maximum: 10 },
    retention: {
      type: 'object',
      required: ['keep_versions', 'note'],
      additionalProperties: false,
      properties: {
        keep_versions: { type: 'integer', minimum: 1, maximum: 10 },
        note: { type: 'string', minLength: 1, maxLength: 500 },
      },
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event_name', 'priority', 'versions'],
        additionalProperties: false,
        properties: {
          event_name: { type: 'string', pattern: '^[a-z][a-z0-9]*(_[a-z0-9]+)+$', maxLength: 64 },
          priority: { enum: ['normal', 'critical'] },
          versions: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['schema_version', 'status', 'fields'],
              additionalProperties: false,
              properties: {
                schema_version: { type: 'integer', minimum: 1 },
                status: { enum: ['draft', 'in_review', 'active', 'deprecated', 'retired'] },
                change_note: { type: 'string', maxLength: 1000 },
                replaces_version: { type: 'integer', minimum: 1 },
                fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'kind', 'type', 'required', 'description', 'sensitivity'],
                    additionalProperties: false,
                    properties: {
                      name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
                      kind: { enum: ['dimension', 'metric'] },
                      type: { enum: ['string', 'enum', 'integer', 'number', 'boolean'] },
                      required: { type: 'boolean' },
                      description: { type: 'string', minLength: 2, maxLength: 300 },
                      sensitivity: { enum: ['none', 'mask', 'hash', 'drop'] },
                      enum_values: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 200,
                        items: { type: 'string', maxLength: 64 },
                        uniqueItems: true,
                      },
                      max_length: { type: 'integer', minimum: 1, maximum: 256 },
                      minimum: { type: 'number' },
                      maximum: { type: 'number' },
                      unit: { enum: ['ms', 's', 'bytes', 'count', 'ratio', 'percent', 'px', 'none'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** 构建导出选项。 */
export interface BuildRulesOptions {
  registryName: string;
  generatedAt: number;
  keepVersions?: number;
}

/** 由事件定义构建运行期校验规则。 */
export function buildValidationRules(
  events: readonly EventDefinition[],
  options: BuildRulesOptions,
): RuntimeRules {
  const keepVersions = options.keepVersions ?? DEFAULT_KEEP_VERSIONS;
  const byName = new Map<string, EventDefinition[]>();
  for (const event of events) {
    const list = byName.get(event.eventName) ?? [];
    list.push(event);
    byName.set(event.eventName, list);
  }

  const rules: RuntimeEventRule[] = [];
  for (const eventName of [...byName.keys()].sort()) {
    const versions = byName.get(eventName) ?? [];
    const sorted = [...versions].sort((left, right) => right.schemaVersion - left.schemaVersion);
    const latest = sorted[0];
    if (latest === undefined) continue;
    rules.push({
      event_name: eventName,
      priority: latest.priority,
      versions: sorted.slice(0, keepVersions).map(toVersionRule),
    });
  }

  return {
    export_version: 1,
    schema_id: RUNTIME_RULES_SCHEMA_ID,
    registry_name: options.registryName,
    generated_at: options.generatedAt,
    keep_versions: keepVersions,
    retention: {
      keep_versions: keepVersions,
      note: '每个事件只保留最近 keep_versions 个 schema_version，保证未升级的客户端仍能入库（dictionary-compat.md 运行期校验）',
    },
    events: rules,
  };
}

function toVersionRule(event: EventDefinition): RuntimeVersionRule {
  const rule: RuntimeVersionRule = {
    schema_version: event.schemaVersion,
    status: event.status,
    fields: event.fields.map(toFieldRule),
  };
  if (event.changeNote !== undefined) rule.change_note = event.changeNote;
  if (event.replacesVersion !== undefined) rule.replaces_version = event.replacesVersion;
  return rule;
}

function toFieldRule(field: FieldDefinition): RuntimeFieldRule {
  const rule: RuntimeFieldRule = {
    name: field.name,
    kind: field.kind,
    type: field.type,
    required: field.required,
    description: field.description,
    sensitivity: field.sensitivity,
  };
  if (field.enum_values !== undefined) rule.enum_values = field.enum_values;
  if (field.max_length !== undefined) rule.max_length = field.max_length;
  if (field.minimum !== undefined) rule.minimum = field.minimum;
  if (field.maximum !== undefined) rule.maximum = field.maximum;
  if (field.unit !== undefined) rule.unit = field.unit;
  return rule;
}

let cachedRulesValidator: ReturnType<Ajv2020['compile']> | null = null;

function rulesValidator(): ReturnType<Ajv2020['compile']> {
  cachedRulesValidator ??= new Ajv2020({ allErrors: true, strict: false }).compile(RUNTIME_RULES_SCHEMA);
  return cachedRulesValidator;
}

/** 用工具自带的规则 Schema 校验一份导出结果；通过返回 `null`，否则返回可读错误列表。 */
export function validateRuntimeRules(value: unknown): string[] | null {
  const validate = rulesValidator();
  if (validate(value)) return null;
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath === '' ? '(根)' : error.instancePath} ${error.message ?? '不符合规则 Schema'}`,
  );
}
