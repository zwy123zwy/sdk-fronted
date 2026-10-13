/**
 * 会话级采样（T13，C03-F3）。
 *
 * 契约 `remote-config.md` 5.2：`random < session_rate` 命中；会话随机数在会话开始生成并持久化
 * （同意前只存内存）；`allow_users` 命中者始终全量采集。
 *
 * 白名单匹配（对接负责人 2026-10-13 裁定）：原始 `user_id` 走**同步**精确比较；
 * 哈希值需要异步 `crypto.subtle.digest`，由 `updateUserHash()` 预计算后供同步比较，
 * 因此同步采样判定的中位数护栏只覆盖同步路径（异步 digest 的耗时单独记录，不计入护栏）。
 */
import type { SessionSampling, SessionSamplingOptions, SessionStorePort } from './types';

/** 会话随机数存储键前缀。 */
export const SESSION_KEY_PREFIX = 'wr_session:';
const DEFAULT_STORE_KEY = `${SESSION_KEY_PREFIX}session`;

/** 生成 `[0,1)` 随机数：优先 WebCrypto，回退 `Math.random`（调用时解析，无副作用）。 */
export function randomUnit(): number {
  const scope = globalThis as {
    crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array } | undefined;
  };
  const cryptoScope = scope.crypto;
  if (typeof cryptoScope?.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    cryptoScope.getRandomValues(buffer);
    return (buffer[0] ?? 0) / 4_294_967_296;
  }
  return Math.random();
}

/** 默认持久化：`sessionStorage`（不可用时退回本实例内存，页面刷新后重掷，已文档化）。 */
function resolveDefaultStorage(): SessionStorePort {
  const scope = globalThis as { sessionStorage?: Storage | undefined };
  const storage = scope.sessionStorage;
  if (storage !== undefined) {
    return {
      read: (key) => storage.getItem(key) ?? undefined,
      write: (key, value) => {
        try {
          storage.setItem(key, value);
        } catch {
          // 隐私模式等写入失败：静默降级为内存语义
        }
      },
    };
  }
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
  };
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function readStored(storage: SessionStorePort, key: string): number | undefined {
  const raw = storage.read(key);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 1 ? parsed : undefined;
}

/** 创建会话级采样状态。 */
export function createSessionSampling(options: SessionSamplingOptions): SessionSampling {
  const config = options.config;
  const storage = options.storage ?? resolveDefaultStorage();
  const key = options.storeKey ?? DEFAULT_STORE_KEY;
  const random = options.random ?? randomUnit;
  const persist = options.consentGranted?.() ?? true;

  let value: number;
  const stored = persist ? readStored(storage, key) : undefined;
  if (stored !== undefined) {
    value = stored;
  } else {
    value = random();
    if (persist) storage.write(key, String(value));
  }

  let hashedId: string | undefined;

  function allowUser(): boolean {
    const user = options.getUser?.();
    if (user === undefined) return false;
    const allow = config.current().sampling.allow_users;
    if (allow.includes(user.id)) return true;
    if (hashedId !== undefined && allow.includes(hashedId)) return true;
    return false;
  }

  return {
    isHit: () => allowUser() || value < config.current().sampling.session_rate,
    sessionRandom: () => value,
    allowUser,
    async updateUserHash(): Promise<void> {
      const user = options.getUser?.();
      if (user === undefined || user.hashed === true) return;
      const scope = globalThis as { crypto?: { subtle?: SubtleCrypto | undefined } | undefined };
      const subtle = scope.crypto?.subtle;
      if (subtle === undefined) return;
      try {
        const digest = await subtle.digest('SHA-256', new TextEncoder().encode(user.id));
        // 同时接受 hex 与 base64url 两种哈希写法
        const hex = toHex(digest);
        const base64 = toBase64Url(digest);
        const allow = config.current().sampling.allow_users;
        hashedId = allow.includes(base64) ? base64 : hex;
      } catch {
        // 摘要失败时保持未设置，同步路径不受影响
      }
    },
  };
}
