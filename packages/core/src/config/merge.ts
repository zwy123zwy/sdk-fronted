/**
 * 三级配置合并（T13，C03-F1）。
 *
 * 优先级从低到高：builtin < remote（含 `overrides.patch`）< runtime 覆盖。
 * runtime 只允许覆盖 `transport`、`debug`，以及在 `plugins` 中**关闭**插件（不能开启远程已关闭的插件）。
 * `kill_switch`、`sampling`、`privacy` 不接受运行时覆盖；`consent_mode` 按 D002 单独合并。
 */
import { matchesSemverRange } from './kill-switch';
import type {
  ConsentMode,
  EffectiveConfig,
  PluginName,
  ResolvedKillSwitch,
  ResolvedMaskRule,
  ResolvedPluginSetting,
  ResolvedPrivacy,
  ResolvedSampling,
  RuntimeOverrides,
  SamplingRule,
  TransportSettings,
} from './types';
import { PLUGIN_NAMES } from './types';

/** 合并输入。 */
export interface MergeInput {
  /** 内建默认层；测试可显式传入带 `transport` 值的 builtin 以验证三级优先级。 */
  readonly builtin: EffectiveConfig;
  /** 已验签并通过结构校验的远程正文；`undefined` 表示没有远程层。 */
  readonly remote: Readonly<Record<string, unknown>> | undefined;
  readonly runtime: RuntimeOverrides | undefined;
  readonly configVersion: number | undefined;
  readonly publishedAt: number | undefined;
  readonly source: 'remote' | 'cache' | 'builtin' | 'conservative';
  readonly consentMode: ConsentMode | undefined;
  readonly sessionRandom: number;
  readonly sdkVersion: string;
}

/** 合并结果。 */
export interface MergeResult {
  readonly config: EffectiveConfig;
  /** 远程 `consent_mode` 为 `full`/非法而被忽略时为 true（计 `config_consent_mode_rejected`）。 */
  readonly consentModeRejected: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (isString(item)) items.push(item);
  }
  return items;
}

/**
 * 解析远程 `consent_mode`（`remote-config.md` 2.1 / D002）。
 * 远程只接受 `essential_only`/`buffer`；`full` 或任何非法取值只忽略该字段，回退初始化参数值，
 * 都没有时为 `essential_only`。`rejected` 表示是否因非法取值而忽略。
 */
export function resolveConsentMode(
  remoteConsentMode: unknown,
  initConsentMode: ConsentMode | undefined,
): { readonly mode: ConsentMode; readonly rejected: boolean } {
  if (remoteConsentMode === 'essential_only' || remoteConsentMode === 'buffer') {
    return { mode: remoteConsentMode, rejected: false };
  }
  return { mode: initConsentMode ?? 'essential_only', rejected: remoteConsentMode !== undefined };
}

function readRuleMatch(record: Readonly<Record<string, unknown>>): SamplingRule['match'] {
  const match: {
    event_name?: string;
    event_type?: 'custom' | 'log' | 'error' | 'perf' | 'pageview' | 'http';
    dimension?: { key: string; equals: string };
  } = {};
  const eventName = record['event_name'];
  if (isString(eventName)) match.event_name = eventName;
  const eventType = record['event_type'];
  if (
    eventType === 'custom' ||
    eventType === 'log' ||
    eventType === 'error' ||
    eventType === 'perf' ||
    eventType === 'pageview' ||
    eventType === 'http'
  ) {
    match.event_type = eventType;
  }
  const dimension = record['dimension'];
  if (isRecord(dimension) && isString(dimension['key']) && isString(dimension['equals'])) {
    match.dimension = { key: dimension['key'], equals: dimension['equals'] };
  }
  return match;
}

function readRules(value: unknown): readonly SamplingRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: SamplingRule[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const match = isRecord(item['match']) ? readRuleMatch(item['match']) : {};
    const rate = isFiniteNumber(item['rate']) ? item['rate'] : 1;
    rules.push({ match, rate });
  }
  return rules;
}

