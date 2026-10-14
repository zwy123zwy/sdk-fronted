/**
 * 真实入口的加载层（T20）。
 *
 * ## 为什么用「变量说明符的动态 import」（与 `tests/contract/lib/sdk-runtime.ts` 同一原因）
 *
 * 根 `tsconfig.json` 用 `include: ["*.ts", "tests/**\/*.ts"]` 把 `tests/**` 纳入根程序，而根程序
 * 是 `lib: ["ES2022"]` + `types: ["node"]`，各包源码按自己的 tsconfig（含 `DOM`）编写。
 * 任何**静态可解析**的导入都会把这些源码拉进根程序，产生 lib 冲突并使 `pnpm typecheck` 失败。
 * 说明符写成变量后 TS 不做静态解析，根 typecheck 保持通过；运行期加载的仍是各包
 * `package.json` 的 `exports["."].source` 指向的真实源码入口（`src/index.ts`）。
 *
 * ## 代价与补偿
 *
 * 1. 跨这条边界没有静态类型：下面的结构类型只声明基准真正调用的成员，签名对齐各包 README；
 * 2. `loadEntries` 在运行期断言入口存在、且**必须的导出都不是 undefined**，缺失立刻抛错
 *    （避免「以为测了实现，其实测了个空壳」）；
 * 3. 基准断言真实行为的样本量/结果，不依赖这里的类型精度。
 */

/** 一个「记录型」值；`asRecord` 之后可以按键取值。 */
export type Loose = Record<string, unknown>;

function asRecord(value: unknown, label: string): Loose {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value as Loose;
}

/* ------------------------------------------------------------------ C01/C02/C03/C04 */

/** C01 公共 API 客户端（本基准用到的成员）。 */
export interface ClientLike {
  init(options?: Loose): void;
  track(name: string, input?: Loose): void;
  setConsent(state: string): void;
  flush(): void;
  destroy(): void;
}

/** C02 原因码计数器（C08 的计数操作载体）。 */
export interface CountersLike {
  count(reason: string, delta?: number): void;
  get(reason: string): number;
  snapshot(): Readonly<Record<string, number>>;
  reset(): void;
}

/** C01 命令队列。 */
export interface CommandQueueLike {
  push(command: Loose): { readonly status: string };
  shift(): Loose | undefined;
  size(): number;
  capacity(): number;
  clear(): void;
}

/** 六段管线中的处理器。 */
export type ProcessorFn = (event: Loose, context?: unknown) => unknown;

/** C02 内核（本基准用到的成员）。 */
export interface KernelLike {
  init(): void;
  start(): void;
  destroy(): void;
  markConfigReady(): void;
  report(event: Loose): unknown;
  registerProcessor(stage: string, processor: ProcessorFn): unknown;
  readonly pipeline: {
    process(event: Loose): unknown;
    size(stage: string): number;
  };
  readonly prestartQueue: {
    push(event: Loose): unknown;
    drain(): readonly Loose[];
    size(): number;
    capacity(): number;
    clear(): void;
  };
  readonly counters: {
    get(key: string): number | undefined;
    snapshot(): Readonly<Record<string, number>>;
  };
}

/** C03 配置读取器。 */
export interface ConfigReaderLike {
  current(): Loose;
  subscribe(listener: () => void): () => void;
}

/** C03 会话采样。 */
export interface SessionSamplingLike {
  /** 会话是否命中（具体方法名由实现决定，基准只透传）。 */
  readonly [member: string]: unknown;
}

/** 脱敏器。 */
export interface MaskerLike {
  apply(value: string): string;
}

/** 页面追踪器。 */
export interface PageTrackerLike {
  snapshot(): Loose;
  enrich(event: Loose): Loose;
}

/** 公共上下文存储（同时满足 `ContextEnrichPort`）。 */
export interface ContextStoreLike {
  enrich(event: Loose): Loose;
  setContext(key: string, value: string): void;
}

