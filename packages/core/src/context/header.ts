/**
 * 批次公共头 provider（C04-F1）。
 *
 * 输出**结构兼容** T16 的 `BatchHeader`（`packages/transport/src/batch/types.ts`），
 * 由装配根在 T18 把它当作 `BatchHeaderSource` 接线。core 不 import transport。
 *
 * 取值口径：
 * - `device_id_persistent`：**只有确定已授权才 `true`**（编排方裁定）；未授权一律 `false`；
 * - `consent`：批头枚举只有 `granted|denied|unknown`（`buffer` 映射为 `unknown`）；
 * - `clock_offset` / `clock_calibrated`：来自 C04 的时钟校准状态（未校准时 `0` + `false`）；
 * - `user_id` / `user_id_hashed`：只在有用户时出现；`user_id` 绝不进事件体。
 *
 * `device_id`/`session_id` 由会话追踪器提供；`clock_offset`/`clock_calibrated` 由时钟校准器提供；
 * 用户字段只在此处出现（绝不进事件体）。
 */
import { createUuid } from '../api/values';
import type { BatchHeaderProviderOptions, C04BatchHeader } from './ports';

/** 批次头的默认 `env`（批次 Schema：小写字母开头、≤32 字符）。 */
const DEFAULT_ENV = 'production';

/** 批次头的默认 `release`（批次 Schema：非空、≤64 字符）。 */
const DEFAULT_RELEASE = '0.0.0';

/** 创建批次头 provider。 */
export function createBatchHeaderProvider(
  options: BatchHeaderProviderOptions,
): () => C04BatchHeader {
  return (): C04BatchHeader => {
    const session = options.session();
    const clock = options.clock();
    const user = options.user();
    const sessionId = session.sessionId.length > 0 ? session.sessionId : createUuid();
    const deviceId = session.deviceId.length > 0 ? session.deviceId : createUuid();
    const header: C04BatchHeader = {
      protocol_version: 1,
      app_id: options.appId,
      env: options.env ?? DEFAULT_ENV,
      release: options.release ?? DEFAULT_RELEASE,
      sdk_name: options.sdkName,
      sdk_version: options.sdkVersion,
      device_id: deviceId,
      device_id_persistent: session.deviceIdPersistent,
      session_id: sessionId,
      clock_offset: clock.offsetMs,
      clock_calibrated: clock.calibrated,
      consent: options.consent(),
    };
    if (user === undefined) return header;
    return user.hashed === true
      ? { ...header, user_id: user.id, user_id_hashed: true }
      : { ...header, user_id: user.id };
  };
}
