/**
 * D-01 / D-02（T33 阻断级）在**装配根真实产出**上的契约守卫。
 *
 * 为什么单独一个文件、且**对真实批次做 Ajv 校验**（D-06 的教训）：
 * 既有的端到端验证用的是**不校验结构的自建接收端**，"收到字节"就被当成"收到合法批次"，
 * 于是 D-01（`common.page_id: null`）在 45 格兼容矩阵、多个 spec 与全部 examples 里
 * 一次都没被触发。本文件的接收端是 `TransportPort` 替身，但**每一条都拿真实批次喂
 * `docs/contracts/schemas/batch.schema.json`**（与 `packages/core/src/api/schema-validation.test.ts`
 * 同一套 Ajv 用法与同一份冻结 Schema）。
 *
 * 覆盖：
 * - D-01：未设置页面归属时，批次的 `page_id`（事件体与 `common` 两处）**要么是 string、
 *   要么整个键不出现**，且完整批次通过 Schema 校验。包含"注入的 `LocationSource`
 *   在运行时给出非字符串 `pageId`"这一外部输入形态（JS 接入方 / SSR 适配层反序列化快照）；
 * - D-02：接入方在 `init` **前/后**调用公共 `client.onEvent()`，投递必须仍然成立，
 *   且接入方自己的观察者仍能收到事件 —— 内部接线与接入方观察**互不顶掉**。
 */
import Ajv2020 from 'ajv/dist/2020';
import { afterEach, describe, expect, it } from 'vitest';

import type { LocationSource } from '@web-report-sdk/core';
import type { TransportPort, TransportRequest, TransportResponse } from '@web-report-sdk/transport';

import batchSchema from '../../../docs/contracts/schemas/batch.schema.json';
import { createAssembly } from './assembly';
import type { Assembly } from './assembly';

interface FakeTransport {
  readonly port: TransportPort;
  readonly requests: TransportRequest[];
}

function createFakeTransport(): FakeTransport {
  const requests: TransportRequest[] = [];
  const response: TransportResponse = { status: 202, headers: {} };
  return {
    requests,
    port: {
      send(request: TransportRequest): Promise<TransportResponse> {
        requests.push(request);
        return Promise.resolve(response);
      },
    },
  };
}

/** 轮询等待异步发送链路完成（不用墙钟断言，只等条件成立）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

interface ParsedBatch extends Record<string, unknown> {
  readonly common?: Readonly<Record<string, unknown>>;
  readonly events: readonly Readonly<Record<string, unknown>>[];
}

function parseBatch(request: TransportRequest): ParsedBatch {
  return JSON.parse(request.body) as ParsedBatch;
}

const assemblies: Assembly[] = [];

function build(overrides: Partial<Parameters<typeof createAssembly>[0]> = {}): {
  assembly: Assembly;
  transport: FakeTransport;
} {
  const transport = createFakeTransport();
  const assembly = createAssembly({
    appId: 'app-1',
    endpoint: 'https://collect.example/v1/batch',
    token: 'placeholder-write-token-0000',
    env: 'test',
    release: '1.2.3',
    consent: 'granted',
    transport: transport.port,
    now: () => 1_700_000_000_000,
    startHealthReporting: false,
    ...overrides,
  });
  assemblies.push(assembly);
  return { assembly, transport };
}

afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
});

/**
 * 注入的 `LocationSource` 是**外部输入**：类型上 `pageId`/`href` 是 `string | undefined`，
 * 但 JS 接入方、SSR 适配层或反序列化出来的位置快照在运行期可以给别的值。
 * 本助手只表达"这个对象在运行期不是类型声明所说的形状"，不做任何伪造数据。
 */
function externalLocation(value: unknown): LocationSource {
  return value as LocationSource;
}

/** 用冻结的批次 Schema 校验**真实产出的完整批次**；失败时把 Ajv 原文打进断言信息。 */
function expectContractBatch(request: TransportRequest | undefined): ParsedBatch {
  if (request === undefined) throw new Error('没有产出批次：投递未发生');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(batchSchema);
  const batch = parseBatch(request);
  const valid = validate(batch);
  expect(validate.errors ?? [], JSON.stringify(validate.errors ?? [], null, 2)).toEqual([]);
  expect(valid).toBe(true);
  return batch;
}

/**
 * `page_id` 的契约口径：`{type: string, maxLength: 256}` 且**不在 required**。
 * 因此"合法"只有两种：键不存在，或键是 string。`null` 与其他类型都违约。
 * 事件体与批次 `common` 两处都要成立（C06 可能把相同取值提升到 `common`）。
 */
