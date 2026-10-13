/**
 * 内建默认值与保守默认（T13）。
 *
 * 口径（对接负责人 2026-10-13 裁定）：
 * - **内建默认值**（配置存在但字段缺失时的兜底）是 SDK 内部实现，不需要契约变更；
 * - **保守默认**（无可用配置时的兜底）必须逐字符合 `remote-config.md` 第 56 行：
 *   只保留 critical 事件与 JS 错误采集、采样率 1、其他插件关闭、`consent_mode` 取初始化参数；
 * - **与其它模块重叠的默认值以模块所有者为准**：`transport` 各字段的默认与钳制归 C06
 *   （`packages/transport/README.md`），C03 的 builtin `transport` 留空、不复制一份。
 */
import type { ConsentMode, EffectiveConfig, PluginName, ResolvedPluginSetting } from './types';
import { PLUGIN_NAMES } from './types';

/** 插件默认开关（内建默认；对齐 `remote-config.valid.json` 的 `decoded_payload`）。 */
const BUILTIN_PLUGINS: Readonly<Record<string, boolean>> = {
  error: true,
  perf: true,
  route: true,
  http: false,
  apm_dual_write: false,
};

/** 保守默认的插件开关：只保留 JS 错误采集（critical 由 client 直报，不依赖插件）。 */
const CONSERVATIVE_PLUGINS: Readonly<Record<string, boolean>> = {
  error: true,
  perf: false,
  route: false,
  http: false,
  apm_dual_write: false,
};

function pluginSettings(flags: Readonly<Record<string, boolean>>): Readonly<Record<PluginName, ResolvedPluginSetting>> {
  const result = {} as Record<PluginName, ResolvedPluginSetting>;
  for (const name of PLUGIN_NAMES) {
    result[name] = { enabled: flags[name] === true };
  }
  return result;
}

/** 创建内建默认配置（`transport` 留空，默认与钳制归 C06）。 */
export function createBuiltinConfig(consentMode: ConsentMode): EffectiveConfig {
  return {
    source: 'builtin',
    config_version: undefined,
    published_at: undefined,
    sampling: { session_rate: 1, allow_users: [], rules: [] },
    kill_switch: { all: false, sdk_versions: [], plugins: [] },
    plugins: pluginSettings(BUILTIN_PLUGINS),
    privacy: {
      consent_mode: consentMode,
      url_query_allowlist: [],
      sensitive_headers: [],
      extra_mask_rules: [],
    },
    endpoints: {},
    transport: {},
    debug: undefined,
    applied_overrides: 0,
  };
}

/**
 * 创建保守默认配置（`remote-config.md` 第 56 行）。
 * 只保留 critical 事件与 JS 错误采集；采样率 1；其他插件关闭。
 */
export function createConservativeConfig(consentMode: ConsentMode): EffectiveConfig {
  return {
    source: 'conservative',
    config_version: undefined,
    published_at: undefined,
    sampling: { session_rate: 1, allow_users: [], rules: [] },
    kill_switch: { all: false, sdk_versions: [], plugins: [] },
    plugins: pluginSettings(CONSERVATIVE_PLUGINS),
    privacy: {
      consent_mode: consentMode,
      url_query_allowlist: [],
      sensitive_headers: [],
      extra_mask_rules: [],
    },
    endpoints: {},
    transport: {},
    debug: undefined,
    applied_overrides: 0,
  };
}
