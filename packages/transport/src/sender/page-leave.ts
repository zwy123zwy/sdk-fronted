/**
 * C07-F1 / C07-F5 的页面离开通道（信标为主、`fetch keepalive` 为备 + 显式预算）。
 *
 * POC-1 的实测教训（**不得违反**）：
 * - `sendBeacon` 没有响应通道，返回 `true` 只表示"浏览器接受了请求"；
 * - `fetch keepalive` 的 Promise 在页面销毁时会被丢弃（Chromium/Firefox 全部 reject）。
 * 因此本模块**从不把任何信号当作"已送达"**，离线副本只由常规通道的 202 删除（AC-13）。
 *
 * AC-03 修复（依据 `docs/reports/e2e-real-browser.md` 的两引擎实测）：
 * - 片大小取 `BEACON_SLICE_BYTES`（32 KiB），远离浏览器**同一同步回合 ≈64 KiB 的累计在途额度**；
 * - 按 `BEACON_INFLIGHT_BYTES` 把片分**波次**：再写一片就会超过额度时先 `schedule()` 让出主线程；
 * - 片超过剩余预算时**二次切片**（头部优先），把能装下的前缀发出去，绝不整片丢弃；
 * - 被跳过的片按事件数计入 `skipped`，并被 CR-008 的观测量 `budgetStops` 计到。
 */
import type { BatchEnvelope, QueueEvent } from '../batch/types';
import { estimateEventBytes } from '../queue/size';
import type { CountersPort } from '../queue/types';
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
 * （CR-008：离开 burst 内首次因预算用尽而停手的次数）。全部是内部观测量，
 * 其中只有 `budgetStops` 有契约指标名（`flush_skipped_due_to_budget`）。
 */
