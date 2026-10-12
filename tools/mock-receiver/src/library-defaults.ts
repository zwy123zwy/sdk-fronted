/**
 * 内置默认配置发布物（M01-F5）。
 *
 * 优先从契约样例 `docs/contracts/examples/remote-config.valid.json` 读取 envelope；
 * 找不到时退回这里的内置占位发布物（字段形态与 I-02 一致，签名是占位值，不含任何真实密钥）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfigEnvelope, type ConfigEnvelope } from './config-host.js';

/** 默认托管的应用与环境。 */
export const DEFAULT_CONFIG_APP_ID = 'demo-app';
export const DEFAULT_CONFIG_ENV = 'staging';

/** 内置占位发布物：正文是 dev/staging 占位配置，签名为全零占位值。 */
export const PLACEHOLDER_ENVELOPE: ConfigEnvelope = {
  format_version: 1,
  key_id: 'test-key-2026a',
  alg: 'ES256',
  payload: JSON.stringify({
    format_version: 1,
    app_id: DEFAULT_CONFIG_APP_ID,
    env: DEFAULT_CONFIG_ENV,
    config_version: 42,
    published_at: 1793000000000,
    sampling: { session_rate: 1 },
    plugins: { error: { enabled: true } },
  }),
  signature: 'A'.repeat(86),
};

/** 解析契约样例的绝对路径（源码、dist 与 cwd 三种位置都试）。 */
function contractExampleCandidates(): string[] {
  const configured = process.env['M01_CONTRACT_EXAMPLE'];
  if (configured !== undefined && configured.length > 0) return [configured];
  const relative = [
    '../../../docs/contracts/examples/remote-config.valid.json',
    '../../../../docs/contracts/examples/remote-config.valid.json',
    'docs/contracts/examples/remote-config.valid.json',
  ];
  const candidates: string[] = [];
  for (const candidate of relative) {
    try {
      candidates.push(fileURLToPath(new URL(candidate, import.meta.url)));
    } catch {
      // import.meta.url 不是 file: URL 时跳过
    }
  }
  for (const candidate of relative) candidates.push(resolve(process.cwd(), candidate));
  return candidates;
}

/** 读取 `--config-file` 指定的发布物文件；失败时抛出可读错误。 */
export function loadEnvelopeFromFile(path: string): ConfigEnvelope {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`无法读取配置发布物 ${path}：${(error as Error).message}`, { cause: error });
  }
  return parseEnvelope(raw, path);
}

/** 从契约样例加载默认发布物；找不到或不可用时用内置占位发布物。 */
export function loadDefaultEnvelope(): ConfigEnvelope {
  for (const candidate of contractExampleCandidates()) {
    try {
      const doc = JSON.parse(readFileSync(candidate, 'utf8')) as unknown;
      const envelope = pickEnvelope(doc);
      if (envelope !== null) return envelope;
    } catch {
      // 样例不存在或不可读时继续尝试下一个候选
    }
  }
  return structuredClone(PLACEHOLDER_ENVELOPE);
}

function pickEnvelope(doc: unknown): ConfigEnvelope | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return null;
  const record = doc as Record<string, unknown>;
  if (isConfigEnvelope(record['envelope'])) return structuredClone(record['envelope']);
  if (isConfigEnvelope(doc)) return structuredClone(doc);
  return null;
}

function parseEnvelope(raw: string, source: string): ConfigEnvelope {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置发布物不是合法 JSON（${source}）：${(error as Error).message}`, { cause: error });
  }
  const envelope = pickEnvelope(doc);
  if (envelope === null) throw new Error(`配置发布物缺少 I-02 必需字段（${source}）`);
  return envelope;
}
