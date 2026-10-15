/**
 * `examples/webpack/scripts/lib/verify-bundle.mjs` 的类型声明。
 *
 * 为什么需要它：`tests/compat/receiver-contract-gate.test.ts` 要拿**接收端替身的真实工厂**
 * 做判别性注入（违约批次必须被拒收），而 `.mjs` 在根 `tsconfig.json`（`include` 只含 `.ts`）
 * 下没有静态类型。声明文件只覆盖测试真正用到的面，实现仍以 `.mjs` 为准。
 */
export declare const FAKE_ENDPOINT: string;

export interface UploadStubRequest {
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface UploadStubResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

/** 被接收端按契约拒收的批次。 */
export interface UploadStubRejection {
  readonly body: string;
  readonly code: string;
  readonly errors: readonly string[];
}

export interface UploadStub {
  readonly requests: readonly UploadStubRequest[];
  readonly rejections: readonly UploadStubRejection[];
  readonly port: { send(request: UploadStubRequest): Promise<UploadStubResponse> };
  accepted(): number;
  allAccepted(): boolean;
}

export function createUploadStub(): UploadStub;

/** 最小浏览器全局面（`window`/`self`/`document`/`MutationObserver` 的空实现）。 */
export function createBrowserSandbox(): Record<string, unknown>;

/** 把最小浏览器面**临时**装到宿主 `globalThis`；用完必须 `restore()`。 */
export function installBrowserGlobals(): { restore(): void };

/** `runBundleInSandbox` 的可选参数（默认值保持 webpack 例子的原行为）。 */
export interface BundleSandboxOptions {
  readonly exposedKey?: string;
  readonly appId?: string;
  readonly probeEventName?: string;
  readonly probeDimensions?: Readonly<Record<string, string>>;
}

export interface BundleSandboxResult {
  readonly status: string;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly batchSummary: { readonly eventNames: readonly string[] } | null;
  readonly minimalPathError: string | null;
  readonly evaluationError: string | null;
}

export function runBundleInSandbox(
  code: string,
  bundlePath: string,
  options?: BundleSandboxOptions,
): Promise<BundleSandboxResult>;

/** 装配根的最小投递路径（四个例子共用的唯一实现）。 */
export interface MinimalPathOptions {
  /** 参数用 `never` 是为了让任意签名更窄的 `createAssembly` 都能传进来（不变性规避）。 */
  readonly createAssembly: (config: never) => MinimalAssembly;
  readonly appId?: string;
  readonly probeEventName?: string;
  readonly probeDimensions?: Readonly<Record<string, string>>;
}

export interface MinimalAssembly {
  readonly client: { track(name: string, options?: unknown): void };
  init(): void;
  flush(): void;
  destroy(): void;
}

export interface MinimalPathResult {
  readonly checks: Readonly<Record<string, boolean>>;
  /** 接收方收到的第一个批次正文（已解析）；没收到或解析失败时为 `null`。 */
  readonly batch: Record<string, unknown> | null;
  readonly minimalPathError: string | null;
}

export function runAssemblyMinimalPath(options: MinimalPathOptions): Promise<MinimalPathResult>;
