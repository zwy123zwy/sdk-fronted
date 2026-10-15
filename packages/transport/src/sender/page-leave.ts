/**
 * C07-F1 / C07-F5 的页面离开通道（信标为主、`fetch keepalive` 为备 + 显式预算）。
 *
 * POC-1 的实测教训（**不得违反**）：
 * - `sendBeacon` 没有响应通道，返回 `true` 只表示"浏览器接受了请求"；
 * - `fetch keepalive` 的 Promise 在页面销毁时会被丢弃（Chromium/Firefox 全部 reject）。
 * 因此本模块**从不把任何信号当作"已送达"**，离线副本只由常规通道的 202 删除（AC-13）。
 *
 * AC-03 第 3 步的修复（依据 `docs/reports/e2e-real-browser.md` 追加节第 2 次的真机实测）：
 * 1. **按同步回合约束累计写入**：瓶颈不是单请求（60 KB 上限）而是浏览器**同一同步回合的
 *    累计在途额度**（实测 ∈ [65536, 86016) B）。`turnBytes` 计本回合已写入的真实正文体积，
 *    再写一片就会超 `BEACON_INFLIGHT_BYTES` 时把该片**与后续片**（保序）交给 `schedule`，
 *    让出主线程后在新任务里继续写；
 * 2. **估算器校准**：改用 `beacon-size.ts` 的校准口径（数字按 `String(value).length`），
 *    单事件 743 B 实测 → 745 B 估算（旧口径 923 B，高估 24%），80 KB 由 4 片回到 3 片；
 * 3. **默认让出真的生效**：未注入 `schedule` 时缺省是**宏任务**（`setTimeout(…, 0)`）——
 *    微任务仍在同一任务里、额度不重置（实测 `sync-32x32x32 → [true,true,false]` 对
 *    `delay0-21x4 → [true,true,true,true]`）；
 * 4. **丢失必须自报**：被 `sendBeacon` 拒绝的整片事件计入 `skipped`（不再计 `sent`）并记一次
 *    `budgetStops`（CR-008 的 `flush_skipped_due_to_budget` 出口）；`dispose()` /
 *    `resetBudget()` 丢掉待发片同样计入 `skipped`。**不新增字段、不改指标名**。
 *
 * 「让出 vs 离页同步语义」的权衡（见 `LeaveSenderOptions.schedule`）：第一个回合仍然
 * **同步写完**（实测被接受的额度内），只有超出该额度的尾部才被推到下一个任务；旧实现把尾部
 * 也同步写出去，结果是被浏览器拒绝后静默丢弃——同步性在那里并没有换来送达。若页面在下一个
 * 任务前就销毁，尾部事件计入 `skipped`（可见），不再谎报成 `sent`。
 */
import type { BatchEnvelope, QueueEvent } from '../batch/types';
import type { CountersPort } from '../queue/types';
import { estimateBeaconEventBytes } from './beacon-size';
import {
  BEACON_INFLIGHT_BYTES,
  BEACON_SLICE_BYTES,
  LEAVE_BUDGET,
  REASON_RETRY_NETWORK,
} from './constants';
import { createBeaconSender } from './native';
import type { CredentialsPort, CredentialsSnapshot, NativeHttpRefs, TransportPort } from './types';

export interface LeaveBudget {
  readonly maxBytes: number;
  readonly maxEvents: number;
  readonly maxBatches: number;
  readonly maxMs: number;
}

export interface LeaveSendResult {
  /** 只表示"浏览器接受了信标请求"，**不是送达**。 */
  readonly accepted: boolean;
  readonly requests: number;
  readonly skippedEvents: number;
  readonly bytes: number;
}

