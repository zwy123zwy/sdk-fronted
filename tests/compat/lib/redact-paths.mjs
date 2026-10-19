/**
 * 证据产物脱敏：把**绝对路径**改写成可以永久提交进仓库的稳定形式。
 *
 * ## 为什么要这一层
 *
 * `tests/e2e/results/*.json` 与 `tests/compat/results/*.json` 是**证据**，要跟着提交进仓库。
 * 但写它们的人直接把运行时路径原样落盘：`/Users/<本机用户名>/Library/Caches/ms-playwright/...`。
 * 每提交一次证据，就把本机用户名永久写进一次 git 历史——这不是功能缺陷，是隐私/卫生问题。
 *
 * ## 口径（改写入者，不改产物）
 *
 * 在**写入前**改写，而不是事后 sed 产物：这样重跑一次门禁就会自然产出干净证据，
 * 不会出现"新产物又脏、又要人工清一次"的循环。
 *
 * - 仓库内的路径 → `<repo>/…`（相对仓库根，保留完整诊断信息）；
 * - 仓库外的 Playwright 缓存 → `<ms-playwright>/<name>-<revision>/…`
 *   （**保留浏览器名与构建号**，人仍能看出"用的是哪个浏览器、哪个构建"）；
 * - 其他家目录路径 → `<home>/…`；
 * - 系统临时目录 → `<tmp>/…`（macOS 的 `/var/folders/<x>/<y>/T/`、`/tmp/`、
 *   Windows 的 `…\AppData\Local\Temp\`）。
 *
 * ## 幂等
 *
 * 所有替换都只命中绝对路径前缀，替换结果里不再含 `/Users/`、`/home/`、`C:\Users` 或仓库根，
 * 所以对同一份载荷重复调用结果不变——`writeJsonStable` 的"实质内容"比较因此仍然成立。
 *
 * ## 单一实现
 *
 * `tests/compat/lib/stable-write.mjs`（含 `examples/webpack/` 的脚本）、
 * `tests/compat/scripts/{browser-core-path,vite-dev-server}.mjs`、`tests/e2e/` 的写入者
 * 都从这里取脱敏器，避免三份实现各自漂移。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根标记（仓库内路径相对它表达）。 */
export const REPO_MARKER = '<repo>';
/** Playwright 浏览器缓存的类别标记（其后保留 `<name>-<revision>` 段）。 */
export const PLAYWRIGHT_MARKER = '<ms-playwright>';
/** 其他家目录的类别标记。 */
export const HOME_MARKER = '<home>';
/** 系统临时目录的类别标记。 */
export const TMP_MARKER = '<tmp>';

/**
 * 本模块所在仓库的根目录。
 *
 * 不用 `new URL()`：`tests/compat/lib/matrix.ts` 记录了 happy-dom 会改写 `new URL()` 的结果；
 * 这里同样只把 `import.meta.url` 的**字符串**交给 `fileURLToPath`，取不到再退回 `process.cwd()`。
 */
/**
 * @returns {string}
 */
function repoRootFromModule() {
  const url = import.meta.url;
  if (url.startsWith('file://')) {
    try {
      // tests/compat/lib/redact-paths.mjs → 上三层是仓库根。
      return resolve(dirname(fileURLToPath(url)), '..', '..', '..');
    } catch {
      // 理论上不可达；真出现非 file: 形态时走 cwd
    }
  }
  return process.cwd();
}

/** 仓库根（供调用方复用，避免各自推导）。 */
export const REPO_ROOT = repoRootFromModule();

