/**
 * 「有意未使用的参数」标记。
 *
 * 某些导出必须保留完整签名（否则调用方无法按最终形态接线），但实现当前不读取该参数。
 * `noUnusedParameters` 与 `@typescript-eslint/no-unused-vars` 都要求参数被“用到”，
 * 而 `void parameter;` 会被 `no-meaningless-void-operator` 判为无意义（其操作数不是调用）。
 *
 * 因此用一个**只读取参数、不产生副作用**的函数显式声明"我读过它，只是当前不用"。
 * 该函数不导出给接入方（`internal/` 不在子路径导出表里）。
 */
export function unused(...values: readonly unknown[]): number {
  // 只读取实参、不做任何事；返回值是实参个数，便于调用方需要时使用。
  return values.length;
}
