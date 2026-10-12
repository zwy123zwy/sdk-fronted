/**
 * K01 事件定义校验与注册表加载（K01-F1、K01-F3）。
 *
 * 校验用 Ajv 2020（`ajv/dist/2020`）逐条应用 `event-definition.schema.json`（契约 0.2），
 * 不手写 JSON Schema 关键字子集。契约里 JSON Schema 表达不了的规则（critical 配额、
 * metric 字段名后缀与 unit 一致）在本模块里显式检查，并输出可读的字段路径。
 *
 * 只用 Node 内置模块 + 已批准的 ajv。
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

/** 事件投递等级（Q3）。 */
export type EventPriority = 'normal' | 'critical';
/** 事件生命周期状态。 */
export type EventStatus = 'draft' | 'in_review' | 'active' | 'deprecated' | 'retired';
/** 字段类型。 */
export type FieldTypeName = 'string' | 'enum' | 'integer' | 'number' | 'boolean';
/** 字段归类：dimension 写入 dimensions，metric 写入 metrics。 */
export type FieldKind = 'dimension' | 'metric';
/** 接收方二次脱敏方式。 */
export type Sensitivity = 'none' | 'mask' | 'hash' | 'drop';
/** metric 字段的计量单位。 */
export type FieldUnit = 'ms' | 's' | 'bytes' | 'count' | 'ratio' | 'percent' | 'px' | 'none';

/** 注册表中的一个事件字段定义。 */
export interface FieldDefinition {
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
  unit?: FieldUnit;
}

/** 注册表中的一个带版本的事件定义。 */
export interface EventDefinition {
  eventName: string;
  schemaVersion: number;
  eventType: 'custom' | 'log';
  description: string;
  owner: string;
  trigger: string;
  priority: EventPriority;
  status: EventStatus;
  fields: readonly FieldDefinition[];
  appIds?: readonly string[];
  criticalReason?: string;
  changeNote?: string;
  replacesVersion?: number;
  /** 定义来自哪个文件（相对仓库根目录）。 */
  sourceFile: string;
}

/** 校验/加载问题：`code` 供程序判定，`message` 给人看，`path` 指出字段位置。 */
export interface DefinitionProblem {
  code: string;
  message: string;
  /** JSON 指针风格路径，如 `/fields/0/name`；没有字段位置时为空串。 */
  path: string;
  file?: string;
  eventName?: string;
}

/** 校验结果。 */
export type ValidationResult =
  | { ok: true; definition: EventDefinition }
  | { ok: false; errors: readonly DefinitionProblem[] };

/** critical 配额结果（K01-F3、Q3 结论：不超过总数的 10%）。 */
export interface CriticalQuota {
  totalCount: number;
  criticalCount: number;
  limit: number;
  ratio: number;
  ok: boolean;
  message: string;
}

/** 已加载的注册表（由 `registry.ts` 的 `loadRegistry` 产出）。 */
export interface Registry {
  events: readonly EventDefinition[];
  files: readonly string[];
  errors: readonly DefinitionProblem[];
  criticalQuota: CriticalQuota;
}

/** critical 配额上限（Q3 结论：10%）。 */
export const CRITICAL_QUOTA_RATIO = 0.1;

/** 字段名后缀与 unit 一致性规则的说明（契约 `unit` 描述）。 */
export const UNIT_SUFFIX_RULE =
  'metric 字段名后缀必须与 unit 一致（unit 为 ms/bytes/ratio 时字段名必须以 _ms/_bytes/_ratio 结尾）';

/**
 * 与契约 `docs/contracts/schemas/event-definition.schema.json` 0.2 逐关键字一致的 Schema 对象。
 *
 * 结构（`required`、`additionalProperties`、`allOf`、`$defs`）与契约完全相同，只去掉纯说明性的
 * `description` 字段。`src/__tests__/definitions.test.ts` 逐项断言一致性；字段路径错误依赖这份结构，
 * 因此不能改写（例如 `fields.items` 必须保留 `$ref: '#/$defs/field'`）。
 */