/** `@web-report-sdk/core` 入口的加载结果。 */
export interface CoreEntry {
  readonly createClient: (options: Loose) => ClientLike;
  readonly createCommandQueue: (options?: Loose) => CommandQueueLike;
  readonly createKernel: (options: Loose) => KernelLike;
  readonly PIPELINE_STAGES: readonly string[];
  readonly PRESTART_QUEUE_CAPACITY: number;
  readonly createBuiltinConfig: (profile: string) => Loose;
  readonly mergeConfig: (input: Loose) => { readonly config: Loose };
  readonly createSamplingProcessor: (options: Loose) => unknown;
  readonly createSessionSampling: (options: Loose) => SessionSamplingLike;
  readonly createFieldConstraintsProcessor: (options: Loose) => ProcessorFn;
  readonly createMasker: () => MaskerLike;
  readonly C04_LIMITS: Loose;
  readonly CONSENT_BUFFER_MAX_EVENTS: number;
  readonly CONSENT_BUFFER_MAX_BYTES: number;
  readonly createPageTracker: (options: Loose) => PageTrackerLike;
  readonly createConsentManager: (options: Loose) => unknown;
  readonly createContextStore: (options: Loose) => ContextStoreLike;
  readonly createContextEnrichProcessor: (port: ContextStoreLike) => ProcessorFn;
  readonly createUuid: () => string;
  readonly createCounters: () => CountersLike;
}

/* ------------------------------------------------------------------ C06/C07/C08 */

/** C06 传输队列。 */
export interface TransportQueueLike {
  enqueue(event: Loose): unknown;
  flush(reason?: string): unknown;
  queueLength(): number;
  queueBytes(): number;
  limits(): Loose;
  dispose(): void;
}

/** C06 批次组装器。 */
export interface BatchAssemblerLike {
  assemble(events: readonly Loose[]): Loose;
}

/** C07 离线存储。 */
export interface OfflineStoreLike {
  ready(): Promise<void>;
  prewrite(batch: Loose): { readonly settled: Promise<unknown> };
  stats(): {
    readonly exposure: {
      readonly commitLatencyP50Ms: number | null;
      readonly commitLatencyP95Ms: number | null;
      readonly commitLostEvents: number;
    };
  };
  dispose(): void;
}

/** C08 流量占比。 */
export interface TrafficShareLike {
  readonly healthEvents: number;
  readonly businessEvents: number;
  readonly healthBytes: number;
  readonly businessBytes: number;
  readonly countRatio: number;
  readonly byteRatio: number;
}

/** `@web-report-sdk/transport` 入口的加载结果。 */
export interface TransportEntry {
  readonly createTransportQueue: (options: Loose) => TransportQueueLike;
  readonly createBatchAssembler: (options: Loose) => BatchAssemblerLike;
  readonly createOfflineStore: (options: Loose) => OfflineStoreLike;
  readonly buildHealthMetrics: (input: Loose) => Record<string, number>;
  readonly buildHealthEvents: (input: Loose) => readonly unknown[];
  readonly measureTrafficShare: (health: readonly unknown[], business: readonly unknown[]) => TrafficShareLike;
  readonly jsonSize: (value: unknown) => number;
  readonly COUNT_REASON_CODES: readonly string[];
  readonly DROP_REASON_CODES: readonly string[];
  /** 内存队列默认上限（C06-F1）：条数与体积。 */
  readonly QUEUE_MAX_EVENTS: number;
  readonly QUEUE_MAX_BYTES: number;
}

/* ------------------------------------------------------------------ K02 */

