/**
 * C07 批次发送器（C07-F1 至 C07-F4、C07-F8）。
 *
 * - 通道：常规通道用注入的传输（默认 `fetch keepalive` → `XMLHttpRequest` 降级）；
 * - 响应分类、退避重试、熔断、401/403 暂停都委托给 `policy.ts`；
 * - `413` 二分拆分（`event_id` 不变、`batch_id` 重新生成）；
 * - 终态丢弃（4xx / 单条超限）用 `terminal: true` 告知调用方**删除离线副本**，
 *   避免被丢弃的批次在补发里无限重试。
 */
import type { BatchEnvelope, QueueEvent } from '../batch/types';
import type { CountersPort } from '../queue/types';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  REASON_REJECTED_413,
  REASON_RETRY_EXHAUSTED,
  REASON_RETRY_NETWORK,
  REASON_SPLIT_413,
} from './constants';
import { createCompressor, shouldCompress } from './compress';
import { createDefaultTransport, supportsFetchKeepalive } from './native';
import {
  classifyError,
  classifyStatus,
  createBackoff,
  createCircuitBreaker,
  createSendGate,
  parseServerTime,
} from './policy';
import type {
  BatchSender,
  CompressorPort,
  SendResult,
  SenderOptions,
  SenderStats,
  TransportPort,
} from './types';

const noopCounters: CountersPort = { count: (): void => undefined };
const MAX_SPLIT_DEPTH = 8;

function createUuid(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } | undefined }).crypto;
  if (cryptoRef?.randomUUID !== undefined) {
    try {
      return cryptoRef.randomUUID();
    } catch {
      // 落到下面的兜底实现
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

/** 创建批次发送器。 */
export function createBatchSender(options: SenderOptions): BatchSender {
  const counters = options.counters ?? noopCounters;
  const now = options.now ?? ((): number => Date.now());
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, ms);
      }));
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const compressor: CompressorPort = options.compressor ?? createCompressor();
  const backoff = createBackoff(options.backoff, random);
  const circuit = createCircuitBreaker(options.circuit, now);
  const gate = createSendGate(options.credentials);
  const transport: TransportPort =
    options.transport ??
    createDefaultTransport(options.http ?? {}, options.keepaliveSupported ?? supportsFetchKeepalive);

  let attempts = 0;
  let retries = 0;
  let sent = 0;
  let dropped = 0;

  async function attemptOnce(batch: BatchEnvelope): Promise<ReturnType<typeof classifyStatus>> {
    const credentials = options.credentials.current();
    if (credentials === null) {
      // 无可用凭据：与 401 同样按暂停处理，避免无意义的重试。
      return { kind: 'pause', reason: 'rejected_401' };
    }
    const body = JSON.stringify(batch);
    let bodyBytes: Uint8Array<ArrayBuffer> | undefined;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-app-id': credentials.appId,
      'x-write-token': credentials.writeToken,
      'x-request-id': batch.batch_id,
    };
    if (shouldCompress(body, compressor)) {
      try {
        bodyBytes = await compressor.compress(body);
        headers['content-encoding'] = 'gzip';
      } catch {
        bodyBytes = undefined;
        delete headers['content-encoding'];
      }
    }
    try {
      const response = await transport.send({
        url: credentials.endpoint,
        headers,
        body,
        bodyBytes,
        keepalive: true,
        timeoutMs,
      });
      const serverTime = parseServerTime(response.headers);
      if (serverTime !== null && options.onServerTime !== undefined) options.onServerTime(serverTime);
      return classifyStatus(response.status, response.headers);
    } catch {
      return classifyError();
    }
  }

  async function sendSplit(batch: BatchEnvelope, depth: number): Promise<SendResult> {
    const events = batch.events;
    if (events.length <= 1) {
      // 单条仍超限：丢弃该条并计 rejected_413（AC-07），终态不再补发。
      counters.count(REASON_REJECTED_413);
      dropped += 1;
      return { status: 'failed', attempts: 1, terminal: true, reason: REASON_REJECTED_413 };
    }
    if (depth >= MAX_SPLIT_DEPTH) {
      return { status: 'failed', attempts: 1, terminal: false, reason: REASON_RETRY_EXHAUSTED };
    }
    counters.count(REASON_SPLIT_413);
    const middle = Math.floor(events.length / 2);
    const halves: readonly (readonly QueueEvent[])[] = [
      events.slice(0, middle),
      events.slice(middle),
    ];
    let totalAttempts = 0;
    for (const half of halves) {
      const sub: BatchEnvelope = { ...batch, batch_id: createUuid(), events: half };
      const result = await sendWithRetry(sub, depth + 1);
      totalAttempts += result.attempts;
      if (result.status !== 'sent') {
        return {
          status: 'failed',
          attempts: totalAttempts,
          terminal: result.terminal,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        };
      }
    }
    return { status: 'sent', attempts: totalAttempts, terminal: false };
  }

  async function sendWithRetry(batch: BatchEnvelope, depth: number): Promise<SendResult> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      attempts += 1;
      const classified = await attemptOnce(batch);
      if (classified.kind === 'success') {
        sent += 1;
        circuit.onSuccess();
        return { status: 'sent', attempts: attempt, terminal: false };
      }
      if (classified.kind === 'drop') {
        counters.count(classified.reason);
        dropped += 1;
        circuit.onSuccess();
        return {
          status: 'failed',
          attempts: attempt,
          terminal: true,
          reason: classified.reason,
        };
      }
      if (classified.kind === 'pause') {
        counters.count(classified.reason);
        gate.pause();
        return { status: 'failed', attempts: attempt, terminal: false, reason: classified.reason };
      }
      if (classified.kind === 'split') {
        return sendSplit(batch, depth);
      }
      if (attempt > backoff.options.maxAttempts) {
        dropped += 1;
        circuit.onFailure();
        return {
          status: 'failed',
          attempts: attempt,
          terminal: false,
          reason: REASON_RETRY_EXHAUSTED,
        };
      }
      counters.count(classified.reason);
      retries += 1;
      await sleep(backoff.delayFor(attempt, classified.retryAfterMs));
    }
  }

  return {
    transport,

    async send(batch: BatchEnvelope): Promise<SendResult> {
      if (!circuit.admit()) {
        return { status: 'circuit_open', attempts: 0, terminal: false };
      }
      if (gate.isPaused()) {
        // 暂停期间不发送：批次留给队列/离线副本，等凭据更新后恢复。
        return { status: 'failed', attempts: 0, terminal: false };
      }
      try {
        return await sendWithRetry(batch, 0);
      } catch {
        counters.count(REASON_RETRY_NETWORK);
        return { status: 'failed', attempts: 1, terminal: false };
      }
    },

    isCircuitOpen(): boolean {
      return circuit.isOpen();
    },

    isPaused(): boolean {
      return gate.isPaused();
    },

    stats(): SenderStats {
      return {
        attempts,
        retries,
        sent,
        dropped,
        retryRatio: attempts === 0 ? 0 : retries / attempts,
        circuitOpen: circuit.isOpen(),
        paused: gate.isPaused(),
        circuitOpens: circuit.opens(),
        probes: circuit.probes(),
      };
    },
  };
}
