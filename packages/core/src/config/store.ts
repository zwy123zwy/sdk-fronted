/**
 * 配置运行时编排（T13，C03-F1/F2/F5）。
 *
 * 时序：`start()` 同步返回并调度一次异步拉取（不阻塞初始化）；之后每 5 分钟、
 * 页面重新可见时各拉取一次，两次拉取至少间隔 60 秒。`refresh()` 供手动/测试触发，绕过最小间隔。
 *
 * 失败求值顺序（安全负责人 2026-10-13 批准，**每次只计首个原因码**）：
 * 发布物 JSON 解析 → 发布物结构/格式 → WebCrypto 可用性 → 验签 → 正文解析 → 正文格式 →
 * scope → 版本单调性 → 正文结构 → `consent_mode` 字段级例外。拒绝时**保持当前生效配置**，
 * 没有可用配置时才使用保守默认（`remote-config.md` 第 48 行 + CR-004 通则，AC-24 同口径）。
 *
 * **缓存是不可信输入**（安全项 8）：缓存只保存发布物本体；网络失败降级与 304 路径都必须
 * 走与拉取**完全相同**的 `processEnvelope()`（先对原始 `payload` 字符串重新验签，再解析）。
 * 因此 `source: 'cache'` 只可能在“本次读回并通过验签”之后出现。
 */
import { createConfigCache, isCacheFresh } from './cache';
import {
  CONFIG_CAPABILITY,
  CONFIG_REASON_CODES,
  FETCH_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  MIN_FETCH_GAP_MS,
  SUPPORTED_FORMAT_VERSION,
} from './constants';
import { createBuiltinConfig, createConservativeConfig } from './defaults';
import { buildConfigUrl, createFetchPort } from './fetch';
import { applyKillSwitch, evaluateKillSwitch } from './kill-switch';
import { mergeConfig } from './merge';
import { resolveWebCrypto, verifyEnvelope } from './signature';
import { validateEnvelopeShape, validateRemoteBody } from './validate';
import type {
  ConfigEnvelope,
  ConfigFetchResponse,
  ConfigRuntime,
  ConfigRuntimeOptions,
  ConsentMode,
  EffectiveConfig,
  PluginToggleSignal,
} from './types';
import type { Dispose } from '../kernel';
import { randomUnit } from '../sampling/session';

const PROCESSOR_ERROR = 'processor_error';
const PLUGIN_IDS: readonly ('error' | 'perf' | 'route' | 'http' | 'apm_dual_write')[] = [
  'error',
  'perf',
  'route',
  'http',
  'apm_dual_write',
];

type ConfigListener = (next: EffectiveConfig, previous: EffectiveConfig) => void;
type PluginListener = (signal: PluginToggleSignal) => void;

