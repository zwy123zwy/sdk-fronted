/**
 * K02-AC-07：正文中的疑似令牌/密钥必须拦截，指出字段路径，且不回显原文。
 *
 * 同时覆盖反向用例（连字符 UUID、`sha256-<hex>` 摘要、业务订单号形态不得误报），
 * 以及获批的 `--allow-token-path <JSON 指针>` 逃生舱（默认空、每次放行留痕）。
 *
 * 注意：32 位及以上纯十六进制串**必须拦截**（含 UUID 紧凑写法）——
 * K02-AC-07 字面要求「32 位以上随机十六进制串」命中即报；确属良性时走白名单。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir, runFail, runOk, writeJsonFile } from './test-support.js';
import { makeBody } from './workflow.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnopqrstuvwxyz0123456789';
const HEX_32 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEX_40 = '9f2c7b41a8e35d06c1b4f7a90e2d8c35b6a1f04e';
const HEX_UPPER_64 =
  'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678ABCDEF90A1B2C3D4E5F60718';
const BASE64_SECRET = 'QWxphA9zc2VjcmV0VG9rZW5WYWx1ZTEyMzQ1Njc4OTA';
const BEARER = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
const PEM_LINE = ['-----BEGIN ', 'PRIVATE', ' KEY-----'].join('');
const CODE_BLOCK = 'const token = "x"';
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SHA256_ETAG = `sha256-${'a'.repeat(64)}`;
const ORDER_NO = 'ORD123456789012';

/** 在正文的指定路径放一个字符串值，并返回写入的正文。 */
function bodyWith(path: readonly (string | number)[], value: string): Record<string, unknown> {
  const body = makeBody();
  let cursor: Record<string, unknown> | unknown[] = body;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const next = path[index + 1];
    if (segment === undefined) break;
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor)) break;
      const existing = cursor[segment];
      const container: Record<string, unknown> | unknown[] =
        typeof next === 'number' ? [] : {};
      cursor[segment] = existing ?? container;
      cursor = (existing ?? container) as Record<string, unknown> | unknown[];
      continue;
    }
    if (Array.isArray(cursor)) break;
    const existing = cursor[segment];
    const container: Record<string, unknown> | unknown[] =
      typeof next === 'number' ? [] : {};
    cursor[segment] = existing ?? container;
    cursor = (existing ?? container) as Record<string, unknown> | unknown[];
  }
  const last = path[path.length - 1];
  if (last === undefined) return body;
  if (typeof last === 'number' && Array.isArray(cursor)) cursor[last] = value;
  else if (!Array.isArray(cursor)) cursor[last] = value;
  ensurePluginEnabled(body);
  return body;
}

/** `plugins.<name>` 必须带 `enabled`，否则会先撞 Schema 错误，测不到令牌扫描。 */
function ensurePluginEnabled(body: Record<string, unknown>): void {
  const plugins = body['plugins'];
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return;
  for (const value of Object.values(plugins as Record<string, unknown>)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      if (entry['enabled'] === undefined) entry['enabled'] = true;
    }
  }
}

