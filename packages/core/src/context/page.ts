/**
 * 页面归属（C04-F2）：`page_id` 与 `view_id` 的生命周期。
 *
 * 口径（编排方 2026-10-13 裁定 8）：`page_id` **原样使用** `setPage` 的值
 * （`/task/:id` 就是 `/task/:id`）—— C04 **不从 URL 推导路由模板、不内置模板匹配器、
 * 不监听 History/popstate**（路由事件与模板来源属 C05-F3 / T18）。
 *
 * `view_id` 的生命周期：
 * - 实例创建时生成首个 `view_id`（UUID v4）；
 * - `page_id` 变化时轮换；
 * - URL 变化（同 `page_id` 的 SPA 导航）时轮换 —— 由装配根/路由插件通过 `noteLocation` 通知；
 * - 重复设置同一 `page_id` 或同一 URL 时不轮换；
 * - `destroy()` 后不保留。
 *
 * 入队快照点：`snapshot()` 由 `api/client.ts` 在 `submit()` 里调用，因此 `page_id`/`view_id`/
 * `url` 在**调用当时**定下来（AC-03 的唯一落点）。`enrich` 只补缺失字段，**不覆盖**快照。
 */
import type { KernelEvent } from '../kernel';
import { MAX_PAGE_ID_LENGTH } from '../privacy/constants';
import { truncateUtf16Safe } from '../privacy/limits';
import type { ContextSnapshot } from '../privacy/types';
import type { PageTracker, PageTrackerOptions } from './ports';

/** 从「路径 + 查询 + 片段」里取出纯路径（`page_id` 是路由模板，不是 URL）。 */
function toPath(value: string): string {
  const hashIndex = value.indexOf('#');
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutHash.indexOf('?');
  return queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
}

/** 判断是否为可用的 `page_id`（非空、去掉空白后仍有内容）。 */
function normalizePageId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = toPath(value).trim();
  if (path.length === 0) return undefined;
  return truncateUtf16Safe(path, MAX_PAGE_ID_LENGTH);
}

/** 创建页面追踪器。 */
export function createPageTracker(options: PageTrackerOptions): PageTracker {
  let pageId = normalizePageId(options.pageId);
  let viewId = options.createId();
  let url = options.url;
  let urlChangedAt = options.now?.() ?? 0;

  /** 页面变化（`page_id` 变了）或导航发生（URL 变了）时轮换 `view_id`。 */
  function rotate(): void {
    viewId = options.createId();
  }

  return {
    snapshot(): ContextSnapshot {
      return { page_id: pageId, view_id: viewId, url, context: undefined };
    },
    setPage(next: string | undefined): void {
      const normalized = normalizePageId(next);
      if (normalized === undefined) return;
      if (normalized === pageId) return;
      pageId = normalized;
      rotate();
    },
    noteLocation(nextUrl: string | undefined, explicitViewId?: string  ): void {
      if (explicitViewId !== undefined && explicitViewId.length > 0) {
        if (nextUrl !== undefined) url = nextUrl;
        viewId = explicitViewId;
        return;
      }
      if (nextUrl === undefined || nextUrl === url) return;
      url = nextUrl;
      urlChangedAt = options.now?.() ?? urlChangedAt;
      rotate();
    },
    enrich(event: KernelEvent): KernelEvent {
      let result: KernelEvent | undefined;
      const ensure = (): KernelEvent => {
        if (result === undefined) result = { ...event };
        return result;
      };
      if (event['page_id'] === undefined && pageId !== undefined) ensure()['page_id'] = pageId;
      if (event['view_id'] === undefined) ensure()['view_id'] = viewId;
      if (event['url'] === undefined && url !== undefined) ensure()['url'] = url;
      return result ?? event;
    },
    isSamePage(candidate: string | undefined): boolean {
      return normalizePageId(candidate) === pageId;
    },
  };
}
