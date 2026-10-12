/**
 * C01 全局单例 API（T12）：`window.WebReportSDK` 与 npm 默认入口共同使用的形态。
 *
 * 与 `createClient` 的区别只有一处：模块在被导入时创建一个默认实例，
 * 因此未 `init` 就调用 `track` 等方法是安全的——调用进入命令队列，`init` 后按序回放。
 * 除此之外模块顶层无其它副作用（不注册监听、不访问 `window`）。
 */
import { createClient } from './client';
import type { Client } from './types';
import type { EventDictionary, PermissiveDictionary } from './typed-events';


/** 全局单例 API：拥有 `Client` 的全部方法。 */
export type Sdk<TDictionary extends EventDictionary = PermissiveDictionary> = Client<TDictionary>;

/** 创建 SDK 单例。每次调用都会创建一个新的独立实例（多实例请用 `createClient`）。 */
export function createSdk<TDictionary extends EventDictionary = PermissiveDictionary>(): Sdk<TDictionary> {
  return createClient<TDictionary>();
}
