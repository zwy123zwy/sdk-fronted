/**
 * `ingest-receiver.mjs` 的类型（`.mjs` 需要同名 `.d.mts` 才能被 `tests/**\/*.ts` 静态导入，
 * 否则根 `tsconfig.json` 的 typecheck 会报找不到声明）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 一个收到的批次（含被拒的；`schemaOk` 是接收端的判决）。 */
export interface IngestBatchRecord {
  readonly at: string;
  readonly bytes: number;
  readonly body: unknown;
  readonly schemaOk: boolean;
  readonly code: string;
  readonly errors: readonly string[];
}

export interface IngestReceiver {
  /** 处理 `POST /ingest`；负责该请求时返回 `true`。 */
  readonly handle: (request: IncomingMessage, response: ServerResponse) => boolean;
  readonly batches: readonly IngestBatchRecord[];
  readonly accepted: readonly IngestBatchRecord[];
  readonly rejected: readonly IngestBatchRecord[];
}

export interface IngestReceiverHandle extends IngestReceiver {
  readonly url: string;
  close(): Promise<void>;
}

export function createBatchIngestHandler(): IngestReceiver;
export function startBatchIngestReceiver(): Promise<IngestReceiverHandle>;
