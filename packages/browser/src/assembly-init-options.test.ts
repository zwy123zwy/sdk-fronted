/**
 * 装配根的 `endpoint` / `token` 归属（发布阻塞点 ⑧的裁定：core 面显式拒绝，不做静默忽略）。
 *
 * 事实：`endpoint` / `token` 的消费点是 `createAssembly` 的凭据端口（→ C07 发送器）。core 没有网络、
 * 不可能消费它们；此前 `createClient({ endpoint })` 与 `init({ endpoint })` 声明了却从不读取。
 * 现在改为「计 `invalid_args` + `dropped: 'field'` 诊断」，本文件锁定：
 * ① 支持面（`AssemblyOptions.endpoint/token`）照常生效（请求 url + `x-write-token` 头）；
 * ② `assembly.init({ endpoint })` —— 即把 endpoint 传进 core 的初始化面 —— 被**显式拒绝**
 *    （`invalid_args` 计数）且**不**产生请求（不会因为"看起来传了"就假装生效）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { TransportPort, TransportRequest, TransportResponse } from '@web-report-sdk/transport';

import { createAssembly } from './assembly';
import type { Assembly } from './assembly';

function createFakeTransport(): { port: TransportPort; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    port: {
      send(request: TransportRequest): Promise<TransportResponse> {
        requests.push(request);
        return Promise.resolve({ status: 202, headers: {} });
      },
    },
  };
}

const assemblies: Assembly[] = [];
afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
});

describe('endpoint / token 只在装配根生效', () => {
  it('对照：`AssemblyOptions.endpoint` / `token` 组装凭据端口（请求 url 与 x-write-token 头）', () => {
    const transport = createFakeTransport();
    const assembly = createAssembly({
      appId: 'app-1',
      endpoint: 'https://collect.example/ingest',
      token: 'placeholder-write-token-0001',
      consent: 'granted',
      transport: transport.port,
      startHealthReporting: false,
    });
    assemblies.push(assembly);
    assembly.init();
    assembly.client.track('task_complete');
    assembly.flush();

    expect(transport.requests.length).toBeGreaterThan(0);
    expect(transport.requests[0]?.url).toBe('https://collect.example/ingest');
    expect(transport.requests[0]?.headers['x-write-token']).toBe('placeholder-write-token-0001');
  });

  it('`assembly.init({ endpoint })` 被显式拒绝：计 invalid_args 且不产生请求', () => {
    const transport = createFakeTransport();
    const assembly = createAssembly({
      appId: 'app-1',
      consent: 'granted',
      transport: transport.port,
      startHealthReporting: false,
    });
    assemblies.push(assembly);

    assembly.init({ endpoint: 'https://collect.example/ingest' });
    assembly.client.track('task_complete');
    assembly.flush();

    // 拒绝可观测（不再静默忽略），且没有凭据端口 → 零投递。
    expect(assembly.kernel.counters.get('invalid_args')).toBe(1);
    expect(transport.requests).toHaveLength(0);
  });
});