function mergeSampling(base: ResolvedSampling, incoming: unknown): ResolvedSampling {
  if (!isRecord(incoming)) return base;
  const sessionRate = incoming['session_rate'];
  const allowUsers = asStringArray(incoming['allow_users']);
  const rules = readRules(incoming['rules']);
  return {
    session_rate: isFiniteNumber(sessionRate) ? sessionRate : base.session_rate,
    allow_users: allowUsers ?? base.allow_users,
    rules: rules ?? base.rules,
  };
}

function mergeKillSwitch(base: ResolvedKillSwitch, incoming: unknown): ResolvedKillSwitch {
  if (!isRecord(incoming)) return base;
  const all = incoming['all'];
  const versions = asStringArray(incoming['sdk_versions']);
  const plugins = asStringArray(incoming['plugins']);
  return {
    all: typeof all === 'boolean' ? all : base.all,
    sdk_versions: versions ?? base.sdk_versions,
    plugins: (plugins ?? base.plugins).filter((name): name is PluginName =>
      (PLUGIN_NAMES as readonly string[]).includes(name),
    ),
  };
}

function readPluginSetting(value: unknown): ResolvedPluginSetting | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = value['enabled'];
  if (typeof enabled !== 'boolean') return undefined;
  const options = value['options'];
  if (options === undefined) return { enabled };
  if (!isRecord(options)) return { enabled };
  return { enabled, options: { ...options } };
}

function mergePlugins(
  base: Readonly<Record<PluginName, ResolvedPluginSetting>>,
  incoming: unknown,
): Readonly<Record<PluginName, ResolvedPluginSetting>> {
  if (!isRecord(incoming)) return base;
  const result = { ...base };
  for (const name of PLUGIN_NAMES) {
    const setting = readPluginSetting(incoming[name]);
    if (setting === undefined) continue;
    result[name] = setting;
  }
  return result;
}

function readMaskRules(value: unknown): readonly ResolvedMaskRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: ResolvedMaskRule[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = item['name'];
    const pattern = item['pattern'];
    if (!isString(name) || !isString(pattern)) continue;
    const rule: { name: string; pattern: string; flags?: string; replacement?: string } = { name, pattern };
    if (isString(item['flags'])) rule.flags = item['flags'];
    if (isString(item['replacement'])) rule.replacement = item['replacement'];
    rules.push(rule);
  }
  return rules;
}

function mergePrivacy(base: ResolvedPrivacy, incoming: unknown): ResolvedPrivacy {
  if (!isRecord(incoming)) return base;
  const allowlist = asStringArray(incoming['url_query_allowlist']);
  const headers = asStringArray(incoming['sensitive_headers']);
  const maskRules = readMaskRules(incoming['extra_mask_rules']);
  return {
    // consent_mode 由 resolveConsentMode 单独决定，不在此合并
    consent_mode: base.consent_mode,
    url_query_allowlist: allowlist ?? base.url_query_allowlist,
    sensitive_headers: headers ?? base.sensitive_headers,
    extra_mask_rules: maskRules ?? base.extra_mask_rules,
  };
}

function mergeEndpoints(base: Readonly<{ ingest?: string | undefined }>, incoming: unknown): Readonly<{ ingest?: string | undefined }> {
  if (!isRecord(incoming)) return base;
  const ingest = incoming['ingest'];
  return isString(ingest) ? { ingest } : base;
}

function mergeTransport(base: Readonly<TransportSettings>, incoming: unknown): Readonly<TransportSettings> {
  if (!isRecord(incoming)) return base;
  const result: {
    max_batch_events?: number;
    max_batch_bytes?: number;
    idle_flush_ms?: number;
    max_wait_ms?: number;
    replay_batches_per_second?: number;
  } = {};
  const read = (key: keyof TransportSettings): number | undefined =>
    isFiniteNumber(incoming[key]) ? incoming[key] : base[key];
  const maxBatchEvents = read('max_batch_events');
  if (maxBatchEvents !== undefined) result.max_batch_events = maxBatchEvents;
  const maxBatchBytes = read('max_batch_bytes');
  if (maxBatchBytes !== undefined) result.max_batch_bytes = maxBatchBytes;
  const idleFlushMs = read('idle_flush_ms');
  if (idleFlushMs !== undefined) result.idle_flush_ms = idleFlushMs;
  const maxWaitMs = read('max_wait_ms');
  if (maxWaitMs !== undefined) result.max_wait_ms = maxWaitMs;
  const replay = read('replay_batches_per_second');
  if (replay !== undefined) result.replay_batches_per_second = replay;
  return result;
}

