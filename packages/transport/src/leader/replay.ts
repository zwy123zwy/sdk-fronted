/**
 * C07-F6 补发：启动 / `online` / 页面可见 / `pageshow` 触发，由 leader 限速执行。
 *
 * 契约与 POC 的硬性要求：
 * - **只在常规通道拿到 202 之后才删副本**（本模块唯一删除入口）；
 * - 单批 ≤100 条、单轮 ≤500 条；
 * - 限速 ≤2 批/秒（取配置值与契约上限的较小者），批间隔 ≥100 ms；
 * - 补发的事件带 `replayed: true`（Schema 里该字段在**事件级**），`batch_id`/`event_id` 不变；
 * - 失败退避：`min(2^attempt × 1s, 60s)` 之后才再试，避免补发风暴。
 */
import type { BatchEnvelope } from '../batch/types';
import type { CountersPort } from '../queue/types';
import {
  REASON_REPLAYED,
  REPLAY_MAX_BATCH_EVENTS,
  REPLAY_MAX_ROUND_EVENTS,
  REPLAY_MIN_INTERVAL_MS,
} from '../sender/constants';
import type { BatchSender } from '../sender/types';
import type { OfflineStore } from '../offline/types';
import type { LeaderElection, LeaderMode } from './leader';

export interface ReplayRoundResult {
  readonly leader: boolean;
  readonly mode: LeaderMode;
  readonly batches: number;
  readonly events: number;
  readonly skipped: number;
}

export interface ReplayControllerOptions {
  readonly offline: OfflineStore;
  readonly sender: BatchSender;
  readonly leader: LeaderElection;
  readonly counters: CountersPort;
  /** 当前允许的补发批次数/秒（来自 C06 的 `replay_batches_per_second`）。 */
  readonly rate: () => number;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly maxRoundEvents?: number | undefined;
  readonly maxBatchEvents?: number | undefined;
}

export interface ReplayController {
  run(): Promise<ReplayRoundResult>;
  /** 单轮上限（观测用）。 */
  maxRoundEvents(): number;
}

const DEFAULT_RATE = 1;
const MAX_RATE = 2;
const FAILURE_BACKOFF_BASE_MS = 1_000;
const FAILURE_BACKOFF_MAX_MS = 60_000;

/** 标记补发：事件级 `replayed: true`，`batch_id` 与 `event_id` 保持不变。 */
export function markReplayed(batch: BatchEnvelope): BatchEnvelope {
  return {
    ...batch,
    events: batch.events.map((event) => ({ ...event, replayed: true })),
  };
}

/** 创建补发控制器。 */
export function createReplayController(options: ReplayControllerOptions): ReplayController {
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => {
      return new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, ms);
      });
    });
  const maxRoundEvents = options.maxRoundEvents ?? REPLAY_MAX_ROUND_EVENTS;
  const maxBatchEvents = options.maxBatchEvents ?? REPLAY_MAX_BATCH_EVENTS;

  function intervalMs(): number {
    const raw = options.rate();
    const rate = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_RATE) : DEFAULT_RATE;
    return Math.max(REPLAY_MIN_INTERVAL_MS, Math.ceil(1_000 / rate));
  }

  async function runRound(): Promise<{ batches: number; events: number; skipped: number }> {
    let batches = 0;
    let events = 0;
    let skipped = 0;
    const interval = intervalMs();
    let firstSend = true;
    while (events < maxRoundEvents) {
      const remaining = maxRoundEvents - events;
      const summaries = await options.offline.list(Math.min(maxBatchEvents, remaining));
      if (summaries.length === 0) break;
      const summary = summaries[0];
      if (summary === undefined) break;
      // 限速：两批之间至少间隔 interval（不在最后一批后白等，避免拖长一轮）。
      if (!firstSend) await sleep(interval);
      firstSend = false;
      const batch = await options.offline.read(summary.batch_id);
      if (batch === null) {
        // 记录在读取前被清掉（撤回同意 / 格式不兼容 / 另一标签页已确认）。
        skipped += summary.event_count;
        continue;
      }
      const result = await options.sender.send(markReplayed(batch));
      if (result.status === 'sent') {
        await options.offline.remove([summary.batch_id]);
        options.counters.count(REASON_REPLAYED);
        batches += 1;
        events += summary.event_count;
        continue;
      }
      // 失败：记一次尝试，按指数退避延后，**保留副本**等下一轮。
      await options.offline.markAttempt(summary.batch_id);
      if (result.terminal) {
        // 终态（4xx / 单条超限）：不再补发，删除副本避免死循环。
        await options.offline.remove([summary.batch_id]);
        skipped += summary.event_count;
        continue;
      }
      const attempt = summary.attempt_count + 1;
      const backoff = Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (attempt - 1), FAILURE_BACKOFF_MAX_MS);
      await sleep(backoff);
      break;
    }
    return { batches, events, skipped };
  }

  return {
    async run(): Promise<ReplayRoundResult> {
      const outcome = await options.leader.run(runRound);
      if (!outcome.leader || outcome.result === undefined) {
        return { leader: outcome.leader, mode: outcome.mode, batches: 0, events: 0, skipped: 0 };
      }
      return {
        leader: true,
        mode: outcome.mode,
        batches: outcome.result.batches,
        events: outcome.result.events,
        skipped: outcome.result.skipped,
      };
    },

    maxRoundEvents(): number {
      return maxRoundEvents;
    },
  };
}