function expectPageIdContract(batch: ParsedBatch): void {
  const holders: readonly Readonly<Record<string, unknown>>[] = [
    ...(batch.common === undefined ? [] : [batch.common]),
    ...batch.events,
  ];
  for (const holder of holders) {
    if (Object.prototype.hasOwnProperty.call(holder, 'page_id')) {
      expect(typeof holder['page_id']).toBe('string');
    }
  }
  // 兜底断言：整份批次里不得出现 null（Ajv 会先报，这里让失败原因更直白）。
  expect(JSON.stringify(batch)).not.toContain('"page_id":null');
}

describe('D-01：未设置页面归属时，产出的批次必须通过冻结契约校验', () => {
  it('完全不注入 location、不调 setPage：批次通过 Schema，page_id 键不出现', async () => {
    const { assembly, transport } = build();
    assembly.init();
    assembly.client.track('task_complete', { dimensions: { task_id: 't-1' } });
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);

    const batch = expectContractBatch(transport.requests[0]);
    expectPageIdContract(batch);
    // 明确的键语义：`page_id` 键要么不存在，要么是 string（不是"值不是 null"）。
    expect(Object.prototype.hasOwnProperty.call(batch.common ?? {}, 'page_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(batch.events[0] ?? {}, 'page_id')).toBe(false);
  });

  it('注入的 location.pageId 运行期为 null 时，批次仍通过 Schema 且 page_id 键不出现', async () => {
    const { assembly, transport } = build({
      location: externalLocation({ href: 'https://app.example.invalid/selfcheck', pageId: null }),
    });
    assembly.init();
    assembly.client.track('task_complete', { dimensions: { task_id: 't-1' } });
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);

    const batch = expectContractBatch(transport.requests[0]);
    expectPageIdContract(batch);
  });

  it('注入的 location.pageId 运行期为非字符串（数字）时，同样不得进事件体', async () => {
    const { assembly, transport } = build({
      location: externalLocation({ href: 'https://app.example.invalid/selfcheck', pageId: 42 }),
    });
    assembly.init();
    assembly.client.track('task_complete', { dimensions: { task_id: 't-1' } });
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);

    const batch = expectContractBatch(transport.requests[0]);
    expectPageIdContract(batch);
  });

  it('显式给出的合法 pageId 仍然原样进入批次（契约不因兜底而丢值）', async () => {
    const { assembly, transport } = build();
    assembly.init();
    assembly.client.setPage('/task/:id');
    assembly.client.track('task_complete', { dimensions: { task_id: 't-1' } });
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);

    const batch = expectContractBatch(transport.requests[0]);
    expectPageIdContract(batch);
    const pageId = batch.events[0]?.['page_id'] ?? batch.common?.['page_id'];
    expect(pageId).toBe('/task/:id');
  });
});

describe('D-02：装配根上调公共 onEvent() 不得顶掉内部投递', () => {
  it('init 前调 onEvent()：投递仍生效，且接入方观察者仍收到事件', async () => {
    const { assembly, transport } = build();
    const observed: string[] = [];
    assembly.client.onEvent((event) => {
      observed.push(event.event_name);
    });

    assembly.init();
    assembly.client.track('task_complete', { dimensions: { task_id: 't-1' } });
    assembly.flush();
    await waitFor(() => assembly.delivery.metrics().eventsSent >= 1);

    // ① 投递腿：事件真的进了队列并到了接收端（stored >= 1）。
    const batch = expectContractBatch(transport.requests[0]);
    expect(batch.events.length).toBeGreaterThanOrEqual(1);
    expect(batch.events[0]?.['event_name']).toBe('task_complete');
    expect(assembly.delivery.metrics().eventsSent).toBeGreaterThanOrEqual(1);
    // ② 观察腿：接入方自己的出口仍然收到同一条事件（互不顶掉）。
    expect(observed).toContain('task_complete');
  });

  it('init 后调 onEvent()：投递仍生效，且接入方观察者仍收到事件', async () => {
    const { assembly, transport } = build();
    assembly.init();

    const observed: string[] = [];
    assembly.client.onEvent((event) => {
      observed.push(event.event_name);
    });

    assembly.client.track('task_complete', { dimensions: { task_id: 't-1' } });
    assembly.flush();
    await waitFor(() => assembly.delivery.metrics().eventsSent >= 1);

    const batch = expectContractBatch(transport.requests[0]);
    expect(batch.events.length).toBeGreaterThanOrEqual(1);
    expect(observed).toContain('task_complete');
  });

  it('不调 onEvent() 的基线行为不变（投递成立）', async () => {
    const { assembly, transport } = build();
    assembly.init();
    assembly.client.track('task_complete');
    assembly.flush();
    await waitFor(() => assembly.delivery.metrics().eventsSent >= 1);

    expect(transport.requests.length).toBeGreaterThanOrEqual(1);
    expect(assembly.delivery.metrics().eventsSent).toBeGreaterThanOrEqual(1);
  });
});
