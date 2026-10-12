import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
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
} from './lib/fs-json';
import {
  CONTRACT_VERSION,
  ID_PREFIX,
  compileContractRegistry,
  compileInlineSchema,
  createAjv,
  extractInvalidInstances,
  extractValidInstance,
  listAllSampleFiles,
  listSchemaEntries,
  missingSampleKinds,
  readContractSample,
  samplesFor,
} from './lib/schemas';

// 全部断言都从文件系统枚举 docs/contracts/schemas 与 examples 得出，
// 不用人工清单：新增 Schema 或新增样例都会被自动纳入。
const entries = listSchemaEntries();
const registry = compileContractRegistry();
const remoteConfigSchemaPath = repoPath(join(schemasDir, 'remote-config.schema.json'));

describe('契约 Schema 基本约束', () => {
  test.each([...entries])('$path 是 2020-12 JSON Schema，\\$id 是 0.2 的 URN', (entry) => {
    const schema = asRecord(readJsonFile(absolutePath(entry.path)), entry.path);
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const id = requireString(schema, '$id', entry.path);
    expect(id.startsWith(ID_PREFIX)).toBe(true);
    expect(id.endsWith(`:${CONTRACT_VERSION}`)).toBe(true);
    expect(registry.schemaId(entry.name)).toBe(id);
  });

  test('远程配置 Schema 不允许 consent_mode: full（D002）', () => {
    const schema = asRecord(readJsonFile(absolutePath(remoteConfigSchemaPath)), 'remote-config.schema.json');
    const properties = asRecord(schema['properties'], 'remote-config.schema.json.properties');
    const privacy = asRecord(properties['privacy'], 'remote-config.schema.json.properties.privacy');
    const privacyProperties = asRecord(privacy['properties'], 'remote-config.schema.json.properties.privacy.properties');
    const consentMode = asRecord(privacyProperties['consent_mode'], 'consent_mode');
    expect(consentMode['enum']).not.toContain('full');
  });

  test('ajv-formats 已启用（format 关键字生效，不是手写关键字子集校验器）', () => {
    const ajv = createAjv();
    const validate = compileInlineSchema(ajv, { type: 'string', format: 'date-time' });
    expect(validate('2026-10-12T00:00:00Z')).toBe(true);
    expect(validate('2026-10-12 00:00:00')).toBe(false);
  });

  test('Schema 里的全部 $ref（含内部 $defs 与 URN $id）都能被 Ajv 解析', () => {
    // compileContractRegistry 在编译期解析全部 $ref；这里再用 URN $ref 走一遍解析路径。
    for (const entry of entries) {
      for (const samplePath of samplesFor(entry).valid) {
        const value = extractValidInstance(entry.name, readContractSample(samplePath), samplePath);
        expect({
          sample: samplePath,
          schema: entry.name,
          outcome: registry.validateByRef(entry.name, value),
        }).toEqual({
          sample: samplePath,
          schema: entry.name,
          outcome: { valid: true, errors: [] },
        });
      }
    }
  });
});

describe('AC1 双向校验：所有合法样例都通过校验', () => {
  for (const entry of entries) {
    for (const samplePath of samplesFor(entry).valid) {
      test(`${samplePath} 通过 ${entry.path}`, () => {
        const value = extractValidInstance(entry.name, readContractSample(samplePath), samplePath);
        expect(registry.validate(entry.name, value)).toEqual({ valid: true, errors: [] });
      });
    }
  }
});

describe('AC1 双向校验：非法样例中的每一个 case 都校验失败', () => {
  for (const entry of entries) {
    for (const samplePath of samplesFor(entry).invalid) {
      const instances = extractInvalidInstances(readContractSample(samplePath), samplePath);
      for (const instance of instances) {
        test(`${samplePath} case[${String(instance.index)}] 必须失败（${instance.why ?? '整份样例'}）`, () => {
          const outcome = registry.validate(entry.name, instance.value);
          expect({ valid: outcome.valid, hasErrors: outcome.errors.length > 0 }).toEqual({
            valid: false,
            hasErrors: true,
          });
        });
      }
    }
  }
});

describe('AC3 结构与双向覆盖：改动 Schema 而不更新样例时 CI 失败', () => {
  test.each([...entries])('$path 至少各有一个合法样例与一个非法样例', (entry) => {
    expect(missingSampleKinds(entry)).toEqual([]);
    expect(samplesFor(entry).valid.length).toBeGreaterThan(0);
    expect(samplesFor(entry).invalid.length).toBeGreaterThan(0);
  });

  test('机制自检：新增 Schema 而没有样例时会被判定为缺失', () => {
    const hypothetical = { name: 'zzz-not-a-contract-schema', samplesDirectory: repoPath(examplesDir) };
    expect(samplesFor(hypothetical)).toEqual({ valid: [], invalid: [] });
    expect(missingSampleKinds(hypothetical)).toEqual(['valid', 'invalid']);
  });

  test('examples/ 下的合法/非法样例都被某个 Schema 覆盖（没有孤儿样例）', () => {
    const claimed = new Set(entries.flatMap((entry) => [...samplesFor(entry).valid, ...samplesFor(entry).invalid]));
    const orphans = listAllSampleFiles(examplesDir).filter((samplePath) => !claimed.has(samplePath));
    expect(orphans).toEqual([]);
  });
});

// event-standard.md 第 3 节：字段提升规则。契约要求契约测试覆盖
// 「全部提升」「部分提升」「不提升」三种样例，且提升不得改变语义。
const PROMOTABLE_FIELDS = ['page_id', 'view_id', 'url', 'sample_rate', 'context'] as const;
type PromotionShape = 'none' | 'full' | 'partial';

const promotionShapeOf = (batch: Record<string, unknown>): PromotionShape => {
  const common = batch['common'];
  const promotedFields = isRecord(common) ? PROMOTABLE_FIELDS.filter((field) => field in common) : [];
  if (promotedFields.length === 0) {
    return 'none';
  }
  const events = asArray(batch['events'], 'batch.events').map((event, position) => asRecord(event, `batch.events[${String(position)}]`));
  const overriddenByEvent = promotedFields.some((field) => events.some((event) => field in event));
  return overriddenByEvent ? 'partial' : 'full';
};

describe('event-standard.md 第 3 节：字段提升的三种样例都被覆盖', () => {
  test('合法批次样例覆盖「不提升 / 全部提升 / 部分提升」', () => {
    const batchEntry = listSchemaEntries().find((entry) => entry.name === 'batch');
    if (batchEntry === undefined) {
      throw new Error('找不到 batch.schema.json');
    }
    const shapes = samplesFor(batchEntry).valid.map((samplePath) =>
      promotionShapeOf(asRecord(readContractSample(samplePath), samplePath)),
    );
    expect([...new Set(shapes)].sort()).toEqual(['full', 'none', 'partial']);
  });
});
