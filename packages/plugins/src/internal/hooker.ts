/**
 * 包装端口与内存实现。
 *
 * `Hooker` 是 C02 `GlobalRegistry.hook` 的结构子集；route 与 http 两个插件都需要
 * "包装原生方法并成对恢复"，若让 http 直接 import route 的类型，两个**独立入口**之间
 * 就产生了不该有的耦合（`@web-report-sdk/plugins/http` 会牵出 route 的类型）。
 *
 * 语义（与 C02 注册表一致，满足 T18-plan §6 的 Q7 叠加规则）：
 * - 安装时保存**当前**引用并把包装叠在其上；
 * - 仅当当前值**仍是自己的包装**时才还原（否则会误删第三方 hook）。
 */
export interface Hooker {
  hook<T extends object, K extends keyof T>(
    target: T,
    key: K,
    wrapper: (original: T[K]) => T[K],
  ): () => void;
}

/**
 * 内存实现：**没有内核注册表时的降级包装器**（装配根未注入 `registry` 的场景），
 * 也是测试注入的默认实现。语义与 C02 注册表逐条对齐（含条件还原）。
 */
export function createInlineHooker(): Hooker {
  return {
    hook<T extends object, K extends keyof T>(
      target: T,
      key: K,
      wrapper: (original: T[K]) => T[K],
    ): () => void {
      const saved = target[key];
      const wrapped = wrapper(saved);
      target[key] = wrapped;
      return (): void => {
        // 只还原自己装上的那一层：期间被第三方替换过就不动它。
        if (target[key] === wrapped) target[key] = saved;
      };
    },
  };
}
