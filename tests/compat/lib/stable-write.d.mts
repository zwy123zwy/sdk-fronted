/**
 * `stable-write.mjs` 的类型声明（供 `tests/**\/*.ts` 静态导入该幂等落盘器）。
 */

/** 未写盘的原因：逐字节相同 / 只差易变字段；写盘时为 `content-changed`。 */
export type StableWriteReason = 'identical' | 'only-volatile-fields-changed' | 'content-changed';

export interface StableWriteOutcome {
  readonly file: string;
  readonly written: boolean;
  readonly reason: StableWriteReason;
}

export function writeJsonStable(
  file: string,
  payload: unknown,
  volatilePaths?: readonly string[],
): StableWriteOutcome;
