/**
 * C07-AC-17 / AC-18 多标签页选主。
 *
 * POC-1 实测口径：**丢失率与选主方式无关，选主只控制重复流量**；
 * BroadcastChannel 必须有 settle 窗口（0 ms 会退化到 ≈不选主）。
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_LOCK_NAME,
  MIN_SETTLE_MS,
  createDefaultBroadcastPort,
  createDefaultLocksPort,
  createLeaderElection,
} from './leader';
import type { BroadcastChannelLike, BroadcastPort, LocksPort } from './leader';

/** 替身一次 `LockManager.request` 调用的观测记录。 */
interface RequestRecord {
  /** 调用时的接收者（`this`）；Web IDL 方法要求它必须是 `LockManager` 本体。 */
  readonly receiver: unknown;
  readonly name: string;
  readonly options: unknown;
}

/** 符合 Web Locks 形状的替身：立即授予锁，并记录接收者。 */
function installFakeLockManager(): { readonly records: RequestRecord[] } {
  let granted: unknown = null;
  const records: RequestRecord[] = [];
  const manager = {
    request(
      this: unknown,
      name: string,
      options: unknown,
      callback: (lock: unknown) => Promise<boolean>,
    ): Promise<boolean> {
      records.push({ receiver: this, name, options });
      granted = { name };
      try {
        return callback(granted);
      } finally {
        granted = null;
      }
    },
  };
  // happy-dom 的 `navigator.locks` 是原型上的 getter（返回 null）：在实例上盖一层，
  // 测完删除，不污染其他用例。浏览器/测试环境里 `navigator` 本体总是存在。
  const navigatorRef = globalThis.navigator as unknown as Record<string, unknown>;
  Object.defineProperty(navigatorRef, 'locks', {
    value: manager,
    configurable: true,
    writable: true,
  });
  afterEach(() => {
    delete navigatorRef['locks'];
  });
  return { records };
}

/** 进程内假总线（happy-dom 的 BroadcastChannel 不跨实例投递，必须自建）。 */
function createBus(): BroadcastPort {
  const channels: {
    readonly name: string;
    readonly listeners: Set<(event: { data: unknown }) => void>;
  }[] = [];
  return {
    open(name: string): BroadcastChannelLike | null {
      const entry = { name, listeners: new Set<(event: { data: unknown }) => void>() };
      channels.push(entry);
      return {
        postMessage(message: unknown): void {
          for (const target of channels) {
            if (target.name !== name) continue;
            for (const listener of target.listeners) listener({ data: message });
          }
        },
        addEventListener(_type, listener): void {
          entry.listeners.add(listener);
        },
        removeEventListener(_type, listener): void {
          entry.listeners.delete(listener);
        },
        close(): void {
          entry.listeners.clear();
        },
      };
    },
  };
}

/** 假 Web Locks：同一时刻只允许一个持有者。 */
function createMutexLocks(): LocksPort {
  let held = false;
  return {
    async tryAcquire(_name: string, task: () => Promise<void>): Promise<boolean> {
      if (held) return false;
      held = true;
      try {
        await task();
        return true;
      } finally {
        held = false;
      }
    },
  };
}

const immediateSleep = (): Promise<void> => Promise.resolve();

