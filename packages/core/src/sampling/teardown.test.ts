/**
 * C03-F6 未命中会话拆除监听 —— fail-first 用例（M0）。
 * 覆盖：C03-AC-15（error/perf/route/http（及 apm_dual_write）监听被拆除；critical 仍可上报；
 * normal 计 `sampled_out_session`）。
 *
 * M0 说明：`teardown.ts`/`processor.ts` 是桩实现，本文件预期断言级失败。
 */
import { describe, expect, it } from 'vitest';

import { createKernel, definePlugin } from '../kernel';
import type { ConfigReader, EffectiveConfig, ResolvedSampling } from '../config/types';
import { createBuiltinConfig } from '../config/defaults';
import { createSamplingProcessor } from './processor';
import { createSessionSampling } from './session';
import type { SessionStorePort } from './types';
import { teardownForSampledOutSession } from './teardown';

const COLLECTORS: readonly string[] = ['error', 'perf', 'route', 'http', 'apm_dual_write'];


function memoryStore(): SessionStorePort {
  const map = new Map<string, string>();
  return {
    read: (key) => map.get(key),
    write: (key, value) => {
      map.set(key, value);
    },
  };
}

function readerWith(sampling: ResolvedSampling): ConfigReader {
  const config: EffectiveConfig = { ...createBuiltinConfig('essential_only'), sampling };
  return { current: () => config, subscribe: () => () => undefined };
}

describe('C03-F6 会话未命中：拆除采集监听', () => {
  it('C03-AC-15 拆除 error/perf/route/http/（apm_dual_write）的安装与 hook，返回启停信号', () => {
    const kernel = createKernel({ target: null });
    const target = { ping: (): string => 'original' };
    for (const id of COLLECTORS) {
      kernel.registerPlugin(
        definePlugin({
          id,
          install: (context) => {
            context.hook(target, 'ping', () => () => `hooked:${id}`);
          },
        }),
      );
    }
    kernel.applyPluginConfig(Object.fromEntries(COLLECTORS.map((id) => [id, true])));
    expect(kernel.plugins.installedIds().length).toBe(COLLECTORS.length);

    const config = readerWith({ session_rate: 0.3, allow_users: [], rules: [] });
    const signal = teardownForSampledOutSession(kernel, config);

    expect(signal?.reason).toBe('sampled_out_session');
    for (const id of COLLECTORS) {
      expect(kernel.plugins.isInstalled(id), `${id} 应被卸载`).toBe(false);
    }
    expect(target.ping()).toBe('original');
  });

  it('C03-AC-15 未命中会话的 normal 事件计 sampled_out_session；critical 仍可上报（sample_rate 1）', () => {
    const config = readerWith({ session_rate: 0.3, allow_users: [], rules: [] });
    const kernel = createKernel({ target: null });
    const session = createSessionSampling({ config, random: () => 0.99, storage: memoryStore(), storeKey: 'teardown-1' });
    const dispose = createSamplingProcessor({ kernel, config, session, random: () => 0.99 });
    expect(kernel.pipeline.size('sample')).toBeGreaterThanOrEqual(1);

    const normal = kernel.pipeline.process({ event_name: 'page_view', priority: 'normal', occurred_at: 1 });
    expect(normal.status).toBe('stopped');
    expect(normal.reason).toBe('sampled_out_session');
    expect(kernel.counters.get('sampled_out_session')).toBeGreaterThan(0);

    const critical = kernel.pipeline.process({ event_name: 'order_paid', priority: 'critical', occurred_at: 1 });
    expect(critical.status).toBe('processed');
    expect(critical.event['sample_rate']).toBe(1);

    dispose();
  });
});
