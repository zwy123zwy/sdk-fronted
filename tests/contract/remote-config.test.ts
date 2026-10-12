import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { absolutePath, asRecord, examplesDir, readJsonFile, repoPath, requireString } from './lib/fs-json';
import { compileContractRegistry } from './lib/schemas';

// examples/remote-config.valid.json 同时包含签名发布物 envelope 与解码后的配置正文 decoded_payload
// （契约 remote-config.md 第 4、5 节）。两者都是契约对象，分别校验。
const registry = compileContractRegistry();
const validSamplePath = repoPath(join(examplesDir, 'remote-config.valid.json'));
const invalidSamplePath = repoPath(join(examplesDir, 'remote-config.invalid.json'));

const validDocument = asRecord(readJsonFile(absolutePath(validSamplePath)), validSamplePath);
const envelope = asRecord(validDocument['envelope'], `${validSamplePath}.envelope`);
const decodedPayload = validDocument['decoded_payload'];

describe('远程配置发布物与正文（examples/remote-config.valid.json）', () => {
  test('样例同时包含 envelope 与 decoded_payload', () => {
    expect(validDocument['envelope']).toBeDefined();
    expect(decodedPayload).toBeDefined();
  });

  test('envelope 通过 remote-config.schema.json#/$defs/envelope', () => {
    expect(registry.validateEnvelope(envelope)).toEqual({ valid: true, errors: [] });
  });

  test('envelope.signature 是 86 字符的 base64url（无填充，IEEE P1363 的 64 字节）', () => {
    const signature = requireString(envelope, 'signature', 'envelope');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(Buffer.from(signature, 'base64url').length).toBe(64);
  });

  test('envelope.payload 是配置正文字符串，解码后通过正文 Schema', () => {
    const payload = requireString(envelope, 'payload', 'envelope');
    const body: unknown = JSON.parse(payload);
    expect(registry.validate('remote-config', body)).toEqual({ valid: true, errors: [] });
  });

  test('decoded_payload 通过正文 Schema', () => {
    expect(registry.validate('remote-config', decodedPayload)).toEqual({ valid: true, errors: [] });
  });

  test('envelope.payload 与 decoded_payload 的 scope 与版本一致（app_id/env/config_version）', () => {
    const payload = requireString(envelope, 'payload', 'envelope');
    const body = asRecord(JSON.parse(payload) as unknown, `${validSamplePath}.envelope.payload`);
    const decoded = asRecord(decodedPayload, `${validSamplePath}.decoded_payload`);
    for (const field of ['app_id', 'env', 'config_version'] as const) {
      expect(body[field]).toBe(decoded[field]);
    }
  });
});

describe('远程配置非法样例是「正文」形态的 case 容器', () => {
  test('examples/remote-config.invalid.json 用 cases 数组逐个列出非法正文', () => {
    const document = asRecord(readJsonFile(absolutePath(invalidSamplePath)), invalidSamplePath);
    expect(Array.isArray(document['cases'])).toBe(true);
  });
});
