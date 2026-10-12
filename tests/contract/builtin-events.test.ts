import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  absolutePath,
  asArray,
  asRecord,
  builtinExamplesDir,
  readJsonFile,
  repoPath,
  requireInteger,
  requireString,
} from './lib/fs-json';
import { compileContractRegistry } from './lib/schemas';

// examples/builtin-events/index.json 是 T06 产出的机器可读索引：
// 每个内置事件声明自己的 Schema、合法样例、非法样例与预期失败原因。
// 这里断言索引与磁盘上的 Schema、样例三者一致，避免索引漂移。
const registry = compileContractRegistry();
const indexPath = join(builtinExamplesDir, 'index.json');
const index = asRecord(readJsonFile(indexPath), 'builtin-events/index.json');
const eventEntries = asArray(index['events'], 'builtin-events/index.json.events');

interface BuiltinEventCase {
  readonly eventName: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly priority: string;
  readonly schemaName: string;
  /** 相对仓库根目录的 Schema 路径。 */
  readonly schemaPath: string;
  readonly invalidFiles: readonly string[];
}

const toBuiltinCase = (item: unknown, position: number): BuiltinEventCase => {
  const label = `builtin-events/index.json.events[${String(position)}]`;
  const event = asRecord(item, label);
  const schemaPath = repoPath(resolve(builtinExamplesDir, requireString(event, 'schema', label)));
  const additionalInvalid = event['additional_invalid'];
  const extra =
    additionalInvalid === undefined
      ? []
      : asArray(additionalInvalid, `${label}.additional_invalid`).map((entry, index0) =>
          requireString(asRecord(entry, `${label}.additional_invalid[${String(index0)}]`), 'file', `${label}.additional_invalid[${String(index0)}]`),
        );
  return {
    eventName: requireString(event, 'event_name', label),
    eventType: requireString(event, 'event_type', label),
    schemaVersion: requireInteger(event, 'schema_version', label),
    priority: requireString(event, 'priority', label),
    schemaName: basename(schemaPath, '.schema.json'),
    schemaPath,
    invalidFiles: [requireString(event, 'invalid', label), ...extra],
  };
};

const builtinCases = eventEntries.map((item, position) => toBuiltinCase(item, position));

describe('builtin-events/index.json 与 Schema、样例一致', () => {
  test.each([...builtinCases])('$eventName 的 Schema 存在、被 registry 登记，且 const 与索引一致', (builtinCase) => {
    expect({ path: builtinCase.schemaPath, exists: existsSync(absolutePath(builtinCase.schemaPath)) }).toEqual({
      path: builtinCase.schemaPath,
      exists: true,
    });
    expect(registry.schemaNames).toContain(builtinCase.schemaName);
    const schema = asRecord(readJsonFile(absolutePath(builtinCase.schemaPath)), builtinCase.schemaPath);
    const properties = asRecord(schema['properties'], `${builtinCase.schemaPath}.properties`);
    const constOf = (key: string): unknown => asRecord(properties[key], `${builtinCase.schemaPath}.properties.${key}`)['const'];
    expect(constOf('event_name')).toBe(builtinCase.eventName);
    expect(constOf('event_type')).toBe(builtinCase.eventType);
    expect(constOf('schema_version')).toBe(builtinCase.schemaVersion);
    expect(constOf('priority')).toBe(builtinCase.priority);
    expect(requireString(schema, '$id', builtinCase.schemaPath)).toBe(registry.schemaId(builtinCase.schemaName));
  });

  test.each([...builtinCases])('$eventName 的合法样例通过自己的 Schema，且声明字段一致', (builtinCase) => {
    const samplePath = join(builtinExamplesDir, `${builtinCase.eventName}.valid.json`);
    expect(existsSync(samplePath)).toBe(true);
    const sample = asRecord(readJsonFile(samplePath), repoPath(samplePath));
    expect(registry.validate(builtinCase.schemaName, sample)).toEqual({ valid: true, errors: [] });
    expect(sample['event_name']).toBe(builtinCase.eventName);
    expect(sample['event_type']).toBe(builtinCase.eventType);
    expect(sample['schema_version']).toBe(builtinCase.schemaVersion);
    expect(sample['priority']).toBe(builtinCase.priority);
  });

  test.each([...builtinCases])('$eventName 声明的非法样例都存在并且校验失败', (builtinCase) => {
    expect(builtinCase.invalidFiles.length).toBeGreaterThan(0);
    for (const invalidFile of builtinCase.invalidFiles) {
      const invalidPath = join(builtinExamplesDir, invalidFile);
      expect({ file: invalidFile, exists: existsSync(invalidPath) }).toEqual({ file: invalidFile, exists: true });
      const outcome = registry.validate(builtinCase.schemaName, readJsonFile(invalidPath));
      expect({ file: invalidFile, valid: outcome.valid }).toEqual({ file: invalidFile, valid: false });
    }
  });

  test('每个内置事件都声明了预期失败原因，非法样例命名以 .invalid.json 结尾', () => {
    for (const item of eventEntries) {
      const event = asRecord(item, 'builtin-events/index.json.events[]');
      expect(requireString(event, 'invalid_expectation', 'invalid_expectation').length).toBeGreaterThan(0);
    }
    for (const builtinCase of builtinCases) {
      for (const invalidFile of builtinCase.invalidFiles) {
        expect(invalidFile.endsWith('.invalid.json')).toBe(true);
      }
    }
  });
});
