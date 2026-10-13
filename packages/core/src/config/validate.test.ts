/**
 * C03-F2 结构校验器分支 —— 用例（M4，覆盖率补强）。
 * 与 `contract.test.ts`（真实 Schema 交叉验证）互补：这里逐分支打点。
 */
import { describe, expect, it } from 'vitest';

import { CONFIG_REASON_CODES } from './constants';
import { validateEnvelopeShape, validateRemoteBody } from './validate';

const NOW = 1_793_000_000_000;

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 1,
    app_id: 'demo-app',
    env: 'production',
    config_version: 10,
    published_at: NOW,
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 1,
    key_id: 'key-a',
    alg: 'ES256',
    payload: '{"a":1}',
    signature: 'A'.repeat(86),
    ...overrides,
  };
}

describe('validateEnvelopeShape 分支', () => {
  it('合法发布物通过', () => {
    expect(validateEnvelopeShape(envelope())).toEqual({ ok: true, reason: undefined });
  });

  it('非对象 → schema_invalid；缺字段/alg/签名格式 → signature_invalid；额外字段 → schema_invalid', () => {
    expect(validateEnvelopeShape([1, 2] as unknown as Record<string, unknown>).reason).toBe(
      CONFIG_REASON_CODES.schemaInvalid,
    );
    expect(validateEnvelopeShape(envelope({ signature: undefined })).reason).toBe(
      CONFIG_REASON_CODES.signatureInvalid,
    );
    expect(validateEnvelopeShape(envelope({ alg: 'ES384' })).reason).toBe(CONFIG_REASON_CODES.signatureInvalid);
    expect(validateEnvelopeShape(envelope({ key_id: 'bad key!' })).reason).toBe(
      CONFIG_REASON_CODES.signatureInvalid,
    );
    expect(validateEnvelopeShape(envelope({ payload: 'x' })).reason).toBe(CONFIG_REASON_CODES.signatureInvalid);
    expect(validateEnvelopeShape(envelope({ signature: 'short' })).reason).toBe(
      CONFIG_REASON_CODES.signatureInvalid,
    );
    expect(validateEnvelopeShape(envelope({ extra: 1 })).reason).toBe(CONFIG_REASON_CODES.schemaInvalid);
  });

  it('format_version 不认识 → format_unsupported', () => {
    expect(validateEnvelopeShape(envelope({ format_version: 2 })).reason).toBe(
      CONFIG_REASON_CODES.formatUnsupported,
    );
  });
});

describe('validateRemoteBody 分支', () => {
  it('合法正文（含全部可选字段组）通过', () => {
    const full = body({
      kill_switch: { all: false, sdk_versions: ['>=1.0.0'], plugins: ['http'] },
      sampling: { session_rate: 0.5, allow_users: ['u'], rules: [{ match: { event_type: 'perf' }, rate: 0 }] },
      plugins: { http: { enabled: true, options: { a: 1 } } },
      privacy: {
        consent_mode: 'buffer',
        url_query_allowlist: ['a'],
        sensitive_headers: ['x-a'],
        extra_mask_rules: [{ name: 'n', pattern: 'p', flags: 'i', replacement: 'r' }],
      },
      endpoints: { ingest: 'https://i.example.com/path' },
      transport: { max_batch_events: 10, max_batch_bytes: 1024, idle_flush_ms: 200, max_wait_ms: 1000, replay_batches_per_second: 2 },
      overrides: [{ when: { sdk_versions: ['^1.0.0'], session_bucket: [0, 10] }, patch: { transport: { max_batch_events: 5 } } }],
    });
    expect(validateRemoteBody(full).ok).toBe(true);
  });

  it('数值为字符串时按类型拒绝（不静默接受）', () => {
    expect(validateRemoteBody({ format_version: '1' }).ok).toBe(false);
    expect(validateRemoteBody(body({ config_version: '10' })).ok).toBe(false);
    expect(validateRemoteBody(body({ published_at: '1793000000000' })).ok).toBe(false);
  });

  it('format_version 不认识 → format_unsupported', () => {
    expect(validateRemoteBody(body({ format_version: 2 })).reason).toBe(CONFIG_REASON_CODES.formatUnsupported);
  });

  it('非对象正文 → schema_invalid', () => {
    expect(validateRemoteBody([1] as unknown as Record<string, unknown>).reason).toBe(
      CONFIG_REASON_CODES.schemaInvalid,
    );
  });
});

