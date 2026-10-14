/**
 * T30 降级路径矩阵（T30 验收用例第 2 条）。
 *
 * 验收原文：「不支持的 API（如 `CompressionStream`、Web Locks）降级路径各有一条用例」。
 * 本文件把"不支持"做成**真的把能力拿掉**（在创建装配根之前把全局设为 `undefined`），
 * 而不是断言"实现里有 if 分支"——后者在实现漏判时照样绿。
 *
 * 每个能力都有**正反两面**（能力存在 / 不存在），因此用例具备判别力：只断言降级分支能跑通
 * 是不够的，必须同时证明"能力存在时走的确实是另一条路"，否则降级用例可能是空转。
 *
 * 环境说明：node 环境。本文件导入的是**构建产物** `packages/browser/dist/index.js` 与
 * `packages/transport/dist/index.js`（安全测试同样用产物：测的是发布出去的东西）。
 * node 24 自带 `CompressionStream` / `BroadcastChannel` / `crypto`，因此前两者可以做出真实对照；
 * node 没有 `navigator.locks` 与 `indexedDB`，所以它们的"不支持"是环境默认值。
 */
import { afterEach, describe, expect, test } from 'vitest';

import { loadBrowserEntry, loadTransportEntry } from './lib/entries';
import type {
  AssemblyLike,
  BroadcastPortLike,
  TransportPortLike,
  TransportRequestLike,
  TransportResponseLike,
} from './lib/entries';
import { derivedCell, writeCells } from './lib/matrix';
import type { MatrixCell, ProbeTable } from './lib/matrix';

const compatCommand =
  'pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false';

const probe: ProbeTable = {};

function cell(id: string, input: Parameters<typeof derivedCell>[3]): MatrixCell {
  return derivedCell(probe, compatCommand, id, input);
}

const browserEntry = await loadBrowserEntry();
const transportEntry = await loadTransportEntry();
const { createLeaderElection } = transportEntry;

interface FakeTransport {
  readonly port: TransportPortLike;
  readonly requests: TransportRequestLike[];
}

