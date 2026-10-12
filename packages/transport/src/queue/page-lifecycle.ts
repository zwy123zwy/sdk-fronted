/**
 * 页面离开信号源的 DOM 适配（C06-F2、C06-AC-07）：
 * `visibilitychange` 且 `visibilityState === 'hidden'`，以及 `pagehide`，都视为页面离开。
 *
 * 工厂内才访问传入的 document，模块顶层不产生任何副作用（可在 SSR / Vitest 中导入）。
 * `packages/core` 的全局注册表（C02-F6）可以改用注入端统一回收监听。
 */
import type { PageLeaveSignal, PageLeaveSource, PageLifecycleDocument } from './types';

/** 把 DOM 页面生命周期事件适配成页面离开信号源。 */
export function createDomPageLeaveSource(target: PageLifecycleDocument): PageLeaveSource {
  return {
    subscribe(handler: (signal: PageLeaveSignal) => void): () => void {
      const onVisibilityChange = (): void => {
        if (target.visibilityState === 'hidden') handler('hidden');
      };
      const onPageHide = (): void => {
        handler('pagehide');
      };
      target.addEventListener('visibilitychange', onVisibilityChange);
      target.addEventListener('pagehide', onPageHide);
      return (): void => {
        target.removeEventListener('visibilitychange', onVisibilityChange);
        target.removeEventListener('pagehide', onPageHide);
      };
    },
  };
}
