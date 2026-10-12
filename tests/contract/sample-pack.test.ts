import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  absolutePath,
  asRecord,
  readJsonFile,
  readTextFile,
  receiverRequirementsFile,
  repoRoot,
} from './lib/fs-json';
import { compileContractRegistry, extractInvalidInstances, extractValidInstance } from './lib/schemas';
import { parseReceiverRequirements, parseSamplePackChecks, type SamplePackCheck } from './lib/sample-pack';

// AC4：接收方可复用的样例包。清单只引用 docs/contracts/examples/ 下已冻结的样例，
// 不复制样例本身（避免出现两份会漂移的样例），并把 receiver-requirements.md 的每条「必须」
// 映射到具体样例与自查步骤。这里断言清单与契约文档、样例文件三者一致。
const registry = compileContractRegistry();
const packDir = join(repoRoot, 'tests/contract/sample-pack');
const requirements = parseReceiverRequirements(readTextFile(receiverRequirementsFile));
const requirementIds = new Set(requirements.map((requirement) => requirement.id));
const documentedRequiredIds = requirements
  .filter((requirement) => requirement.level === '必须')
  .map((requirement) => requirement.id)
  .sort();

const DATA_CHECK_KINDS = ['data', 'data_and_behavior', 'behavior'];
const SAMPLE_EXPECTATIONS = ['pass', 'each_case_must_fail'];

interface SamplePack {
  readonly requiredChecks: readonly SamplePackCheck[];
  readonly optionalChecks: readonly SamplePackCheck[];
}

let cachedPack: SamplePack | undefined;

const loadPack = (): SamplePack => {
  if (cachedPack !== undefined) {
    return cachedPack;
  }
  const manifest = asRecord(readJsonFile(join(packDir, 'manifest.json')), 'sample-pack/manifest.json');
  cachedPack = {
    requiredChecks: parseSamplePackChecks(manifest['required_checks'], 'sample-pack/manifest.json.required_checks'),
    optionalChecks: parseSamplePackChecks(manifest['optional_checks'], 'sample-pack/manifest.json.optional_checks'),
  };
  return cachedPack;
};

const schemaNameOf = (schemaRepoPath: string): string => basename(schemaRepoPath, '.schema.json');

describe('AC4 样例包：覆盖 receiver-requirements.md 的全部「必须」条目', () => {
  test('required_checks 的编号集合与契约文档的「必须」条目完全一致', () => {
    const { requiredChecks } = loadPack();
    expect(requiredChecks.map((check) => check.id).sort()).toEqual(documentedRequiredIds);
  });

  test('required_checks 的级别都是「必须」，条目类型合法，且有自查说明', () => {
    const { requiredChecks } = loadPack();
    for (const check of requiredChecks) {
      expect({
        id: check.id,
        level: check.level,
        kind: DATA_CHECK_KINDS.includes(check.check_kind),
        hasSelfCheck: check.self_check.length > 0,
      }).toEqual({ id: check.id, level: '必须', kind: true, hasSelfCheck: true });
    }
  });

  test('optional_checks（应该 / 可以）都不是「必须」，且编号在契约文档中存在', () => {
    const { optionalChecks } = loadPack();
    for (const check of optionalChecks) {
      expect({ id: check.id, isRequired: check.level === '必须', documented: requirementIds.has(check.id) }).toEqual({
        id: check.id,
        isRequired: false,
        documented: true,
      });
    }
  });
});

describe('AC4 样例包：清单里的样例可复现（真的通过 / 真的失败）', () => {
  test('数据类条目至少引用一个样例，样例与 Schema 文件都存在；行为类条目不引用样例', () => {
    const { requiredChecks } = loadPack();
    for (const check of requiredChecks) {
      if (check.check_kind === 'behavior') {
        expect({ id: check.id, samples: check.samples.length }).toEqual({ id: check.id, samples: 0 });
        continue;
      }
      expect({ id: check.id, hasSample: check.samples.length > 0 }).toEqual({ id: check.id, hasSample: true });
      for (const sample of check.samples) {
        expect({ id: check.id, expect: SAMPLE_EXPECTATIONS.includes(sample.expect) }).toEqual({ id: check.id, expect: true });
        const schemaRepoPath = sample.schema;
        if (schemaRepoPath === undefined) {
          throw new Error(`${check.id} 的样例 ${sample.path} 缺少 schema`);
        }
        expect({
          id: check.id,
          sample: sample.path,
          sampleExists: existsSync(absolutePath(sample.path)),
          schemaExists: existsSync(absolutePath(schemaRepoPath)),
        }).toEqual({ id: check.id, sample: sample.path, sampleExists: true, schemaExists: true });
      }
    }
  });

  test('清单里每个样例的校验结论与样例包声明一致（pass / each_case_must_fail）', () => {
    const { requiredChecks } = loadPack();
    for (const check of requiredChecks) {
      for (const sample of check.samples) {
        const schemaRepoPath = sample.schema;
        if (schemaRepoPath === undefined) {
          throw new Error(`${check.id} 的样例 ${sample.path} 缺少 schema`);
        }
        const schemaName = schemaNameOf(schemaRepoPath);
        expect({ id: check.id, knownSchema: registry.schemaNames.includes(schemaName) }).toEqual({ id: check.id, knownSchema: true });
        const document = readJsonFile(absolutePath(sample.path));
        if (sample.expect === 'pass') {
          const value = extractValidInstance(schemaName, document, sample.path);
          expect({ id: check.id, sample: sample.path, outcome: registry.validate(schemaName, value) }).toEqual({
            id: check.id,
            sample: sample.path,
            outcome: { valid: true, errors: [] },
          });
          continue;
        }
        const instances = extractInvalidInstances(document, sample.path);
        expect({ id: check.id, sample: sample.path, hasCase: instances.length > 0 }).toEqual({
          id: check.id,
          sample: sample.path,
          hasCase: true,
        });
        for (const instance of instances) {
          expect({
            id: check.id,
            sample: sample.path,
            case: instance.index,
            valid: registry.validate(schemaName, instance.value).valid,
          }).toEqual({ id: check.id, sample: sample.path, case: instance.index, valid: false });
        }
      }
    }
  });
});

describe('AC4 样例包：不复制契约样例，README 说明用途与运行方式', () => {
  test('样例包目录里只有 manifest.json 与 README.md（样例只引用不复制）', () => {
    expect(readdirSync(packDir).sort()).toEqual(['README.md', 'manifest.json']);
  });

  test('README.md 列出全部「必须」编号，并说明如何运行契约测试', () => {
    const readme = readTextFile(join(packDir, 'README.md'));
    for (const id of documentedRequiredIds) {
      expect({ id, mentioned: readme.includes(id) }).toEqual({ id, mentioned: true });
    }
    expect(readme.includes('pnpm test:contract')).toBe(true);
  });
});
