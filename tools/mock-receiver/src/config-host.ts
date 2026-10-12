/**
 * 远程配置托管（M01-F5、remote-config.md I-02）。
 *
 * 按 `{app_id}/{env}` 存放 K02 生成的签名发布物（envelope），支持 `ETag` / `If-None-Match` / 304。
 * 发布物替换后 ETag 变化；ETag 由发布物内容的 SHA-256 计算，不使用时间戳。
 */
import { createHash } from 'node:crypto';

/** 发布物（remote-config.md 第 4 节）。 */
export interface ConfigEnvelope {
  format_version: number;
  key_id: string;
  alg: string;
  payload: string;
  signature: string;
  [key: string]: unknown;
}

export interface ConfigEntry {
  app_id: string;
  env: string;
  envelope: ConfigEnvelope;
}

export interface ConfigStore {
  /** 首次注册返回 false（已存在则不覆盖）。 */
  register: (appId: string, env: string, envelope: ConfigEnvelope) => boolean;
  /** 发布/替换，返回新的 ETag。 */
  publish: (appId: string, env: string, envelope: ConfigEnvelope) => string;
  get: (appId: string, env: string) => ConfigEntry | null;
  etagFor: (appId: string, env: string) => string | null;
  list: () => ConfigEntry[];
  clear: () => void;
}

/** 是否为合法发布物：只校验 I-02 必需字段。 */
export function isConfigEnvelope(value: unknown): value is ConfigEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record['format_version']) &&
    typeof record['key_id'] === 'string' &&
    record['key_id'].length > 0 &&
    typeof record['alg'] === 'string' &&
    typeof record['payload'] === 'string' &&
    typeof record['signature'] === 'string'
  );
}

/** ETag 取值：发布物序列化的 SHA-256，弱校验不需要。 */
export function computeEtag(envelope: ConfigEnvelope): string {
  const digest = createHash('sha256').update(JSON.stringify(envelope), 'utf8').digest('hex');
  return `"sha256-${digest}"`;
}

/** `if-none-match` 与当前 ETag 是否等价（忽略引号与空白，支持 `*`）。 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const normalize = (value: string): string => value.trim().replace(/^W\//, '').replace(/"/g, '');
  const target = normalize(etag);
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    if (value === '*') return true;
    return normalize(value) === target;
  });
}

/** 创建配置存储。 */
export function createConfigStore(): ConfigStore {
  const entries = new Map<string, ConfigEntry>();

  const keyOf = (appId: string, env: string): string => `${appId}\u0000${env}`;

  return {
    register: (appId: string, env: string, envelope: ConfigEnvelope): boolean => {
      const key = keyOf(appId, env);
      if (entries.has(key)) return false;
      entries.set(key, { app_id: appId, env, envelope: structuredClone(envelope) });
      return true;
    },
    publish: (appId: string, env: string, envelope: ConfigEnvelope): string => {
      entries.set(keyOf(appId, env), { app_id: appId, env, envelope: structuredClone(envelope) });
      return computeEtag(envelope);
    },
    get: (appId: string, env: string): ConfigEntry | null => {
      const entry = entries.get(keyOf(appId, env));
      return entry === undefined ? null : structuredClone(entry);
    },
    etagFor: (appId: string, env: string): string | null => {
      const entry = entries.get(keyOf(appId, env));
      return entry === undefined ? null : computeEtag(entry.envelope);
    },
    list: () => [...entries.values()].map((entry) => structuredClone(entry)),
    clear: () => {
      entries.clear();
    },
  };
}
