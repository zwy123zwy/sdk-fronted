/**
 * T31 验收项（本文件）：**撤回同意后设备标识、离线数据、会话随机数被清除**。
 *
 * 为什么现在才可测：`ErasePort` 曾是死类型（`context/ports.ts` 声明了它，但全库无注入点、
 * 无调用点），「撤回同意后清除」从未真正发生，本项只能标「未验证」。2026-10-13 修复后
 * （`api/client.ts` 在 `setConsent('denied')` 时依次触发 `deviceId → offlineData →
 * sessionRandom`；`browser/assembly.ts` 把后两腿接到 `delivery.clearOffline()` 与
 * `config.resetSessionRandom()`），该项才可验证。
 *
 * 设计原则（与同目录 `t31-security.test.ts` 一致）：
 * 1. **用公开 API 触发撤回同意**（`client.setConsent('denied')`），不依赖内部函数；
 * 2. **断言「清除」而不是「调用了某个函数」**：优先观测值变化——设备标识从注入的持久化
 *    存储里消失、离线记录数 1→0（并用另一个索引同一数据库的离线存储复读，证明是落盘副本
 *    被清而不是只清了内存索引）、会话随机数换值；
 * 3. **三腿分用例**，任一腿失灵只让对应用例变红（变异验证结论见
 *    `docs/reports/security-draft.md` 的 1.3）。
 *
 * 本文件**只读实现代码，不修改任何实现**。样本只用格式合法的伪造数据（非真实个人信息）。
 *
 * 为什么要 import 构建产物而不是源码：与 `t31-security.test.ts` 同一理由——根 `tsconfig.json`
 * 的 `lib` 只有 `ES2022`（不含 DOM），import core/transport/browser 源码会把 DOM 类型拉进根编译
 * 程序。`pnpm gates` 的顺序是 build 在 test 之前，产物始终存在。
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';

import {
  BATCH_HEADER_CAPABILITY,
  DEVICE_ID_KEY,
  createClient,
  createConfigRuntime,
} from '../../packages/core/dist/index.js';
import type { C04BatchHeader, ConfigRuntime, ContextStoragePort } from '../../packages/core/dist/index.js';
import { createOfflineStore } from '../../packages/transport/dist/index.js';
import type { TransportPort, TransportResponse } from '../../packages/transport/dist/index.js';
import { createAssembly } from '../../packages/browser/dist/index.js';
import type { Assembly } from '../../packages/browser/dist/index.js';

/** 记录读写的注入式存储端口（替代默认的内存实现，用于观测设备标识是否真的被删除）。 */
function createRecordingStorage(): {
  readonly storage: ContextStoragePort;
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      read: (key: string): string | undefined => values.get(key),
      write: (key: string, value: string): void => {
        values.set(key, value);
      },
      remove: (key: string): void => {
        values.delete(key);
      },
    },
  };
}

/** 永不 resolve 的传输：让批次停留在离线存储里，便于观测「清除前确实有离线数据」。 */
function neverTransport(): TransportPort {
  return { send: (): Promise<TransportResponse> => new Promise<TransportResponse>(() => undefined) };
}

const assemblies: Assembly[] = [];

/** 按装配根的真实接线建一个实例并 init（`createAssembly` 自身不调用 `client.init()`）。 */
function buildAssembly(overrides: Partial<Parameters<typeof createAssembly>[0]> = {}): Assembly {
  const assembly = createAssembly({
    appId: 'app-t31',
    endpoint: 'https://collect.example/ingest',
    token: 'tok_t31_fixture',
    target: null,
    consent: 'granted',
    startHealthReporting: false,
    transport: neverTransport(),
    ...overrides,
  });
  assemblies.push(assembly);
  assembly.init();
  return assembly;
}

afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
});

/** 读取 C04 的批次头 provider（内核能力 `sdk.batch_header`，公共可观测面）。 */
function headerReader(assembly: Assembly): () => C04BatchHeader {
  const capability = assembly.kernel.getCapability(BATCH_HEADER_CAPABILITY);
  expect(typeof capability).toBe('function');
  return capability as () => C04BatchHeader;
}

