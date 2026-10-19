/**
 * `redact-paths.mjs` 的类型声明（供 `tests/**\/*.ts` 静态导入证据脱敏器）。
 */

/** 仓库根标记。 */
export const REPO_MARKER: '<repo>';
/** Playwright 浏览器缓存标记（其后保留 `<name>-<revision>` 段）。 */
export const PLAYWRIGHT_MARKER: '<ms-playwright>';
/** 其他家目录标记。 */
export const HOME_MARKER: '<home>';
/** 系统临时目录标记。 */
export const TMP_MARKER: '<tmp>';
/** 本模块推导出的仓库根。 */
export const REPO_ROOT: string;

/** 脱敏一条字符串里的绝对路径。 */
export function redactText(text: string, repoRoot?: string): string;

/** 递归脱敏一份 JSON 载荷（返回新对象，不修改入参）。 */
export function redactPaths<T>(value: T, repoRoot?: string): T;
