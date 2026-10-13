/**
 * SDK 版本号的唯一来源。
 *
 * 放在独立模块里是为了避免 `api/client.ts` 与 `src/index.ts` 之间的循环 import
 * （客户端需要把版本写进批次头 `sdk_version`）。
 */
export const SDK_VERSION = '0.0.0';
