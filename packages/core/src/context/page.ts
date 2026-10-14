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
 * - `noteLocation` 的显式 `view_id`（接管场景）必须**本身满足 `$defs/uuid`** 才采用，否则
 *   按未传入处理（丢弃 + 自动生成，见 `noteLocation` 的注释；2026-10-14 收口上轮遗留）；
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

/**
 * `view_id` 的形态判据 —— 与 `batch.schema.json` 的 `$defs/uuid` **逐字一致**
 * （v4 + variant `[89ab]`，小写）。**不**放宽成 RFC 4122 的宽松判据：接收方按
 * `$defs/uuid` 校验，任何"看着像 uuid"的值都得按会被拒处理。
 * 与 Schema 的漂移由 `page.test.ts` 直接读真实 Schema 的 `$defs/uuid.pattern`
 * 逐样本比对锁定（形态改了这里就红）。
 */
const SCHEMA_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 该字符串是否满足 `$defs/uuid`（能安全作为 `view_id` 上报）。 */
function isSchemaUuid(value: string): boolean {
  return SCHEMA_UUID_PATTERN.test(value);
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
    noteLocation(nextUrl: string | undefined, explicitViewId?: string): void {
      // 显式 `view_id` 必须**本身**满足 `$defs/uuid` 才采用：`view_id` 已在协议字段排除
      // 清单里（UUID 结构上不可能含 PII → 不脱敏），因此非 uuid 的显式值不会再被兜底
      // 改写，带着它上报只会让整条事件过不了 `$defs/uuid`（接收方拒绝）。
      // 非 uuid 的输入**按未传入处理**（丢弃后走自动生成路径，与 `normalizePageId`
      // 丢弃非法 `page_id`、与空串的先例一致）；**不**截断/改写成"像 uuid"的标识符 ——
      // 那会造出一个语义不明的标识符。
      if (explicitViewId !== undefined && isSchemaUuid(explicitViewId)) {
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
