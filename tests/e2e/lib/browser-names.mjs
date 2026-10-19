/**
 * 「声明的浏览器」词汇表 —— **唯一来源**，不写手写名单。
 *
 * 为什么需要它：`smoke-browsers.mjs`（`all` 的展开）与 `d004-run.mjs`（默认要枚举哪些引擎）都需要
 * 回答"哪些浏览器是声明过的"。此前两处各自写死一个字面量数组 / 一个 `chromium` 默认值，
 * 于是"词汇表"与"真实探测口径"是**两份东西**：拼错的名字（`chrome` / `firefox ` 带空格）会被
 * 当成浏览器名继续往下传，`all` 也可能与 Playwright 实际提供的引擎漂移。
 *
 * 这里的取法：**从 Playwright 自己的导出里取** `chromium` / `firefox` / `webkit` 这几个
 * `BrowserType`（判据 = 带 `launchPersistentContext` 方法，即 `lib/harness.mjs` 真正调用的那个方法）。
 * 好处是词汇表与探测口径不可能漂移——`lib/browsers.mjs` 的解析、`lib/browser-availability.mjs`
 * 的启动探测、`lib/harness.mjs` 的 launch 用的都是**同一批对象**。
 *
 * 与 `playwright.config.ts` 的关系：该配置当前声明了同名三个 project
 * （`chromium` / `firefox` / `webkit`），所以"声明的浏览器" = 这里的三个名字。配置是 `.ts`，
 * 从 `.mjs` 脚本里安全读取它需要额外的 loader，因此这里不解析它；**若配置增删 project，
 * 需同步本文件顶部的说明与 `playwright.config.ts`**（该文件不在 T29/T30 的可写范围里）。
 */
import * as playwrightModule from '@playwright/test';

/** CLI 上的"全部"取值（`--browser all` / `smoke-browsers.mjs all`）。 */
export const ALL_BROWSERS = 'all';

/**
 * 从 Playwright 的导出里取引擎名（按字母序，稳定可比）。
 * 过滤掉以下划线开头的私有导出（如 `_electron`、`_android`）与非 BrowserType 导出（`devices` 等）。
 * @param {Record<string, unknown>} module 默认是 `@playwright/test` 的命名空间（可注入以便自检）
 * @returns {string[]}
 */
export function declaredBrowsers(module = playwrightModule) {
  return Object.keys(module)
    .filter((key) => !key.startsWith('_'))
    .filter((key) => {
      const value = module[key];
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof value.launchPersistentContext === 'function'
      );
    })
    .sort();
}

/** 本进程里声明的浏览器（`['chromium','firefox','webkit']`）。 */
export const DECLARED_BROWSERS = declaredBrowsers();

/**
 * 把一个 CLI 取值展开成浏览器名数组。
 *
 * 合法取值只有：`all`，或**声明过的**某个名字。别的写法一律抛错并列出合法取值——
 * 不允许把拼错的名字当成"某个浏览器"继续传下去（那样 `resolveBrowser` 只会给出一个
 * 与环境无关的"没有可用组合"错误，看不出是参数错）。
 *
 * @param {string} value
 * @param {string[]} [names] 声明过的名字（默认 `DECLARED_BROWSERS`）
 * @returns {string[]}
 */
export function expandBrowserArg(value, names = DECLARED_BROWSERS) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') {
    throw new Error(`浏览器名为空：合法取值是 ${ALL_BROWSERS}（全部）或 ${names.join(' / ')}`);
  }
  if (text === ALL_BROWSERS) return [...names];
  if (!names.includes(text)) {
    throw new Error(
      `未知的浏览器名 ${JSON.stringify(text)}：合法取值是 ${ALL_BROWSERS}（全部）或 ` +
        `${names.join(' / ')}（来源：@playwright/test 导出的 BrowserType，见 lib/browser-names.mjs）`,
    );
  }
  return [text];
}
