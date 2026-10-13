/**
 * C07 发送器的测试夹具（仅供 `*.test.ts` 使用，不从 `src/index.ts` 导出）。
 */
import type { CredentialsPort, CredentialsSnapshot, TransportPort, TransportRequest, TransportResponse } from './types';

export interface FakeTransport {
  readonly requests: TransportRequest[];
  readonly transport: TransportPort;
  /** 排定下一次响应。 */
  push(status: number, headers?: Record<string, string>): void;
  /** 排定下一次网络错误。 */
  pushError(): void;
  /** 后续未排定的响应（缺省 202）。 */
  setDefault(status: number): void;
}

export function createFakeTransport(): FakeTransport {
  const requests: TransportRequest[] = [];
  const queue: (
    | { readonly kind: 'response'; readonly status: number; readonly headers: Record<string, string> }
    | { readonly kind: 'error' }
  )[] = [];
  let fallback = 202;
  return {
    requests,
    push(status: number, headers: Record<string, string> = {}): void {
      queue.push({ kind: 'response', status, headers });
    },
    pushError(): void {
      queue.push({ kind: 'error' });
    },
    setDefault(status: number): void {
      fallback = status;
    },
    transport: {
      send(request: TransportRequest): Promise<TransportResponse> {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) return Promise.resolve({ status: fallback, headers: {} });
        if (next.kind === 'error') return Promise.reject(new Error('network error'));
        return Promise.resolve({ status: next.status, headers: next.headers });
      },
    },
  };
}

export interface FakeCredentials {
  readonly port: CredentialsPort;
  set(next: Partial<CredentialsSnapshot>): void;
  readonly current: CredentialsSnapshot;
}

export function createFakeCredentials(initial: Partial<CredentialsSnapshot> = {}): FakeCredentials {
  const state: { value: CredentialsSnapshot } = {
    value: {
      endpoint: 'https://ingest.example.com/v1/batch',
      appId: 'demo-app',
      writeToken: 'placeholder-write-token-0001',
      revision: 1,
      ...initial,
    },
  };
  return {
    port: {
      current: (): CredentialsSnapshot => state.value,
    },
    set(next: Partial<CredentialsSnapshot>): void {
      state.value = { ...state.value, ...next };
    },
    get current(): CredentialsSnapshot {
      return state.value;
    },
  };
}

export interface SleepSpy {
  readonly delays: number[];
  readonly sleep: (ms: number) => Promise<void>;
}

/** 立刻 resolve 的 sleep，记录请求的延迟（重试节奏可断言、测试不真的等 7 秒）。 */
export function createSleepSpy(): SleepSpy {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}
