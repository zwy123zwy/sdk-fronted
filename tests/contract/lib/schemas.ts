import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv2020, { type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {
  absolutePath,
  asArray,
  asRecord,
  examplesDir,
  isRecord,
  readJsonFile,
  repoPath,
  requireString,
  schemasDir,
} from './fs-json';

const SCHEMA_SUFFIX = '.schema.json';
const VALID_SUFFIX = '.valid.json';
const INVALID_SUFFIX = '.invalid.json';

/** README.md「约定」：Schema $id 的末段是契约文档版本（当前 0.2）。 */
export const CONTRACT_VERSION = '0.2';
export const ID_PREFIX = 'urn:web-report-sdk:contracts:';
const REMOTE_CONFIG_SCHEMA_NAME = 'remote-config';
const ENVELOPE_POINTER = '#/$defs/envelope';

export interface SchemaEntry {
  /** 相对仓库根目录的 Schema 路径。 */
  readonly path: string;
  /** 去掉 `.schema.json` 的文件基名，即样例命名约定的前缀（如 `batch`、`web_vitals`）。 */
  readonly name: string;
  /** 该 Schema 的样例目录（相对仓库根目录）。 */
  readonly samplesDirectory: string;
}

/**
 * 从文件系统枚举 docs/contracts/schemas/** 下的全部 `*.schema.json`。
 *
 * 枚举结果直接驱动双向校验与样例覆盖断言：新增 Schema 而不补样例时，
 * 覆盖断言会立即失败，不依赖人工清单。
 */
export const listSchemaEntries = (): readonly SchemaEntry[] => {
  const entries: SchemaEntry[] = [];
  const walk = (directory: string): void => {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!dirent.name.endsWith(SCHEMA_SUFFIX)) {
        continue;
      }
      entries.push({
        path: repoPath(fullPath),
        name: dirent.name.slice(0, -SCHEMA_SUFFIX.length),
        // schemas/builtin-events/x.schema.json 的样例在 examples/builtin-events/ 下，
        // 其余 Schema 的样例在 examples/ 下；用相对子目录保持同一套命名约定。
        samplesDirectory: repoPath(join(examplesDir, relative(schemasDir, directory))),
      });
    }
  };
  walk(schemasDir);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};

export interface SampleFiles {
  readonly valid: readonly string[];
  readonly invalid: readonly string[];
}

export type SampleKind = 'valid' | 'invalid';

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * 按契约 README 的命名约定找出某个 Schema 的样例：
 * `<name>.valid.json`、`<name>.invalid.json`，以及附加样例 `<name>-*.json`、`<name>.*.json`。
 * 例如 `batch-beacon.valid.json` 属于 `batch`，`web_vitals.rating.invalid.json` 属于 `web_vitals`。
 */
export const samplesFor = (entry: Pick<SchemaEntry, 'name' | 'samplesDirectory'>): SampleFiles => {
  const directory = absolutePath(entry.samplesDirectory);
  const prefix = new RegExp(`^${escapeForRegExp(entry.name)}[-.]`, 'u');
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const isSample = name.endsWith(VALID_SUFFIX) || name.endsWith(INVALID_SUFFIX);
    if (!isSample || !prefix.test(name)) {
      continue;
    }
    (name.endsWith(VALID_SUFFIX) ? valid : invalid).push(repoPath(join(directory, name)));
  }
  return { valid, invalid };
};

/** 该 Schema 缺失的样例类型；返回空数组表示合法样例与非法样例都齐备。 */
export const missingSampleKinds = (entry: Pick<SchemaEntry, 'name' | 'samplesDirectory'>): readonly SampleKind[] => {
  const files = samplesFor(entry);
  const missing: SampleKind[] = [];
  if (files.valid.length === 0) {
    missing.push('valid');
  }
  if (files.invalid.length === 0) {
    missing.push('invalid');
  }
  return missing;
};

/** 递归列出目录下全部 `*.valid.json` / `*.invalid.json`（样例命名约定的范围）。 */
export const listAllSampleFiles = (directory: string): readonly string[] => {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, dirent.name);
      if (dirent.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (dirent.name.endsWith(VALID_SUFFIX) || dirent.name.endsWith(INVALID_SUFFIX)) {
        found.push(repoPath(fullPath));
      }
    }
  };
  walk(directory);
  return found.sort();
};

