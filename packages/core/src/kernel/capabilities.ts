/**
 * 能力注册表：内核与各模块之间的弱耦合扩展点（例如 transport 发送端口、配置读取器）。
 * 同名以后注册者为准；注销只在自己仍是当前值时移除。
 */
import { REASON_CODES } from './constants';
import type { CapabilityRegistry, Counters, Dispose } from './types';

const NOOP_DISPOSE: Dispose = () => undefined;

export interface CapabilityRegistryServices {
  readonly counters: Counters;
}

/** 创建能力注册表。 */
export function createCapabilityRegistry(services: CapabilityRegistryServices): CapabilityRegistry {
  const { counters } = services;
  const values = new Map<string, unknown>();
  let disposed = false;

  return {
    register(name: string, value: unknown): Dispose {
      if (disposed) {
        counters.count(REASON_CODES.destroyed);
        return NOOP_DISPOSE;
      }
      values.set(name, value);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (values.get(name) === value) values.delete(name);
      };
    },
    has(name: string): boolean {
      return values.has(name);
    },
    get(name: string): unknown {
      return values.get(name);
    },
    names(): readonly string[] {
      return [...values.keys()];
    },
    dispose(): void {
      disposed = true;
      values.clear();
    },
  };
}