/**
 * 离开通道的观测量。
 *
 * **单位口径**：`sent` / `skipped` 是**事件数**；`requests` 是**信标/fetch 请求数**；
 * `bytes` 是**累计写入的估算体积**（UTF-16 码元数）；`budgetStops` 是**次数**
 * （CR-008：离开 burst 内首次因预算/浏览器额度用尽而停手的次数）。全部是内部观测量，
 * 其中只有 `budgetStops` 有契约指标名（`flush_skipped_due_to_budget`）。
 *
 * **对账不变量（AC-03 第 3 步）**：`sent + skipped + 待发波次内的事件数 = 提交的事件数`。
 * `sent` 只计**浏览器接受了信标请求**的片；被拒的片、被预算拦下的片、`dispose()`
 * 丢弃的待发片都进 `skipped`（可观测），因此 `sent + skipped` 永远对得上总数。
 */
export interface LeaveStats {
  /** 事件数（仅计浏览器**接受**的片）。 */
  readonly sent: number;
  /** 事件数（预算拦下 / 浏览器拒绝 / 待发波次被丢弃）。 */
  readonly skipped: number;
  /** 累计写入的估算体积（UTF-16 码元数）。 */
  readonly bytes: number;
  /** 信标 / fetch keepalive 请求数（含被浏览器拒绝的尝试）。 */
  readonly requests: number;
  /**
   * CR-008：离开 burst 内**首次**因预算（字节 / 条数 / 批数 / 时间窗）或浏览器累计额度
   * 用尽而**停手**的次数；同一 burst 内后续被跳过的切片不重复计数。它是**次数**，
   * 不是被跳过的事件数（事件数见 `skipped`）。burst 以 `resetBudget()` 划界。
   */
  readonly budgetStops: number;
}

export interface LeaveSenderOptions {
  readonly credentials: CredentialsPort;
  readonly http?: NativeHttpRefs | undefined;
  readonly transport: TransportPort;
  readonly counters?: CountersPort | undefined;
  readonly now?: (() => number) | undefined;
  readonly budget?: Partial<LeaveBudget> | undefined;
  /**
   * 波次调度钩子（AC-03 第 3 步）：一个同步回合写入的累计体积再增加一片就会超过
   * `BEACON_INFLIGHT_BYTES` 时，实现把剩余写入交给它，让出主线程后再继续。
   *
   * **缺省是真实让出**：`setTimeout(flush, 0)`（新**任务**）。为什么必须跨任务：浏览器按
   * 同一同步回合累计在途量计额度，实测 `sync-32x32x32 → [true,true,false]` 而
   * `delay0-21x4` / `raf-28x28x28` 全被接受——只有新的任务边界才会重置额度，微任务不行。
   *
   * **离页语义的权衡**：`send()` 本身仍然同步把**第一个回合**写满（实测被接受的额度内），
   * 只有超出额度的尾部才被让出。旧实现把尾部也同步写出去，换来的是浏览器拒绝 + 静默丢弃，
   * 同步性并未换来送达；让出后若页面已销毁，尾部会计入 `skipped`（可见），不会谎报成 `sent`。
   * 显式传 `schedule` 的装配层（测试 / 浏览器）负责决定"让出"的实现。
   */
  readonly schedule?: ((flush: () => void) => void) | undefined;
}

export interface LeaveSender {
  send(batch: BatchEnvelope): LeaveSendResult;
  /** 新的离开事件（burst）开始时重置预算。 */
  resetBudget(): void;
  stats(): LeaveStats;
  /** 离开路径结束：作废所有待发波次，之后的 `send()` 不再发出任何请求。 */
  dispose(): void;
}

const noopCounters: CountersPort = { count: (): void => undefined };

/** 一片已备好正文的待发写入（被让出时原样保存，保序发出）。 */
interface PendingWrite {
  readonly endpoint: string;
  readonly appId: string;
  readonly writeToken: string;
  readonly events: readonly QueueEvent[];
  readonly batchId: string;
  readonly body: string;
  readonly bytes: number;
}

