/**
 * C05-F3 路由模板匹配。
 *
 * AC-08 要求 `page_id` 为**路由模板**（如 `/task/:id`）而非实参（`/task/123`）。
 * 本模块只做"路径 → 模板"的匹配；`page_id` 的最终计算归 C04。
 */

/** 把 `path` 去掉查询参数与 hash，得到参与匹配的路径部分。 */
export function stripQuery(path: string): string {
  const withoutHash = path.split('#')[0] ?? path;
  return withoutHash.split('?')[0] ?? withoutHash;
}

/** 把模板转成锚定正则：`:param` 段匹配单段非空路径，其余字符按字面量转义。 */
function templateToPattern(template: string): RegExp {
  const segments = stripQuery(template).split('/');
  const pattern = segments
    .map((segment) => {
      if (segment.startsWith(':') && segment.length > 1) return '[^/]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${pattern}$`);
}

/**
 * 用模板清单匹配路径（按清单顺序，**首个命中生效**）。
 *
 * 未命中任何模板时返回**去掉查询参数后的原路径**——保证事件始终有可用的 `path`，
 * 且查询参数（可能含令牌）不会进入模板。
 */
export function matchTemplate(path: string, templates: readonly string[]): string {
  const clean = stripQuery(path);
  for (const template of templates) {
    if (templateToPattern(template).test(clean)) return stripQuery(template);
  }
  return clean;
}

/** 按模板清单创建一个匹配器（便于在创建插件时绑定一次）。 */
export function createMatcher(templates: readonly string[]): (path: string) => string {
  return (path: string): string => matchTemplate(path, templates);
}
