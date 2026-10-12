/**
 * 计数（M01-F4）：`received` / `stored` / `duplicate` / `rejected_<error>` 分类。
 *
 * 批次与事件都计数：`received_batches` 用于吞吐报告，`received_events` / `stored_events` /
 * `duplicate_events` 用于去重对账（received_events - stored_events === duplicate_events）。
 */

/** 批次被拒绝的原因码（与 `ingest-protocol.md` 3.1 和响应体的 `error` 对齐）。 */
export type RejectCode =
  | 'invalid_json'
  | 'invalid_structure'
  | 'unsupported_protocol'
  | 'unsupported_encoding'
  | 'app_id_mismatch'
  | 'invalid_token'
  | 'token_revoked'
  | 'payload_too_large'
  | 'too_many_events';

/** 注入过的故障（M01-F3）。 */
export type InjectionCode = '429' | '503' | '413' | '401' | 'timeout' | 'reset';

export type CounterSnapshot = {
  received_batches: number;
  received_events: number;
  stored_batches: number;
  stored_events: number;
  duplicate_events: number;
  rejected_event_too_large: number;
  failed_storage: number;
  injected_429: number;
  injected_503: number;
  injected_413: number;
  injected_401: number;
  injected_timeout: number;
  injected_reset: number;
} & { [key in `rejected_${RejectCode}`]: number };

export interface Counters {
  onBatchReceived: (events: number) => void;
  onEventsStored: (events: number) => void;
  onDuplicate: (events: number) => void;
  onRejected: (code: RejectCode) => void;
  onEventTooLarge: () => void;
  onStorageFailure: () => void;
  onInjected: (kind: InjectionCode) => void;
  snapshot: () => CounterSnapshot;
  clear: () => void;
}

const REJECT_CODES: readonly RejectCode[] = [
  'invalid_json',
  'invalid_structure',
  'unsupported_protocol',
  'unsupported_encoding',
  'app_id_mismatch',
  'invalid_token',
  'token_revoked',
  'payload_too_large',
  'too_many_events',
];

/** 创建计数器。 */
export function createCounters(): Counters {
  const rejected = new Map<RejectCode, number>(REJECT_CODES.map((code) => [code, 0]));
  const injected = new Map<InjectionCode, number>([
    ['429', 0],
    ['503', 0],
    ['413', 0],
    ['401', 0],
    ['timeout', 0],
    ['reset', 0],
  ]);
  let receivedBatches = 0;
  let receivedEvents = 0;
  let storedBatches = 0;
  let storedEvents = 0;
  let duplicateEvents = 0;
  let eventTooLarge = 0;
  let storageFailures = 0;

  return {
    onBatchReceived: (events: number) => {
      receivedBatches += 1;
      receivedEvents += events;
    },
    onEventsStored: (events: number) => {
      if (events <= 0) return;
      storedBatches += 1;
      storedEvents += events;
    },
    onDuplicate: (events: number) => {
      duplicateEvents += events;
    },
    onRejected: (code: RejectCode) => {
      rejected.set(code, (rejected.get(code) ?? 0) + 1);
    },
    onEventTooLarge: () => {
      eventTooLarge += 1;
    },
    onStorageFailure: () => {
      storageFailures += 1;
    },
    onInjected: (kind: InjectionCode) => {
      injected.set(kind, (injected.get(kind) ?? 0) + 1);
    },
    snapshot: (): CounterSnapshot => {
      const base = {
        received_batches: receivedBatches,
        received_events: receivedEvents,
        stored_batches: storedBatches,
        stored_events: storedEvents,
        duplicate_events: duplicateEvents,
        rejected_event_too_large: eventTooLarge,
        failed_storage: storageFailures,
        injected_429: injected.get('429') ?? 0,
        injected_503: injected.get('503') ?? 0,
        injected_413: injected.get('413') ?? 0,
        injected_401: injected.get('401') ?? 0,
        injected_timeout: injected.get('timeout') ?? 0,
        injected_reset: injected.get('reset') ?? 0,
      };
      const rejects: Record<string, number> = {};
      for (const code of REJECT_CODES) rejects[`rejected_${code}`] = rejected.get(code) ?? 0;
      return { ...base, ...rejects } as CounterSnapshot;
    },
    clear: () => {
      receivedBatches = 0;
      receivedEvents = 0;
      storedBatches = 0;
      storedEvents = 0;
      duplicateEvents = 0;
      eventTooLarge = 0;
      storageFailures = 0;
      for (const code of REJECT_CODES) rejected.set(code, 0);
      for (const kind of injected.keys()) injected.set(kind, 0);
    },
  };
}
