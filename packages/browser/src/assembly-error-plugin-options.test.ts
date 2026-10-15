/**
 * 装配根 `AssemblyOptions.errorPlugin` 的接线用例。
 *
 * 背景：错误插件的配置项此前在装配根**没有任何入口**（`createErrorPlugin` 只拿到
 * `globalContext`），因此 `captureResourceErrors` / `reportRepeats` / `sources` / `windowMs`
 * 等字段在**生产路径上不可达**——看起来设了、实际不生效。本文件用公开装配面证明
 * 这些配置**真的**从 `AssemblyOptions` 走到了插件行为里。
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { TransportPort, TransportRequest, TransportResponse } from '@web-report-sdk/transport';

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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

interface ParsedBatch {
  readonly common?: Readonly<Record<string, unknown>> | undefined;
  readonly events: readonly Readonly<Record<string, unknown>>[];
}

const assemblies: Assembly[] = [];

function build(overrides: Partial<Parameters<typeof createAssembly>[0]> = {}): {
  assembly: Assembly;
  transport: FakeTransport;
} {
  const transport = createFakeTransport();
  const assembly = createAssembly({
    appId: 'app-1',
    endpoint: 'https://collect.example/ingest',
    token: 'token-1',
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

/** 采一条错误 → 结算插件窗口 → 冲刷队列，返回批次里的 `web_js_error` 事件与批次公共字段。 */
async function collectJsErrors(
  assembly: Assembly,
  transport: FakeTransport,
  capture: () => void,
): Promise<{
  events: readonly Readonly<Record<string, unknown>>[];
  common: Readonly<Record<string, unknown>> | undefined;
}> {
  assembly.init();
  capture();
  assembly.collectors.error?.flush();
  assembly.flush();
  await waitFor(() => transport.requests.length > 0);
  const request = transport.requests[0];
  if (request === undefined) return { events: [], common: undefined };
  const batch = JSON.parse(request.body) as ParsedBatch;
  return {
    common: batch.common,
    events: batch.events.filter((event) => event['event_name'] === 'web_js_error'),
  };
}

/** C06 会把取值相同的公共字段提升到 `batch.common`，两处都要看。 */
function fieldOf(
  batch: { readonly common?: Readonly<Record<string, unknown>> | undefined },
  event: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const direct = event[key];
  return direct === undefined ? batch.common?.[key] : direct;
}

describe('AssemblyOptions.errorPlugin 真的接进错误插件', () => {
  it('reportRepeats: true 时窗口内 3 次相同错误产出 3 条事件，count 累计（1/2/3）', async () => {
    const { assembly, transport } = build({ errorPlugin: { reportRepeats: true } });
    const { events } = await collectJsErrors(assembly, transport, () => {
      for (let index = 0; index < 3; index += 1) {
        assembly.collectors.error?.capture(new Error('repeated from assembly'));
      }
    });
    expect(events.map((event) => (event['metrics'] as { count: number }).count)).toEqual([1, 2, 3]);
  });

  it('reportRepeats 缺省时同一输入只产出 1 条事件，count 为总次数（对照）', async () => {
    const { assembly, transport } = build();
    const { events } = await collectJsErrors(assembly, transport, () => {
      for (let index = 0; index < 3; index += 1) {
        assembly.collectors.error?.capture(new Error('repeated from assembly'));
      }
    });
    expect(events.map((event) => (event['metrics'] as { count: number }).count)).toEqual([3]);
  });

  it('sources 白名单在装配路径上生效：被排除的源不产出事件，被保留的源照常产出', async () => {
    const { assembly, transport } = build({ errorPlugin: { sources: ['unhandled_rejection'] } });
    const { events } = await collectJsErrors(assembly, transport, () => {
      assembly.collectors.error?.capture(new Error('dropped by sources'));
      assembly.collectors.error?.handleRejection(new Error('kept by sources'));
    });
    expect(events).toHaveLength(1);
    expect((events[0]?.['dimensions'] as { source: string }).source).toBe('unhandled_rejection');
  });

  it('接入方显式提供的 globalContext 不被装配根的 C04 端口静默顶掉', async () => {
    const { assembly, transport } = build({
      errorPlugin: { globalContext: () => ({ tenant: 'acme' }) },
    });
    const batch = await collectJsErrors(assembly, transport, () => {
      assembly.collectors.error?.capture(new Error('with tenant'));
    });
    expect(batch.events).toHaveLength(1);
    const event = batch.events[0] ?? {};
    const context = fieldOf(batch, event, 'context') as Readonly<Record<string, string>> | undefined;
    expect(context?.['tenant']).toBe('acme');
  });
});