function createUuid(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } | undefined }).crypto;
  if (cryptoRef?.randomUUID !== undefined) {
    try {
      return cryptoRef.randomUUID();
    } catch {
      // 落到兜底实现
    }
  }
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      out += '-';
      continue;
    }
    if (index === 14) {
      out += '4';
      continue;
    }
    if (index === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)] ?? '8';
      continue;
    }
    out += hex[Math.floor(Math.random() * 16)] ?? '0';
  }
  return out;
}

/**
 * 按信标体积上限切片（每片 ≤ `maxBytes`；`event_id` 不变，`batch_id` 重新生成）。
 *
 * AC-03 第 3 步：`maxBytes` 约束的是**整片 JSON**（契约的 60 KB 是请求体上限），因此先把
 * 批次头（含空 `events` 数组）的体积扣掉，再用**校准后**的单事件估算切分。
 */
export function sliceForBeacon(batch: BatchEnvelope, maxBytes: number): readonly BatchEnvelope[] {
  // 批次头（含 `"events":[]`）的固定体积：片正文 = 它 + 事件数组文本 - 2（`[]` 被数组内容替换）。
  const envelopeBytes = JSON.stringify({ ...batch, events: [] }).length;
  const eventsBudget = maxBytes - envelopeBytes;
  const groups: QueueEvent[][] = [];
  let current: QueueEvent[] = [];
  let size = 0;
  for (const event of batch.events) {
    const bytes = estimateBeaconEventBytes(event) + 2;
    if (current.length > 0 && size + bytes > eventsBudget) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(event);
    size += bytes;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) return [batch];
  if (groups.length === 1) return [batch];
  return groups.map((events) => ({ ...batch, batch_id: createUuid(), events }));
}

/**
 * 按剩余预算取**最长可发前缀**（空表示一条都装不下）。
 *
 * `bytesOf` 是单事件的校准估算；这里另加方括号（2）与每个成员的分隔逗号（1），
 * 得到事件数组文本长度的上界。
 */
function packPrefix(
  events: readonly QueueEvent[],
  bytesOf: (event: QueueEvent) => number,
  limit: number,
): readonly QueueEvent[] {
  const packed: QueueEvent[] = [];
  let size = 2;
  for (const event of events) {
    const next = bytesOf(event) + 1;
    if (size + next > limit) break;
    packed.push(event);
    size += next;
  }
  return packed;
}

/** 候选片正文的 `batch_id` 占位符（与真实 UUID 同长，用于二次切片时精确估体积）。 */
const CANDIDATE_BATCH_ID = '00000000-0000-4000-8000-000000000000';

