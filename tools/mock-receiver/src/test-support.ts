/**
 * 测试工具（非 `.test.ts`，不会被 Vitest 收集）。
 *
 * M01-AC-13 备注：单元项目运行在 happy-dom 环境，本机回环请求统一用 `node:http`
 * 客户端，避免 happy-dom 的 `fetch` 实现干扰。
 */
import { request as httpRequest, Agent } from 'node:http';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 契约样例使用的固定占位令牌（与 `docs/contracts/examples/batch-beacon.valid.json` 一致）。 */
export const PLACEHOLDER_WRITE_TOKEN = 'placeholder-write-token-0000';

/** 常规通道默认请求头。 */
export const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'x-app-id': 'demo-app',
  'x-write-token': PLACEHOLDER_WRITE_TOKEN,
};

/** 样例目录（指向 `docs/contracts/examples/`）。 */
export const EXAMPLES_DIR = resolveExamplesDir();

function resolveExamplesDir(): string {
  // Vitest 的 happy-dom 环境里 import.meta.url 可能不是 file: URL，用 cwd 兜底。
  try {
    const fromModule = fileURLToPath(new URL('../../../docs/contracts/examples/', import.meta.url));
    if (existsSync(fromModule)) return fromModule;
  } catch {
    // 忽略，走 cwd 分支
  }
  for (const candidate of [
    'docs/contracts/examples/',
    '../../../docs/contracts/examples/',
    '../../../../docs/contracts/examples/',
  ]) {
    const absolute = resolve(process.cwd(), candidate);
    if (existsSync(absolute)) return absolute.endsWith('/') ? absolute : `${absolute}/`;
  }
  throw new Error('找不到 docs/contracts/examples/，请在仓库根目录运行测试');
}

/** 读取契约样例 JSON。 */
export async function readExample(name: string): Promise<unknown> {
  return JSON.parse(await readFile(`${EXAMPLES_DIR}${name}`, 'utf8')) as unknown;
}

/** 深拷贝（样例需要被反复改写）。 */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 取出 `batch.invalid.json` 中的非法批次。 */
export async function invalidCases(): Promise<Record<string, unknown>[]> {
  const doc = (await readExample('batch.invalid.json')) as { cases: Record<string, unknown>[] };
  return doc.cases;
}

/** 把样例批次改写成信标通道形态（令牌在请求体 `auth`）。 */
export function toBeaconBody(batch: Record<string, unknown>): Record<string, unknown> {
  const copy = clone(batch);
  copy['auth'] = { app_id: copy['app_id'], write_token: PLACEHOLDER_WRITE_TOKEN };
  return copy;
}

/** 把样例批次拆成两半（`event_id` 保持原样，`batch_id` 变化）。 */
export function splitBatch(
  batch: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] {
  const events = batch['events'] as Record<string, unknown>[];
  const half = Math.ceil(events.length / 2);
  const first = clone(batch);
  first['batch_id'] = 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c70';
  first['events'] = events.slice(0, half);
  const second = clone(batch);
  second['batch_id'] = 'b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c71';
  second['events'] = events.slice(half);
  return [first, second];
}

/** 构造一个 `sdk_health` 事件。 */
export function sdkHealthEvent(eventId: string): Record<string, unknown> {
  return {
    event_id: eventId,
    event_name: 'sdk_health',
    event_type: 'sdk_internal',
    schema_version: 1,
    occurred_at: 1793000005000,
    priority: 'normal',
    metrics: { calls_total: 3, batches_sent: 1 },
    // dimensions 的值必须是字符串（batch.schema.json）
    dimensions: { sdk_version: '0.1.0', state: 'running', config_version: '42' },
  };
}

/** 把批次序列化为请求体。 */
export function bodyOf(batch: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(batch), 'utf8');
}

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  /**
   * 取消信号：abort 时立即销毁连接并 reject。
   *
   * 这是「用例结束时不得留下在途请求」的机制（M01-AC-09 的 300 次串行请求曾因此在
   * vitest 5 s 超时后继续存活，见 `injection.acceptance.test.ts` 的注释）。调用方
   * 应当在 `finally` 里 abort 后 `await Promise.allSettled(...)`，让请求全部结算。
   */
  signal?: AbortSignal;
}

/** abort / 客户端超时用的错误文案（断言里可读）。 */
const CLIENT_ABORT_MESSAGE = 'mock-receiver test client aborted';

/**
 * 发送一个本机请求。超时、连接被重置或被 `signal` 取消时 reject，
 * 网络错误信息直接返回给断言。
 */
