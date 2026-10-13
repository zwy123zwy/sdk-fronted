/**
 * 未命中会话拆除监听（T13，C03-F6）。
 *
 * 会话未命中时经内核公共 API 卸载采集类插件（`error`/`perf`/`route`/`http` 与 `apm_dual_write`，
 * 对接负责人 2026-10-13 裁定 apm_dual_write 同处理），释放其监听与 hook；critical 事件由 client 直报，
 * 仍可上报。返回发给装配根的启停信号（collectors 一律 false，其余保持当前配置）。
 *
 * 不可恢复：会话随机数与命中结果是会话属性（`remote-config.md` 5.2），本次会话不提供恢复路径。
 * 使用内核公共 API，**不修改 `packages/core/src/kernel/**`**。
 */
import { COLLECTOR_PLUGIN_IDS } from '../config/constants';
import type { ConfigReader, PluginToggleSignal } from '../config/types';
import type { Kernel } from '../kernel';

/** 会话未命中时拆除采集监听；返回发给装配根的启停信号。 */
export function teardownForSampledOutSession(
  kernel: Kernel,
  config: ConfigReader,
): PluginToggleSignal | undefined {
  const settings = config.current().plugins as Readonly<
    Record<string, { readonly enabled: boolean } | undefined>
  >;
  const enabled: Record<string, boolean> = {};
  for (const [name, setting] of Object.entries(settings)) {
    enabled[name] = setting?.enabled === true;
  }
  for (const pluginId of COLLECTOR_PLUGIN_IDS) {
    kernel.plugins.uninstall(pluginId);
    enabled[pluginId] = false;
  }
  return { enabled, reason: 'sampled_out_session' };
}