export const EVENT_DEFINITION_SCHEMA: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:web-report-sdk:contracts:event-definition:0.2",
  title: "事件注册表中的事件定义（K01 元模型）",
  type: "object",
  "required": [
    "event_name",
    "schema_version",
    "event_type",
    "description",
    "owner",
    "trigger",
    "priority",
    "status",
    "fields"
  ],
  additionalProperties: false,
  "properties": {
    "event_name": {
      type: "string",
      pattern: "^[a-z][a-z0-9]*(_[a-z0-9]+)+$",
      maxLength: 64,
      "not": {
        pattern: "^(sdk|web)_"
      },
      description: "业务域前缀加小写下划线；sdk_、web_ 为 SDK 保留前缀"
    },
    "schema_version": {
      type: "integer",
      minimum: 1
    },
    "event_type": {
      "enum": [
        "custom",
        "log"
      ]
    },
    "description": {
      type: "string",
      minLength: 4,
      maxLength: 500
    },
    "owner": {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "负责人或负责团队的标识，不写个人联系方式"
    },
    "trigger": {
      type: "string",
      minLength: 4,
      maxLength: 500,
      description: "触发时机，写清在哪个业务动作的哪个时刻上报"
    },
    "priority": {
      "enum": [
        "normal",
        "critical"
      ],
      description: "投递等级，判定规则见 decisions/Q3；critical 需要同时填写 critical_reason"
    },
    "critical_reason": {
      type: "string",
      minLength: 10,
      maxLength: 500
    },
    "status": {
      "enum": [
        "draft",
        "in_review",
        "active",
        "deprecated",
        "retired"
      ]
    },
    "app_ids": {
      type: "array",
      description: "允许上报该事件的应用；为空表示所有应用",
      "items": {
        type: "string",
        pattern: "^[a-z0-9][a-z0-9_-]{2,63}$"
      },
      uniqueItems: true
    },
    "fields": {
      type: "array",
      maxItems: 100,
      "items": {
        $ref: "#/$defs/field"
      }
    },
    "change_note": {
      type: "string",
      maxLength: 1000,
      description: "本版本相对上一版本的变更说明"
    },
    "replaces_version": {
      type: "integer",
      minimum: 1
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "priority": {
            const: "critical"
          }
        }
      },
      "then": {
        "required": [
          "critical_reason"
        ]
      }
    }
  ],
  "$defs": {
    "field": {
      type: "object",
      "required": [
        "name",
        "kind",
        "type",
        "required",
        "description",
        "sensitivity"
      ],
      additionalProperties: false,
      "properties": {
        "name": {
          type: "string",
          pattern: "^[a-z][a-z0-9_]{0,63}$"
        },
        "kind": {
          "enum": [
            "dimension",
            "metric"
          ],
          description: "dimension 写入 dimensions，metric 写入 metrics"
        },
        "type": {
          "enum": [
            "string",
            "enum",
            "integer",
            "number",
            "boolean"
          ],
          description: "dimension 只能是 string、enum、boolean；metric 只能是 integer、number、boolean"
        },
        "required": {
          type: "boolean"
        },
        "description": {
          type: "string",
          minLength: 2,
          maxLength: 300
        },
        "enum_values": {
          type: "array",
          minItems: 1,
          maxItems: 200,
          "items": {
            type: "string",
            maxLength: 64
          },
          uniqueItems: true
        },
        "max_length": {
          type: "integer",
          minimum: 1,
          maximum: 256
        },
        "minimum": {
          type: "number"
        },
        "maximum": {
          type: "number"
        },
        "unit": {
          "enum": [
            "ms",
            "s",
            "bytes",
            "count",
            "ratio",
            "percent",
            "px",
            "none"
          ],
          description: "metric 必填；字段名后缀必须与单位一致（_ms、_bytes、_ratio）"
        },
        "sensitivity": {
          "enum": [
            "none",
            "mask",
            "hash",
            "drop"
          ],
          description: "接收方二次脱敏时的处理方式，由 K01 导出到校验规则（K01-F5）"
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "type": {
                const: "enum"
              }
            }
          },
          "then": {
            "required": [
              "enum_values"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                const: "metric"
              }
            }
          },
          "then": {
            "required": [
              "unit"
            ],
            "properties": {
              "type": {
                "enum": [
                  "integer",
                  "number",
                  "boolean"
                ]
              }
            }
          }
        },
        {
          "if": {
            "properties": {
              "kind": {
                const: "dimension"
              }
            }
          },
          "then": {
            "properties": {
              "type": {
                "enum": [
                  "string",
                  "enum",
                  "boolean"
                ]
              }
            }
          }
        }
      ]
    }
  }
};

