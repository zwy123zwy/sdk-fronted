/**
 * 全局注册表（C02-F6）：
 * - 多个插件订阅同一原生事件时，同一目标 + 事件 + capture 只安装一次原生监听；
 * - hook 只包装不替换：包装函数收到包装前的函数，注销时恢复；包装逻辑抛错时回退原函数；
 * - 定时器统一登记，注销或销毁时清除；
 * - 销毁后不留任何监听、hook 与定时器，之后的注册计数 `destroyed`。
 *
 * 模块顶层不访问 window：默认目标在首次订阅时解析 `globalThis`。
 */
import { REASON_CODES } from './constants';
import type {
  Counters,
  Dispose,
  GlobalRegistry,
  GlobalRegistryStats,
  ListenerOptions,
} from './types';

const NOOP_DISPOSE: Dispose = () => undefined;

/** 内部统一的函数形态，用于包装任意原生方法。 */
type RawFunction = (this: unknown, ...args: unknown[]) => unknown;

interface ListenerGroup {
  readonly target: EventTarget;
  readonly type: string;
  readonly capture: boolean;
  readonly passive: boolean;
  readonly handlers: Set<(event: Event) => void>;
  readonly dispatch: (event: Event) => void;
  installed: boolean;
}

interface HookRecord {
  readonly factory: (original: RawFunction) => RawFunction;
}

interface HookChain {
  readonly holder: Record<string, unknown>;
  readonly key: string;
  readonly base: unknown;
  readonly records: HookRecord[];
  composite: unknown;
}

export interface GlobalRegistryServices {
  readonly counters: Counters;
  /** 原生目标；`null` 表示没有（SSR、Node 测试环境），`undefined` 表示按需解析 globalThis。 */
  readonly target?: EventTarget | null | undefined;
}

type TimerKind = 'timeout' | 'interval';

