/**
 * C05 与第三方 APM 共存（Q7；AC-19、AC-20）的启停缺省解析。
 *
 * 裁定（T18-plan §1、§13-④）：**共存模式在初始化参数中声明**。
 * - 初始化时处于共存模式 → 相关插件**默认关闭**，之后可由远程配置**逐个开启**；
 * - 不处于共存模式 → 走 C03 的内建默认表（error/perf/route 开、http 关）。
 *
 * 两种缺省不同是**有意**的（共存模式面向"已有 APM、先不重复采集"的接入方）。
 * 与 C03「运行期只能关不能开」不冲突：这里解析的是**初始化缺省 + 远程配置缺省值**，
 * 不是运行期覆盖。
 */

/** `COLLECTOR_PLUGIN_IDS` 的结构子集（与 `packages/core` 的取值一致）。 */
export const COLLECTOR_IDS: readonly string[] = ['error', 'perf', 'route', 'http'];

/** 非共存模式下的内建缺省（C03 默认表）：error/perf/route 开、http 关。 */
export const BUILTIN_DEFAULTS: Readonly<Record<string, boolean>> = {
  error: true,
  perf: true,
  route: true,
  http: false,
};

/** 共存模式下的缺省：错误、性能、HTTP 插件默认关闭（AC-20）；路由采集不重复也不上报第三方数据。 */
export const COEXISTENCE_DEFAULTS: Readonly<Record<string, boolean>> = {
  error: false,
  perf: false,
  route: false,
  http: false,
};

/** 共存模式声明：初始化参数。 */
export interface CoexistenceInitOptions {
  /** 是否处于第三方 APM 共存模式（AC-20 的缺省来源）。 */
  readonly apmCoexistence?: boolean | undefined;
}

/** 远程配置里的插件开关形状（`plugins.<id>.enabled`）。 */
export type RemotePluginSettings = Readonly<
  Record<string, { readonly enabled?: boolean | undefined } | undefined>
>;

/**
 * 解析出要交给 `kernel.applyPluginConfig` 的启停表。
 *
 * 规则：
 * - 非共存模式 → `BUILTIN_DEFAULTS`；
 * - 共存模式 → `COEXISTENCE_DEFAULTS`，再叠加**远程配置**里显式给出的 `enabled`
 *   （AC-20「可由远程配置逐个开启」）。远程配置只影响它**显式声明**的插件，
 *   未声明的保持共存模式缺省（关闭）。
 */
export function resolvePluginDefaults(
  init: CoexistenceInitOptions,
  remotePlugins?: RemotePluginSettings,
): Readonly<Record<string, boolean>> {
  const base = init.apmCoexistence === true ? COEXISTENCE_DEFAULTS : BUILTIN_DEFAULTS;
  const resolved: Record<string, boolean> = { ...base };
  if (init.apmCoexistence !== true || remotePlugins === undefined) return resolved;
  for (const id of COLLECTOR_IDS) {
    const enabled = remotePlugins[id]?.enabled;
    if (enabled !== undefined) resolved[id] = enabled;
  }
  return resolved;
}
