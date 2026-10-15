/**
 * C07-F7 多标签页协调：**Web Locks 优先**，BroadcastChannel 降级（settle 强制 ≥50 ms），
 * 两者都不支持时各自补发、靠接收方 RR-05 去重兜底。
 *
 * 关键性质（POC-1 实测）：**正确性不依赖选主**——选主只控制重复补发流量；
 * 三个引擎的 IndexedDB 并发写零覆盖，因此多标签页同时补发不会丢数据。
 */
import type { CountersPort } from '../queue/types';

export type LeaderMode = 'locks' | 'broadcast' | 'none';

export interface LeaderRunResult<T> {
  readonly leader: boolean;
  readonly mode: LeaderMode;
  readonly result: T | undefined;
}

/** 广播通道的最小能力（测试用假总线实现它）。 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface BroadcastPort {
  open(name: string): BroadcastChannelLike | null;
}

/** Web Locks 的最小能力：拿不到锁返回 false。 */
export interface LocksPort {
  tryAcquire(name: string, task: () => Promise<void>): Promise<boolean>;
}

export interface LeaderElectionOptions {
  readonly locks?: LocksPort | null | undefined;
  readonly broadcast?: BroadcastPort | null | undefined;
  /** settle 窗口；**钳到 ≥50 ms**（POC：0 ms 会退化到 ≈不选主）。 */
  readonly settleMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  /** 本标签页标识；缺省用随机值。 */
  readonly tabId?: string | undefined;
  readonly lockName?: string | undefined;
  readonly channelName?: string | undefined;
  readonly counters?: CountersPort | undefined;
}

export interface LeaderElection {
  /** 执行一轮"只有 leader 才做"的工作。 */
  run<T>(task: () => Promise<T>): Promise<LeaderRunResult<T>>;
  /** 最近一次选主使用的模式（观测用）。 */
  mode(): LeaderMode;
  /** 最近一次是否当选（观测用）。 */
  lastLeader(): boolean;
  /**
   * CR-008：本标签页**从 leader 变为非 leader**的累计次数（首轮即未当选不计）。
   * 契约指标名 `leader_lost`（观测量，不是原因码——POC-1 实测正确性不依赖选主）。
   */
  leaderLost(): number;
}

/** settle 窗口下界（D003/POC 强制；0 ms 不可用）。 */
export const MIN_SETTLE_MS = 50;

export const DEFAULT_LOCK_NAME = 'web-report-sdk:replay';
export const DEFAULT_CHANNEL_NAME = 'web-report-sdk:leader';

/** 默认 Web Locks 端口；环境不支持时返回 null。 */
export function createDefaultLocksPort(): LocksPort | null {
  const manager = (
    globalThis as {
      navigator?: {
        /** 真实环境里 `navigator.locks` 可能不存在；happy-dom 显式返回 `null`。 */
        locks?: {
          request?: (
            name: string,
            options: { mode: string; ifAvailable: boolean },
            callback: (lock: unknown) => Promise<boolean>,
          ) => Promise<boolean>;
        } | null;
      };
    }
  ).navigator?.locks;
  if (manager === undefined || manager === null) return null;
  const request: typeof manager.request = manager.request;
  if (request === undefined) return null;
  return {
    tryAcquire(name: string, task: () => Promise<void>): Promise<boolean> {
      // `LockManager.request` 是 Web IDL 方法：**必须带正确的接收者调用**。把它取出后裸调用
      // 会在真实浏览器抛 `TypeError: Illegal invocation`（Chromium/WebKit 都必现，见
      // `docs/reports/e2e-real-browser.md` D-2）。这里用 `call` 显式补上接收者。
      return request.call(manager, name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (lock === null || lock === undefined) return false;
        await task();
        return true;
      });
    },
  };
}

/** 默认 BroadcastChannel 端口；环境不支持时返回 null。 */
export function createDefaultBroadcastPort(): BroadcastPort | null {
  const ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
    .BroadcastChannel;
  if (typeof ctor !== 'function') return null;
  return {
    open(name: string): BroadcastChannelLike | null {
      try {
        return new ctor(name);
      } catch {
        return null;
      }
    },
  };
}

