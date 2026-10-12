/**
 * 批次组装器（C06-F3）。
 * 批次头来自注入的 `BatchHeaderSource`；`batch_id`、`sent_at` 由组装器生成。
 */
import { promoteCommonFields } from './promote';
import type { BatchAssembler, BatchAssemblerOptions, BatchEnvelope, QueueEvent } from './types';

const UUID_VARIANT_MIN = 8;

function randomHex(length: number): string {
  let output = '';
  while (output.length < length) output += Math.floor(Math.random() * 16).toString(16);
  return output;
}

/** Math.random 实现的 UUID v4；只在运行环境没有 `crypto.randomUUID` 时使用。 */
function fallbackUuidV4(): string {
  // 变体位取值 8、9、a、b
  const variant = (UUID_VARIANT_MIN + Math.floor(Math.random() * 4)).toString(16);
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-${variant}${randomHex(3)}-${randomHex(12)}`;
}

/** 默认 `batch_id` 生成器。 */
function defaultCreateId(): string {
  const source = globalThis.crypto as { randomUUID?: (() => string) | undefined } | undefined;
  if (source !== undefined && typeof source.randomUUID === 'function') return source.randomUUID();
  return fallbackUuidV4();
}

/** 创建批次组装器。 */
export function createBatchAssembler(options: BatchAssemblerOptions): BatchAssembler {
  const headerSource = options.header;
  const now = options.now ?? ((): number => Date.now());
  const createId = options.createId ?? defaultCreateId;

  return {
    assemble(events: readonly QueueEvent[]): BatchEnvelope {
      if (events.length === 0) {
        throw new Error('批次至少要有一条事件（batch.schema.json 的 events.minItems 为 1）');
      }
      const promoted = promoteCommonFields(events);
      const envelope: BatchEnvelope = {
        ...headerSource.header(),
        batch_id: createId(),
        sent_at: now(),
        events: promoted.events,
      };
      if (promoted.common === undefined) return envelope;
      return { ...envelope, common: promoted.common };
    },
  };
}