/** 创建全局注册表。 */
export function createGlobalRegistry(services: GlobalRegistryServices): GlobalRegistry {
  const { counters, target: configuredTarget } = services;
  const listeners = new Map<EventTarget, Map<string, ListenerGroup>>();
  const chains = new Map<object, Map<string, HookChain>>();
  const timers = new Map<number, TimerKind>();
  let disposed = false;

  function runSafely(handler: () => void): void {
    try {
      handler();
    } catch {
      counters.count(REASON_CODES.processorError);
    }
  }

  function resolveTarget(): EventTarget | null {
    if (configuredTarget !== undefined) return configuredTarget;
    const candidate: { addEventListener?: unknown; removeEventListener?: unknown } = globalThis;
    return typeof candidate.addEventListener === 'function' &&
      typeof candidate.removeEventListener === 'function'
      ? (candidate as unknown as EventTarget)
      : null;
  }

  function createGroup(
    target: EventTarget,
    type: string,
    capture: boolean,
    passive: boolean,
  ): ListenerGroup {
    const handlers = new Set<(event: Event) => void>();
    return {
      target,
      type,
      capture,
      passive,
      handlers,
      installed: false,
      dispatch: (event: Event): void => {
        for (const handler of [...handlers]) {
          try {
            handler(event);
          } catch {
            counters.count(REASON_CODES.processorError);
          }
        }
      },
    };
  }

  function installGroup(group: ListenerGroup): void {
    try {
      group.target.addEventListener(group.type, group.dispatch, {
        capture: group.capture,
        passive: group.passive,
      });
      group.installed = true;
    } catch {
      counters.count(REASON_CODES.processorError);
    }
  }

  function uninstallGroup(group: ListenerGroup): void {
    if (!group.installed) return;
    group.installed = false;
    try {
      group.target.removeEventListener(group.type, group.dispatch, { capture: group.capture });
    } catch {
      counters.count(REASON_CODES.processorError);
    }
  }

  function listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    options?: ListenerOptions,
  ): Dispose {
    if (disposed) {
      counters.count(REASON_CODES.destroyed);
      return NOOP_DISPOSE;
    }
    const capture = options?.capture === true;
    const passive = options?.passive === true;
    const groupKey = `${type}\u0000${capture ? '1' : '0'}`;

    let byKey = listeners.get(target);
    if (byKey === undefined) {
      byKey = new Map<string, ListenerGroup>();
      listeners.set(target, byKey);
    }
    const existing = byKey.get(groupKey);
    const group = existing ?? createGroup(target, type, capture, passive);
    if (existing === undefined) {
      byKey.set(groupKey, group);
      installGroup(group);
    }
    group.handlers.add(handler);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      group.handlers.delete(handler);
      if (group.handlers.size > 0) return;
      uninstallGroup(group);
      byKey.delete(groupKey);
      if (byKey.size === 0) listeners.delete(target);
    };
  }

  function ensureChain(target: object, key: string): HookChain | undefined {
    let byKey = chains.get(target);
    if (byKey === undefined) {
      byKey = new Map<string, HookChain>();
      chains.set(target, byKey);
    }
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;

    const holder = target as Record<string, unknown>;
    const base = holder[key];
    if (typeof base !== 'function') {
      if (byKey.size === 0) chains.delete(target);
      return undefined;
    }
    const chain: HookChain = { holder, key, base, records: [], composite: base };
    byKey.set(key, chain);
    return chain;
  }

  function removeChain(target: object, key: string): void {
    const byKey = chains.get(target);
    if (byKey === undefined) return;
    byKey.delete(key);
    if (byKey.size === 0) chains.delete(target);
  }

  /** 从链底（包装前的函数）重新组合全部生效的包装层。 */
  function composeChain(chain: HookChain): unknown {
    let current = chain.base as RawFunction;
    for (const record of chain.records) {
      const next = current;
      let wrapped: RawFunction;
      try {
        wrapped = record.factory(next);
      } catch {
        counters.count(REASON_CODES.processorError);
        wrapped = next;
      }
      const captured = wrapped;
      current = function (this: unknown, ...args: unknown[]): unknown {
        try {
          return captured.apply(this, args);
        } catch {
          counters.count(REASON_CODES.processorError);
          return next.apply(this, args);
        }
      };
    }
    return current;
  }

  /**
   * 只有在全局值**仍是 SDK 最后装上的那一层**（`chain.composite`）时才还原到 `chain.base`。
   *
   * 外部（业务代码、第三方 APM）在 SDK 之上又包了一层时，当前值不再是自己的那一层，
   * 就**只撤销自己的逻辑、不动别人的包装**（Q7 第 4 条）。
   * 增量注销与整体销毁**共用这一套判断**，两条路径不得再各写一份。
   */
  function restoreChainIfOwned(chain: HookChain): void {
    if (chain.holder[chain.key] !== chain.composite) return;
    try {
      chain.holder[chain.key] = chain.base;
    } catch {
      counters.count(REASON_CODES.processorError);
    }
  }

  function registerHook(
    target: object,
    key: string,
    factory: (original: RawFunction) => RawFunction,
  ): Dispose {
    if (disposed) {
      counters.count(REASON_CODES.destroyed);
      return NOOP_DISPOSE;
    }
    const chain = ensureChain(target, key);
    if (chain === undefined) {
      counters.count(REASON_CODES.processorError);
      return NOOP_DISPOSE;
    }

    const record: HookRecord = { factory };
    chain.records.push(record);
    const composed = composeChain(chain);
    chain.composite = composed;
    try {
      chain.holder[key] = composed;
    } catch {
      counters.count(REASON_CODES.processorError);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = chain.records.indexOf(record);
      if (index < 0) return;

      chain.records.splice(index, 1);
      if (chain.records.length === 0) {
        restoreChainIfOwned(chain);
        removeChain(target, key);
        return;
      }

      // 外部在 SDK 之上又包装了一层时不动当前值，避免覆盖业务行为。
      if (chain.holder[key] !== chain.composite) return;
      const recomposed = composeChain(chain);
      chain.composite = recomposed;
      try {
        chain.holder[key] = recomposed;
      } catch {
        counters.count(REASON_CODES.processorError);
      }
    };
  }

  function scheduleTimer(handler: () => void, delayMs: number, kind: TimerKind): Dispose {
    if (disposed) {
      counters.count(REASON_CODES.destroyed);
      return NOOP_DISPOSE;
    }
    const id =
      kind === 'timeout'
        ? setTimeout(() => {
            timers.delete(id);
            runSafely(handler);
          }, delayMs)
        : setInterval(() => {
            runSafely(handler);
          }, delayMs);
    timers.set(id, kind);

    return () => {
      if (!timers.delete(id)) return;
      if (kind === 'timeout') clearTimeout(id);
      else clearInterval(id);
    };
  }

  return {
    listen,
    listenGlobal(type: string, handler: (event: Event) => void, options?: ListenerOptions): Dispose {
      if (disposed) {
        counters.count(REASON_CODES.destroyed);
        return NOOP_DISPOSE;
      }
      const target = resolveTarget();
      if (target === null) return NOOP_DISPOSE;
      return listen(target, type, handler, options);
    },
    hook<T extends object, K extends keyof T>(
      target: T,
      key: K,
      wrapper: (original: T[K]) => T[K],
    ): Dispose {
      return registerHook(
        target,
        key as string,
        wrapper as unknown as (original: RawFunction) => RawFunction,
      );
    },
    schedule(handler: () => void, delayMs: number): Dispose {
      return scheduleTimer(handler, delayMs, 'timeout');
    },
    scheduleRepeat(handler: () => void, intervalMs: number): Dispose {
      return scheduleTimer(handler, intervalMs, 'interval');
    },
    stats(): GlobalRegistryStats {
      let listenerCount = 0;
      let nativeListenerCount = 0;
      for (const byKey of listeners.values()) {
        for (const group of byKey.values()) {
          listenerCount += group.handlers.size;
          if (group.installed) nativeListenerCount += 1;
        }
      }
      let hookCount = 0;
      for (const byKey of chains.values()) {
        for (const chain of byKey.values()) hookCount += chain.records.length;
      }
      return {
        listeners: listenerCount,
        nativeListeners: nativeListenerCount,
        hooks: hookCount,
        timers: timers.size,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;

      for (const byKey of [...chains.values()]) {
        for (const chain of [...byKey.values()]) {
          // 与增量注销路径同一套判断：只还原自己装上的那一层，外部包装不动。
          restoreChainIfOwned(chain);
        }
      }
      chains.clear();

      for (const id of [...timers.keys()]) {
        const kind = timers.get(id);
        timers.delete(id);
        if (kind === 'interval') clearInterval(id);
        else clearTimeout(id);
      }

      for (const byKey of [...listeners.values()]) {
        for (const group of [...byKey.values()]) uninstallGroup(group);
      }
      listeners.clear();
    },
  };
}
