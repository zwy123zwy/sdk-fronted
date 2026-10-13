/**
 * C03 契约自证（T13）：用 **真实** `remote-config.schema.json`（Ajv 2020-12）校验 C03 会接受/产出的
 * 配置正文与发布物，并做**运行时手写校验器 ↔ Ajv 同语料交叉验证**（防止手搓校验器与冻结契约漂移）。
 *
 * M0 说明：运行时校验器是桩（恒通过），因此负向对照与交叉验证预期失败；这正是本文件的价值。
 * 例外（显式白名单）：`privacy.consent_mode` 为 `full`/非法时，Ajv 整份拒绝，而 SDK 按 D002
 * 只忽略该字段；交叉验证对这两类 case 断言「Ajv 拒绝 && 运行时接受」。
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import remoteConfigSchema from '../../../../docs/contracts/schemas/remote-config.schema.json';
import invalidExample from '../../../../docs/contracts/examples/remote-config.invalid.json';
import validExample from '../../../../docs/contracts/examples/remote-config.valid.json';
import { validateEnvelopeShape, validateRemoteBody } from './validate';

const schemaId = remoteConfigSchema.$id;

function createAjv(): {
  readonly body: (value: unknown) => boolean;
  readonly envelope: (value: unknown) => boolean;
} {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const body = ajv.compile(remoteConfigSchema);
  const envelope = ajv.compile({ $ref: `${schemaId}#/$defs/envelope` });
  return { body: (value) => body(value), envelope: (value) => envelope(value) };
}

function stripMeta(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('_')) body[key] = value;
  }
  return body;
}

function casesOf(document: unknown): readonly Record<string, unknown>[] {
  if (typeof document !== 'object' || document === null) return [];
  const cases = (document as { cases?: unknown }).cases;
  return Array.isArray(cases) ? (cases as readonly Record<string, unknown>[]) : [];
}

/**
 * D002 归一化：远程出现非法 `consent_mode`（含 `full`）时，SDK 只忽略该字段，
 * 因此把该字段摘除后再与 Ajv 比较（其余字段仍须与 Schema 一致）。
 */
function normalizeConsentMode(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const privacy = body['privacy'];
  if (typeof privacy !== 'object' || privacy === null || Array.isArray(privacy)) return { ...body };
  const record = privacy as Record<string, unknown>;
  const mode = record['consent_mode'];
  if (mode === undefined || mode === 'essential_only' || mode === 'buffer') return { ...body };
  const nextPrivacy: Record<string, unknown> = { ...record };
  delete nextPrivacy['consent_mode'];
  return { ...body, privacy: nextPrivacy };
}

describe('C03 契约自证：真实 remote-config Schema', () => {
  it('正向基线：合法样例正文与发布物都通过 Ajv，且运行时校验器接受', () => {
    const ajv = createAjv();
    expect(ajv.body(validExample.decoded_payload)).toBe(true);
    expect(ajv.envelope(validExample.envelope)).toBe(true);
    expect(validateRemoteBody(validExample.decoded_payload).ok).toBe(true);
    expect(validateEnvelopeShape(validExample.envelope).ok).toBe(true);
  });

  it('负向对照：real invalid 样例逐个被 Ajv 拒绝', () => {
    const ajv = createAjv();
    const cases = casesOf(invalidExample);
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const item of cases) {
      expect(ajv.body(stripMeta(item)), `应被拒绝：${String(item['_why'])}`).toBe(false);
    }
  });

  it('交叉验证：运行时校验器与 Ajv 在整份语料上判定一致（D002 例外显式化）', () => {
    const ajv = createAjv();
    const minimal: Record<string, unknown> = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 20,
      published_at: 1_793_000_000_000,
    };
    const corpus: readonly Record<string, unknown>[] = [
      validExample.decoded_payload,
      ...casesOf(invalidExample).map(stripMeta),
      minimal,
      { ...minimal, endpoints: { ingest: 'https://ok.example.com' } },
      { ...minimal, consent_mode_field_is_unknown: true },
      { ...minimal, sampling: { session_rate: -0.1 } },
      { ...minimal, sampling: { rules: [{ match: { event_name: 'x' } }] } },
      { ...minimal, transport: { max_batch_events: 0 } },
      { ...minimal, transport: { unknown_field: 1 } },
      { ...minimal, plugins: { replay: { enabled: true } } },
      { ...minimal, plugins: { perf: {} } },
      { ...minimal, overrides: [{ when: { session_bucket: [0, 10] }, patch: { unknown: {} } }] },
      { ...minimal, overrides: [{ when: {}, patch: {} }] },
      { ...minimal, privacy: { extra_mask_rules: [{ name: 'a', pattern: 'x', extra: 1 }] } },
      { ...minimal, kill_switch: { sdk_versions: ['>=1.0.0'] } },
    ];
    for (const body of corpus) {
      // D002：先摘除非法 consent_mode，再与 Ajv 比较（其余字段仍须与 Schema 一致）
      const ajvAccepts = ajv.body(normalizeConsentMode(body));
      const runtimeAccepts = validateRemoteBody(body).ok;
      expect(runtimeAccepts, `与归一化后的 Ajv 判定不一致：${JSON.stringify(body)}`).toBe(ajvAccepts);
    }
  });

  it('CR-003 补充约束：Ajv 接受但 C03 必须整份拒绝的 semver 语法', () => {
    const ajv = createAjv();
    const body: Record<string, unknown> = {
      format_version: 1,
      app_id: 'demo-app',
      env: 'production',
      config_version: 21,
      published_at: 1_793_000_000_000,
      kill_switch: { sdk_versions: ['1.2.3 - 2.0.0'] },
    };
    const overridesBody: Record<string, unknown> = {
      ...body,
      config_version: 22,
      kill_switch: { sdk_versions: [] },
      overrides: [{ when: { sdk_versions: ['>=1.2.3-beta.1'] }, patch: {} }],
    };
    // 5.1 的语法子集超出 Schema 能表达的范围：Ajv 只校验字符串长度，必须接受
    expect(ajv.body(body)).toBe(true);
    expect(ajv.body(overridesBody)).toBe(true);
    // C03 侧必须整份拒绝（不得静默当作不命中）
    expect(validateRemoteBody(body).ok).toBe(false);
    expect(validateRemoteBody(overridesBody).ok).toBe(false);
  });

  it('校验器非空转：明显非法的配置两边都拒绝', () => {
    const ajv = createAjv();
    const bad = { format_version: 1, app_id: 'demo-app', env: 'production' };
    expect(ajv.body(bad)).toBe(false);
    expect(validateRemoteBody(bad).ok).toBe(false);
  });

  it('发布物负向对照：alg 非法 / 缺 signature 被 Ajv 拒绝', () => {
    const ajv = createAjv();
    const envelope: Record<string, unknown> = { ...validExample.envelope };
    expect(ajv.envelope({ ...envelope, alg: 'ES384' })).toBe(false);
    const withoutSignature: Record<string, unknown> = { ...envelope };
    delete withoutSignature['signature'];
    expect(ajv.envelope(withoutSignature)).toBe(false);
    expect(validateEnvelopeShape({ ...envelope, alg: 'ES384' }).ok).toBe(false);
  });
});