describe('K02-AC-07 疑似令牌扫描', () => {
  const positiveCases: readonly { readonly name: string; readonly path: readonly (string | number)[]; readonly value: string; readonly pointer: string; readonly pattern: string }[] = [
    {
      name: 'JWT',
      path: ['sampling', 'allow_users', 0],
      value: JWT,
      pointer: '/sampling/allow_users/0',
      pattern: 'jwt',
    },
    {
      name: 'PEM 头',
      path: ['plugins', 'error', 'options', 'note'],
      value: PEM_LINE,
      pointer: '/plugins/error/options/note',
      pattern: 'pem_header',
    },
    {
      name: '32 位纯十六进制（UUID 紧凑写法，必须拦截）',
      path: ['sampling', 'allow_users', 0],
      value: HEX_32,
      pointer: '/sampling/allow_users/0',
      pattern: 'hex_secret',
    },
    {
      name: '40 位小写十六进制',
      path: ['plugins', 'perf', 'options', 'token'],
      value: HEX_40,
      pointer: '/plugins/perf/options/token',
      pattern: 'hex_secret',
    },
    {
      name: '64 位大写十六进制（嵌套数组元素）',
      path: ['overrides', 0, 'patch', 'plugins', 'http', 'options', 'secret'],
      value: HEX_UPPER_64,
      pointer: '/overrides/0/patch/plugins/http/options/secret',
      pattern: 'hex_secret',
    },
    {
      name: '长 base64 随机串',
      path: ['privacy', 'extra_mask_rules', 0, 'pattern'],
      value: BASE64_SECRET,
      pointer: '/privacy/extra_mask_rules/0/pattern',
      pattern: 'base64_secret',
    },
    {
      name: 'Bearer 令牌',
      path: ['endpoints', 'ingest'],
      value: `https://ingest.example.com?x=${BEARER}`,
      pointer: '/endpoints/ingest',
      pattern: 'bearer_literal',
    },
    {
      name: '云厂商前缀密钥',
      path: ['sampling', 'allow_users', 0],
      value: 'AKIAIOSFODNN7EXAMPLE',
      pointer: '/sampling/allow_users/0',
      pattern: 'provider_prefix',
    },
  ];

  for (const testCase of positiveCases) {
    it(`${testCase.name} 非零退出码、指出字段路径、不回显原文`, async () => {
      const directory = await makeTempDir();
      try {
        const body = bodyWith(testCase.path, testCase.value);
        const bodyPath = await writeJsonFile(join(directory, 'body.json'), body);
        const result = await runFail(['validate', '--body', bodyPath]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(testCase.pointer);
        expect(result.stderr).toContain(testCase.pattern);
        expect(result.stderr).not.toContain(testCase.value);
        expect(result.stdout).not.toContain(testCase.value);
      } finally {
        await removeTempDir(directory);
      }
    });
  }

  const negativeCases: readonly { readonly name: string; readonly value: string }[] = [
    { name: '连字符 UUID v4', value: UUID },
    { name: 'SHA-256 ETag', value: SHA256_ETAG },
    { name: '业务订单号（正则样例）', value: 'ORD\\d{12}' },
    { name: '纯十进制数字串', value: '1234567890123456789012345678901234' },
    { name: '短句柄', value: ORDER_NO },
    { name: '代码片段', value: CODE_BLOCK },
  ];

  for (const testCase of negativeCases) {
    it(`已知良性形态不误报：${testCase.name}`, async () => {
      const directory = await makeTempDir();
      try {
        const body = bodyWith(['plugins', 'error', 'options', 'note'], testCase.value);
        const plugins = body['plugins'] as Record<string, Record<string, unknown>>;
        plugins['error'] = { enabled: true, options: { note: testCase.value } };
        const bodyPath = await writeJsonFile(join(directory, 'body.json'), body);
        const result = await runOk(['validate', '--body', bodyPath]);
        expect(result.stdout).toContain('K02 validate 通过');
      } finally {
        await removeTempDir(directory);
      }
    });
  }

  it('命中多个字段时全部列出', async () => {
    const directory = await makeTempDir();
    try {
      const body = makeBody({
        sampling: { allow_users: [JWT] },
        plugins: { error: { enabled: true, options: { token: HEX_40 } } },
      });
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), body);
      const result = await runFail(['validate', '--body', bodyPath]);
      expect(result.stderr).toContain('/sampling/allow_users/0');
      expect(result.stderr).toContain('/plugins/error/options/token');
      expect(result.stderr).not.toContain(JWT);
      expect(result.stderr).not.toContain(HEX_40);
    } finally {
      await removeTempDir(directory);
    }
  });

  it('32 位纯十六进制默认拦截；用 --allow-token-path 放行后 exit 0 且 stdout 留痕', async () => {
    const directory = await makeTempDir();
    try {
      const body = makeBody({ sampling: { allow_users: [HEX_32] } });
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), body);
      const blocked = await runFail(['validate', '--body', bodyPath]);
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain('/sampling/allow_users/0');
      expect(blocked.stderr).toContain('hex_secret');
      expect(blocked.stderr).not.toContain(HEX_32);
      expect(blocked.stdout).not.toContain(HEX_32);

      const allowed = await runOk([
        'validate',
        '--body',
        bodyPath,
        '--allow-token-path',
        '/sampling/allow_users/0',
      ]);
      expect(allowed.stdout).toContain('已放行 /sampling/allow_users/0');
      expect(allowed.stdout).not.toContain(HEX_32);
    } finally {
      await removeTempDir(directory);
    }
  });

  it('--allow-token-path 放行指定字段，并在 stdout 留痕', async () => {
    const directory = await makeTempDir();
    try {
      const body = makeBody({ sampling: { allow_users: [JWT] } });
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), body);
      const blocked = await runFail(['validate', '--body', bodyPath]);
      expect(blocked.code).toBe(1);
      const allowed = await runOk([
        'validate',
        '--body',
        bodyPath,
        '--allow-token-path',
        '/sampling/allow_users/0',
      ]);
      expect(allowed.stdout).toContain('已放行');
      expect(allowed.stdout).toContain('/sampling/allow_users/0');
      expect(allowed.stdout).not.toContain(JWT);
    } finally {
      await removeTempDir(directory);
    }
  });

  it('--allow-token-path 只对该路径生效，其他路径仍然拦截', async () => {
    const directory = await makeTempDir();
    try {
      const body = makeBody({
        sampling: { allow_users: [JWT] },
        plugins: { error: { enabled: true, options: { token: HEX_40 } } },
      });
      const bodyPath = await writeJsonFile(join(directory, 'body.json'), body);
      const result = await runFail([
        'validate',
        '--body',
        bodyPath,
        '--allow-token-path',
        '/sampling/allow_users/0',
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('/plugins/error/options/token');
      expect(result.stderr).toContain('hex_secret');
    } finally {
      await removeTempDir(directory);
    }
  });
});