export interface LeaveStats {
  /** 事件数。 */
  readonly sent: number;
  /** 事件数。 */
  readonly skipped: number;
  /** 累计估算体积（UTF-16 码元数）。 */
  readonly bytes: number;
  /** 信标 / fetch keepalive 请求数。 */
  readonly requests: number;
  /**
   * CR-008：离开 burst 内**首次**因预算（字节 / 条数 / 批数 / 时间窗）用尽
   * 而**停手**的次数；同一 burst 内后续被跳过的切片不重复计数。它是**次数**，
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
   * 波次调度钩子（AC-03 修复）：一个同步回合写入的累计体积再增加一片就会超过
   * `BEACON_INFLIGHT_BYTES` 时，实现把剩余写入交给它，让出主线程后再继续。
   *
   * 缺省是**立即执行**——离页路径必须同步送出，且显式传 `schedule` 的装配层
   * （测试 / 浏览器）负责决定"让出"的实现。
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

/** 按信标体积上限切片（每片 ≤ `maxBytes`；`event_id` 不变，`batch_id` 重新生成）。 */
export function sliceForBeacon(batch: BatchEnvelope, maxBytes: number): readonly BatchEnvelope[] {
  const groups: QueueEvent[][] = [];
  let current: QueueEvent[] = [];
  let size = 0;
  for (const event of batch.events) {
    const bytes = estimateEventBytes(event) + 2;
    if (current.length > 0 && size + bytes > maxBytes) {
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

/** 一批事件的估算体积（与 `sliceForBeacon` 同一口径，另加 JSON 数组的方括号与逗号）。 */
function estimateEventsBytes(events: readonly QueueEvent[]): number {
  let items = 0;
  for (const event of events) items += estimateEventBytes(event) + 3;
  return items === 0 ? 2 : items - 1;
}

/** 把一条事件序列按剩余预算取**最长可发前缀**（空表示一条都装不下）。 */
function packPrefix(
  events: readonly QueueEvent[],
  sizeOf: (events: readonly QueueEvent[]) => number,
  limit: number,
): readonly QueueEvent[] {
  const packed: QueueEvent[] = [];
  let size = 0;
  for (const event of events) {
    const next = sizeOf([event]) - 2;
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
  // 波次：当前同步回合已写入的累计体积；超过在途额度时让出主线程。
  const schedule =
    options.schedule ??
    ((flush: () => void): void => {
      flush();
    });
  let waveBytes = 0;
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

  /**
   * 写入前的波次控制：本回合再写 `size` 字节就会超过 `BEACON_INFLIGHT_BYTES` 时先让出。
   * 浏览器按**同一同步回合**的累计在途量计额度，因此让出后 `waveBytes` 归零重新累计。
   */
  function trackWave(size: number): void {
    if (waveBytes > 0 && waveBytes + size > BEACON_INFLIGHT_BYTES) {
      schedule(() => {
        waveBytes = 0;
      });
    }
  }

  return {
    resetBudget(): void {
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
      // 绑定成非空常量：`emit()` 是函数声明，控制流收窄不会带进它的函数体。
      const creds: CredentialsSnapshot = credentials;
      if (burstStartedAt === 0) burstStartedAt = now();
      const bytesBefore = usedBytes;
      const slices = sliceForBeacon(batch, BEACON_SLICE_BYTES);
      const sizeOf = (events: readonly QueueEvent[]): number => estimateEventsBytes(events);
      /** 片正文；`batch_id` 每片重新生成（`sliceForBeacon` 的既有口径）。 */
      const bodyOf = (events: readonly QueueEvent[], batchId: string): string =>
        JSON.stringify({
          ...batch,
          batch_id: batchId,
          events,
          auth: { app_id: creds.appId, write_token: creds.writeToken },
        });
      let accepted = false;
      let requests = 0;
      let skipped = 0;
      let bytes = usedBytes;

      /** 发出一片（已确认装得下预算）：计账、波次控制，走信标或 `fetch keepalive`。 */
      function emit(events: readonly QueueEvent[], batchId: string): void {
        const body = bodyOf(events, batchId);
        requests += 1;
        usedBatches += 1;
        usedEvents += events.length;
        usedBytes += body.length;
        bytes = usedBytes;
        trackWave(body.length);
        waveBytes += body.length;
        if (beacon !== null) {
          const ok = beacon(
            creds.endpoint,
            new Blob([body], { type: 'text/plain;charset=UTF-8' }),
          );
          if (ok) accepted = true;
          else counters.count(REASON_RETRY_NETWORK);
        } else {
          // 备选：fetch keepalive。**忽略 Promise 结果**（页面销毁时不可信）。
          void options.transport
            .send({
              url: creds.endpoint,
              headers: {
                'content-type': 'application/json',
                'x-app-id': creds.appId,
                'x-write-token': creds.writeToken,
                'x-request-id': batchId,
                'x-beacon-fallback': 'keepalive',
              },
              body,
              bodyBytes: undefined,
              keepalive: true,
              timeoutMs: 5_000,
            })
            .catch(() => {
              counters.count(REASON_RETRY_NETWORK);
            });
        }
      }

      for (const slice of slices) {
        if (exhausted()) {
          skipped += slice.events.length;
          noteBudgetStop();
          break;
        }
        let outgoing = slice;
        if (
          usedBytes + bodyOf(outgoing.events, CANDIDATE_BATCH_ID).length >
          budget.maxBytes
        ) {
          // AC-03 修复：超预算的片**二次切片**（头部优先），不整片丢弃。
          const residual = packPrefix(
            outgoing.events,
            sizeOf,
            budget.maxBytes - usedBytes,
          );
          const batchId = createUuid();
          if (
            residual.length === 0 ||
            usedBytes + bodyOf(residual, batchId).length > budget.maxBytes
          ) {
            skipped += outgoing.events.length;
            noteBudgetStop();
            break;
          }
          outgoing = { ...outgoing, batch_id: batchId, events: residual };
          if (residual.length < slice.events.length) {
            skipped += slice.events.length - residual.length;
            noteBudgetStop();
          }
        }
        emit(outgoing.events, outgoing.batch_id);
      }
      sentTotal += usedEvents;
      skippedTotal += skipped;
      requestsTotal += requests;
      bytesTotal += usedBytes - bytesBefore;
      return { accepted, requests, skippedEvents: skipped, bytes };
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
      waveBytes = 0;
    },
  };
}