export interface ValidationOutcome {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const describeErrors = (errors: readonly ErrorObject[] | null | undefined): readonly string[] =>
  (errors ?? []).map((error) => {
    const path = error.instancePath === '' ? '/' : error.instancePath;
    return `${path} ${error.keyword}: ${error.message ?? ''} ${JSON.stringify(error.params)}`.trim();
  });

const outcomeOf = (validate: ValidateFunction, value: unknown): ValidationOutcome => {
  const valid = validate(value);
  return { valid, errors: valid ? [] : describeErrors(validate.errors) };
};

export interface ContractRegistry {
  /** 全部契约 Schema 的基名。 */
  readonly schemaNames: readonly string[];
  /** 某个 Schema 的 $id（URN）。 */
  readonly schemaId: (name: string) => string;
  /** 直接用 Schema 校验。 */
  readonly validate: (name: string, value: unknown) => ValidationOutcome;
  /** 通过 `{ "$ref": "<$id>" }` 校验，用来证明 URN 形式的 $ref 能正确解析。 */
  readonly validateByRef: (name: string, value: unknown) => ValidationOutcome;
  /**
   * 校验某个契约 Schema 内部的一段 `$defs`（例如 `batch` 的 `event`）。
   *
   * 用途：真实产出的事件体正好是 `batch.schema.json#/$defs/event` 那一层
   * （批次公共头不在其中），必须能独立于完整批次被校验。这里仍然编译**同一份冻结
   * Schema**，只是换一个 `$ref` 指向，因此不会与 `validate('batch', ...)` 漂移；
   * 片段名写错时 Ajv 在编译期就报「can't resolve reference」。
   */
  readonly validateFragment: (name: string, fragment: string, value: unknown) => ValidationOutcome;
  /** 校验远程配置发布物 envelope（`remote-config.schema.json#/$defs/envelope`）。 */
  readonly validateEnvelope: (value: unknown) => ValidationOutcome;
}

/**
 * 创建 Ajv 2020-12 实例（含 ajv-formats）。
 *
 * 只关闭 `strictRequired` 这一条风格检查：冻结的 batch.schema.json 用
 * `allOf[].if/then` 表达「event_type 为 log 时必须带 level」，`then` 子模式里
 * 只有 `required` 而没有重复声明 `properties`（契约是只读的，不改契约）。
 * 其余 strict 检查保持开启，校验语义不受影响。
 */
export const createAjv = (): Ajv2020 => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv;
};

const asSchemaObject = (schema: Record<string, unknown>): AnySchemaObject => schema;

/** 编译一份测试内联的 Schema（用于验证 ajv-formats 等机制本身生效）。 */
export const compileInlineSchema = (ajv: Ajv2020, schema: Record<string, unknown>): ValidateFunction =>
  ajv.compile(asSchemaObject(schema));

/**
 * 把 docs/contracts/schemas/** 的全部 Schema 登记进一个 Ajv 实例并编译。
 *
 * - 使用 Ajv 2020（JSON Schema 2020-12），不手写关键字子集校验器。
 * - 每条 Schema 都按原文件编译，Ajv 会解析全部内部 `$ref`（含 `#/$defs/*`），
 *   引用解析不了会在编译期抛错，从而被 CI 拦住。
 * - 额外按 `$id`（URN）编译一份 `{ "$ref": "<$id>" }` 包装器，验证 URN 解析路径。
 * - `$defs` 片段（如 `batch#/$defs/event`）按需编译并缓存，供真实产出校验使用。
 */
