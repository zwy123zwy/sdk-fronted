/**
 * 会话与设备标识（C04-F1）。
 *
 * 口径（`event-standard.md` 第 1 节 + Q5 + 编排方 2026-10-13 的裁定）：
 * - `session_id`：随机 UUID v4，**30 分钟无活动后重新生成**（`SESSION_IDLE_MS`）；
 * - `device_id`：随机 UUID v4。**未取得同意时是页面级临时值**，批头 `device_id_persistent: false`；
 * - **只有确定已授权**（`granted`，或初始化参数声明已授权的 `full`）才持久化设备标识；
 * - `denied` 时清除持久化与内存中的标识，之后重新生成的都是临时值；
 * - 空闲判定**不持久化** `last_activity_at`（避免同意前落盘）：刷新即重新计时。
 *
 * 存储分工：
 * - `persistentStorage`（**总是注入**，否则运行期「后来同意」就无法开始持久化）→
 *   设备标识跨页面稳定；**是否真的读写由授权判定控制**，未授权时既不读也不写；
 * - `sessionStorage`（页面级临时）→ 会话标识与未授权时的临时设备标识，刷新后重建。
 */
import { DEVICE_ID_KEY, SESSION_ID_KEY, SESSION_IDLE_MS } from './constants';
import type { ConsentMode, ConsentState } from '../privacy/types';
import type { SessionState, SessionTracker, SessionTrackerOptions } from './ports';

/** 判断某个同意状态/模式组合是否已获授权（决定设备标识是否持久化）。 */
function isAuthorized(state: ConsentState, mode: ConsentMode): boolean {
  if (state === 'denied') return false;
  if (state === 'granted') return true;
  // `unknown`：只有初始化参数声明已取得授权的 `full` 才允许持久化（D002）。
  return mode === 'full';
}

/** 创建会话追踪器。 */
export function createSessionTracker(options: SessionTrackerOptions): SessionTracker {
  const idleMs = options.limits.sessionIdleMs > 0 ? options.limits.sessionIdleMs : SESSION_IDLE_MS;
  let sessionId: string | undefined;
  let deviceId: string | undefined;
  let lastActivityAt = options.now();
  // 初始同意状态（装配根在初始化前注入；缺省 `unknown`）。授权判定与初始持久化策略都用它。
  let consentState: ConsentState = options.state ?? 'unknown';
  // 只有确定已授权**且**装配根注入了持久化存储时，设备标识才允许落盘。
  let persistent =
    options.persistentStorage !== undefined && isAuthorized(consentState, options.mode ?? 'essential_only');

  function ensureSession(nowMs: number): string {
    if (sessionId === undefined) {
      sessionId = options.createId();
      options.sessionStorage?.write(SESSION_ID_KEY, sessionId);
    }
    if (nowMs - lastActivityAt > idleMs) {
      sessionId = options.createId();
      options.sessionStorage?.write(SESSION_ID_KEY, sessionId);
    }
    return sessionId;
  }

  function ensureDevice(): string {
    if (deviceId !== undefined) return deviceId;
    if (persistent && options.persistentStorage !== undefined) {
      const stored = options.persistentStorage.read(DEVICE_ID_KEY);
      if (stored !== undefined && stored.length > 0) {
        deviceId = stored;
        return deviceId;
      }
    }
    deviceId = options.createId();
    if (persistent && options.persistentStorage !== undefined) {
      options.persistentStorage.write(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  }

  /** 把当前设备标识落到持久化存储（授权后调用；已有标识也要补写）。 */
  function persistDevice(): void {
    if (!persistent || options.persistentStorage === undefined) return;
    const current = ensureDevice();
    options.persistentStorage.write(DEVICE_ID_KEY, current);
  }

  function dropDevice(): void {
    deviceId = undefined;
    persistent = false;
    options.persistentStorage?.remove(DEVICE_ID_KEY);
  }

  return {
    touch(nowMs: number): SessionState {
      const currentSession = ensureSession(nowMs);
      lastActivityAt = nowMs;
      const currentDevice = ensureDevice();
      return { sessionId: currentSession, deviceId: currentDevice, deviceIdPersistent: persistent };
    },

    current(): SessionState {
      // 只读：不刷新活动时间，也不因空闲而作废（轮换只由 touch 推进）。
      const currentSession = sessionId ?? '';
      return {
        sessionId: currentSession,
        deviceId: deviceId ?? '',
        deviceIdPersistent: persistent,
      };
    },

    onConsentChange(state: ConsentState, mode: ConsentMode): void {
      consentState = state;
      if (isAuthorized(consentState, mode)) {
        if (options.persistentStorage !== undefined) {
          persistent = true;
          // 立即把当前（或新建的）设备标识落到持久化存储：授权前只存在内存里的
          // 临时标识此时必须补写，否则「授权后仍不持久化」。
          persistDevice();
        }
        return;
      }
      if (consentState === 'denied') dropDevice();
      else persistent = false;
    },

    purge(): void {
      options.sessionStorage?.remove(SESSION_ID_KEY);
      sessionId = undefined;
      dropDevice();
    },
  };
}
