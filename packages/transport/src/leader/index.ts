/**
 * C07-F6 / C07-F7 补发与多标签页协调的公开导出（最小面）。
 */
export {
  DEFAULT_CHANNEL_NAME,
  DEFAULT_LOCK_NAME,
  MIN_SETTLE_MS,
  createDefaultBroadcastPort,
  createDefaultLocksPort,
  createLeaderElection,
} from './leader';
export { createReplayController } from './replay';
export type {
  BroadcastChannelLike,
  BroadcastPort,
  LeaderElection,
  LeaderElectionOptions,
  LeaderMode,
  LeaderRunResult,
  LocksPort,
} from './leader';
export type { ReplayController, ReplayControllerOptions, ReplayRoundResult } from './replay';