const invalidBodies: readonly (readonly [string, Record<string, unknown>])[] = [
  ['app_id 非法', body({ app_id: 'A' })],
  ['env 非法', body({ env: '1bad' })],
  ['config_version 为 0', body({ config_version: 0 })],
  ['published_at 过小', body({ published_at: 1 })],
  ['kill_switch 非对象', body({ kill_switch: 1 })],
  ['kill_switch.all 非布尔', body({ kill_switch: { all: 'yes' } })],
  ['kill_switch.sdk_versions 超长', body({ kill_switch: { sdk_versions: Array.from({ length: 21 }, () => '1.0.0') } })],
  ['kill_switch.sdk_versions 语法不支持', body({ kill_switch: { sdk_versions: ['1.2.3 - 2.0.0'] } })],
  ['kill_switch.plugins 非数组', body({ kill_switch: { plugins: 'http' } })],
  ['kill_switch.plugins 未知名', body({ kill_switch: { plugins: ['replay'] } })],
  ['kill_switch.plugins 重复', body({ kill_switch: { plugins: ['http', 'http'] } })],
  ['sampling.session_rate 超界', body({ sampling: { session_rate: 2 } })],
  ['sampling.allow_users 超量', body({ sampling: { allow_users: Array.from({ length: 201 }, () => 'u') } })],
  ['sampling.rules 非数组', body({ sampling: { rules: {} } })],
  ['sampling.rules 超量', body({ sampling: { rules: Array.from({ length: 101 }, () => ({ match: { event_type: 'perf' }, rate: 1 })) } })],
  ['rule.match 为空对象', body({ sampling: { rules: [{ match: {}, rate: 1 }] } })],
  ['rule.match 额外键', body({ sampling: { rules: [{ match: { foo: 1 }, rate: 1 }] } })],
  ['rule.event_type 非法', body({ sampling: { rules: [{ match: { event_type: 'audio' }, rate: 1 }] } })],
  ['rule.dimension 缺 equals', body({ sampling: { rules: [{ match: { dimension: { key: 'k' } }, rate: 1 }] } })],
  ['rule.rate 非法', body({ sampling: { rules: [{ match: { event_type: 'perf' }, rate: 5 }] } })],
  ['plugins 设置非对象', body({ plugins: { perf: 1 } })],
  ['plugins 缺 enabled', body({ plugins: { perf: {} } })],
  ['plugins.enabled 非布尔', body({ plugins: { perf: { enabled: 1 } } })],
  ['plugins.options 非对象', body({ plugins: { perf: { enabled: true, options: 1 } } })],
  ['privacy 非对象', body({ privacy: 1 })],
  ['privacy.url_query_allowlist 非法键', body({ privacy: { url_query_allowlist: ['bad key'] } })],
  ['privacy.sensitive_headers 非法', body({ privacy: { sensitive_headers: ['Bad_Header'] } })],
  ['privacy.extra_mask_rules 超量', body({ privacy: { extra_mask_rules: Array.from({ length: 41 }, () => ({ name: 'n', pattern: 'p' })) } })],
  ['mask rule 额外键', body({ privacy: { extra_mask_rules: [{ name: 'n', pattern: 'p', extra: 1 }] } })],
  ['mask rule 名称非法', body({ privacy: { extra_mask_rules: [{ name: 'N', pattern: 'p' }] } })],
  ['mask rule pattern 为空', body({ privacy: { extra_mask_rules: [{ name: 'n', pattern: '' }] } })],
  ['mask rule flags 非法', body({ privacy: { extra_mask_rules: [{ name: 'n', pattern: 'p', flags: 'z' }] } })],
  ['mask rule replacement 过长', body({ privacy: { extra_mask_rules: [{ name: 'n', pattern: 'p', replacement: 'x'.repeat(33) }] } })],
  ['endpoints 非对象', body({ endpoints: 1 })],
  ['endpoints.ingest 非 https', body({ endpoints: { ingest: 'http://x' } })],
  ['transport 非对象', body({ transport: 1 })],
  ['transport 额外键', body({ transport: { unknown: 1 } })],
  ['transport.max_batch_events 超界', body({ transport: { max_batch_events: 0 } })],
  ['transport.max_batch_bytes 超界', body({ transport: { max_batch_bytes: 1023 } })],
  ['transport.idle_flush_ms 超界', body({ transport: { idle_flush_ms: 199 } })],
  ['transport.max_wait_ms 超界', body({ transport: { max_wait_ms: 999 } })],
  ['transport.replay_batches_per_second 为 0', body({ transport: { replay_batches_per_second: 0 } })],
  ['overrides 非数组', body({ overrides: {} })],
  ['overrides 超量', body({ overrides: Array.from({ length: 21 }, () => ({ when: { session_bucket: [0, 1] }, patch: {} })) })],
  ['override 非对象', body({ overrides: [1] })],
  ['override 缺 patch', body({ overrides: [{ when: { session_bucket: [0, 1] } }] })],
  ['override.when 为空', body({ overrides: [{ when: {}, patch: {} }] })],
  ['override.when.session_bucket 长度错', body({ overrides: [{ when: { session_bucket: [0] }, patch: {} }] })],
  ['override.when.session_bucket 超界', body({ overrides: [{ when: { session_bucket: [0, 101] }, patch: {} }] })],
  ['override.when.sdk_versions 语法不支持', body({ overrides: [{ when: { sdk_versions: ['>=1.2.3-beta.1'] }, patch: {} }] })],
  ['override.patch 额外键', body({ overrides: [{ when: { session_bucket: [0, 1] }, patch: { kill_switch: { all: true } } }] })],
  ['override.patch.sampling 非法', body({ overrides: [{ when: { session_bucket: [0, 1] }, patch: { sampling: { session_rate: 2 } } }] })],
];

describe('validateRemoteBody 负向分支表', () => {
  for (const [label, value] of invalidBodies) {
    it(`拒绝：${label}`, () => {
      const result = validateRemoteBody(value);
      expect(result.ok, label).toBe(false);
      expect(result.reason, label).toBe(CONFIG_REASON_CODES.schemaInvalid);
    });
  }
});
