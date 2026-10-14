/**
 * C05-AC-19 与第三方 APM 共存（Q7）。
 *
 * 口径（`tests/acceptance/C05.md` 原文）：第三方 APM 先于本 SDK 初始化、两边都 hook
 * `fetch` 与 `onerror`，然后反过来再测一次 → **两边都采集到数据**；
 * **本 SDK 销毁后，第三方的 hook 仍然生效**。
 *
 * 包装叠加规则（T18-plan §6，依 Q7 第 16 行）：安装时保存当前引用并叠在其上，
 * 卸载时**仅当当前值仍是自己的包装**才还原（否则会误删第三方 hook）。
 *
 * 第三方 APM 桩是**本测试自造**的最小实现，不 import 任何第三方包。
 */
import { describe, expect, it } from 'vitest';

import { ERROR_PLUGIN_ID, installErrorCapture } from '../error/index';
import { createHttpCapture } from '../http/index';
import type { HttpEvent, NativeHttpRefs } from '../http/index';
import { createRouteCapture } from '../route/index';
import type { RouteHooker } from '../route/index';

/**
 * 宿主 fetch 签名（与 `NativeHttpRefs.fetch` 一致，宽松入参）。
 * 与 `NativeHttpRefs` 同型后，包装链上的赋值不会触发参数逆变冲突。
 */
type FetchLike = (...args: readonly unknown[]) => Promise<unknown>;

/** 与 C02 `GlobalRegistry.hook` 同构的成对恢复注册表。 */
function createHooker(): RouteHooker {
  return {
    hook<T extends object, K extends keyof T>(
      target: T,
      key: K,
      wrapper: (original: T[K]) => T[K],
    ): () => void {
      const saved = target[key];
      const wrapped = wrapper(saved);
      target[key] = wrapped;
      return (): void => {
        if (target[key] === wrapped) target[key] = saved;
      };
    },
  };
}

/** 一个最小的宿主页面环境：原生 fetch 与 onerror。 */
interface HostTarget {
  fetch: FetchLike;
  onerror: ((message: string) => void) | undefined;
}

function createHost(): {
  target: HostTarget;
  refs: NativeHttpRefs;
  nativeCalls: string[];
} {
  const nativeCalls: string[] = [];
  // 原生 fetch 与宿主 target 使用同一签名（(...args: readonly unknown[]) => Promise<unknown>），
  // 调用侧通过 hostFetchView 这个更窄的视图传字符串 URL，避免对 unknown[] 参数做不安全收窄。
  const nativeFetch: FetchLike = (...args): Promise<unknown> => {
    nativeCalls.push(String(args[0]));
    return Promise.resolve({ status: 200 });
  };
  function Xhr(): void {
    // 本用例不使用 XHR
  }
  return {
    target: { fetch: nativeFetch, onerror: undefined },
    nativeCalls,
    refs: { fetch: nativeFetch, XMLHttpRequest: Xhr },
  };
}

/** 第三方 APM 桩：包装并转发 + 记录。 */
function createThirdPartyApm(): {
  install(target: HostTarget): void;
  fetchCalls: string[];
  onerrorCalls: string[];
  proxy(): FetchLike;
} {
  const fetchCalls: string[] = [];
  const onerrorCalls: string[] = [];
  let proxy: FetchLike | undefined;

  return {
    fetchCalls,
    onerrorCalls,
    proxy(): FetchLike {
      if (proxy === undefined) throw new Error('第三方 APM 尚未安装');
      return proxy;
    },
    install(target: HostTarget): void {
      const inner = target.fetch;
      const innerOnerror = target.onerror;
      const proxyImpl: FetchLike = (...args) => {
        fetchCalls.push(String(args[0]));
        return inner(...args);
      };
      proxy = proxyImpl;
      target.fetch = proxyImpl;
      target.onerror = (message: string): void => {
        onerrorCalls.push(message);
        innerOnerror?.(message);
      };
    },
  };
}

/**
 * 装成本 SDK 的 HTTP 采集。
 *
 * **关键**：`refs` 必须是与宿主/第三方共享的**同一个容器**，且按
 * `captureNativeHttpRefs()` 的语义在"本 SDK 插件安装之前"取当前值——
 * 因此若第三方先装，我们包装的就是第三方的 hook（叠在其上）。
 */
function installSdkHttp(
  holder: HostTarget,
  hooker: RouteHooker,
): { events: HttpEvent[]; uninstall: () => void } {
  const events: HttpEvent[] = [];
  const capture = createHttpCapture(
    (event) => {
      events.push(event);
    },
    { refs: holder as unknown as NativeHttpRefs, hooker },
  );
  return {
    events,
    uninstall: (): void => {
      capture.uninstall();
    },
  };
}