export function httpRequestTo(
  port: number,
  path: string,
  options: HttpOptions = {},
): Promise<HttpResult> {
  const { method = 'GET', headers = {}, body, timeoutMs = 5_000, signal } = options;
  return new Promise<HttpResult>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error(CLIENT_ABORT_MESSAGE));
      return;
    }
    let detach = (): void => undefined;
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          detach();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    const onAbort = (): void => {
      req.destroy(new Error(CLIENT_ABORT_MESSAGE));
    };
    detach = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('mock-receiver test client timeout'));
    });
    req.on('error', (error) => {
      detach();
      reject(error);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 读取响应体的 `error` 字段。 */
export function errorOf(result: HttpResult): string {
  const parsed = JSON.parse(result.body) as { error?: string };
  return parsed.error ?? '';
}

/** 断言响应头是整数秒。 */
export function retryAfterSeconds(result: HttpResult): number {
  const raw = result.headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) throw new Error('missing Retry-After header');
  if (!/^\d+$/.test(value)) throw new Error(`Retry-After is not an integer: ${value}`);
  return Number.parseInt(value, 10);
}

/** 延迟。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 由 (worker, sequence, index) 生成符合契约 UUID v4 格式的全局唯一标识（压测用）。 */
export function idOf(workerIndex: number, sequence: number, eventIndex: number): string {
  // 32 个十六进制字符；第 13 位固定 4、第 17 位固定 8（UUID v4 变体）
  const worker = (workerIndex >>> 0).toString(16).slice(-8).padStart(8, '0');
  const seq = ((sequence * 16 + (eventIndex & 0xf)) >>> 0).toString(16).padStart(20, '0').slice(-20);
  const hex = `${worker}${seq}`.slice(0, 32).padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** 生成一段不可压缩的十六进制文本（用于构造超过 256 KB 的 gzip 请求）。 */
export function randomText(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

/**
 * 解析 JSON 响应体。`parse` 负责把 `unknown` 收窄成具体类型，
 * 类型参数出现在参数位置，便于调用方定义小解析器。
 */
export function jsonOf<T>(result: HttpResult, parse: (value: unknown) => T): T {
  return parse(JSON.parse(result.body) as unknown);
}

export interface LoadResult {
  seconds: number;
  batches: number;
  events: number;
  statuses: Map<number, number>;
  errors: number;
  /** 第一个非 202 响应的样本，便于定位压测中的校验失败。 */
  firstFailure: { status: number; body: string } | null;
}

/**
 * 本地压测：在 `durationMs` 内用 `concurrency` 条 keep-alive 连接持续发送批次。
 * 每个批次带 `eventsPerBatch` 条唯一事件，全部通过 HTTP 走完整处理路径。
 */
export async function loadTest(
  port: number,
  options: { durationMs: number; concurrency?: number; eventsPerBatch?: number; appId?: string },
): Promise<LoadResult> {
  const { durationMs, concurrency = 4, eventsPerBatch = 15, appId = 'demo-app' } = options;
  const statuses = new Map<number, number>();
  let batches = 0;
  let errors = 0;
  let firstFailure: { status: number; body: string } | null = null;
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  const deadline = Date.now() + durationMs;

  const worker = async (workerIndex: number): Promise<void> => {
    let sequence = 0;
    while (Date.now() < deadline) {
      const events = Array.from({ length: eventsPerBatch }, (_, eventIndex) => ({
        event_id: idOf(workerIndex, sequence, eventIndex),
        event_name: 'task_submit_complete',
        event_type: 'custom',
        schema_version: 2,
        occurred_at: 1793000000000,
        priority: 'normal',
        sample_rate: 1,
        dimensions: { result: 'pass' },
        metrics: { duration_ms: 12 },
      }));      const batch = {
        protocol_version: 1,
        app_id: appId,
        env: 'staging',
        release: '1.4.0',
        sdk_name: 'web-report-sdk',
        sdk_version: '0.1.0',
        device_id: '3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f',
        session_id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
        batch_id: idOf(workerIndex + 1000, sequence, 0),
        sent_at: 1793000000500,
        clock_offset: 0,
        events,
      };
      sequence += 1;
      try {
        const progress = Date.now() - started;
        const stream = progress < 3_000;
        const raw = Buffer.from(JSON.stringify(batch), 'utf8');
        const body = stream ? gzipSync(raw) : raw;
        const result = await requestAsAgent(agent, port, '/v1/batch', {
          'content-type': 'application/json',
          'x-app-id': appId,
          'x-write-token': PLACEHOLDER_WRITE_TOKEN,
          ...(stream ? { 'content-encoding': 'gzip' } : {}),
        }, body);
        statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
        if (result.status !== 202 && firstFailure === null) {
          firstFailure = { status: result.status, body: result.body.slice(0, 300) };
        }
        batches += 1;
      } catch {
        errors += 1;
      }
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
  const seconds = (Date.now() - started) / 1000;
  agent.destroy();
  return { seconds, batches, events: batches * eventsPerBatch, statuses, errors, firstFailure };
}

function requestAsAgent(
  agent: Agent,
  port: number,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers, agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(10_000, () => {
      req.destroy(new Error('load test client timeout'));
    });
    req.on('error', reject);
    req.end(body);
  });
}
