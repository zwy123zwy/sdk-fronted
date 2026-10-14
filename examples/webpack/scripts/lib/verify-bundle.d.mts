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

export interface BundleSandboxResult {
  readonly status: string;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly batchSummary: { readonly eventNames: readonly string[] } | null;
  readonly minimalPathError: string | null;
}

export function runBundleInSandbox(code: string, bundlePath: string): Promise<BundleSandboxResult>;