/** 发布物求值结果（拉取路径与缓存路径共用）。 */
interface EnvelopeOutcome {
  readonly status: 'applied' | 'rejected' | 'unavailable';
  readonly config?: EffectiveConfig | undefined;
  readonly reason?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 缓存里的发布物（信封）→ 共用求值路径可处理的记录形态（字段恒为已校验过的 5 个）。 */
function envelopeToRecord(envelope: ConfigEnvelope): Record<string, unknown> {
  return {
    format_version: envelope.format_version,
    key_id: envelope.key_id,
    alg: envelope.alg,
    payload: envelope.payload,
    signature: envelope.signature,
  };
}

/** 创建配置运行时。 */
export function createConfigRuntime(options: ConfigRuntimeOptions): ConfigRuntime {
  const { kernel } = options;
  const clock = options.clock ?? { now: () => Date.now() };
  const cache = options.cache ?? createConfigCache({ indexedDb: undefined });
  const fetchPort = options.fetch ?? createFetchPort({ timeoutMs: FETCH_TIMEOUT_MS });
  // 会话随机数可被重置（AC-12：撤回同意时清除）；`build()` 每次读取当前值。
  let sessionRandom = options.sessionRandom ?? 0;
  const random = options.random ?? randomUnit;
  const builtinConsent: ConsentMode = options.consentMode ?? 'essential_only';

  let current: EffectiveConfig = createBuiltinConfig(builtinConsent);
  let etag: string | undefined;
  let started = false;
  let stopped = false;
  let killed = false;
  let ready = false;
  let lastFetchAt: number | undefined;
  let inFlight: Promise<void> | undefined;
  const disposers: Dispose[] = [];
  const subscribers = new Set<ConfigListener>();
  const pluginListeners = new Set<PluginListener>();

  function count(reason: string): void {
    kernel.counters.count(reason);
  }

  function notify(next: EffectiveConfig, previous: EffectiveConfig): void {
    for (const listener of [...subscribers]) {
      try {
        listener(next, previous);
      } catch {
        count(PROCESSOR_ERROR);
      }
    }
  }

  function emitPluginToggle(signal: PluginToggleSignal): void {
    for (const listener of [...pluginListeners]) {
      try {
        listener(signal);
      } catch {
        count(PROCESSOR_ERROR);
      }
    }
  }

  function pluginPlan(config: EffectiveConfig): Readonly<Record<string, boolean>> {
    const plan: Record<string, boolean> = {};
    for (const id of PLUGIN_IDS) plan[id] = config.plugins[id].enabled;
    return plan;
  }

  /** 应用一份生效配置：同步插件启停、求值并生效 kill switch、通知订阅者。 */
  function applyConfig(next: EffectiveConfig): void {
    const previous = current;
    current = next;
    const decision = evaluateKillSwitch(next, options.sdkVersion);
    if (decision.all) killed = true;
    const plan = pluginPlan(next);
    kernel.applyPluginConfig(plan);
    emitPluginToggle({ enabled: plan, reason: decision.all ? 'kill_switch' : 'config' });
    if (decision.all || decision.plugins.length > 0) {
      applyKillSwitch(kernel, decision, stopInternal);
    }
    notify(next, previous);
  }

  function build(builtin: EffectiveConfig, remote: Readonly<Record<string, unknown>>, source: 'remote' | 'cache'): EffectiveConfig {
    const version = isInteger(remote['config_version']) ? remote['config_version'] : undefined;
    const publishedAt = isInteger(remote['published_at']) ? remote['published_at'] : undefined;
    const result = mergeConfig({
      builtin,
      remote,
      runtime: options.runtimeOverrides,
      configVersion: version,
      publishedAt,
      source,
      consentMode: options.consentMode,
      sessionRandom,
      sdkVersion: options.sdkVersion,
    });
    if (result.consentModeRejected) count(CONFIG_REASON_CODES.consentModeRejected);
    return result.config;
  }

  /** 是否已有可用配置（远程或**本次读回并验签通过**的缓存）。 */
  function hasUsableConfig(): boolean {
    return current.source === 'remote' || current.source === 'cache';
  }

  /**
   * 拒绝本次配置：只计首个原因码；有可用配置时保持不变，否则退回保守默认
   * （`remote-config.md` 第 48 行 + CR-004 通则；AC-24 修正后的口径）。
   */
  function reject(reason: string): void {
    count(reason);
    if (!hasUsableConfig()) applyConfig(createConservativeConfig(builtinConsent));
  }

  /**
   * 发布物求值（拉取与缓存共用，**唯一**的验签入口）。
   *
   * 缓存路径（`mode: 'cache'`）的版本比较允许相等（缓存就是我们刚接受的同一版本），
   * 只有更旧才判 `config_version_stale`；拉取路径要求严格递增（防回放，AC-08）。
   */
  async function processEnvelope(
    envelope: Readonly<Record<string, unknown>>,
    mode: 'remote' | 'cache',
  ): Promise<EnvelopeOutcome> {
    const shape = validateEnvelopeShape(envelope);
    if (!shape.ok) return { status: 'rejected', reason: shape.reason ?? CONFIG_REASON_CODES.signatureInvalid };

    // 安全项 8：缓存读数同样先验签；WebCrypto 不可用时不得信任任何配置（含缓存）
    const cryptoView = options.webcrypto ?? resolveWebCrypto();
    if (cryptoView.subtle === undefined) return { status: 'unavailable' };
    const verified = await verifyEnvelope(envelope, options.publicKeys, cryptoView);
    if (!verified.ok) {
      return { status: 'rejected', reason: verified.reason ?? CONFIG_REASON_CODES.signatureInvalid };
    }

    // 验签通过后才解析原始 payload 字符串
    const payloadText = envelope['payload'];
    if (!isString(payloadText)) return { status: 'rejected', reason: CONFIG_REASON_CODES.signatureInvalid };
    let body: unknown;
    try {
      body = JSON.parse(payloadText);
    } catch {
      return { status: 'rejected', reason: CONFIG_REASON_CODES.parseFailed };
    }
    if (!isRecord(body)) return { status: 'rejected', reason: CONFIG_REASON_CODES.schemaInvalid };
    if (body['format_version'] !== SUPPORTED_FORMAT_VERSION) {
      return { status: 'rejected', reason: CONFIG_REASON_CODES.formatUnsupported };
    }
    if (body['app_id'] !== options.appId || body['env'] !== options.env) {
      return { status: 'rejected', reason: CONFIG_REASON_CODES.scopeMismatch };
    }
    const version = body['config_version'];
    if (!isInteger(version)) return { status: 'rejected', reason: CONFIG_REASON_CODES.schemaInvalid };
    const currentVersion = current.config_version;
    if (currentVersion !== undefined) {
      const stale = mode === 'remote' ? version <= currentVersion : version < currentVersion;
      if (stale) return { status: 'rejected', reason: CONFIG_REASON_CODES.versionStale };
    }
    const validation = validateRemoteBody(body);
    if (!validation.ok) {
      return { status: 'rejected', reason: validation.reason ?? CONFIG_REASON_CODES.schemaInvalid };
    }
    return { status: 'applied', config: build(createBuiltinConfig(builtinConsent), body, mode) };
  }

  /** 缓存条目不可用（验签/结构失败）：按通则处理并删除该条目。 */
  async function discardCache(outcome: EnvelopeOutcome): Promise<void> {
    if (outcome.status === 'unavailable') {
      count(CONFIG_REASON_CODES.signatureUnavailable);
      applyConfig(createConservativeConfig(builtinConsent));
    } else {
      reject(outcome.reason ?? CONFIG_REASON_CODES.schemaInvalid);
    }
    await cache.remove();
  }

  /** 拉取失败/无 200 时的降级：已有可用配置则保持；否则未过期缓存 → 保守默认。 */
  async function degrade(): Promise<void> {
    count(CONFIG_REASON_CODES.fetchFailed);
    if (hasUsableConfig()) return;
    const entry = await cache.read();
    if (entry !== undefined) {
      if (isCacheFresh(entry, clock)) {
        const outcome = await processEnvelope(envelopeToRecord(entry.envelope), 'cache');
        if (outcome.status === 'applied' && outcome.config !== undefined) {
          applyConfig(outcome.config);
          return;
        }
        await discardCache(outcome);
        return;
      }
      count(CONFIG_REASON_CODES.cacheExpired);
    }
    applyConfig(createConservativeConfig(builtinConsent));
  }

  /**
   * 304：不重新解析正文，但**仍对缓存发布物重新验签**（否则 304 会成为绕过验签的旁路）；
   * 通过后刷新存储时间（滑动 TTL），仅在生效版本不同的时候重新应用。
   */
  async function handleNotModified(): Promise<void> {
    const entry = await cache.read();
    if (entry === undefined) {
      await degrade();
      return;
    }
    const outcome = await processEnvelope(envelopeToRecord(entry.envelope), 'cache');
    if (outcome.status === 'applied' && outcome.config !== undefined) {
      await cache.write({ envelope: entry.envelope, etag: entry.etag, stored_at: clock.now() });
      if (current.config_version !== outcome.config.config_version) applyConfig(outcome.config);
      return;
    }
    await discardCache(outcome);
  }

  /** 接收一份发布物（拉取路径）。 */
  async function accept(text: string, responseEtag: string | undefined): Promise<void> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      reject(CONFIG_REASON_CODES.parseFailed);
      return;
    }
    if (!isRecord(envelope)) {
      reject(CONFIG_REASON_CODES.schemaInvalid);
      return;
    }
    const outcome = await processEnvelope(envelope, 'remote');
    if (outcome.status === 'unavailable') {
      count(CONFIG_REASON_CODES.signatureUnavailable);
      applyConfig(createConservativeConfig(builtinConsent));
      return;
    }
    if (outcome.status === 'rejected' || outcome.config === undefined) {
      reject(outcome.reason ?? CONFIG_REASON_CODES.schemaInvalid);
      return;
    }
    const keyId = envelope['key_id'];
    const alg = envelope['alg'];
    const payload = envelope['payload'];
    const signature = envelope['signature'];
    if (isString(keyId) && isString(alg) && isString(payload) && isString(signature)) {
      const stored: ConfigEnvelope = {
        format_version: SUPPORTED_FORMAT_VERSION,
        key_id: keyId,
        alg,
        payload,
        signature,
      };
      etag = responseEtag;
      await cache.write({ envelope: stored, etag: responseEtag, stored_at: clock.now() });
    }
    applyConfig(outcome.config);
  }

  async function runRefresh(): Promise<void> {
    if (stopped || killed) return;
    const { configEndpoint, appId, env } = options;
    if (configEndpoint === undefined || appId === undefined || env === undefined) return;
    let response: ConfigFetchResponse;
    try {
      response = await fetchPort({ url: buildConfigUrl(configEndpoint, appId, env), etag });
    } catch {
      await degrade();
      return;
    }
    lastFetchAt = clock.now();
    if (response.status === 304) {
      await handleNotModified();
      return;
    }
    if (response.status !== 200) {
      await degrade();
      return;
    }
    await accept(response.body, response.etag);
  }

  function refresh(): Promise<void> {
    if (stopped || killed) return Promise.resolve();
    if (inFlight !== undefined) return inFlight;
    inFlight = runRefresh()
      .catch(() => {
        count(PROCESSOR_ERROR);
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  function maybeRefresh(): void {
    if (lastFetchAt !== undefined && clock.now() - lastFetchAt < MIN_FETCH_GAP_MS) return;
    void refresh();
  }

  function isDocumentVisible(): boolean {
    const scope = globalThis as { document?: { visibilityState?: string | undefined } | undefined };
    return scope.document?.visibilityState === 'visible';
  }

  function stopInternal(): void {
    if (stopped) return;
    stopped = true;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        count(PROCESSOR_ERROR);
      }
    }
  }

  const runtime: ConfigRuntime = {
    current: () => current,
    subscribe(listener: ConfigListener): Dispose {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    start(): void {
      if (started || stopped) return;
      started = true;
      ready = true;
      disposers.push(
        kernel.registry.listenGlobal('visibilitychange', () => {
          if (isDocumentVisible()) maybeRefresh();
        }),
      );
      disposers.push(
        kernel.registry.scheduleRepeat(() => {
          maybeRefresh();
        }, FETCH_INTERVAL_MS),
      );
      void refresh();
    },
    stop: stopInternal,
    refresh,
    onPluginToggle(listener: PluginListener): Dispose {
      pluginListeners.add(listener);
      return () => {
        pluginListeners.delete(listener);
      };
    },
    isKilled: () => killed,
    ready: () => ready,
    sessionRandom: () => sessionRandom,
    resetSessionRandom(): number {
      sessionRandom = random();
      return sessionRandom;
    },
  };

  kernel.registerCapability(CONFIG_CAPABILITY, runtime);
  return runtime;
}