/** 创建页面离开发送器。 */
export function createLeaveSender(options: LeaveSenderOptions): LeaveSender {
  const counters = options.counters ?? noopCounters;
  const now = options.now ?? ((): number => Date.now());
  const budget: LeaveBudget = { ...LEAVE_BUDGET, ...options.budget };
  const beacon = createBeaconSender(options.http ?? {});
  // 缺省让出 = **新任务**（宏任务）。微任务仍属同一任务，浏览器不会重置累计额度。
  const schedule: (flush: () => void) => void =
    options.schedule ??
    ((flush: () => void): void => {
      globalThis.setTimeout(flush, 0);
    });
  let burstStartedAt = 0;
  let usedBatches = 0;
  let usedEvents = 0;
  let usedBytes = 0;
  let sentTotal = 0;
  let skippedTotal = 0;
  let requestsTotal = 0;
  let bytesTotal = 0;
  // CR-008：burst 内首次因预算用尽而停手记 1 次；同一 burst 内不重复计数。
  let budgetStopsTotal = 0;
  let budgetStopCounted = false;
  /** 当前同步回合已写入的**真实正文体积**（浏览器按同一回合的累计在途量计额度）。 */
  let turnBytes = 0;
  /** 被让出到后续同步回合的片（保序）。 */
  let pending: PendingWrite[] = [];
  let flushScheduled = false;
  let disposed = false;

  function noteBudgetStop(): void {
    if (budgetStopCounted) return;
    budgetStopCounted = true;
    budgetStopsTotal += 1;
  }

  function exhausted(): boolean {
    return (
      usedBatches >= budget.maxBatches ||
      usedEvents >= budget.maxEvents ||
      usedBytes >= budget.maxBytes ||
      now() - burstStartedAt > budget.maxMs
    );
  }

  /** 丢弃一批待发/未发的片：事件数必须进 `skipped`，并记一次预算停手。 */
  function dropWrites(writes: readonly PendingWrite[]): void {
    if (writes.length === 0) return;
    for (const write of writes) skippedTotal += write.events.length;
    noteBudgetStop();
  }

  /**
   * 真正写出一片。被 `sendBeacon` 拒绝时**不重试、不再切**（与真机口径一致），但事件必须
   * 计入 `skipped` 并记一次预算停手——真机实测的 35 条丢失正是从这里溜走的。
   */
  function write(item: PendingWrite): boolean {
    requestsTotal += 1;
    usedBatches += 1;
    usedBytes += item.bytes;
    bytesTotal += item.bytes;
    turnBytes += item.bytes;
    if (beacon !== null) {
      const accepted = beacon(
        item.endpoint,
        new Blob([item.body], { type: 'text/plain;charset=UTF-8' }),
      );
      if (accepted) {
        usedEvents += item.events.length;
        sentTotal += item.events.length;
      } else {
        counters.count(REASON_RETRY_NETWORK);
        skippedTotal += item.events.length;
        noteBudgetStop();
      }
      return accepted;
    }
    // 备选：fetch keepalive。**忽略 Promise 结果**（页面销毁时不可信）。
    void options.transport
      .send({
        url: item.endpoint,
        headers: {
          'content-type': 'application/json',
          'x-app-id': item.appId,
          'x-write-token': item.writeToken,
          'x-request-id': item.batchId,
          'x-beacon-fallback': 'keepalive',
        },
        body: item.body,
        bodyBytes: undefined,
        keepalive: true,
        timeoutMs: 5_000,
      })
      .catch(() => {
        counters.count(REASON_RETRY_NETWORK);
      });
    // 没有返回值可用：按"已交给浏览器"计（与修复前一致），但 `accepted` 仍为 false。
    usedEvents += item.events.length;
    sentTotal += item.events.length;
    return false;
  }

  function scheduleFlush(): void {
    if (flushScheduled || disposed) return;
    flushScheduled = true;
    schedule(() => {
      flushPending();
    });
  }

  /** 新的同步回合：把让出的片按序写完；装不下的继续让出。 */
  function flushPending(): void {
    flushScheduled = false;
    if (disposed || pending.length === 0) return;
    const queue = pending;
    pending = [];
    turnBytes = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (item === undefined) continue;
      if (exhausted()) {
        dropWrites(queue.slice(index));
        return;
      }
      if (usedBytes + item.bytes > budget.maxBytes) {
        // 让出期间预算已被前面的片吃掉：尾部同样必须计入 skipped（不静默丢）。
        dropWrites(queue.slice(index));
        return;
      }
      if (turnBytes > 0 && turnBytes + item.bytes > BEACON_INFLIGHT_BYTES) {
        pending = queue.slice(index);
        scheduleFlush();
        return;
      }
      write(item);
    }
  }

  return {
    resetBudget(): void {
      // 上一 burst 里被让出、还没写出去的片不能跨 burst 静默消失：计入 skipped 并记停手。
      const stale = pending;
      pending = [];
      dropWrites(stale);
      burstStartedAt = now();
      usedBatches = 0;
      usedEvents = 0;
      usedBytes = 0;
      budgetStopCounted = false;
    },

    send(batch: BatchEnvelope): LeaveSendResult {
      if (disposed) {
        skippedTotal += batch.events.length;
        return { accepted: false, requests: 0, skippedEvents: batch.events.length, bytes: 0 };
      }
      const credentials = options.credentials.current();
      if (credentials === null) {
        skippedTotal += batch.events.length;
        return { accepted: false, requests: 0, skippedEvents: batch.events.length, bytes: 0 };
      }
      // 绑定成非空常量：`write()` 是函数声明，控制流收窄不会带进它的函数体。
      const creds: CredentialsSnapshot = credentials;
      if (burstStartedAt === 0) burstStartedAt = now();
      const slices = sliceForBeacon(batch, BEACON_SLICE_BYTES);
      /** 片正文；`batch_id` 每片重新生成（`sliceForBeacon` 的既有口径）。 */
      const bodyOf = (events: readonly QueueEvent[], batchId: string): string =>
        JSON.stringify({
          ...batch,
          batch_id: batchId,
          events,
          auth: { app_id: creds.appId, write_token: creds.writeToken },
        });
      /** 批次头 + auth 的固定开销（预算判断里必须扣掉它）。 */
      const fixedBodyBytes = bodyOf([], CANDIDATE_BATCH_ID).length;
      let accepted = false;
      let requests = 0;
      let skipped = 0;
      // 本回合额度已满 → 本片与后续片一起让出（保序）。
      let deferring = false;

      /** 从第 `from` 片起（含）还未发出的事件数：停手时必须**全部**计入 `skipped`。 */
      const remainingEvents = (from: number): number => {
        let total = 0;
        for (let index = from; index < slices.length; index += 1) {
          total += slices[index]?.events.length ?? 0;
        }
        return total;
      };

      for (let index = 0; index < slices.length; index += 1) {
        const slice = slices[index];
        if (slice === undefined) continue;
        if (exhausted()) {
          skipped += remainingEvents(index);
          noteBudgetStop();
          break;
        }
        let outgoing = slice;
        if (usedBytes + bodyOf(outgoing.events, CANDIDATE_BATCH_ID).length > budget.maxBytes) {
          // AC-03 修复：超预算的片**二次切片**（头部优先），不整片丢弃。
          const residual = packPrefix(
            outgoing.events,
            estimateBeaconEventBytes,
            budget.maxBytes - usedBytes - fixedBodyBytes,
          );
          const batchId = createUuid();
          if (
            residual.length === 0 ||
            usedBytes + bodyOf(residual, batchId).length > budget.maxBytes
          ) {
            skipped += remainingEvents(index);
            noteBudgetStop();
            break;
          }
          outgoing = { ...outgoing, batch_id: batchId, events: residual };
          if (residual.length < slice.events.length) {
            skipped += slice.events.length - residual.length;
            noteBudgetStop();
          }
        }
        const body = bodyOf(outgoing.events, outgoing.batch_id);
        const bytes = body.length;
        if (deferring || (turnBytes > 0 && turnBytes + bytes > BEACON_INFLIGHT_BYTES)) {
          // AC-03 第 3 步①：同一同步回合的累计写入不得超额度 → 交给下一个任务。
          deferring = true;
          pending.push({
            endpoint: creds.endpoint,
            appId: creds.appId,
            writeToken: creds.writeToken,
            events: outgoing.events,
            batchId: outgoing.batch_id,
            body,
            bytes,
          });
          continue;
        }
        requests += 1;
        if (
          write({
            endpoint: creds.endpoint,
            appId: creds.appId,
            writeToken: creds.writeToken,
            events: outgoing.events,
            batchId: outgoing.batch_id,
            body,
            bytes,
          })
        ) {
          accepted = true;
        }
      }
      if (pending.length > 0) scheduleFlush();
      skippedTotal += skipped;
      return { accepted, requests, skippedEvents: skipped, bytes: usedBytes };
    },

    stats(): LeaveStats {
      return {
        sent: sentTotal,
        skipped: skippedTotal,
        bytes: bytesTotal,
        requests: requestsTotal,
        budgetStops: budgetStopsTotal,
      };
    },

    dispose(): void {
      disposed = true;
      const stale = pending;
      pending = [];
      dropWrites(stale);
      turnBytes = 0;
    },
  };
}