describe('C07-AC-17/18 选主', () => {
  test('AC-17 Web Locks 优先：3 个标签页只有一个当选并补发', async () => {
    const locks = createMutexLocks();
    const elections = [1, 2, 3].map((index) =>
      createLeaderElection({ locks, tabId: `tab-${String(index)}`, sleep: immediateSleep }),
    );
    const leaders: boolean[] = [];
    await Promise.all(
      elections.map(async (election) => {
        const outcome = await election.run(() => Promise.resolve());
        leaders.push(outcome.leader);
      }),
    );
    expect(leaders.filter((value) => value)).toHaveLength(1);
    expect(elections[0]?.mode()).toBe('locks');
  });

  test('AC-17 主标签页释放后另一个接替（下一轮重新竞争）', async () => {
    const locks = createMutexLocks();
    const first = createLeaderElection({ locks, tabId: 'tab-1', sleep: immediateSleep });
    const second = createLeaderElection({ locks, tabId: 'tab-2', sleep: immediateSleep });
    const leading: { value: string | null } = { value: null };
    await first.run(() => {
      leading.value = 'tab-1';
      return Promise.resolve();
    });
    expect(leading.value).toBe('tab-1');
    // 第一轮结束后锁已释放：另一个标签页在下一轮接管
    await second.run(() => {
      leading.value = 'tab-2';
      return Promise.resolve();
    });
    expect(leading.value).toBe('tab-2');
  });

  test('AC-18 不支持 Web Locks：降级 BroadcastChannel，settle ≥50 ms 时只有一个当选', async () => {
    const bus = createBus();
    const elections = [1, 2, 3].map((index) =>
      createLeaderElection({
        broadcast: bus,
        tabId: `tab-${String(index)}`,
        settleMs: 0,
        sleep: immediateSleep,
      }),
    );
    const leaders: boolean[] = [];
    await Promise.all(
      elections.map(async (election) => {
        const outcome = await election.run(() => Promise.resolve());
        leaders.push(outcome.leader);
      }),
    );
    expect(leaders.filter((value) => value)).toHaveLength(1);
    expect(elections[0]?.mode()).toBe('broadcast');
  });

  test('AC-18 settle 下界强制：两轮 claim，每轮都等待 ≥50 ms（合计 ≥100 ms）', async () => {
    const waits: number[] = [];
    const election = createLeaderElection({
      broadcast: createBus(),
      tabId: 'tab-1',
      settleMs: 0,
      sleep: (ms: number): Promise<void> => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await election.run(() => Promise.resolve());
    // 两轮 claim：第一轮让已打开通道的标签页互相看到；第二轮让"晚加入"的标签页也能看到。
    // 两轮之间**没有额外延迟**（第二轮紧跟第一轮 settle 之后立即广播）。
    expect(waits).toHaveLength(2);
    expect(waits.every((value) => value >= MIN_SETTLE_MS)).toBe(true);
    expect(waits.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(2 * MIN_SETTLE_MS);
  });

  test('AC-18 Web Locks 与 BroadcastChannel 都不支持：各自补发（不阻塞、不丢数据）', async () => {
    const elections = [1, 2, 3].map((index) =>
      createLeaderElection({ tabId: `tab-${String(index)}`, sleep: immediateSleep }),
    );
    const leaders: boolean[] = [];
    await Promise.all(
      elections.map(async (election) => {
        const outcome = await election.run(() => Promise.resolve());
        leaders.push(outcome.leader);
      }),
    );
    // 三级兜底：都补发，靠接收方 RR-05 去重
    expect(leaders).toEqual([true, true, true]);
    expect(elections[0]?.mode()).toBe('none');
  });

  test('默认端口：happy-dom 无 Web Locks（null）但有 BroadcastChannel', () => {
    // happy-dom 的 navigator.locks 是 null（源码 get locks() { return null }）
    expect(createDefaultLocksPort()).toBeNull();
    const port = createDefaultBroadcastPort();
    expect(port).not.toBeNull();
    const channel = port?.open('wr-test-channel');
    expect(channel).not.toBeNull();
    channel?.close();
  });

  test('默认 Web Locks 端口：以 LockManager 为接收者调用 request（真浏览器拒绝裸调用）', async () => {
    const fake = installFakeLockManager();
    const port = createDefaultLocksPort();
    expect(port).not.toBeNull();

    let taskRan = 0;
    const acquired = await port?.tryAcquire(DEFAULT_LOCK_NAME, () => {
      taskRan += 1;
      return Promise.resolve();
    });

    expect(acquired).toBe(true);
    expect(taskRan).toBe(1);
    expect(fake.records).toHaveLength(1);
    const record = fake.records[0];
    if (record === undefined) throw new Error('没有记录到 request 调用');
    // 关键断言：接收者必须是那个 LockManager 本体（裸调用时 `this` 是 undefined/globalThis）。
    expect(record.receiver).toBe(globalThis.navigator.locks);
    expect(record.receiver).not.toBeUndefined();
    expect(record.receiver).not.toBe(globalThis);
    expect(record.name).toBe(DEFAULT_LOCK_NAME);
    expect(record.options).toEqual({ mode: 'exclusive', ifAvailable: true });
  });

  test('BC 端口 open 返回 null 时退化为各自补发', async () => {
    const election = createLeaderElection({
      broadcast: { open: () => null },
      tabId: 'tab-1',
      sleep: immediateSleep,
    });
    const outcome = await election.run(() => Promise.resolve());
    expect(outcome.leader).toBe(true);
    expect(outcome.mode).toBe('none');
  });

  test('忽略非法 claim 消息（不做类型断言崩溃）', async () => {
    const bus = createBus();
    const election = createLeaderElection({
      broadcast: bus,
      tabId: 'tab-1',
      sleep: immediateSleep,
    });
    const intruder = bus.open('web-report-sdk:leader');
    intruder?.postMessage({ type: 'claim', ts: 'not-a-number', id: 42 });
    intruder?.postMessage(null);
    intruder?.postMessage({ type: 'other' });
    const outcome = await election.run(() => Promise.resolve());
    expect(outcome.leader).toBe(true);
    intruder?.close();
  });

  test('锁被占用时不当选（tryAcquire 返回 false）', async () => {
    const locks: LocksPort = {
      tryAcquire: () => Promise.resolve(false),
    };
    const election = createLeaderElection({ locks, tabId: 'tab-1', sleep: immediateSleep });
    const outcome = await election.run(() => Promise.resolve());
    expect(outcome.leader).toBe(false);
    expect(outcome.result).toBeUndefined();
    expect(election.lastLeader()).toBe(false);
    expect(election.mode()).toBe('locks');
  });
});
