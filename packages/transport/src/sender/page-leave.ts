/**
 * C07-F1 / C07-F5 的页面离开通道（信标为主、`fetch keepalive` 为备 + 显式预算）。
 *
 * POC-1 的实测教训（**不得违反**）：
 * - `sendBeacon` 没有响应通道，返回 `true` 只表示"浏览器接受了请求"；
 * - `fetch keepalive` 的 Promise 在页面销毁时会被丢弃（Chromium/Firefox 全部 reject）。
 * 因此本模块**从不把任何信号当作"已送达"**，离线副本只由常规通道的 202 删除（AC-13）。
 */
import type { BatchEnvelope, QueueEvent } from '../batch/types';
import { estimateEventBytes } from '../queue/size';
import type { CountersPort } from '../queue/types';
import { BEACON_MAX_BYTES, LEAVE_BUDGET, REASON_RETRY_NETWORK } from './constants';
import { createBeaconSender } from './native';
import type { CredentialsPort, NativeHttpRefs, TransportPort } from './types';

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
   * CR-008：离开 burst 内**首次**因预算（≤48 KB / ≤200 条 / ≤4 批 / 时间窗）用尽
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
}

export interface LeaveSender {
  send(batch: BatchEnvelope): LeaveSendResult;
  /** 新的离开事件（burst）开始时重置预算。 */
  resetBudget(): void;
  stats(): LeaveStats;
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

  return {
    resetBudget(): void {
      burstStartedAt = now();
      usedBatches = 0;
      usedEvents = 0;
      usedBytes = 0;
      budgetStopCounted = false;
    },

    send(batch: BatchEnvelope): LeaveSendResult {
      const credentials = options.credentials.current();
      if (credentials === null) {
        skippedTotal += batch.events.length;
        return { accepted: false, requests: 0, skippedEvents: batch.events.length, bytes: 0 };
      }
      if (burstStartedAt === 0) burstStartedAt = now();
      const bytesBefore = usedBytes;
      const slices = sliceForBeacon(batch, BEACON_MAX_BYTES - 256);
      let accepted = false;
      let requests = 0;
      let skipped = 0;
      let bytes = usedBytes;
      for (const slice of slices) {
        if (exhausted()) {
          skipped += slice.events.length;
          noteBudgetStop();
          continue;
        }
        const body = JSON.stringify({
          ...slice,
          auth: { app_id: credentials.appId, write_token: credentials.writeToken },
        });
        const size = body.length;
        if (usedBytes + size > budget.maxBytes) {
          skipped += slice.events.length;
          noteBudgetStop();
          continue;
        }
        requests += 1;
        usedBatches += 1;
        usedEvents += slice.events.length;
        usedBytes += size;
        bytes = usedBytes;
        if (beacon !== null) {
          const ok = beacon(
            credentials.endpoint,
            new Blob([body], { type: 'text/plain;charset=UTF-8' }),
          );
          if (ok) accepted = true;
          else counters.count(REASON_RETRY_NETWORK);
        } else {
          // 备选：fetch keepalive。**忽略 Promise 结果**（页面销毁时不可信）。
          void options.transport
            .send({
              url: credentials.endpoint,
              headers: {
                'content-type': 'application/json',
                'x-app-id': credentials.appId,
                'x-write-token': credentials.writeToken,
                'x-request-id': slice.batch_id,
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
  };
}
