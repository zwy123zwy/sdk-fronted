/**
 * 离线记录的形状与版本校验（AC-22）。
 *
 * 体积口径与 C06 保持一致：用 `estimateEventBytes` 逐字段累加，
 * **不做整批 `JSON.stringify`**（避免在 `prewrite` 的同步路径上做全量序列化，
 * 这是「单次写入不阻塞主线程 ≤1 ms」的实现前提）。
 */
import type { BatchEnvelope } from '../batch/types';
import { estimateEventBytes } from '../queue/size';
import type { OfflineRecord, OfflineRecordSummary } from './types';

/** 批次头的保守固定开销（协议版本、app_id、env、sdk_* 等）。 */
const HEADER_BYTES = 256;

export interface RecordInput {
  readonly batch: BatchEnvelope;
  readonly formatVersion: number;
  readonly sessionId: string;
  readonly appId: string;
  readonly enqueuedAt: number;
  readonly committedAt: number;
}

/** 统计批次里的 critical 事件数（决定是否预写与淘汰优先级）。 */
export function countCriticalEvents(batch: BatchEnvelope): number {
  let total = 0;
  for (const event of batch.events) {
    if (event.priority === 'critical') total += 1;
  }
  return total;
}

/** 估算批次体积（含头的保守开销）。 */
export function estimateBatchBytes(batch: BatchEnvelope): number {
  let total = HEADER_BYTES;
  for (const event of batch.events) total += estimateEventBytes(event);
  return total;
}

/** 构造离线记录（不含落盘语义；落盘由后端事务决定）。 */
export function createOfflineRecord(input: RecordInput): OfflineRecord {
  const criticalCount = countCriticalEvents(input.batch);
  return {
    batch_id: input.batch.batch_id,
    format_version: input.formatVersion,
    app_id: input.appId,
    session_id: input.sessionId,
    enqueued_at: input.enqueuedAt,
    committed_at: input.committedAt,
    has_critical: criticalCount > 0,
    event_count: input.batch.events.length,
    critical_count: criticalCount,
    bytes: estimateBatchBytes(input.batch),
    attempt_count: 0,
    last_attempt_at: null,
    batch: input.batch,
  };
}

/** 从完整记录抽出摘要（写入 `summaries` store，供内存索引与淘汰使用）。 */
export function toSummary(record: OfflineRecord): OfflineRecordSummary {
  return {
    batch_id: record.batch_id,
    format_version: record.format_version,
    enqueued_at: record.enqueued_at,
    has_critical: record.has_critical,
    event_count: record.event_count,
    critical_count: record.critical_count,
    bytes: record.bytes,
    attempt_count: record.attempt_count,
    last_attempt_at: record.last_attempt_at,
  };
}

/** 记录是否与当前格式版本兼容（不兼容即按 AC-22 清理）。 */
export function isRecordCompatible(record: OfflineRecord, formatVersion: number): boolean {
  return record.format_version === formatVersion;
}
