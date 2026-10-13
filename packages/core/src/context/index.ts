/**
 * C04 上下文（T14）目录汇总。
 *
 * 只从 `packages/core/src/index.ts` 对外暴露（指南第 11 节）。
 */
export {
  CLOCK_OFFSET_LIMIT_MS,
  CONSENT_BUFFER_MAX_BYTES,
  CONSENT_BUFFER_MAX_EVENTS,
  CONTEXT_CAPABILITY,
  DEVICE_ID_KEY,
  MAX_CLOCK_ROUND_TRIP_MS,
  SESSION_ID_KEY,
  SESSION_IDLE_MS,
  VIEW_CAPABILITY,
} from './constants';
export { clampOffset, createClockCalibration } from './clock';
export { createBatchHeaderProvider } from './header';
export { createConsentManager, toBatchConsent } from './consent';
export { createContextStore } from './store';
export type { ContextStoreOptions } from './store';
export { createPageTracker } from './page';
export { createConsentProcessor, createEnrichProcessor } from './processors';
export type { ConsentGateSource } from './processors';
export { createSessionTracker } from './session';
export type { ContextSnapshot, ContextUser } from '../privacy/types';
export type {
  BatchConsent,
  ViewOptions,
  BatchHeaderProviderOptions,
  C04BatchHeader,
  ClockCalibration,
  ClockSample,
  ClockState,
  ConsentManager,
  ConsentManagerOptions,
  ContextStoragePort,
  ContextStore,
  ContextStoreState,
  ErasePort,
  PageTracker,
  PageTrackerOptions,
  SessionState,
  SessionTracker,
  SessionTrackerOptions,
} from './ports';
