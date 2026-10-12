/**
 * 契约 Schema 的加载与编译（`docs/contracts/schemas/remote-config.schema.json`，0.2 冻结版）。
 *
 * 只用 Node 内置模块 + 已批准的 `ajv`。编译结果在进程内缓存复用；
 * 重复编译不是必要的开销，但缓存也让 AC-09 的计时更稳定。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { checkProblem, type Problem } from './errors.js';

/** 发布物结构（`remote-config.md` 第 4 节、Schema `$defs/envelope`）。 */
export interface Envelope {
  readonly format_version: number;
  readonly key_id: string;
  readonly alg: string;
  readonly payload: string;
  readonly signature: string;
}

/** 校验函数（带 `errors`）。 */
export interface Validator {
  (value: unknown): boolean;
  readonly errors?: readonly ErrorObject[] | null;
}

/** 仓库根目录：从模块位置向上找到含 `pnpm-workspace.yaml` 的目录。 */
export function repoRoot(): string {
  let candidate = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(candidate, 'pnpm-workspace.yaml'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  const fallback = resolve(process.cwd());
  if (existsSync(join(fallback, 'pnpm-workspace.yaml'))) return fallback;
  throw new Error('找不到仓库根目录（缺少 pnpm-workspace.yaml），请在仓库内运行');
}

/** 契约 Schema 的路径。 */
export function schemaPath(): string {
  return join(repoRoot(), 'docs/contracts/schemas/remote-config.schema.json');
}

const DEFAULT_SCHEMA_ID = 'urn:web-report-sdk:contracts:remote-config:0.2';

interface RawSchema {
  readonly $id?: string;
  readonly $defs?: Record<string, unknown>;
}

function loadRawSchema(): { readonly schema: RawSchema; readonly id: string } {
  const schema = JSON.parse(readFileSync(schemaPath(), 'utf8')) as RawSchema;
  return { schema, id: schema.$id ?? DEFAULT_SCHEMA_ID };
}

function makeAjv(): Ajv2020 {
  // 契约明确要求「正文允许额外字段」，因此保持默认的 removeAdditional 关闭。
  return new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
}

let bodyValidator: Validator | undefined;
let envelopeValidator: Validator | undefined;

/** 配置正文校验器（Schema 根对象）。 */
export function getBodyValidator(): Validator {
  if (bodyValidator === undefined) {
    const { schema, id } = loadRawSchema();
    const ajv = makeAjv();
    ajv.addSchema({ ...schema, $id: id });
    bodyValidator = ajv.getSchema(id) as Validator;
  }
  return bodyValidator;
}

/** 发布物校验器（`$defs/envelope`）。 */
export function getEnvelopeValidator(): Validator {
  if (envelopeValidator === undefined) {
    const { schema, id } = loadRawSchema();
    const ajv = makeAjv();
    ajv.addSchema({ ...schema, $id: id });
    envelopeValidator = ajv.getSchema(`${id}#/$defs/envelope`) as Validator;
  }
  return envelopeValidator;
}

/**
 * 字段路径：Ajv 对 `required` 把 `instancePath` 报在父对象上，
 * 这里补上缺失字段名，保证「错误信息含字段路径」（K02-AC-01）。
 */
export function errorPath(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'required') {
    const missing = scalar(params['missingProperty']);
    return `${error.instancePath}/${missing}`;
  }
  if (error.keyword === 'propertyNames') {
    const propertyName = scalar(params['propertyName']);
    return `${error.instancePath}/${propertyName}`;
  }
  if (error.keyword === 'additionalProperties') {
    const additional = scalar(params['additionalProperty']);
    return `${error.instancePath}/${additional}`;
  }
  return error.instancePath;
}

/** 把 Ajv 参数安全地转成字符串；只接受 string/number，绝不 stringify 对象。 */
function scalar(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
}

/** 关键字 + 参数 → 不包含实际取值的说明。 */
function describeError(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required':
      return `缺少必需字段「${scalar(params['missingProperty'])}」`;
    case 'enum':
      return '取值不在允许的枚举内';
    case 'const':
      return '取值必须等于约定常量';
    case 'additionalProperties':
      return `不允许出现额外字段「${scalar(params['additionalProperty'])}」`;
    case 'type':
      return `类型必须是 ${scalar(params['type'])}`;
    case 'pattern':
      return '字符串不满足约定格式';
    case 'minimum':
      return `数值必须不小于 ${scalar(params['limit'])}`;
    case 'maximum':
      return `数值必须不大于 ${scalar(params['limit'])}`;
    case 'exclusiveMinimum':
      return `数值必须大于 ${scalar(params['limit'])}`;
    case 'minLength':
      return `长度必须不小于 ${scalar(params['limit'])}`;
    case 'maxLength':
      return `长度必须不大于 ${scalar(params['limit'])}`;
    case 'minItems':
      return `数组元素个数必须不少于 ${scalar(params['limit'])}`;
    case 'maxItems':
      return `数组元素个数必须不多于 ${scalar(params['limit'])}`;
    case 'minProperties':
      return '对象至少要有一个属性';
    case 'uniqueItems':
      return '数组元素不能重复';
    case 'propertyNames':
      return '存在不允许的属性名';
    default:
      return `不满足约束（${error.keyword}）`;
  }
}

/**
 * 把 Ajv 错误转成 `Problem` 列表。
 *
 * 只使用 `keyword` 与 `params` 生成说明；即使 `error.message` 里带了实际取值，
 * 也不会进入输出（AC-07 要求不打印字符串原文）。
 */
export function toSchemaProblems(
  errors: readonly ErrorObject[] | null | undefined,
): readonly Problem[] {
  if (errors === null || errors === undefined) return [];
  return errors.map((error) =>
    checkProblem(
      'schema_invalid',
      `Schema 校验失败：${describeError(error)}`,
      errorPath(error),
    ),
  );
}