export const compileContractRegistry = (): ContractRegistry => {
  const ajv = createAjv();
  const entries = listSchemaEntries();
  const ids = new Map<string, string>();
  const direct = new Map<string, ValidateFunction>();
  const byRef = new Map<string, ValidateFunction>();

  for (const entry of entries) {
    const schema = asRecord(readJsonFile(absolutePath(entry.path)), entry.path);
    const id = requireString(schema, '$id', entry.path);
    const compiled = ajv.compile(asSchemaObject(schema));
    if (ajv.getSchema(id) === undefined) {
      throw new Error(`${entry.path} 的 $id 没有被 Ajv 登记：${id}`);
    }
    ids.set(entry.name, id);
    direct.set(entry.name, compiled);
    byRef.set(entry.name, ajv.compile({ $ref: id }));
  }

  const remoteConfigId = ids.get(REMOTE_CONFIG_SCHEMA_NAME);
  if (remoteConfigId === undefined) {
    throw new Error(`契约中缺少 ${REMOTE_CONFIG_SCHEMA_NAME} Schema`);
  }
  const envelope = ajv.compile({ $ref: `${remoteConfigId}${ENVELOPE_POINTER}` });

  /** `$defs` 片段的校验器缓存，键为 `<Schema 基名>#/$defs/<片段名>`。 */
  const fragments = new Map<string, ValidateFunction>();
  const fragmentValidator = (name: string, fragment: string): ValidateFunction => {
    const key = `${name}#/$defs/${fragment}`;
    const cached = fragments.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const id = ids.get(name);
    if (id === undefined) {
      throw new Error(`未知的契约 Schema：${name}`);
    }
    // 与 validate(name, ...) 共用同一个 Ajv 实例（即同一份已编译的冻结 Schema）。
    const compiled = ajv.compile({ $ref: `${id}#/$defs/${fragment}` });
    fragments.set(key, compiled);
    return compiled;
  };

  const lookup = (map: Map<string, ValidateFunction>, name: string): ValidateFunction => {
    const validate = map.get(name);
    if (validate === undefined) {
      throw new Error(`未知的契约 Schema：${name}`);
    }
    return validate;
  };

  return {
    schemaNames: entries.map((entry) => entry.name),
    schemaId: (name) => {
      const id = ids.get(name);
      if (id === undefined) {
        throw new Error(`未知的契约 Schema：${name}`);
      }
      return id;
    },
    validate: (name, value) => outcomeOf(lookup(direct, name), value),
    validateByRef: (name, value) => outcomeOf(lookup(byRef, name), value),
    validateFragment: (name, fragment, value) => outcomeOf(fragmentValidator(name, fragment), value),
    validateEnvelope: (value) => outcomeOf(envelope, value),
  };
};

/** 合法样例正文的容器字段：remote-config.valid.json 是「发布物 + 解码后的正文」的容器。 */
const VALID_SAMPLE_BODY_FIELD: Readonly<Record<string, string>> = {
  [REMOTE_CONFIG_SCHEMA_NAME]: 'decoded_payload',
};

/** 从合法样例中取出应被校验的正文实例。 */
export const extractValidInstance = (schemaName: string, document: unknown, label: string): unknown => {
  const field = VALID_SAMPLE_BODY_FIELD[schemaName];
  if (field === undefined) {
    return document;
  }
  const record = asRecord(document, label);
  if (!(field in record)) {
    throw new Error(`${label} 缺少正文容器字段 ${field}`);
  }
  return record[field];
};

export interface InvalidInstance {
  readonly index: number;
  /** 样例自带的失败原因说明（`_why`），没有时为 undefined。 */
  readonly why: string | undefined;
  /** 去掉 `_` 前缀元数据后、真正应被拒绝的实例。 */
  readonly value: unknown;
}

/**
 * 取出非法样例里每一个应被拒绝的实例。
 *
 * - 容器形态（`{ "_cases": ..., "cases": [...] }`，见 batch/event-definition/remote-config）：
 *   逐个 case，并去掉 `_` 前缀的说明字段，让失败原因来自数据本身而不是元数据。
 * - 单值形态（`examples/builtin-events/*.invalid.json`）：整份文件就是被拒绝的事件体。
 */
export const extractInvalidInstances = (document: unknown, label: string): readonly InvalidInstance[] => {
  if (isRecord(document) && Array.isArray(document['cases'])) {
    return asArray(document['cases'], `${label}.cases`).map((item, index) => {
      const record = asRecord(item, `${label}.cases[${String(index)}]`);
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!key.startsWith('_')) {
          body[key] = value;
        }
      }
      const why = record['_why'];
      return { index, why: typeof why === 'string' ? why : undefined, value: body };
    });
  }
  return [{ index: 0, why: undefined, value: document }];
};

export const readContractSample = (sampleRepoPath: string): unknown => readJsonFile(absolutePath(sampleRepoPath));
