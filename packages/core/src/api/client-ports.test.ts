/**
 * 三处 core 缺陷修复的用例（2026-10-13 负责人批准，T18 装配根暴露的问题）：
 *
 * 1. `init` 的 `appId` 没有进入批次头（`api/client.ts` 把 `appId: ''` 写死给
 *    `createBatchHeaderProvider`），而批次 Schema 要求 `app_id` 非空；
 * 2. `ErasePort` 是死类型：`context/ports.ts` 声明了它，但全库没有注入点、也没有调用点，
 *    于是「撤回同意后清除 deviceId/离线数据/会话随机数」根本不工作（T31 对应验收项无法通过）；
 * 3. `ContextStoragePort` 没有注入点（core README §29 声称的装配面不存在），
 *    装配根无法注入持久化存储——默认仍必须是内存（负责人 2026-10-13 裁定不改）。
 *
 * 另含 `BATCH_HEADER_CAPABILITY` 从公共面导出（装配根此前只能用字面量）。
 */
import { describe, expect, it } from 'vitest';

import { BATCH_HEADER_CAPABILITY, createClient } from './client';
import type { C04BatchHeader } from '../context';
import type { ContextStoragePort, ErasePort } from '../context';
import type { Kernel } from '../kernel';

/** 读取 C04 的批次头 provider（内核能力 `sdk.batch_header`）。 */
function headerOf(client: { readonly kernel: Kernel }): () => C04BatchHeader {
  const capability = client.kernel.getCapability(BATCH_HEADER_CAPABILITY);
  expect(typeof capability).toBe('function');
  return capability as () => C04BatchHeader;
}

/** 记录读写的注入式存储端口（替代默认的内存实现）。 */
function createRecordingStorage(initial: Readonly<Record<string, string>> = {}): {
  readonly storage: ContextStoragePort;
  readonly values: Map<string, string>;
  readonly writes: string[];
  readonly reads: string[];
} {
  const values = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const reads: string[] = [];
  return {
    values,
    writes,
    reads,
    storage: {
      read(key: string): string | undefined {
        reads.push(key);
        return values.get(key);
      },
      write(key: string, value: string): void {
        writes.push(key);
        values.set(key, value);
      },
      remove(key: string): void {
        values.delete(key);
      },
    },
  };
}

describe('缺陷 1：init 的 appId 必须进入批次头', () => {
  it('createClient({ appId }) + init 后 header().app_id 非空且等于 appId', () => {
    const client = createClient();
    client.init({ appId: 'app-1' });
    expect(headerOf(client)().app_id).toBe('app-1');
  });

  it('构造时就传 appId（含 init 覆盖）也进入批次头', () => {
    const client = createClient({ appId: 'app-ctor' });
    client.init({ appId: 'app-init' });
    expect(headerOf(client)().app_id).toBe('app-init');
  });

  it('未 init 时 app_id 为空串（尚未有应用标识），init 后立即变为非空', () => {
    const client = createClient();
    expect(headerOf(client)().app_id).toBe('');
    client.init({ appId: 'app-late' });
    expect(headerOf(client)().app_id).toBe('app-late');
  });
});

describe('缺陷 2：ErasePort 的真实注入点与调用点', () => {
  it('setConsent(denied) 依次触发 deviceId / offlineData / sessionRandom', () => {
    const calls: string[] = [];
    const erase: ErasePort = {
      deviceId: (): void => {
        calls.push('deviceId');
      },
      offlineData: (): void => {
        calls.push('offlineData');
      },
      sessionRandom: (): void => {
        calls.push('sessionRandom');
      },
    };
    const client = createClient({ erase });
    client.init({ appId: 'app-1', consent: 'granted' });

    client.setConsent('denied');
    expect(calls).toEqual(['deviceId', 'offlineData', 'sessionRandom']);
  });

  it('非 denied 的同意变化不触发清理', () => {
    const calls: string[] = [];
    const client = createClient({
      erase: {
        offlineData: (): void => {
          calls.push('offlineData');
        },
      },
    });
    client.init({ appId: 'app-1', consent: 'unknown' });
    client.setConsent('granted');
    client.setConsent('buffer');
    expect(calls).toEqual([]);
  });

  it('未注入 ErasePort 时 denied 仍不抛错（只做 C04 自己的清除）', () => {
    const client = createClient();
    client.init({ appId: 'app-1', consent: 'granted' });
    expect(() => {
      client.setConsent('denied');
    }).not.toThrow();
  });
});

describe('缺陷 3：ContextStoragePort 的注入点（默认仍是内存）', () => {
  it('授权后把设备标识写入注入的存储，并从注入的存储读回已有标识', () => {
    const recorder = createRecordingStorage({ wr_device_id: 'device-existing' });
    const client = createClient({ storage: recorder.storage });
    client.init({ appId: 'app-1', consent: 'granted' });

    // 读回既有标识：证明注入的存储真的被 C04 使用，而不是被忽略。
    expect(headerOf(client)().device_id).toBe('device-existing');
    // 写路径：授权后设备标识落盘（已有标识也要补写）。
    expect(recorder.writes).toContain('wr_device_id');
  });

  it('未注入存储时行为不变（不抛错、仍能产出批次头）', () => {
    const client = createClient();
    client.init({ appId: 'app-1', consent: 'granted' });
    const header = headerOf(client)();
    expect(header.app_id).toBe('app-1');
    expect(header.device_id.length).toBeGreaterThan(0);
  });
});

describe('缺陷 4：BATCH_HEADER_CAPABILITY 从公共面导出', () => {
  it('core 汇总入口导出该能力名常量', async () => {
    const core = await import('../index');
    expect(core.BATCH_HEADER_CAPABILITY).toBe('sdk.batch_header');
  });
});