/** Playwright 缓存（macOS / Linux，POSIX 分隔符）。 */
const POSIX_PLAYWRIGHT =
  /(?:\/Users\/[^/\s"']+\/Library\/Caches\/ms-playwright\/|\/home\/[^/\s"']+\/\.cache\/ms-playwright\/)/gu;
/** Playwright 缓存（Windows，反斜杠分隔符）。 */
const WIN_PLAYWRIGHT = /[A-Za-z]:\\Users\\[^\s"'\\]+\\AppData\\Local\\ms-playwright\\/gu;
/** 其他家目录（POSIX）。 */
const POSIX_HOME = /(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+)(?=\/|$)/gu;
/** 其他家目录（Windows）。 */
const WIN_HOME = /[A-Za-z]:\\Users\\[^\s"'\\]+/gu;
/** 系统临时目录（POSIX：macOS 的 per-user TMPDIR 与 /tmp）。 */
const POSIX_TMP = /(?:\/private)?\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T\/|(?:\/private)?\/tmp\//gu;
/** 系统临时目录（Windows）。 */
const WIN_TMP = /[A-Za-z]:\\Users\\[^\s"'\\]+\\AppData\\Local\\Temp\\/gu;

/**
 * 把仓库根替换成 `<repo>`（同时覆盖 Windows 分隔符形态与 `file://` 里的出现）。
 *
 * @param {string} text
 * @param {string} repoRoot
 * @returns {string}
 */
function redactRepoRoot(text, repoRoot) {
  const variants = new Set([repoRoot]);
  // Windows 上 repoRoot 可能是 `C:\a\b`；产物里也可能出现 `C:/a/b`（URL、Vite 的 /@fs/）。
  variants.add(repoRoot.replaceAll('\\', '/'));
  variants.add(repoRoot.replaceAll('/', '\\'));
  let out = text;
  for (const variant of variants) {
    if (variant.length === 0) continue;
    const pattern = new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu');
    out = out.replace(pattern, (_match, offset) => {
      // 仓库根前面若不是分隔符（`/@fs`+路径、`http://host`+路径），补一个 `/`，
      // 否则会得到 `/@fs<repo>` 这种读不通的拼接。
      return offset > 0 && out[offset - 1] !== '/' ? `/${REPO_MARKER}` : REPO_MARKER;
    });
  }
  return out;
}

/**
 * 脱敏一条字符串里的绝对路径。
 *
 * @param {string} text 原始字符串（可以是普通路径，也可以是包含路径的 JSON/URL 片段）
 * @param {string} [repoRoot] 仓库根，默认本模块推导出的根（测试可注入临时值）
 * @returns {string}
 */
export function redactText(text, repoRoot = REPO_ROOT) {
  let out = redactRepoRoot(text, repoRoot);
  // 顺序有意义：越具体的类别越先替换，否则会被更宽的家目录规则吃掉。
  out = out.replace(POSIX_PLAYWRIGHT, `${PLAYWRIGHT_MARKER}/`);
  out = out.replace(WIN_PLAYWRIGHT, `${PLAYWRIGHT_MARKER}/`);
  out = out.replace(POSIX_TMP, `${TMP_MARKER}/`);
  out = out.replace(WIN_TMP, `${TMP_MARKER}/`);
  // 保留路径分隔符：`/@fs/Users/<u>/…` → `/@fs/<home>/…`（丢掉分隔符会变成 `/@fs<home>`）。
  out = out.replace(POSIX_HOME, `/${HOME_MARKER}`);
  out = out.replace(WIN_HOME, HOME_MARKER);
  return out;
}

/**
 * 递归脱敏一份 JSON 载荷（返回新对象，不修改入参）。
 *
 * 只处理字符串叶子；数字、布尔、null 与非字符串键原样保留。
 *
 * @template T
 * @param {T} value 载荷
 * @param {string} [repoRoot] 仓库根（默认本模块推导出的根）
 * @returns {T}
 */
export function redactPaths(value, repoRoot = REPO_ROOT) {
  if (typeof value === 'string') return redactText(value, repoRoot);
  if (Array.isArray(value)) return value.map((item) => redactPaths(item, repoRoot));
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactPaths(item, repoRoot);
    }
    return out;
  }
  return value;
}