/** `overrides[].when`：所有给出的条件都满足才算命中（无条件的 when 已被 Schema 拒绝）。 */
function overrideMatches(when: unknown, sessionRandom: number, sdkVersion: string): boolean {
  if (!isRecord(when)) return false;
  if ('sdk_versions' in when) {
    const ranges = asStringArray(when['sdk_versions']);
    if (ranges === undefined || !ranges.some((range) => matchesSemverRange(sdkVersion, range))) return false;
  }
  if ('session_bucket' in when) {
    const rawBucket = when['session_bucket'];
    if (!Array.isArray(rawBucket) || rawBucket.length !== 2) return false;
    const bucket: readonly unknown[] = rawBucket;
    const from = bucket[0];
    const to = bucket[1];
    if (!isFiniteNumber(from) || !isFiniteNumber(to)) return false;
    const bucketValue = Math.floor(sessionRandom * 100);
    if (!(bucketValue >= from && bucketValue < to)) return false;
  }
  return true;
}

/** runtime 覆盖只能关闭插件，不能开启远程已关闭的插件、也不能改 options。 */
function applyRuntimePlugins(
  base: Readonly<Record<PluginName, ResolvedPluginSetting>>,
  overrides: Readonly<Record<string, boolean>>,
): Readonly<Record<PluginName, ResolvedPluginSetting>> {
  const result = { ...base };
  for (const name of PLUGIN_NAMES) {
    if (overrides[name] !== false) continue;
    const setting = result[name];
    result[name] = setting.options === undefined ? { enabled: false } : { enabled: false, options: setting.options };
  }
  return result;
}

/** 三级合并。 */
export function mergeConfig(input: MergeInput): MergeResult {
  const consent = resolveConsentMode(
    input.remote === undefined ? undefined : input.remote['privacy'] === undefined
      ? undefined
      : isRecord(input.remote['privacy'])
        ? input.remote['privacy']['consent_mode']
        : undefined,
    input.consentMode,
  );

  let sampling = input.builtin.sampling;
  let killSwitch = input.builtin.kill_switch;
  let plugins = input.builtin.plugins;
  let privacy: ResolvedPrivacy = { ...input.builtin.privacy, consent_mode: consent.mode };
  let endpoints = input.builtin.endpoints;
  let transport = input.builtin.transport;
  let appliedOverrides = 0;

  const remote = input.remote;
  if (remote !== undefined) {
    sampling = mergeSampling(sampling, remote['sampling']);
    killSwitch = mergeKillSwitch(killSwitch, remote['kill_switch']);
    plugins = mergePlugins(plugins, remote['plugins']);
    privacy = mergePrivacy(privacy, remote['privacy']);
    endpoints = mergeEndpoints(endpoints, remote['endpoints']);
    transport = mergeTransport(transport, remote['transport']);

    const overrides = remote['overrides'];
    if (Array.isArray(overrides)) {
      for (const item of overrides) {
        if (!isRecord(item)) continue;
        if (!overrideMatches(item['when'], input.sessionRandom, input.sdkVersion)) continue;
        const patch = item['patch'];
        if (!isRecord(patch)) continue;
        sampling = mergeSampling(sampling, patch['sampling']);
        plugins = mergePlugins(plugins, patch['plugins']);
        transport = mergeTransport(transport, patch['transport']);
        appliedOverrides += 1;
      }
    }
  }

  if (input.runtime !== undefined) {
    transport = mergeTransport(transport, input.runtime.transport);
    if (input.runtime.plugins !== undefined) plugins = applyRuntimePlugins(plugins, input.runtime.plugins);
  }
  const debug = input.runtime?.debug ?? input.builtin.debug;

  const config: EffectiveConfig = {
    source: input.source,
    config_version: input.configVersion,
    published_at: input.publishedAt,
    sampling,
    kill_switch: killSwitch,
    plugins,
    privacy: { ...privacy, consent_mode: consent.mode },
    endpoints,
    transport,
    debug,
    applied_overrides: appliedOverrides,
  };
  return { config, consentModeRejected: consent.rejected };
}