/** 契约 Schema 文件的默认路径（相对仓库根目录）。 */
export const CONTRACT_SCHEMA_RELATIVE_PATH = 'docs/contracts/schemas/event-definition.schema.json';

/** 用 Ajv 2020 编译一份 Schema；失败时抛出可读错误。 */
export function createSchemaValidator(schema: object): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  return ajv.compile(schema);
}

let cachedBundledValidator: ValidateFunction | null = null;

function bundledValidator(): ValidateFunction {
  cachedBundledValidator ??= createSchemaValidator(EVENT_DEFINITION_SCHEMA);
  return cachedBundledValidator;
}

/**
 * 按契约 Schema 校验一份事件定义。
 *
 * `validator` 可注入（接入方用 `--schema` 指定自带校验器）；默认使用与契约一致的元模型。
 */
export function validateEventDefinition(
  value: unknown,
  validator?: ValidateFunction,
): ValidationResult {
  const validate = validator ?? bundledValidator();
  const accepted = validate(value);
  if (!accepted) {
    return { ok: false, errors: ajvErrorsToProblems(validate.errors ?? []) };
  }
  return { ok: true, definition: parseEventDefinition(value) };
}

/** 把 Ajv 的实例路径与错误信息渲染成可读问题列表。 */
export function ajvErrorsToProblems(errors: readonly ErrorObject[]): DefinitionProblem[] {
  return errors.map((error) => {
    const basePath = error.instancePath;
    // `required` 错误的 instancePath 指向父对象，缺失的属性名在 params 里：
    // 补上属性名，错误信息才能精确到 /fields/0/enum_values（K01-AC-02）
    const params: Record<string, unknown> = error.params;
    const missingProperty = params['missingProperty'];
    const path =
      error.keyword === 'required' && typeof missingProperty === 'string'
        ? `${basePath}/${missingProperty}`
        : basePath;
    const detail =
      error.keyword === 'not' && isRecord(params['schema'])
        ? `取值不符合约束：${JSON.stringify(params['schema'])}`
        : (error.message ?? '不符合 Schema');
    const allowedValues = params['allowedValues'];
    const allowed =
      error.keyword === 'enum' && Array.isArray(allowedValues)
        ? `（允许值：${allowedValues.map((value) => String(value)).join('、')}）`
        : '';
    return {
      code: `schema_${error.keyword}`,
      message: `${path === '' ? '(根)' : path} ${detail}${allowed}`,
      path: path === '' ? '/(根)' : path,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** 把已通过 Schema 的 JSON 收窄成 `EventDefinition`。 */
export function parseEventDefinition(value: unknown, sourceFile = ''): EventDefinition {
  if (!isRecord(value)) {
    throw new Error('事件定义必须是 JSON 对象（应先用 validateEventDefinition 校验）');
  }
  const rawFields = Array.isArray(value['fields']) ? value['fields'] : [];
  const fields: FieldDefinition[] = [];
  for (const rawField of rawFields) {
    if (!isRecord(rawField)) continue;
    const field: FieldDefinition = {
      name: asString(rawField['name']),
      kind: rawField['kind'] === 'metric' ? 'metric' : 'dimension',
      type: (rawField['type'] ?? 'string') as FieldTypeName,
      required: rawField['required'] === true,
      description: asString(rawField['description']),
      sensitivity: (rawField['sensitivity'] ?? 'none') as Sensitivity,
    };
    if (Array.isArray(rawField['enum_values'])) {
      field.enum_values = rawField['enum_values'].map((item) => asString(item));
    }
    const maxLength = asNumber(rawField['max_length']);
    if (maxLength !== undefined) field.max_length = maxLength;
    const minimum = asNumber(rawField['minimum']);
    if (minimum !== undefined) field.minimum = minimum;
    const maximum = asNumber(rawField['maximum']);
    if (maximum !== undefined) field.maximum = maximum;
    const unit = rawField['unit'];
    if (typeof unit === 'string') field.unit = unit as FieldUnit;
    fields.push(field);
  }

  const definition: EventDefinition = {
    eventName: asString(value['event_name']),
    schemaVersion: asNumber(value['schema_version']) ?? 0,
    eventType: value['event_type'] === 'log' ? 'log' : 'custom',
    description: asString(value['description']),
    owner: asString(value['owner']),
    trigger: asString(value['trigger']),
    priority: value['priority'] === 'critical' ? 'critical' : 'normal',
    status: (value['status'] ?? 'draft') as EventStatus,
    fields,
    sourceFile,
  };
  if (Array.isArray(value['app_ids'])) {
    definition.appIds = value['app_ids'].map((item) => asString(item));
  }
  const criticalReason = value['critical_reason'];
  if (typeof criticalReason === 'string') definition.criticalReason = criticalReason;
  const changeNote = value['change_note'];
  if (typeof changeNote === 'string') definition.changeNote = changeNote;
  const replacesVersion = asNumber(value['replaces_version']);
  if (replacesVersion !== undefined) definition.replacesVersion = replacesVersion;
  return definition;
}

/** 契约里 JSON Schema 表达不了的规则（单位后缀映射）。 */
export function checkSemanticRules(definition: EventDefinition): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  definition.fields.forEach((field, index) => {
    const path = `/fields/${String(index)}`;
    if (field.kind === 'metric' && field.unit !== undefined && !unitSuffixMatches(field.name, field.unit)) {
      problems.push({
        code: 'metric_unit_suffix_mismatch',
        message: `${path}/name 字段名 "${field.name}" 与 unit "${field.unit}" 不一致：${UNIT_SUFFIX_RULE}`,
        path: `${path}/name`,
        eventName: definition.eventName,
      });
    }
  });
  return problems;
}

/** 字段名后缀与 unit 的映射（契约 `unit` 描述）。 */
export function unitSuffixMatches(name: string, unit: FieldUnit): boolean {
  switch (unit) {
    case 'ms':
      return name.endsWith('_ms');
    case 's':
      return true;
    case 'bytes':
      return name.endsWith('_bytes');
    case 'count':
      return true;
    case 'ratio':
      return name.endsWith('_ratio');
    case 'percent':
      return true;
    case 'px':
      return true;
    case 'none':
      return true;
    default:
      return true;
  }
}

/** 计算 critical 配额。 */
export function computeCriticalQuota(events: readonly EventDefinition[]): CriticalQuota {
  const names = new Set(events.map((event) => event.eventName));
  const criticalNames = new Set(
    events.filter((event) => event.priority === 'critical').map((event) => event.eventName),
  );
  const totalCount = names.size;
  const criticalCount = criticalNames.size;
  const limit = Math.floor(totalCount * CRITICAL_QUOTA_RATIO);
  const ratio = totalCount === 0 ? 0 : criticalCount / totalCount;
  const ok = criticalCount <= limit;
  const message = ok
    ? `critical 事件 ${String(criticalCount)}/${String(totalCount)}（${(ratio * 100).toFixed(1)}%），未超过 10% 配额`
    : `critical 事件 ${String(criticalCount)}/${String(totalCount)}（${(ratio * 100).toFixed(1)}%）超过 10% 配额（上限 ${String(limit)} 个），请降级为 normal 或拆分注册表`;
  return { totalCount, criticalCount, limit, ratio, ok, message };
}

/** 读取契约 Schema 文件并编译成校验器（`--schema` 用）。 */
export function loadSchemaValidator(schemaPath: string): ValidateFunction {
  const raw = readFileSync(schemaPath, 'utf8');
  const schema: unknown = JSON.parse(raw);
  if (!isRecord(schema)) throw new Error(`Schema 文件不是 JSON 对象：${schemaPath}`);
  return createSchemaValidator(schema);
}

/** 聚合每个事件名的最高版本号。 */
export function latestVersions(events: readonly EventDefinition[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const event of events) {
    const current = latest.get(event.eventName);
    if (current === undefined || event.schemaVersion > current) {
      latest.set(event.eventName, event.schemaVersion);
    }
  }
  return latest;
}
