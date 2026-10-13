/**
 * kill switch 求值与生效（T13，C03-F5）。
 *
 * 契约 `remote-config.md` 5.1（CR-003）：
 * `all: true` 或 `sdk_versions` 命中 → SDK 进入已销毁状态、释放所有监听、同一页面生命周期内不恢复；
 * `plugins` 命中 → 卸载该插件并恢复其 hook；kill switch 生效后丢弃的事件计 `killed`。
 *
 * semver 只实现 5.1 节的语法子集（零依赖）。不支持语法由 `isSupportedSemverRange` 判定，
 * 由 `validate.ts` 在整份配置上计 `config_schema_invalid`，**不得静默当作不命中**。
 *
 * 生效使用内核公共 API（`pause('killed')`、`plugins.uninstall/dispose`、`prestartQueue.drain`），
 * **不修改 `packages/core/src/kernel/**`**。
 */
import type { Kernel } from '../kernel';
import type { EffectiveConfig } from './types';

/** kill switch 丢弃事件的原因码（`reason-codes.md` 第 1 节）。 */
const KILLED_REASON = 'killed';

/** 解析后的 semver。 */
interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

/** kill switch 求值结果。 */
export interface KillSwitchDecision {
  readonly all: boolean;
  readonly plugins: readonly string[];
}

const FULL_VERSION = /^(\^|~|>=|<=|>|<)?(\d+)\.(\d+)\.(\d+)$/u;
const WILDCARD_PATCH = /^(\d+)\.(\d+)\.x$/u;
const WILDCARD_MINOR = /^(\d+)\.x$/u;
const ANY_RANGE = /^\*$/u;
const VERSION_TEXT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_TEXT.exec(value);
  if (match === null) return undefined;
  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  const prereleaseText = match[4];
  if (majorText === undefined || minorText === undefined || patchText === undefined) return undefined;
  const prerelease =
    prereleaseText === undefined
      ? []
      : prereleaseText.split('.').map((identifier) => (/^\d+$/u.test(identifier) ? Number(identifier) : identifier));
  return { major: Number(majorText), minor: Number(minorText), patch: Number(patchText), prerelease };
}

function compareIdentifiers(left: string | number, right: string | number): number {
  if (typeof left === 'number' && typeof right === 'number') return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** semver §11 优先级比较（忽略 build）。 */
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const compared = compareIdentifiers(leftId, rightId);
    if (compared !== 0) return compared;
  }
  return 0;
}

function makeVersion(major: number, minor: number, patch: number): ParsedVersion {
  return { major, minor, patch, prerelease: [] };
}

/** 单个比较符是否受支持（严格按 5.1 表：`x` 通配，不支持 `1.2` / `1` 这类省略写法）。 */
function isSupportedComparator(comparator: string): boolean {
  if (ANY_RANGE.test(comparator)) return true;
  return FULL_VERSION.test(comparator) || WILDCARD_PATCH.test(comparator) || WILDCARD_MINOR.test(comparator);
}

/**
 * 范围字符串是否使用了 5.1 节支持的语法子集。
 * 连字符区间、范围中的预发布标识、未列出语法一律返回 `false`。
 */
export function isSupportedSemverRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed.length === 0) return false;
  for (const orPart of trimmed.split('||')) {
    const part = orPart.trim();
    if (part.length === 0) return false;
    if (part.includes('-')) return false;
    const comparators = part.split(/\s+/u);
    for (const comparator of comparators) {
      if (!isSupportedComparator(comparator)) return false;
    }
  }
  return true;
}

function matchesComparator(version: ParsedVersion, comparator: string): boolean {
  if (ANY_RANGE.test(comparator)) return true;

  const patchWildcard = WILDCARD_PATCH.exec(comparator);
  if (patchWildcard !== null) {
    const majorText = patchWildcard[1];
    const minorText = patchWildcard[2];
    if (majorText === undefined || minorText === undefined) return false;
    return version.major === Number(majorText) && version.minor === Number(minorText);
  }

  const minorWildcard = WILDCARD_MINOR.exec(comparator);
  if (minorWildcard !== null) {
    const majorText = minorWildcard[1];
    if (majorText === undefined) return false;
    return version.major === Number(majorText);
  }

  const full = FULL_VERSION.exec(comparator);
  if (full === null) return false;
  const opText = full[1];
  const majorText = full[2];
  const minorText = full[3];
  const patchText = full[4];
  if (majorText === undefined || minorText === undefined || patchText === undefined) return false;
  const target = makeVersion(Number(majorText), Number(minorText), Number(patchText));
  const compared = compareVersions(version, target);

  switch (opText ?? '') {
    case '':
      return compared === 0;
    case '>':
      return compared > 0;
    case '>=':
      return compared >= 0;
    case '<':
      return compared < 0;
    case '<=':
      return compared <= 0;
    case '^': {
      const upper =
        target.major > 0
          ? makeVersion(target.major + 1, 0, 0)
          : target.minor > 0
            ? makeVersion(0, target.minor + 1, 0)
            : makeVersion(0, 0, target.patch + 1);
      return compared >= 0 && compareVersions(version, upper) < 0;
    }
    case '~': {
      const upper = makeVersion(target.major, target.minor + 1, 0);
      return compared >= 0 && compareVersions(version, upper) < 0;
    }
    default:
      return false;
  }
}

/**
 * semver 范围匹配（5.1 子集）。
 * 调用方须先用 `isSupportedSemverRange` 判定支持性；对不支持语法返回 `false`。
 */
export function matchesSemverRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === undefined || !isSupportedSemverRange(range)) return false;
  return range
    .trim()
    .split('||')
    .some((orPart) => orPart.trim().split(/\s+/u).every((comparator) => matchesComparator(parsed, comparator)));
}

/** 求值 kill switch。 */
export function evaluateKillSwitch(config: EffectiveConfig, sdkVersion: string): KillSwitchDecision {
  const hitByVersion = config.kill_switch.sdk_versions.some((range) => matchesSemverRange(sdkVersion, range));
  return { all: config.kill_switch.all || hitByVersion, plugins: config.kill_switch.plugins };
}

/**
 * 生效 kill switch（使用内核公共 API，不改内核）。
 *
 * - 全局 kill：先 `pause('killed')`（后续 `report` 由内核按 pauseReason 计 `killed`），清空预启动队列
 *   并逐条计 `killed`，再卸载全部插件释放监听与 hook；**不调用 `kernel.destroy()`**（那会计 `destroyed`）。
 * - 插件级 kill：只卸载目标插件，内核按后进先出恢复其 hook/监听；不产生 `killed` 计数。
 * - 不追回传输层已入队/已落盘的事件（契约未要求，跨模块撤回有一致性风险）。
 */
export function applyKillSwitch(
  kernel: Kernel,
  decision: KillSwitchDecision,
  stopRuntime: () => void,
): void {
  if (!decision.all) {
    for (const pluginId of decision.plugins) {
      kernel.plugins.uninstall(pluginId);
    }
    return;
  }

  kernel.pause('killed');
  const queued = kernel.prestartQueue.drain();
  if (queued.length > 0) kernel.counters.count(KILLED_REASON, queued.length);
  kernel.plugins.dispose();
  stopRuntime();
}
