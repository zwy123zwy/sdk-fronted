/**
 * C03 采样模块汇总（T13）。只从 `packages/core/src/index.ts` 对外暴露。
 */
export { SAMPLING_REASON_CODES } from './types';
export type {
  RuleOutcome,
  Rules,
  SamplingDispose,
  SamplingEvent,
  SamplingProcessorOptions,
  SessionSampling,
  SessionSamplingOptions,
  SessionStorePort,
  UserLike,
} from './types';
export { SESSION_KEY_PREFIX, createSessionSampling, randomUnit } from './session';
export { combineSampleRate, matchFirstRule, ruleMatches } from './rules';
export { createSamplingProcessor } from './processor';
export { teardownForSampledOutSession } from './teardown';
