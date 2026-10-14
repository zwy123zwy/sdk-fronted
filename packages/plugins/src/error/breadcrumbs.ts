/**
 * C05-F1 行为面包屑。
 *
 * 裁定（T18-plan §2 与 §13-③、`docs/use-cases.md` 问题 5）：
 * - 面包屑是**错误事件的自动上下文**，不加独立公共 API；
 * - **容量固定**为 20 条，不开放配置；
 * - **文本必须过滤掉输入框内容**——绝不记录 `input` / `textarea` / `select` 的 `value`。
 *
 * 承载方式：契约的 `web_js_error.dimensions` 是**封闭四键**、`metrics` 只认
 * `count`/`line`/`column`，没有面包屑的专属字段；`context` 是该事件上唯一的开放
 * string→string 字段，因此按 `bc_00`…`bc_19` 逐条写入（键名匹配 Schema 的
 * `fieldKey` 模式 `^[a-z][a-z0-9_]{0,63}$`，单值远小于 256 字符上限）。
 */
import { BREADCRUMB_CAPACITY } from './types';
import type { Breadcrumb } from './types';

/** 面包屑写入事件 `context` 时的键前缀。 */
export const BREADCRUMB_CONTEXT_PREFIX = 'bc_';

/** 面包屑缓冲：容量固定，超出后丢弃最早的条目。 */
export interface BreadcrumbBuffer {
  /** 记录一条点击面包屑；`target` 必须来自元素标识，不得取输入框的 `value`。 */
  push(target: Element, type: string): void;
  /** 记录一条路由面包屑（只记路径，不含查询参数）。 */
  pushRoute(to: string): void;
  /** 记录一条已算好的面包屑（装配根在别处采集时使用）。 */
  pushBreadcrumb(breadcrumb: Breadcrumb): void;
  /** 取最近 `BREADCRUMB_CAPACITY` 条，按时间升序（最早在前）。 */
  snapshot(): readonly Breadcrumb[];
  /** 清空缓冲。 */
  clear(): void;
}

/** 输入类元素：其 `value` 属于用户输入，绝不能进面包屑。 */
const INPUT_TAGS: readonly string[] = ['input', 'textarea', 'select', 'option'];

/**
 * 从元素派生安全标识：只用标签名与 `id` / `data-track` / `data-testid` 等
 * **静态属性**，**不读取** `value`、`textContent` 或任何用户输入内容。
 */
export function describeElement(element: Element): string {
  const tag = element.tagName === '' ? 'unknown' : element.tagName.toLowerCase();
  const track = element.getAttribute('data-track');
  if (track !== null && track !== '') return `${tag}[${track}]`;
  const testId = element.getAttribute('data-testid');
  if (testId !== null && testId !== '') return `${tag}#${testId}`;
  const id = element.getAttribute('id');
  if (id !== null && id !== '') return `${tag}#${id}`;
  return tag;
}

/** 该元素是否属于「输入类」（其 value 不得进面包屑）。 */
function isInputElement(element: Element): boolean {
  return INPUT_TAGS.includes(element.tagName.toLowerCase());
}

/** 创建固定容量的面包屑缓冲。 */
export function createBreadcrumbBuffer(clock: () => number): BreadcrumbBuffer {
  let items: Breadcrumb[] = [];

  const append = (breadcrumb: Breadcrumb): void => {
    items = [...items, breadcrumb];
    if (items.length > BREADCRUMB_CAPACITY) {
      items = items.slice(items.length - BREADCRUMB_CAPACITY);
    }
  };

  return {
    push(target: Element, type: string): void {
      // 输入类元素只记标签，绝不触碰 value（AC-04 的硬约束）。
      const label = isInputElement(target) ? target.tagName.toLowerCase() : describeElement(target);
      append({ type, target: label, at: clock() });
    },
    pushRoute(to: string): void {
      // 只记路径：去掉 `?query` 与 `#hash`（查询参数可能含令牌）。
      const path = to.split('?')[0]?.split('#')[0] ?? to;
      append({ type: 'route', target: path, at: clock() });
    },
    pushBreadcrumb(breadcrumb: Breadcrumb): void {
      append(breadcrumb);
    },
    snapshot(): readonly Breadcrumb[] {
      return items;
    },
    clear(): void {
      items = [];
    },
  };
}

/**
 * 把面包屑编码为事件 `context` 的键值对（`bc_00`…，按时间升序）。
 *
 * 键名固定两位序号，保证同一事件的面包屑顺序可还原、且键名匹配 Schema 的 `fieldKey`。
 */
export function encodeBreadcrumbs(crumbs: readonly Breadcrumb[]): Readonly<Record<string, string>> {
  const context: Record<string, string> = {};
  for (const [index, crumb] of crumbs.entries()) {
    const key = `${BREADCRUMB_CONTEXT_PREFIX}${String(index).padStart(2, '0')}`;
    context[key] = `${crumb.type}|${crumb.target}`;
  }
  return context;
}

/** 从事件 `context` 还原面包屑（测试与调试用；顺序按键名升序）。 */
export function decodeBreadcrumbs(
  context: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (context === undefined) return [];
  return Object.keys(context)
    .filter((key) => key.startsWith(BREADCRUMB_CONTEXT_PREFIX))
    .sort()
    .map((key) => context[key] ?? '');
}
