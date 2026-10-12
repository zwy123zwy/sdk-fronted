/**
 * 生命周期状态机（C02-F1）。
 * 未初始化时启动被忽略；已销毁后初始化被忽略；两者都不抛错。
 * 销毁后任何非法调用计数原因码 `destroyed`；销毁后不保留状态变化监听。
 */
import { REASON_CODES } from './constants';
import type { Counters, Dispose, Lifecycle, LifecycleState, StateChangeListener } from './types';

const NOOP_DISPOSE: Dispose = () => undefined;

export interface LifecycleServices {
  readonly counters: Counters;
}

/** 创建生命周期状态机。 */
export function createLifecycle(services: LifecycleServices): Lifecycle {
  const { counters } = services;
  let current: LifecycleState = 'uninitialized';
  const listeners = new Set<StateChangeListener>();

  function reject(): false {
    if (current === 'destroyed') counters.count(REASON_CODES.destroyed);
    return false;
  }

  function transition(next: LifecycleState): boolean {
    if (current === 'destroyed') return reject();
    const previous = current;
    current = next;
    for (const listener of [...listeners]) {
      try {
        listener(next, previous);
      } catch {
        counters.count(REASON_CODES.processorError);
      }
    }
    return true;
  }

  return {
    state(): LifecycleState {
      return current;
    },
    isDestroyed(): boolean {
      return current === 'destroyed';
    },
    init(): boolean {
      return current === 'uninitialized' ? transition('initialized') : reject();
    },
    start(): boolean {
      return current === 'initialized' ? transition('running') : reject();
    },
    pause(): boolean {
      return current === 'running' ? transition('paused') : reject();
    },
    resume(): boolean {
      return current === 'paused' ? transition('running') : reject();
    },
    destroy(): boolean {
      if (current === 'destroyed') return reject();
      const destroyed = transition('destroyed');
      listeners.clear();
      return destroyed;
    },
    onStateChange(listener: StateChangeListener): Dispose {
      if (current === 'destroyed') {
        counters.count(REASON_CODES.destroyed);
        return NOOP_DISPOSE;
      }
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  };
}
