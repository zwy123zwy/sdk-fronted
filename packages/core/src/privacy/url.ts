/**
 * URL 脱敏（C04-F4；`remote-config.md` 5.4）。
 *
 * 契约语义：
 * - **内置 URL 查询参数处理**：不在 `url_query_allowlist` 中的参数一律删除；白名单为空时删除全部查询参数；
 * - URL **路径**也要过脱敏规则（5.4 的规则作用范围包含「URL 路径」）；
 * - 结果长度不超过 2048（批次 Schema `properties.url.maxLength`）。
 *
 * 本模块不读 `window`：URL 由调用方（`LocationSource` / `configureView`）注入。
 *
 * 用例见 `url.test.ts`（含 AC-06 的白名单场景与 2048 截断）。
 */
import { MAX_URL_LENGTH } from './constants';
import { truncateUtf16Safe } from './limits';
import type { Masker } from './types';

/** URL 的解析结果（无副作用、不依赖 DOM）。 */
export interface UrlParts {
  /** `scheme://host`；相对 URL 时为空串。 */
  readonly origin: string;
  readonly pathname: string;
  /** 保序的查询参数（允许重复键）。 */
  readonly query: readonly (readonly [string, string])[];
  /** 井号后的片段（不含 `#`）；没有则为 `undefined`。 */
  readonly hash: string | undefined;
}

/**
 * 拆解 URL。绝对 URL 走 `URL`；相对 URL（`/a/b?x=1`）手工拆分。
 * 只做拆分，不做任何脱敏或过滤。
 */
export function parseUrlParts(url: string): UrlParts {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex + 1) : undefined;
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  const queryText = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
  const withoutQuery = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;

  const query: (readonly [string, string])[] = [];
  if (queryText.length > 0) {
    for (const pair of queryText.split('&')) {
      if (pair.length === 0) continue;
      const equalsIndex = pair.indexOf('=');
      const key = equalsIndex >= 0 ? pair.slice(0, equalsIndex) : pair;
      const value = equalsIndex >= 0 ? pair.slice(equalsIndex + 1) : '';
      query.push([key, value]);
    }
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/iu.exec(withoutQuery);
  if (schemeMatch === null) {
    return { origin: '', pathname: withoutQuery, query, hash };
  }
  const scheme = schemeMatch[1] ?? '';
  const authority = schemeMatch[2] ?? '';
  const origin = `${scheme}://${authority}`;
  const pathname = withoutQuery.slice(origin.length);
  return { origin, pathname: pathname.length > 0 ? pathname : '/', query, hash };
}

/**
 * 按白名单过滤查询参数（保序、允许重复键），然后对路径与保留的参数值做脱敏，最后截断。
 *
 * 处理顺序：
 *   1. 丢弃 `#fragment`（片段不进入上报 URL）；
 *   2. 查询参数：键**不在**白名单里的一律删除（白名单为空 → 删除全部）；
 *   3. 路径与保留下来的参数值过 `Masker`（5.4 的规则作用范围含 URL 路径）；
 *   4. 结果截断到 `maxLength`（批次 Schema 的 2048）。
 *
 * 井号片段一律丢弃：它是同页锚点，不是页面标识，且可能携带业务敏感值。
 */
export function sanitizeUrl(
  url: string,
  allowlist: readonly string[],
  masker: Masker,
  maxLength: number = MAX_URL_LENGTH,
): string {
  const parts = parseUrlParts(url);
  const allowed = new Set(allowlist);
  const query = allowed.size === 0 ? [] : parts.query.filter(([key]) => allowed.has(key));

  const maskedPath = masker.apply(parts.pathname);
  const queryText = query.map(([key, value]) => `${key}=${masker.apply(value)}`).join('&');
  const rebuilt = `${parts.origin}${maskedPath}${queryText.length > 0 ? `?${queryText}` : ''}`;
  return rebuilt.length > maxLength ? truncateUtf16Safe(rebuilt, maxLength) : rebuilt;
}