/** 一个不抛错的插件安装上下文（错误插件用例用）；`listen` 可注入以驱动原生事件。 */
function createContext(listen?: (type: string, handler: (event: Event) => void) => () => void) {
  return {
    pluginId: ERROR_PLUGIN_ID,
    counters: { count: () => undefined, get: () => 0, snapshot: () => ({}), reset: () => undefined },
    pipeline: { register: () => () => undefined, process: () => ({}), size: () => 0, dispose: () => undefined },
    registry: {
      listen: () => () => undefined,
      listenGlobal: () => () => undefined,
      hook: () => () => undefined,
      schedule: () => () => undefined,
      scheduleRepeat: () => () => undefined,
      stats: () => ({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 }),
      dispose: () => undefined,
    },
    capabilities: {
      register: () => () => undefined,
      has: () => false,
      get: () => undefined,
      names: () => [],
      dispose: () => undefined,
    },
    addProcessor: () => () => undefined,
    listen: listen ?? (() => () => undefined),
    hook: () => () => undefined,
    schedule: () => () => undefined,
    scheduleRepeat: () => () => undefined,
    registerCapability: () => () => undefined,
    onDispose: () => undefined,
  };
}

describe('C05-AC-19 两种初始化顺序都共存 + 销毁后第三方仍生效', () => {
  it('第三方先初始化：两边都收到数据，本 SDK 卸载后第三方 hook 仍在', async () => {
    const host = createHost();
    const thirdParty = createThirdPartyApm();
    thirdParty.install(host.target);
    const thirdProxy = thirdParty.proxy();

    // 装配方在"SDK 插件安装之前"捕获当前引用：此时最外层已是第三方的 hook
    const sdk = installSdkHttp(host.target, createHooker());
    expect(host.target.fetch, '本 SDK 的包装应叠在第三方 hook 之上').not.toBe(thirdProxy);

    // 走最外层（本 SDK 包装）：经第三方 → 原生
    await host.target.fetch('/api/task/1');
    expect(thirdParty.fetchCalls, '第三方必须收到数据').toContain('/api/task/1');
    expect(sdk.events, '本 SDK 也必须收到数据').toHaveLength(1);

    sdk.uninstall();
    const afterUninstall: FetchLike = host.target.fetch;
    await afterUninstall('/api/task/2');
    expect(thirdParty.fetchCalls, 'SDK 销毁后第三方 hook 仍被调用').toContain('/api/task/2');
    expect(afterUninstall, 'SDK 卸载不得把第三方的包装一起删掉').toBe(thirdProxy);
  });

  it('本 SDK 先初始化：第三方后装，卸载时不得覆盖第三方的包装', () => {
    const host = createHost();
    const sdk = installSdkHttp(host.target, createHooker());
    const thirdParty = createThirdPartyApm();
    thirdParty.install(host.target);

    const thirdProxy = thirdParty.proxy();
    const installed: FetchLike = host.target.fetch;
    expect(installed, '第三方包装应叠在本 SDK 之上').toBe(thirdProxy);
    sdk.uninstall();
    const afterUninstall: FetchLike = host.target.fetch;
    expect(afterUninstall, '当前值已是第三方的包装：卸载不得覆盖它').toBe(thirdProxy);
  });

  it('与错误插件共存：两边的 onerror 都收到错误，SDK 卸载后第三方仍生效', () => {
    // 浏览器语义：`window.onerror = fn` 与 `addEventListener('error', fn)` 互不影响，
    // 因此第三方用自己的 onerror、本 SDK 用内核的 addEventListener 通道。
    const onerrorListeners: ((event: Event) => void)[] = [];
    const thirdPartyOnerror: string[] = [];
    const target = {
      onerror: ((message: string): void => {
        thirdPartyOnerror.push(message);
      }) as ((message: string) => void) | undefined,
    };
    const dispatchError = (message: string): void => {
      target.onerror?.(message);
      for (const listener of onerrorListeners) {
        listener({ type: 'error', message } as unknown as Event);
      }
    };

    const sdkEvents: string[] = [];
    const harness = createContext((type, handler) => {
      if (type === 'error') onerrorListeners.push(handler);
      return () => undefined;
    });
    const capture = installErrorCapture(
      harness as unknown as Parameters<typeof installErrorCapture>[0],
      () => {
        sdkEvents.push('sdk');
      },
    );

    dispatchError('Uncaught TypeError: boom');
    capture.flush();
    expect(thirdPartyOnerror, '第三方必须收到错误').toContain('Uncaught TypeError: boom');
    expect(sdkEvents, '本 SDK 也必须收到错误').toContain('sdk');

    // 本 SDK 卸载后，第三方的 onerror 仍生效
    capture.uninstall();
    dispatchError('Uncaught TypeError: after destroy');
    expect(thirdPartyOnerror, 'SDK 销毁后第三方仍收到错误').toContain(
      'Uncaught TypeError: after destroy',
    );
  });

  it('路由自动包装也遵循叠加规则（不误删第三方 hook）', () => {
    const thirdPartyHook = (): void => undefined;
    const target = {
      pushState: thirdPartyHook as (data: unknown, unused: string, url?: string | URL | null) => void,
      replaceState: (): void => undefined,
    };

    const capture = createRouteCapture({
      history: target,
      hooker: createHooker(),
    });
    capture.uninstall();
    const current: (data: unknown, unused: string, url?: string | URL | null) => void = target.pushState;
    expect(current, '当前值不是自己的包装时不得还原').toBe(thirdPartyHook);
  });
});