/** 轮询等待异步收敛（离线清除是 fire-and-forget，没有可直接 await 的公共句柄）。 */
async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitForAsync 超时：被观测状态未收敛');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe('T31 撤回同意：生产接线端到端（createAssembly + client.setConsent("denied")）', () => {
  test('设备标识腿：C04 purge 后不再持久化，且已落盘的 device_id 被删除', () => {
    const recorder = createRecordingStorage();
    const assembly = buildAssembly({ storage: recorder.storage });
    const header = headerReader(assembly);

    const before = header();
    expect(before.device_id.length).toBeGreaterThan(0);
    expect(before.device_id_persistent).toBe(true);
    expect(recorder.values.has(DEVICE_ID_KEY)).toBe(true);

    // 公开 API 触发撤回同意。
    assembly.client.setConsent('denied');

    // 值变化（不是「调用过某函数」）：落盘的设备标识被删除，且旧值不再出现在存储里。
    expect(recorder.values.has(DEVICE_ID_KEY)).toBe(false);
    expect([...recorder.values.values()]).not.toContain(before.device_id);
    const after = header();
    expect(after.device_id_persistent).toBe(false);
    expect(after.device_id).not.toBe(before.device_id);
  });

  test('离线数据腿：C07 clearOffline 把离线记录真正从落盘副本里清掉', async () => {
    const assembly = buildAssembly();

    // 先制造一条真实的离线记录：critical 事件入队 → 传输永不 resolve → 预写副本留在离线存储
    // （C07 只对含 critical 事件的批次预写，见 `sender/delivery.ts`）。
    assembly.client.track('t31_offline_probe', {
      priority: 'critical',
      dimensions: { probe: 'withdrawal' },
    });
    await waitForAsync(async () => {
      assembly.flush();
      await assembly.delivery.offline.drain();
      return assembly.delivery.offline.stats().storedBatches >= 1;
    });
    expect(assembly.delivery.offline.stats().storedBatches).toBeGreaterThanOrEqual(1);

    assembly.client.setConsent('denied');

    expect(assembly.delivery.offline.stats().storedBatches).toBe(0);
    expect(assembly.delivery.offline.stats().storedEvents).toBe(0);

    // 后端级证据：另开一个索引同一 IndexedDB 的离线存储复读；若只清了内存索引而没清落盘
    // 副本，这里仍会读到记录。落盘副本的删除是异步的，因此轮询等待收敛。
    const reopened = createOfflineStore({ appId: 'app-t31', sessionId: 'session-t31-probe' });
    try {
      await reopened.ready();
      await waitForAsync(async () => (await reopened.list(10)).length === 0);
      expect(await reopened.list(10)).toEqual([]);
    } finally {
      reopened.dispose();
    }
  });

  test('会话随机数腿：C03 resetSessionRandom 后换值，且重复读取稳定', () => {
    const assembly = buildAssembly();
    // 装配根构造 C03 时传 `sessionRandom: 0`。
    const before = assembly.config.sessionRandom();
    expect(before).toBe(0);

    assembly.client.setConsent('denied');

    const after = assembly.config.sessionRandom();
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThan(1);
    expect(after).not.toBe(before);
    // 「清除」= 重新生成而不是每次读取都重掷。
    expect(assembly.config.sessionRandom()).toBe(after);
  });
});

describe('T31 撤回同意：会话随机数（注入确定性随机源，观测调用次数与语义变化）', () => {
  test('denied 触发一次重置并换值；granted/buffer 不触发重置', () => {
    const resets: number[] = [];
    let resetTarget = (): void => undefined;
    const client = createClient({
      erase: {
        sessionRandom: (): void => {
          resets.push(1);
          resetTarget();
        },
      },
    });
    const config: ConfigRuntime = createConfigRuntime({
      kernel: client.kernel,
      appId: 'app-t31',
      env: 'test',
      configEndpoint: 'https://config.example/ingest',
      sdkVersion: '0.0.0',
      publicKeys: {},
      consentMode: undefined,
      sessionRandom: 0.05,
      // 确定性随机源：重置值可预期（0.05 是构造值，0.95 是重置后值）。
      random: () => 0.95,
    });
    resetTarget = (): void => {
      config.resetSessionRandom();
    };
    client.init({ appId: 'app-t31', consent: 'granted' });

    expect(config.sessionRandom()).toBe(0.05);

    // 负向对照：非 denied 的同意变化不得触发清除（防止「一撤就全清」的过度清除）。
    client.setConsent('buffer');
    client.setConsent('granted');
    expect(resets).toHaveLength(0);
    expect(config.sessionRandom()).toBe(0.05);

    client.setConsent('denied');
    // 调用次数与前后语义变化同时断言：恰好一次，且值从 0.05 变为 0.95。
    expect(resets).toHaveLength(1);
    expect(config.sessionRandom()).toBe(0.95);
    expect(config.sessionRandom()).toBe(0.95);
  });
});
