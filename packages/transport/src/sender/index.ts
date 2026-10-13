/**
 * C07 发送与装配层的公开导出。
 *
 * 指南第 11 节要求「内部模块不对外导出」：这里只暴露装配根与下游任务真正需要的
 * 最小面（其余工厂是本包内部实现，测试通过模块路径直接引用）。
 */
export { createDelivery, createDomPageEventsSource } from './delivery';
export { captureNativeHttpRefs, supportsFetchKeepalive } from './native';
export {
  DEFAULT_BACKOFF,
  DEFAULT_CIRCUIT,
  LEAVE_BUDGET,
  REASON_REJECTED_400,
  REASON_REJECTED_401,
  REASON_REJECTED_403,
  REASON_REJECTED_413,
  REASON_REPLAYED,
  REASON_RETRY_429,
  REASON_RETRY_5XX,
  REASON_RETRY_EXHAUSTED,
  REASON_RETRY_NETWORK,
  REASON_SPLIT_413,
} from './constants';
export type { LeaveBudget, LeaveStats } from './page-leave';
export type {
  CriticalFlushQueue,
  Delivery,
  DeliveryMetrics,
  DeliveryOptions,
  DomPageEventsTarget,
  PageEventsPort,
  PageResumeReason,
  QueueControlPort,
  ReplayReason,
} from './delivery';
export type {
  BatchSender,
  CompressorPort,
  CredentialsPort,
  CredentialsSnapshot,
  DeliveryChannel,
  NativeHttpRefs,
  SenderOptions,
  SenderStats,
  SendResult,
  TransportPort,
  TransportRequest,
  TransportResponse,
} from './types';
