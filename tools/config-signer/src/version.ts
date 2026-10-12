/**
 * `config_version` 单调递增检查（K02-F2）。
 *
 * 「上一份发布物」由调用方用显式文件参数给出（负责人 2026-10-12 裁定：
 * 不发明目录/自动发现约定）。文件三种形态都接受：
 * K02 发布物（envelope，含 `payload` 字符串）、配置正文本身、
 * 以及契约样例的 `{ "decoded_payload": {...} }` 包装（`remote-config.valid.json` 就是这种）。
 */

/** 从任意 JSON 里取出「上一份发布物」的 config_version。 */
export function pickPreviousVersion(input: unknown): number | null {
  if (!isRecord(input)) return null;
  const direct = integerField(input, 'config_version');
  if (direct !== null) return direct;
  // 契约样例 remote-config.valid.json 是 `{_note, envelope, decoded_payload}` 形态：
  // 使用者直接拿仓库自带样例做 --previous 时，从 decoded_payload 里取值。
  const decoded = input['decoded_payload'];
  if (isRecord(decoded)) {
    const nested = integerField(decoded, 'config_version');
    if (nested !== null) return nested;
  }
  const payload = input['payload'];
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (isRecord(parsed)) return integerField(parsed, 'config_version');
    } catch {
      return null;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** 递增检查的结果。 */
export type VersionCheck =
  | { readonly status: 'ok'; readonly previous: number; readonly next: number }
  | { readonly status: 'not_increasing'; readonly previous: number; readonly next: number }
  | { readonly status: 'skipped' };

/**
 * 检查新正文的 config_version 是否严格大于上一份。
 *
 * 相等同样拒绝：SDK 侧会把「不大于当前生效版本」判为 `config_version_stale`
 * （`remote-config.md` 第 3 节），签名工具不应产出这种发布物。
 */
export function checkVersionIncreasing(next: number, previous: number | null): VersionCheck {
  if (previous === null) return { status: 'skipped' };
  if (next > previous) return { status: 'ok', previous, next };
  return { status: 'not_increasing', previous, next };
}
