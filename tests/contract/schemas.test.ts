import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// T10 前的最小契约检查：样例与 Schema 都是合法 JSON，并且版本号一致。
// 完整的双向 Schema 校验（valid 通过、invalid 失败、签名样例）由 T10 实现。
const contracts = resolve(import.meta.dirname, '../../docs/contracts');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(contracts, path), 'utf8'));

const schemas = ['batch', 'event-definition', 'remote-config'] as const;
const examples = [
  'batch.valid.json',
  'batch-promoted.valid.json',
  'batch-beacon.valid.json',
  'batch.invalid.json',
  'event-definition.valid.json',
  'event-definition.invalid.json',
  'remote-config.valid.json',
  'remote-config.invalid.json',
];

describe('契约文件', () => {
  test.each(schemas)('%s.schema.json 是 0.2 版本的 JSON Schema 2020-12', (name) => {
    const schema = readJson(`schemas/${name}.schema.json`) as Record<string, unknown>;
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$id']).toBe(`urn:web-report-sdk:contracts:${name}:0.2`);
  });

  test.each(examples)('examples/%s 是合法 JSON', (file) => {
    expect(() => readJson(`examples/${file}`)).not.toThrow();
  });

  test('远程配置 Schema 不允许 consent_mode: full（D002）', () => {
    const schema = readJson('schemas/remote-config.schema.json') as {
      properties: { privacy: { properties: { consent_mode: { enum: string[] } } } };
    };
    expect(schema.properties.privacy.properties.consent_mode.enum).not.toContain('full');
  });
});
