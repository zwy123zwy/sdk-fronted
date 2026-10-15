/**
 * C07 发送器的常量、默认值与原因码。
 *
 * 退避与熔断参数取自 `docs/contracts/ingest-protocol.md` 第 4 节（冻结值）：
 * 首次 1 秒、倍数 2、上限 60 秒、最多 3 次、±20% 抖动；连续 5 个批次失败后熔断 5 分钟。
 * 离开预算的**字节上限**由 AC-03 的载荷口径反推（见 `LEAVE_BUDGET`）；条数 / 批数 / 时间窗
 * 仍取 POC-1 的推荐值（≤200 条 / ≤4 批 / 50 ms）。
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

/**
 * 信标切片的目标片大小（AC-03；第 3 步**未改这个值**）。
 *
 * 依据 `tests/e2e/results/beacon-quota-{chromium,webkit}.json` 的两引擎实测（数字完全相同）：
 * - 单次上限：`single-64K → true`，`single-80K → false`；
 * - **同一同步回合的累计额度**：`sync-32x32`(65536 B) `→ [true,true]` 被接受、
 *   `sync-24x24x24x24` 第 3 片(73728 B) 被拒 → 额度 ∈ [65536, 73728)；
 * - **跨任务后额度重置**：`raf-28x28x28 → [true,true,true]`、`delay0-21x4 → [true,true,true,true]`。
 *
 * 32 KiB 保持不变：AC-03 第 3 步的根因是**估算器虚高 24%**（923 B vs 实测 743 B/事件），
 * 不是片太大——按旧口径 32 KiB 只装下 26391 B、80 KB 溢出成 4 片；换成校准口径
 * （`beacon-size.ts`）后 32 KiB 装 43 条 / 32323 B，112 条正好 **3 片**。
 * 实测（`page-leave.test.ts` 的真机载荷用例）：两个满片正文 32397 B × 2 = **64794 B**，
 * 落在**实测被接受**的 65536 B 之内（余量 742 B）。
 */
export const BEACON_SLICE_BYTES = 32 * 1024;

/**
 * 一个同步回合允许写入的**累计在途额度**（AC-03；第 3 步**未改这个值**）。
 *
 * 取 64 KiB：实测被接受的**最大同回合累计写入**恰是 65536 B（`sync-32x32 → [true,true]`、
 * `sync-16x16x16x16 → [true,true,true,true]`，两引擎一致），因此 65536 B 是**已被验证接受**
 * 的口径；`BEACON_SLICE_BYTES * 2 ≤ BEACON_INFLIGHT_BYTES` 的自洽约束在等号上成立。
 *
 * 离开通道按此让出主线程：本回合写入量再增加一片就会超过它时先让出（宏任务），下一回合再写
 * （实测让出后额度重置：`raf-28x28x28`、`delay0-21x4` 全被接受）。让出**只**发生在额度已满
 * 之后，第一个回合仍然同步写完（离页语义见 `page-leave.ts` 的 `schedule` 说明）。
 */
export const BEACON_INFLIGHT_BYTES = 64 * 1024;

/**
 * 离开预算（跨引擎保守默认）。
 *
 * - `maxBytes`：**必须 ≥ AC-03 的 80 KB 载荷**（`tests/acceptance/C07.md:9`），否则离页时
 *   首片就被预算整片丢掉、只发尾部（AC-03 不合格的实测原因之一）。96 KiB 相对 80 KB
 *   留出约 16 KB 余量（auth 字段 / 批次头 / JSON 开销），仍远小于常规通道的批量上限。
 * - `maxEvents` / `maxBatches` / `maxMs`：沿用 POC-1 的推荐值，不放宽，避免离开路径长时间
 *   占用主线程；超预算的片按**二次切片**处理（头部优先），不再整片丢弃。
 */
export const LEAVE_BUDGET = {
  maxBytes: 96 * 1024,
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
