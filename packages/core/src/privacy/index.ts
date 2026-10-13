/**
 * C04 隐私与字段约束（T14）目录汇总。
 *
 * 只从 `packages/core/src/index.ts` 对外暴露（指南第 11 节）。
 */
export { C04_LIMITS } from './constants';
export {
  BUILTIN_MASK_RULES,
  BUILTIN_SENSITIVE_HEADERS,
  MASK_RULE_BUDGET,
  compileMaskRules,
  mergeSensitiveHeaders,
} from './mask-rules';
export type { BuiltinMaskRule, CompiledMaskRule } from './mask-rules';
export { PRIVACY_REASON_CODES } from './reason-codes';
export type { PrivacyReasonCode } from './reason-codes';
export { createMasker } from './mask';
export { parseUrlParts, sanitizeUrl } from './url';
export type { UrlParts } from './url';
export { truncateUtf16Safe, utf8Bytes } from './limits';
export { constrainEvent } from './constraints';
export { ESSENTIAL_EVENT_NAMES, decideConsent, isEssentialEvent } from './consent-policy';
export type { ConsentDecision } from './consent-policy';
export {
  PROCESSOR_IDS,
  createConsentFilterProcessor,
  createContextEnrichProcessor,
  createFieldConstraintsProcessor,
} from './processors';
export type { ConsentGatePort, ContextEnrichPort } from './processors';
export type {
  ConsentEmit,
  ConstrainInput,
  ConstrainResult,
  ConsentMode,
  ConsentState,
  ContextSnapshot,
  ContextUser,
  EventPriority,
  FieldConstraintsOptions,
  FieldLimits,
  MaskRule,
  Masker,
  PrivacyDiagnosticsSink,
} from './types';
