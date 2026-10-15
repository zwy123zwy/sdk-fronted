/**
 * CR-008 第 2 步：两个**观测量**是否真的接在**生产装配路径**上。
 *
 * 本文件的红线（正是此前缺口的成因）：
 * - **只调用 `createAssembly()`**，绝不手工拼一个 `observables` 端口注入进去冒充接线；
 * - 触发条件必须是**真实事件处**：页面离开（`pagehide`）把离开预算用尽、以及选主
 *   从 leader 变为非 leader（真实 `replay()` 路径 + 注入的 Locks 端口）；
 * - 断言位置必须是**对外可见处**：上报器产出的 `sdk_health.metrics`，以及最终落到
 *   注入传输替身收到的批次正文里的 `sdk_health` 事件。
 *
 * 契约依据：`docs/contracts/changes/CR-008-squeeze-bounds-and-observables.md` §2.1
 * 与 §4（`flush_skipped_due_to_budget` / `leader_lost` 是观测量、不是原因码）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_BATCH_EVENTS,
  METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET,
  METRIC_LEADER_LOST,
} from '@web-report-sdk/transport';
import type {
  LocksPort,
  TransportPort,
  TransportRequest,
  TransportResponse,
} from '@web-report-sdk/transport';

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
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

/** 把一批 `sdk_health` 事件的 metrics 合并成一个可断言的对象。 */
function metricsOf(
  events: readonly { readonly metrics: Readonly<Record<string, number>> }[],
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const event of events) Object.assign(metrics, event.metrics);
  return metrics;
}

/** 从**传输替身真正收到的批次正文**里取出 `sdk_health` 事件（对外可见的证据）。 */
function sdkHealthOnWire(
  requests: readonly TransportRequest[],
): readonly Readonly<Record<string, unknown>>[] {
  const found: Readonly<Record<string, unknown>>[] = [];
  for (const request of requests) {
    const body = JSON.parse(request.body) as {
      readonly events?: readonly Readonly<Record<string, unknown>>[] | undefined;
    };
    for (const event of body.events ?? []) {
      if (event['event_name'] === 'sdk_health') found.push(event);
    }
  }
  return found;
}

function metricsOnWire(requests: readonly TransportRequest[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const event of sdkHealthOnWire(requests)) {
    const values = event['metrics'];
    if (typeof values === 'object' && values !== null) {
      Object.assign(metrics, values as Readonly<Record<string, number>>);
    }
  }
  return metrics;
}

const assemblies: Assembly[] = [];

function build(
  overrides: Partial<Parameters<typeof createAssembly>[0]> = {},
): { assembly: Assembly; transport: FakeTransport } {
  const transport = createFakeTransport();
  const assembly = createAssembly({
    appId: 'app-cr008',
    endpoint: 'https://collect.example/ingest',
    token: 'token-cr008',
    env: 'test',
    release: '0.0.1',
    consent: 'granted',
    transport: transport.port,
    // 离开通道在本用例里只走"预算停手"这一条判定；信标替身返回 true，避免真实网络。
    nativeHttp: { sendBeacon: (): boolean => true },
    now: () => 1_700_000_000_000,
    startHealthReporting: false,
    ...overrides,
  });
  assemblies.push(assembly);
  return { assembly, transport };
}

/** 只授予一次锁的替身：第二轮起不再授予，用于触发「从 leader 变为非 leader」。 */
function createOneShotLocks(): LocksPort {
  let granted = 0;
  return {
    tryAcquire(_name: string, task: () => Promise<void>): Promise<boolean> {
      granted += 1;
      if (granted > 1) return Promise.resolve(false);
      return task().then(() => true);
    },
  };
}

afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
});

describe('CR-008 两个观测量在生产装配路径上可见', () => {
  it('pagehide 用尽离开预算后，flush_skipped_due_to_budget 进入 sdk_health 并到达传输替身', async () => {
    const { assembly, transport } = build();
    assembly.init();

    // 真实触发条件：把队列灌到远超离开预算的批次数（默认 maxBatches=4、每批 20 条），
    // 然后派发真实的 pagehide → C06 用 page_leave 通道冲刷 → C07 的离开发送器停手。
    for (let index = 0; index < DEFAULT_MAX_BATCH_EVENTS * 20; index += 1) {
      assembly.client.track('cr008_budget_probe', { dimensions: { seq: String(index) } });
    }
    document.dispatchEvent(new Event('pagehide'));

    const events = assembly.reporter.flush();
    expect(events.length).toBeGreaterThan(0);
    expect(metricsOf(events)[METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET]).toBeGreaterThanOrEqual(1);

    assembly.flush();
    await waitFor(() => sdkHealthOnWire(transport.requests).length > 0);
    expect(metricsOnWire(transport.requests)[METRIC_FLUSH_SKIPPED_DUE_TO_BUDGET]).toBeGreaterThanOrEqual(1);
  });

  it('选主从 leader 变为非 leader 后，leader_lost 进入 sdk_health 并到达传输替身', async () => {
    const { assembly, transport } = build({ locks: createOneShotLocks() });
    assembly.init();

    // 真实触发条件：启动补发已经跑过一轮选主（当选），再走一次真实 `replay()` 让它落选。
    await waitFor(() => assembly.delivery.metrics().leader.leader);
    // 让启动那一轮 `replay()` 的 `replaying` 彻底归位，避免下一次调用被短路。
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    for (
      let attempt = 0;
      attempt < 4 && assembly.delivery.metrics().leader.leader;
      attempt += 1
    ) {
      await assembly.delivery.replay('manual');
    }
    expect(assembly.delivery.metrics().leader.leader).toBe(false);
    expect(assembly.delivery.metrics().leader.leaderLost).toBe(1);

    const events = assembly.reporter.flush();
    expect(events.length).toBeGreaterThan(0);
    expect(metricsOf(events)[METRIC_LEADER_LOST]).toBeGreaterThanOrEqual(1);

    assembly.flush();
    await waitFor(() => sdkHealthOnWire(transport.requests).length > 0);
    expect(metricsOnWire(transport.requests)[METRIC_LEADER_LOST]).toBeGreaterThanOrEqual(1);
  });
});
