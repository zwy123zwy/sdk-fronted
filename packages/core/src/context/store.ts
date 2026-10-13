/**
 * 自定义上下文存储（C04-F3）与公共上下文的聚合。
 *
 * 口径（`docs/tasks/T14-plan.md` 第 3 点 + 编排方 2026-10-13 的裁定）：
 * - `setContext(key, value)`：键必须是合法 `fieldKey`；非法键**不写入**并计 `invalid_field_key`
 *   （**非法键名归 C04；非法参数归 C01，两者不合并**）；
 * - 第 51 个**新**键起拒绝写入（内存有界），只记 `contextKeysBeyondLimit` 观测量、
 *   **不占契约原因码**；`enrich` 时若某事件的 `context` 超过 50 键，由字段约束处理器
 *   按键名字典序裁剪并计 `truncated_dimension_keys`（与 `dimensions` 同一套规则）；
 * - 值的脱敏与截断在 `enrich` / 字段约束阶段完成（脱敏器随配置变化，因此不在写入时固化）；
 * - `setUser(id, {hashed})`：只进**批次头**，绝不进事件体、调试输出或本地存储；
 *   超过 128 字符（批次 Schema 上限）时**丢弃整个字段**（由调用方计 `invalid_args`）；
 * - `setPage(pageId)`：原样使用（裁定 8），只取路径（去掉 `?query`/`#hash`）。
 */
import { C04_LIMITS, MAX_USER_ID_LENGTH } from '../privacy/constants';
import type { KernelEvent } from '../kernel';
import type { ConsentMode, ContextSnapshot, ContextUser } from '../privacy/types';
import type { ConsentManager, ContextStore, ContextStoreState, PageTracker } from './ports';

/** 上下文存储的创建选项。 */
export interface ContextStoreOptions {
  readonly page: PageTracker;
  readonly consent: ConsentManager;
  /** 初始生效的 consent_mode（初始化参数；后续由 `setConsentMode` 更新）。 */
  readonly consentMode: ConsentMode;
  /** 初始化时的自定义上下文（键名按 `setContext` 的同一规则校验）。 */
  readonly initialContext?: Readonly<Record<string, string>> | undefined;
}

/** 创建公共上下文存储。 */
export function createContextStore(options: ContextStoreOptions): ContextStore {
  let mode: ConsentMode = options.consentMode;
  let user: ContextUser | undefined;
  let keysBeyondLimit = 0;
  const contexts = new Map<string, string>();

  /** 写入一条初始上下文（第 51 个新键起拒绝，只记观测量）。 */
  function putInitial(key: string, value: string): void {
    if (contexts.has(key) || contexts.size < C04_LIMITS.maxContextKeys) contexts.set(key, value);
    else keysBeyondLimit += 1;
  }

  if (options.initialContext !== undefined) {
    for (const [key, value] of Object.entries(options.initialContext)) putInitial(key, value);
  }

  return {
    snapshot(): ContextSnapshot {
      const page = options.page.snapshot();
      const context = contexts.size > 0 ? Object.fromEntries(contexts) : undefined;
      return context === undefined ? { ...page } : { ...page, context };
    },
    setContext(key: string, value: string): void {
      if (contexts.has(key)) {
        contexts.set(key, value);
        return;
      }
      if (contexts.size >= C04_LIMITS.maxContextKeys) {
        // 第 51 个新键被拒绝：观测量 +1，不占契约原因码（新增码需走 CR）。
        keysBeyondLimit += 1;
        return;
      }
      contexts.set(key, value);
    },
    removeContext(key: string): void {
      contexts.delete(key);
    },
    setInitialContext(values: Readonly<Record<string, string>>): void {
      for (const [key, value] of Object.entries(values)) putInitial(key, value);
    },
    setUser(id: string, userOptions?: { readonly hashed?: boolean | undefined }): void {
      // 超长 `user_id` 会违反批次 Schema（maxLength 128）：丢弃整个字段而不是截断
      // （截断后的哈希值是无意义的错误标识）。计数由调用方负责（`invalid_args`）。
      if (id.length > MAX_USER_ID_LENGTH) {
        user = undefined;
        return;
      }
      user = userOptions?.hashed === true ? { id, hashed: true } : { id };
    },
    clearUser(): void {
      user = undefined;
    },
    setPage(pageId: string): void {
      options.page.setPage(pageId);
    },
    setConsentMode(next: ConsentMode): void {
      mode = next;
    },
    configureView(viewOptions: { readonly url?: string | undefined; readonly view_id?: string | undefined }): void {
      options.page.noteLocation(viewOptions.url, viewOptions.view_id);
    },
    pageId(): string | undefined {
      return options.page.snapshot().page_id;
    },
    user(): ContextUser | undefined {
      return user === undefined ? undefined : { ...user };
    },
    consentMode(): ConsentMode {
      return mode;
    },
    state(): ContextStoreState {
      const page = options.page.snapshot();
      return {
        pageId: page.page_id,
        viewId: page.view_id,
        contexts: Object.fromEntries(contexts),
        user: user === undefined ? undefined : { ...user },
        contextKeysBeyondLimit: keysBeyondLimit,
        bufferEvicted: options.consent.bufferEvicted(),
        bufferSize: options.consent.bufferSize(),
      };
    },
    enrich(event: KernelEvent): KernelEvent {
      // 页面归属（page_id/view_id/url）只补缺失值；`context` 同理（入队快照优先）。
      const enriched = options.page.enrich(event);
      if (contexts.size === 0 || enriched['context'] !== undefined) return enriched;
      const next: KernelEvent = { ...enriched };
      next['context'] = Object.fromEntries(contexts);
      return next;
    },
    destroy(): void {
      contexts.clear();
      user = undefined;
    },
  };
}
