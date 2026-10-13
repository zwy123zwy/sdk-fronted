/**
 * C03 配置模块汇总（T13）。只从 `packages/core/src/index.ts` 对外暴露。
 * M0 阶段：接口与桩实现；`src/index.ts` 的导出扩展已获批准，待实现完成后再接线。
 */
export {
  CACHE_TTL_MS,
  COLLECTOR_PLUGIN_IDS,
  CONFIG_CAPABILITY,
  CONFIG_PATH_PREFIX,
  CONFIG_REASON_CODES,
  FETCH_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  MIN_FETCH_GAP_MS,
  SUPPORTED_FORMAT_VERSION,
} from './constants';
export type { ConfigReasonCode } from './constants';
export { createBuiltinConfig, createConservativeConfig } from './defaults';
export { buildConfigUrl, createFetchPort } from './fetch';
export { createConfigCache, createIndexedDbCache, createMemoryCache, isCacheFresh } from './cache';
export { mergeConfig, resolveConsentMode } from './merge';
export type { MergeInput, MergeResult } from './merge';
export { applyKillSwitch, evaluateKillSwitch, isSupportedSemverRange, matchesSemverRange } from './kill-switch';
export type { KillSwitchDecision } from './kill-switch';
export { resolveWebCrypto, verifyEnvelope } from './signature';
export type { VerifyResult } from './signature';
export { validateEnvelopeShape, validateRemoteBody } from './validate';
export type { ValidationResult } from './validate';
export { createConfigRuntime } from './store';
export { PLUGIN_NAMES } from './types';
export type {
  CachedConfig,
  ConfigEnvelope,
  ClockPort,
  ConfigCachePort,
  ConfigConsentMode,
  ConfigFetchPort,
  ConfigFetchRequest,
  ConfigFetchResponse,
  ConfigReader,
  ConfigRuntime,
  ConfigRuntimeOptions,
  ConfigSource,
  ConsentMode,
  EffectiveConfig,
  PluginName,
  PluginToggleSignal,
  ResolvedKillSwitch,
  ResolvedMaskRule,
  ResolvedPluginSetting,
  ResolvedPrivacy,
  ResolvedSampling,
  RuntimeOverrides,
  SamplingRule,
  TransportSettings,
  WebCryptoLike,
} from './types';