interface Claim {
  readonly type: 'claim';
  readonly ts: number;
  readonly id: string;
}

function isClaim(value: unknown): value is Claim {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['type'] === 'claim' &&
    typeof candidate['ts'] === 'number' &&
    typeof candidate['id'] === 'string'
  );
}

/** 谁的 claim 更优先：时间戳更早者优先，相同则 id 字典序更小者优先。 */
function isBetter(other: Claim, mine: Claim): boolean {
  if (other.ts !== mine.ts) return other.ts < mine.ts;
  return other.id < mine.id;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 创建选主器。 */
export function createLeaderElection(options: LeaderElectionOptions = {}): LeaderElection {
  const locks = options.locks ?? null;
  const broadcast = options.broadcast ?? null;
  const settleMs = Math.max(options.settleMs ?? MIN_SETTLE_MS, MIN_SETTLE_MS);
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, ms);
      }));
  const now = options.now ?? ((): number => Date.now());
  const tabId = options.tabId ?? randomId();
  const lockName = options.lockName ?? DEFAULT_LOCK_NAME;
  const channelName = options.channelName ?? DEFAULT_CHANNEL_NAME;
  let lastMode: LeaderMode = 'none';
  let lastWasLeader = false;
  // CR-008：观测量 `leader_lost`（累计）。首轮即未当选不算"失去"。
  let leaderLostTotal = 0;

  /** 每次 `run()` 结算选主结果时更新：从 leader 变非 leader 记 1 次。 */
  function settleLeader(wasLeader: boolean, isLeader: boolean): void {
    if (wasLeader && !isLeader) leaderLostTotal += 1;
    lastWasLeader = isLeader;
  }

  async function runWithBroadcast<T>(task: () => Promise<T>): Promise<LeaderRunResult<T>> {
    const channel = broadcast === null ? null : broadcast.open(channelName);
    if (channel === null) return { leader: true, mode: 'none', result: await task() };
    const mine: Claim = { type: 'claim', ts: now(), id: tabId };
    const state = { denied: false };
    const listener = (event: { data: unknown }): void => {
      const claim = event.data;
      if (!isClaim(claim) || claim.id === tabId) return;
      if (isBetter(claim, mine)) state.denied = true;
    };
    channel.addEventListener('message', listener);
    try {
      // 两轮 claim：第一轮让当前已打开通道的标签页互相看到；第二轮把 claim 再播一次，
      // 让"在第一轮之后才加入"的标签页也能看到（BroadcastChannel 没有历史消息，
      // 只播一次会让晚加入者误判自己当选）。每轮都等一个 settle 窗口。
      for (let round = 0; round < 2; round += 1) {
        channel.postMessage(mine);
        await sleep(settleMs);
      }
      if (state.denied) return { leader: false, mode: 'broadcast', result: undefined };
      return { leader: true, mode: 'broadcast', result: await task() };
    } finally {
      channel.removeEventListener('message', listener);
      channel.close();
    }
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<LeaderRunResult<T>> {
      if (locks !== null) {
        const holder: { value: T | undefined } = { value: undefined };
        const acquired = await locks.tryAcquire(lockName, async () => {
          holder.value = await task();
        });
        lastMode = 'locks';
        settleLeader(lastWasLeader, acquired);
        return { leader: acquired, mode: 'locks', result: acquired ? holder.value : undefined };
      }
      if (broadcast !== null) {
        const outcome = await runWithBroadcast(task);
        lastMode = outcome.mode;
        settleLeader(lastWasLeader, outcome.leader);
        return outcome;
      }
      lastMode = 'none';
      settleLeader(lastWasLeader, true);
      return { leader: true, mode: 'none', result: await task() };
    },

    mode(): LeaderMode {
      return lastMode;
    },

    lastLeader(): boolean {
      return lastWasLeader;
    },

    leaderLost(): number {
      return leaderLostTotal;
    },
  };
}
