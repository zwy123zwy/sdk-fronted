/**
 * 会话与设备标识（C04-F1）。
 *
 * 口径（`event-standard.md` 第 1 节 + Q5 + 编排方 2026-10-13 的裁定）：
 * - `session_id`：随机 UUID v4，**30 分钟无活动后重新生成**（`SESSION_IDLE_MS`）；
 * - `device_id`：随机 UUID v4。**未取得同意时是页面级临时值**，批头 `device_id_persistent: false`；
 *   持久化存储里读到的值必须**本身满足 `$defs/uuid`** 才采用，否则丢弃并（覆盖）写回新生成的
 *   合法 uuid（见 `ensureDevice`）；
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
import { isSchemaUuid } from './schema-uuid';
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

  /**
   * 只在尚未生成时补一次会话标识（**内存**物化；不推进活动时间、不因空闲轮换）。
   *
   * 与 `ensureSession` 的区别：本函数**不写** `sessionStorage`——`current()` 是读路径，
   * 不应产生存储写入（读批头不算活动，也不该在同意前落任何键）；`touch()` 才是「有活动」
   * 的路径，由它落盘 `SESSION_ID_KEY` 并推进空闲轮换。
   */
  function ensureSessionId(): string {
    if (sessionId === undefined) sessionId = options.createId();
    return sessionId;
  }

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
      // 存储里的值必须**本身**满足 `$defs/uuid` 才采用。`device_id` 是批次头的 required +
      // `$ref #/$defs/uuid` 字段，且同属协议字段排除清单（UUID 结构上不可能含 PII → 不脱敏）：
      // localStorage 被第三方脚本写坏、或旧版本残留非 uuid 值时，非 uuid 的存储值不会被任何
      // 兜底改写，用它组装的**每一批**都会被接收方拒绝（影响面比 `view_id` 大：`view_id` 只毁
      // 一条事件）。非 uuid 的存储值因此按「未存储」处理（丢弃 + 走生成路径，与 `noteLocation`
      // 丢弃非法显式 `view_id`、与 `''` 的先例一致）；**不**截断/改写成"像 uuid"的标识符。
      if (stored !== undefined && isSchemaUuid(stored)) {
        deviceId = stored;
        return deviceId;
      }
    }
    deviceId = options.createId();
    if (persistent && options.persistentStorage !== undefined) {
      // **覆盖写回**非法/缺失的存储值：不写回的话，被污染的存储值会一直留在那里，每次启动
      // 都重新生成一个新标识 ——「同一设备」语义随刷新漂移。代价是非法值场景多一次存储写入
      // （正常路径本来就写，不增加次数）。
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
      //
      // 但必须**惰性物化**标识（2026-10-15 定向诊断的实现修复）：批头 provider 的唯一接线就是
      // `current()`（`touch()` 在生产路径无调用点），若这里只回放 `undefined`/空串：
      // ① 已授权实例从不落盘，批头声称 `device_id_persistent: true` 而存储里没有 `DEVICE_ID_KEY`；
      // ② `header.ts` 现场 `createUuid()` 兜底 ⇒ 连续取批头得到**不同**的 `device_id`/`session_id`
      //   （逐批漂移，且 `session_id` 与交付层用的会话标识不是同一个）。
      // 惰性物化不改「只读」语义：不推进活动时间、不轮换 `session_id`、不写 `sessionStorage`；
      // 只是把标识补出来（设备标识在授权时由 `ensureDevice` 顺带落盘）。
      return {
        sessionId: ensureSessionId(),
        deviceId: ensureDevice(),
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