/** K02 进程内 CLI 结果。 */
export interface CliResultLike {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** K02 全流程工作树（`tools/config-signer/src/__tests__/workflow.ts`）。 */
export interface K02WorkflowLike {
  readonly directory: string;
  readonly bodyPath: string;
  readonly privateKeyPath: string;
  readonly publicKeysPath: string;
  readonly envelopePath: string;
  readonly cleanup: () => Promise<void>;
}

/** `tools/config-signer/src/__tests__/` 下的测试支撑。 */
export interface K02SupportEntry {
  readonly run: (args: readonly string[]) => Promise<CliResultLike>;
  readonly runFullWorkflow: (options?: Loose) => Promise<K02WorkflowLike>;
}

/* ------------------------------------------------------------------ 加载器 */

/** 入口路径（相对本文件）：与各包 `exports["."].source` 一致。 */
const CORE_ENTRY = '../../../packages/core/src/index.ts';
const TRANSPORT_ENTRY = '../../../packages/transport/src/index.ts';
const K02_WORKFLOW_ENTRY = '../../../tools/config-signer/src/__tests__/workflow.js';
const K02_SUPPORT_ENTRY = '../../../tools/config-signer/src/__tests__/test-support.js';

async function importEntry<TEntry>(entry: string, required: readonly string[]): Promise<TEntry> {
  const loaded: unknown = await import(/* @vite-ignore */ entry);
  const record = asRecord(loaded, `真实入口 ${entry}`);
  const missing = required.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`真实入口 ${entry} 缺少导出：${missing.join('、')}`);
  }
  return loaded as TEntry;
}

/** 加载 `@web-report-sdk/core` 的真实入口。 */
export const loadCoreEntry = (): Promise<CoreEntry> =>
  importEntry<CoreEntry>(CORE_ENTRY, [
    'createClient',
    'createCommandQueue',
    'createKernel',
    'PIPELINE_STAGES',
    'PRESTART_QUEUE_CAPACITY',
    'createBuiltinConfig',
    'mergeConfig',
    'createSamplingProcessor',
    'createSessionSampling',
    'createFieldConstraintsProcessor',
    'createMasker',
    'C04_LIMITS',
    'CONSENT_BUFFER_MAX_EVENTS',
    'CONSENT_BUFFER_MAX_BYTES',
    'createPageTracker',
    'createConsentManager',
    'createContextStore',
    'createContextEnrichProcessor',
    'createCounters',
  ]);

/** 加载 `@web-report-sdk/transport` 的真实入口。 */
export const loadTransportEntry = (): Promise<TransportEntry> =>
  importEntry<TransportEntry>(TRANSPORT_ENTRY, [
    'createTransportQueue',
    'createBatchAssembler',
    'createOfflineStore',
    'buildHealthMetrics',
    'buildHealthEvents',
    'measureTrafficShare',
    'jsonSize',
    'COUNT_REASON_CODES',
    'DROP_REASON_CODES',
    'QUEUE_MAX_EVENTS',
    'QUEUE_MAX_BYTES',
  ]);

/** C07 离线存储的测试夹具（内存后端，非公共导出，仅供测试）。 */
export interface OfflineFixturesEntry {
  readonly createRecordingBackend: () => { readonly backend: unknown };
  readonly makeBatch: (overrides?: Loose) => Loose;
  readonly makeEvent: (overrides?: Loose) => Loose;
}

const OFFLINE_FIXTURES_ENTRY = '../../../packages/transport/src/offline/fixtures.ts';

/** 加载 C07 的内存后端夹具（与 `packages/transport/src/offline/perf.test.ts` 同一套）。 */
export const loadOfflineFixtures = (): Promise<OfflineFixturesEntry> =>
  importEntry<OfflineFixturesEntry>(OFFLINE_FIXTURES_ENTRY, ['createRecordingBackend', 'makeBatch', 'makeEvent']);

/** 加载 K02 的进程内 CLI 支撑（`run` 直接调用 `runCli`，不启子进程）。 */
export const loadK02Support = async (): Promise<K02SupportEntry> => {
  const support = await importEntry<{ readonly run: K02SupportEntry['run'] }>(K02_SUPPORT_ENTRY, ['run']);
  const workflow = await importEntry<{ readonly runFullWorkflow: K02SupportEntry['runFullWorkflow'] }>(
    K02_WORKFLOW_ENTRY,
    ['runFullWorkflow'],
  );
  return { run: support.run, runFullWorkflow: workflow.runFullWorkflow };
};
