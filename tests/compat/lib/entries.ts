/**
 * T30 兼容矩阵的「产物入口」加载层。
 *
 * ## 为什么用「变量说明符的动态 import」（与 `tests/bench/lib/entries.ts`、`tests/contract/lib/` 同一原因）
 *
 * 根 `tsconfig.json` 用 `include: ["*.ts", "tests/**\/*.ts"]` 把 `tests/**` 纳入根程序，而根程序是
 * `lib: ["ES2022"]` + `types: ["node"]`，各包源码按自己的 tsconfig（含 `DOM`）编写。
 * 任何**静态可解析**的导入都会把这些源码（经 `customConditions: ["source"]` 与 dist 声明文件里的
 * 裸包名）拉进根程序，产生 `IDBDatabase`/`XMLHttpRequest`/`BufferSource` 等成片 lib 错误，
 * 使 `pnpm typecheck` 失败。说明符写成变量后 TS 不做静态解析，根 typecheck 保持通过。
 *
 * ## 与基准的差别：这里加载的是 **dist 产物**
 *
 * 兼容性测试的对象是**发布出去的东西**（接入方拿到的就是各包的 `dist`），不是源码；
 * 本模块因此指向 `packages/browser/dist/index.js` 与 `packages/transport/dist/index.js`。
 * 前提：仓库先 `pnpm build`（门禁顺序本来就是 build 先于 typecheck/test）。
 *
 * ## 代价与补偿
 *
 * 1. 跨这条边界没有静态类型：下面只声明兼容用例真正调用的成员；
 * 2. `loadEntry` 在运行期断言入口存在、且**必须的导出都不是 `undefined`**，缺失立刻抛错；
 * 3. 断言针对真实行为（批次内容、hook 链形态），不依赖这里的类型精度。
 */

/** 一个「记录型」值。 */
export type Loose = Record<string, unknown>;

function asRecord(value: unknown, label: string): Loose {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value as Loose;
}

/* --------------------------------------------------------------- 结构类型（按需声明） */

/** C01 公共客户端的调用面。 */
export interface ClientLike {
  init(options?: Loose): void;
  track(name: string, input?: Loose): void;
  captureError(error: unknown, input?: Loose): void;
  flush(): void;
  destroy(): void;
}

/** 原因码计数器。 */
export interface CountersLike {
  count(reason: string, delta?: number): void;
  get(reason: string): number;
  snapshot(): Readonly<Record<string, number>>;
}

/** 内核（只用到计数器）。 */
export interface KernelLike {
  readonly counters: CountersLike;
}

/** `createAssembly()` 的返回句柄（兼容用例用到的成员）。 */
export interface AssemblyLike {
  readonly client: ClientLike;
  readonly kernel: KernelLike;
  readonly nativeHttpRefs: { readonly fetch?: unknown };
  init(overrides?: Loose): void;
  flush(): void;
  destroy(): void;
}

/** `@web-report-sdk/browser` 入口。 */
export interface BrowserEntry {
  readonly createAssembly: (options: Loose) => AssemblyLike;
  readonly SDK_VERSION: string;
}

/** 传输请求（与 `packages/transport/src/sender/types.ts` 结构一致）。 */
export interface TransportRequestLike {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bodyBytes: Uint8Array | undefined;
  readonly keepalive: boolean;
  readonly timeoutMs: number;
}

/** 传输响应。 */
export interface TransportResponseLike {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** 传输适配器端口（注入点）。 */
export interface TransportPortLike {
  send(request: TransportRequestLike): Promise<TransportResponseLike>;
}

/** 广播通道（最小能力）。 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

/** 广播端口。 */
export interface BroadcastPortLike {
  open(name: string): BroadcastChannelLike | null;
}

/** Web Locks 端口。 */
export interface LocksPortLike {
  tryAcquire(name: string, task: () => Promise<void>): Promise<boolean>;
}

/** 选主结果。 */
export interface LeaderRunResultLike<T> {
  readonly leader: boolean;
  readonly mode: string;
  readonly result: T | undefined;
}

/** 选主器。 */
export interface LeaderElectionLike {
  run<T>(task: () => Promise<T>): Promise<LeaderRunResultLike<T>>;
  mode(): string;
  lastLeader(): boolean;
}

/** `@web-report-sdk/transport` 入口（兼容用例用到的成员）。 */
export interface TransportEntry {
  readonly createDefaultLocksPort: () => LocksPortLike | null;
  readonly createDefaultBroadcastPort: () => BroadcastPortLike | null;
  readonly createLeaderElection: (options: Loose) => LeaderElectionLike;
}

/* ------------------------------------------------------------------------- 加载器 */

const BROWSER_ENTRY = '../../../packages/browser/dist/index.js';
const TRANSPORT_ENTRY = '../../../packages/transport/dist/index.js';

async function loadEntry<TEntry>(entry: string, required: readonly string[]): Promise<TEntry> {
  const loaded: unknown = await import(/* @vite-ignore */ entry);
  const record = asRecord(loaded, `产物入口 ${entry}`);
  const missing = required.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`产物入口 ${entry} 缺少导出：${missing.join('、')}（先跑 pnpm build）`);
  }
  return loaded as TEntry;
}

/** 加载 `@web-report-sdk/browser` 的 dist 产物。 */
export const loadBrowserEntry = (): Promise<BrowserEntry> =>
  loadEntry<BrowserEntry>(BROWSER_ENTRY, ['createAssembly', 'SDK_VERSION']);

/** 加载 `@web-report-sdk/transport` 的 dist 产物。 */
export const loadTransportEntry = (): Promise<TransportEntry> =>
  loadEntry<TransportEntry>(TRANSPORT_ENTRY, [
    'createDefaultLocksPort',
    'createDefaultBroadcastPort',
    'createLeaderElection',
  ]);