function createFakeTransport(): FakeTransport {
  const requests: TransportRequestLike[] = [];
  const response: TransportResponseLike = { status: 202, headers: {} };
  return {
    requests,
    port: {
      send(request: TransportRequestLike): Promise<TransportResponseLike> {
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

const assemblies: AssemblyLike[] = [];
/** 被删除的全局及其原始属性描述符，用于逐用例恢复。 */
const removed = new Map<string, PropertyDescriptor | undefined>();

/** 把某个全局能力拿掉（在创建装配根**之前**调用才有效）。 */
function removeGlobal(name: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  removed.set(name, descriptor);
  Object.defineProperty(globalThis, name, {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

function restoreGlobals(): void {
  for (const [name, descriptor] of removed) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, name);
    } else {
      Object.defineProperty(globalThis, name, descriptor);
    }
  }
  removed.clear();
}

afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
  restoreGlobals();
});

function build(plugins?: Readonly<Record<string, boolean>>): {
  assembly: AssemblyLike;
  transport: FakeTransport;
} {
  const transport = createFakeTransport();
  const assembly = browserEntry.createAssembly({
    appId: 'compat-app',
    endpoint: 'https://collect.example/ingest',
    token: 'compat-token',
    env: 'test',
    release: '0.0.0',
    consent: 'granted',
    transport: transport.port,
    startHealthReporting: false,
    plugins: { ...plugins },
  });
  assemblies.push(assembly);
  return { assembly, transport };
}

/** 发一条 **> 4 KB** 的事件并等接收方收到，返回该请求。 */
async function trackLargeAndFlush(): Promise<TransportRequestLike> {
  const { assembly, transport } = build();
  assembly.init();
  // 单个 attachment 上限 8 KB（C04 的 clampAttachment），这里用 6 KB 保证序列化后 > 4 KB
  // 的压缩阈值，从而真正走到"是否压缩"的分支。
  assembly.client.track('task_complete', { attachment: 'x'.repeat(6000) });
  assembly.flush();
  await waitFor(() => transport.requests.length > 0);
  const request = transport.requests[0];
  if (request === undefined) throw new Error('接收方没有收到批次');
  return request;
}

describe('不支持 CompressionStream：降级为未压缩发送', () => {
  test('能力不存在时批次仍送达，且正文是未压缩 JSON', async () => {
    removeGlobal('CompressionStream');
    const request = await trackLargeAndFlush();
    expect(request.body.length).toBeGreaterThan(4096);
    expect(request.bodyBytes).toBeUndefined();
    const batch = JSON.parse(request.body) as { events?: readonly unknown[] };
    expect(Array.isArray(batch.events)).toBe(true);
    probe['degrade.compression.missing'] = true;
  });

  test('对照组：能力存在时同一批次被压缩（证明上面的用例不是空转）', async () => {
    expect(typeof (globalThis as { CompressionStream?: unknown }).CompressionStream).toBe(
      'function',
    );
    const request = await trackLargeAndFlush();
    expect(request.bodyBytes).toBeInstanceOf(Uint8Array);
    probe['degrade.compression.present'] = true;
  });
});

describe('不支持 crypto.randomUUID：事件标识退回内置 UUID v4', () => {
  test('能力不存在时送达，且 event_id 仍是合法 UUID v4', async () => {
    removeGlobal('crypto');
    const { assembly, transport } = build();
    assembly.init();
    assembly.client.track('task_complete', { dimensions: { task_id: 't-degrade' } });
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);
    const body = transport.requests[0]?.body ?? '';
    const batch = JSON.parse(body) as { events?: readonly { event_id?: unknown }[] };
    const event = batch.events?.[0];
    expect(event).toBeDefined();
    expect(String(event?.event_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    probe['degrade.randomuuid.missing'] = true;
  });
});

describe('不支持 Web Locks：退回 BroadcastChannel，两者都没有时退回"各自补发"', () => {
  test('对照组：node 24 自带 navigator.locks → 默认端口非 null（证明下面的用例不是空转）', () => {
    expect(transportEntry.createDefaultLocksPort()).not.toBeNull();
    probe['degrade.locks.present'] = true;
  });

  test('删除 navigator 后：默认端口为 null，广播端口仍可用', () => {
    removeGlobal('navigator');
    expect(transportEntry.createDefaultLocksPort()).toBeNull();
    expect(transportEntry.createDefaultBroadcastPort()).not.toBeNull();
    probe['degrade.locks.missing'] = true;
  });

  test('选主模式：locks 缺席时为 broadcast；两者都缺席时为 none；注入 locks 时为 locks', async () => {
    const fast = (): Promise<void> => Promise.resolve();
    const work = (): Promise<string> => Promise.resolve('x');
    const broadcast: BroadcastPortLike | null = transportEntry.createDefaultBroadcastPort();
    const noLocks = await createLeaderElection({ locks: null, broadcast, sleep: fast }).run(work);
    expect(noLocks.mode).toBe('broadcast');
    const noBoth = await createLeaderElection({ locks: null, broadcast: null, sleep: fast }).run(
      work,
    );
    expect(noBoth.mode).toBe('none');
    const withLocks = await createLeaderElection({
      locks: {
        tryAcquire: async (_name: string, task: () => Promise<void>) => {
          await task();
          return true;
        },
      },
      broadcast,
      sleep: fast,
    }).run(work);
    expect(withLocks.mode).toBe('locks');
    expect(withLocks.leader).toBe(true);
    probe['degrade.locks.fallback'] = true;
  });
});

describe('不支持 IndexedDB：离线持久化不可用，正常通道不受影响', () => {
  test('node 没有 indexedDB，init→track→flush 仍送达', async () => {
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
    const { assembly, transport } = build();
    assembly.init();
    assembly.client.track('task_complete', { dimensions: { task_id: 't-no-idb' } });
    assembly.flush();
    await waitFor(() => transport.requests.length > 0);
    expect(transport.requests[0]?.body).toContain('t-no-idb');
    probe['degrade.idb.missing'] = true;
  });
});

describe('矩阵落盘', () => {
  test('写出 results/degradation.json', () => {
    const cells: MatrixCell[] = [
      cell('degrade.compression.missing', {
        requirement: 'T30 验收：`CompressionStream` 不支持的降级路径',
        dimension: '降级能力 / 压缩',
        engine: 'node 24（无 CompressionStream）',
        evidence: '本次运行的 results/degradation.json + 用例输出',
        notes: '> 4 KB 正文未被压缩（bodyBytes undefined），批次仍送达并可按 JSON 解析。',
      }),
      cell('degrade.compression.present', {
        requirement: '同上（对照格，证明降级用例有判别力）',
        dimension: '降级能力 / 压缩（对照）',
        engine: 'node 24（有 CompressionStream）',
        evidence: '本次运行的 results/degradation.json',
        notes: '同一夹具在能力存在时 `bodyBytes` 为 Uint8Array——两条分支真的不同。',
      }),
      cell('degrade.randomuuid.missing', {
        requirement: 'T30 验收：不支持 API 的降级路径',
        dimension: '降级能力 / crypto.randomUUID',
        engine: 'node 24（无 crypto）',
        evidence: 'event_id 匹配 UUID v4 正则',
        notes: '`crypto` 被删除后事件标识退回到内置实现，批次仍送达。',
      }),
      cell('degrade.locks.missing', {
        requirement: 'T30 验收：Web Locks 不支持的降级路径',
        dimension: '降级能力 / Web Locks',
        engine: 'node 24（删除 navigator 后）',
        evidence: 'createDefaultLocksPort() === null',
        notes: '默认端口在能力缺席时返回 null（不是抛错）；**node 24 本身自带 navigator.locks**，故本格必须真删。',
      }),
      cell('degrade.locks.present', {
        requirement: '同上（对照格，证明降级用例有判别力）',
        dimension: '降级能力 / Web Locks（对照）',
        engine: 'node 24（原生 navigator.locks）',
        evidence: 'createDefaultLocksPort() !== null',
        notes: '默认端口在能力存在时给出实现，两条分支不同。',
      }),
      cell('degrade.locks.fallback', {
        requirement: 'T30 验收：Web Locks 不支持的降级路径（多标签页）',
        dimension: '降级能力 / 选主降级',
        engine: 'node 24（无 navigator.locks，有 BroadcastChannel）',
        evidence: 'LeaderMode = broadcast / none / locks 三态实测',
        notes: '含注入 locks 的正向对照；正确性不依赖选主（C07-F7）。',
      }),
      cell('degrade.idb.missing', {
        requirement: 'T30 验收：不支持 API 的降级路径（存储）',
        dimension: '降级能力 / IndexedDB',
        engine: 'node 24（无 indexedDB）',
        evidence: '批次送达且含事件字段',
        notes: '离线持久化不可用时正常通道不受影响；真实 IDB 行为归 T29。',
      }),
    ];
    const file = writeCells('degradation', cells);
    expect(file).toContain('degradation.json');
    for (const entry of cells) expect(entry.status, entry.id).toBe('pass');
  });
});
