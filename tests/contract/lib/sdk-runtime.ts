/**
 * 真实 SDK 产出的驱动层（T10 追加项：用 Ajv 校验**真实产出**，而不是只看契约样例）。
 *
 * ## 为什么用「变量说明符的动态 import」
 *
 * 根 `tsconfig.json`（门禁配置，本任务不可修改）用 `include: ["*.ts", "tests/**\/*.ts"]`
 * 把 `tests/contract/**` 纳入根程序，但根程序是 `lib: ["ES2022"]` + `types: ["node"]`，
 * 而 `packages/core/src`、`packages/transport/src` 是按各自 tsconfig 的
 * `lib: ["ES2020", "DOM", "DOM.Iterable"]` 写的。任何**静态可解析**的导入
 * （普通 `import`，或字面量说明符的 `import()`）都会让 tsc 把这些源码拉进根程序，
 * 产生 5 处 lib 冲突（`globalThis.window`、`setTimeout` 返回 `Timeout` 而不是 `number`），
 * 使 `pnpm typecheck` 失败。把说明符写成变量后 TS 不做静态解析，根 typecheck 保持通过；
 * 运行期加载的仍是**真实源码入口**，即各包 `package.json`
 * `exports["."].source` 指向的文件（`src/index.ts`，也是构建产物的来源）。
 *
 * ## 代价与补偿
 *
 * 跨这条边界没有静态类型。为了不把问题藏起来：
 *
 * 1. `importEntry` 在运行期断言所需导出确实存在且是函数，缺失立刻抛错；
 * 2. 下面的结构类型只声明本任务真正调用的方法，签名与 `packages/core/README.md`
 *    第 11 节、`packages/transport/README.md` 第 2.4 节记载的接口一致；
 * 3. 真实产出的字段是否正确由**冻结 Schema**（Ajv）判定，不靠这里的类型。
 */
import { asRecord } from './fs-json';

/**
 * 真实入口路径（相对本文件）。
 * `packages/core/package.json` / `packages/transport/package.json` 的
 * `exports["."].source` 分别指向这两个文件；用包名导入在本仓库不可行
 * （根 `package.json` 未声明对工作区包的依赖，根 `node_modules` 下没有对应软链，
 * 而根 `package.json` 属门禁配置，不在本任务可写范围内）。
 */
const CORE_ENTRY = '../../../packages/core/src/index.ts';
const TRANSPORT_ENTRY = '../../../packages/transport/src/index.ts';

/** 一个事件体，即 `batch.schema.json` 的 `$defs/event` 那一层。 */
export type SdkEvent = Record<string, unknown>;

/**
 * C01 公共 API 的选项（`ClientOptions` / `ClientInitOptions` 的合并视图）。
 *
 * 带索引签名是为了让调用点保持 `exactOptionalPropertyTypes` 下可用，
 * 同时给 `onEvent` 一个上下文类型（回调参数不必手写注解）。
 */
export interface RealClientOptions {
  /** 原生事件目标；`null` 表示没有原生目标（SSR / Node 的文档化路径）。 */
  readonly target?: unknown;
  readonly registry?: unknown;
  /** 位置来源注入点，用于 `url` / `page_id` 的调用当时快照。 */
  readonly location?: unknown;
  readonly debug?: unknown;
  /** 运行期事件字典（K01 生成物形态）。 */
  readonly dictionary?: unknown;
  /** 事件出口；每次产出一条事件调用一次。 */
  readonly onEvent?: ((event: unknown) => void) | undefined;
  readonly appId?: string | undefined;
  readonly env?: string | undefined;
  readonly release?: string | undefined;
  readonly consent?: string | undefined;
  readonly pageId?: string | undefined;
  readonly [option: string]: unknown;
}

/** C01 公共 API 客户端中本任务驱动到的方法。 */
export interface RealClient {
  init(options?: RealClientOptions): void;
  track(name: string, input?: unknown): void;
  log(level: string, message: string, input?: unknown): void;
  captureError(error: unknown, input?: unknown): void;
  setUser(id: string, options?: unknown): void;
  clearUser(): void;
  setContext(key: string, value: string): void;
  removeContext(key: string): void;
  setPage(pageId: string): void;
  setConsent(state: string): void;
  flush(): void;
  destroy(): void;
}

/** `@web-report-sdk/core` 入口中本任务用到的导出。 */
export interface RealCoreModule {
  readonly createClient: (options: RealClientOptions) => RealClient;
  readonly createUuid: () => string;
}

/** C06 批次组装器的批次头来源（对齐 `BatchHeaderSource`）。 */
export interface RealBatchHeaderSource {
  readonly header: () => unknown;
}

/** C06 批次组装器选项（对齐 `BatchAssemblerOptions`）。 */
export interface RealAssemblerOptions {
  readonly header: RealBatchHeaderSource;
  readonly now?: (() => number) | undefined;
  readonly createId?: (() => string) | undefined;
}

/** C06 批次组装器（对齐 `BatchAssembler`）。 */
export interface RealBatchAssembler {
  assemble(events: readonly Record<string, unknown>[]): Record<string, unknown>;
}

/** `@web-report-sdk/transport` 入口中本任务用到的导出。 */
export interface RealTransportModule {
  readonly createBatchAssembler: (options: RealAssemblerOptions) => RealBatchAssembler;
}

/**
 * 动态导入一个真实入口，并断言列出的导出确实存在且是函数。
 * 说明符是变量，因此 TS 不会把它静态解析进根程序（见文件头注释）。
 */
const importEntry = async <TModule>(entry: string, requiredExports: readonly string[]): Promise<TModule> => {
  const loaded: unknown = await import(/* @vite-ignore */ entry);
  const record = asRecord(loaded, `真实入口 ${entry}`);
  for (const key of requiredExports) {
    if (typeof record[key] !== 'function') {
      throw new Error(`真实入口 ${entry} 没有导出函数 ${key}`);
    }
  }
  return loaded as TModule;
};

/** 加载 C01 公共 API 所在包的真实入口。 */
export const loadCoreModule = (): Promise<RealCoreModule> =>
  importEntry<RealCoreModule>(CORE_ENTRY, ['createClient', 'createUuid']);

/** 加载 C06 批次组装器所在包的真实入口。 */
export const loadTransportModule = (): Promise<RealTransportModule> =>
  importEntry<RealTransportModule>(TRANSPORT_ENTRY, ['createBatchAssembler']);
