/**
 * C06 批次组装（C06-F3）的公开导出。
 * 公共类型只从 `packages/transport/src/index.ts` 暴露（指南第 11 节）。
 */
export { createBatchAssembler } from './assembler';
export type {
  BatchAssembler,
  BatchAssemblerOptions,
  BatchEnvelope,
  BatchHeader,
  BatchHeaderSource,
  CommonFields,
  Dimensions,
  EventPriority,
  QueueEvent,
} from './types';
