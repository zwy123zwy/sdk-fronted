/**
 * C04 上下文模块的常量（T14）。
 *
 * 数值来源与理由：
 * - `SESSION_IDLE_MS`、`CONSENT_BUFFER_MAX_EVENTS`、`CONSENT_BUFFER_MAX_BYTES`、
 *   `CLOCK_OFFSET_LIMIT_MS`、`MAX_CLOCK_ROUND_TRIP_MS` 的权威定义在 `privacy/constants.ts`
 *   （与字段约束同处一份上限表），这里**再导出**，避免两处字面量漂移。
 * - `DEVICE_ID_KEY` / `SESSION_ID_KEY`：本地存储键名，**带 SDK 前缀**，不与接入方的键冲突
 *   （指南第 11 节：不读取业务的 localStorage 键）。
 *   `DEVICE_ID_KEY` 只在**确定已授权**时才写入（Q5 与 AC-10）；`SESSION_ID_KEY` 是页面级临时值。
 */

export {
  CLOCK_OFFSET_LIMIT_MS,
  CONSENT_BUFFER_MAX_BYTES,
  CONSENT_BUFFER_MAX_EVENTS,
  MAX_CLOCK_ROUND_TRIP_MS,
  SESSION_IDLE_MS,
} from '../privacy/constants';

/** 持久化设备标识的存储键（仅在已授权/`full` 时写入）。 */
export const DEVICE_ID_KEY = 'wr_device_id';

/** 页面级会话标识的存储键（未取得同意时也使用，随页面刷新重建）。 */
export const SESSION_ID_KEY = 'wr_session_id';

/** 上下文模块的处理器/能力名。 */
export const CONTEXT_CAPABILITY = 'sdk.context_store';

/** `configureView` 的内核能力名（供 T18 的路由插件通知导航）。 */
export const VIEW_CAPABILITY = 'sdk.view';
