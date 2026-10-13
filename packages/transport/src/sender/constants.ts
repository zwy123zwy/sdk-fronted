/**
 * C07 发送器的常量、默认值与原因码。
 *
 * 退避与熔断参数取自 `docs/contracts/ingest-protocol.md` 第 4 节（冻结值）：
 * 首次 1 秒、倍数 2、上限 60 秒、最多 3 次、±20% 抖动；连续 5 个批次失败后熔断 5 分钟。
 * 离开预算取自 POC-1 的推荐值（≤48 KB / ≤200 条 / ≤4 批）。
 */
import type { BackoffOptions, CircuitOptions } from './types';

/** 退避默认值（契约 §4）。 */
export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 60_000,
  maxAttempts: 3,
  jitterRatio: 0.2,
};

/** 熔断默认值（契约 §4）。 */
export const DEFAULT_CIRCUIT: CircuitOptions = {
  failuresToOpen: 5,
  openMs: 5 * 60 * 1_000,
};

/** 单请求超时；超时按网络错误处理（AC-25）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** 压缩阈值：序列化后超过 4 KB 且浏览器支持时才压缩（C07-F8，契约 §2.1）。 */
export const COMPRESS_THRESHOLD_BYTES = 4 * 1024;

/** 信标通道单请求体积上限（契约 §2.2；SDK 侧切片用，留出 auth 字段余量）。 */
export const BEACON_MAX_BYTES = 60 * 1024;

/** 离开预算（POC-1 推荐值，跨引擎保守默认）。 */
export const LEAVE_BUDGET = {
  maxBytes: 48 * 1024,
  maxEvents: 200,
  maxBatches: 4,
  /** 单次离开循环的软时间上限，避免长时间占用主线程。 */
  maxMs: 50,
} as const;

/** 补发：单批事件上限 / 单轮事件上限（POC-1 推荐值）。 */
export const REPLAY_MAX_BATCH_EVENTS = 100;
export const REPLAY_MAX_ROUND_EVENTS = 500;
/** 补发批间隔下限（与契约的 ≤2 批/秒取更严者）。 */
export const REPLAY_MIN_INTERVAL_MS = 100;

/** 原因码（reason-codes.md；`prewrite_commit_lost` 依据 CR-001）。 */
export const REASON_REJECTED_400 = 'rejected_400';
export const REASON_REJECTED_401 = 'rejected_401';
export const REASON_REJECTED_403 = 'rejected_403';
export const REASON_REJECTED_413 = 'rejected_413';
export const REASON_RETRY_429 = 'retry_429';
export const REASON_RETRY_5XX = 'retry_5xx';
export const REASON_RETRY_NETWORK = 'retry_network';
export const REASON_SPLIT_413 = 'split_413';
export const REASON_CIRCUIT_OPEN = 'circuit_open';
export const REASON_REPLAYED = 'replayed';
export const REASON_RETRY_EXHAUSTED = 'retry_exhausted';
export const REASON_STORAGE_UNAVAILABLE = 'storage_unavailable';
