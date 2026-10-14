// @vitest-environment happy-dom
/**
 * T30 与第三方 APM 共存（T30 验收用例第 3 条 + `docs/decisions/Q7-apm-coexistence.md` 第 4 条）。
 *
 * 验收原文：「与一个第三方 APM SDK 共存，先后初始化顺序各测一次，双方数据都正确，
 * 卸载后 hook 链完整」。
 *
 * 第三方 APM 用**最小可信替身**表示：它按真实 APM 的做法包装 `globalThis.fetch`、监听 `error`
 * 事件，并**只还原自己那一层**。断言的对象是双方各自看到的数据与卸载后的链形态。
 *
 * 关键设计（`packages/core/src/kernel/global-registry.ts`）：SDK 的 hook 链记录 `chain.base`
 * （首次 hook 时的原值）。最后一个 SDK hook 卸载时，只有当全局值仍是 SDK 的复合函数时才还原
 * `chain.base`；若外部在 SDK 之上又包了一层，SDK **不动当前值**——这正是 Q7 要求的
 * "卸载时只还原自己装上的那一层"。
 *
 * 环境说明（**踩过的坑**）：happy-dom 里 `Request` 不支持 `keepalive`，transport 因此降级到
 * `XMLHttpRequest` 并会去真连端点。所以本文件**注入传输替身**（`transport` 端口）来观测 SDK 的
 * 上报，绝不依赖网络；真实原生通道（fetch / XHR / sendBeacon）的验证归 T29。
 *
 * 不测的部分：真实第三方 APM（Sentry/Datadog 等）的采集行为与真机 hook 顺序语义，归 T29。
 */
import { afterEach, describe, expect, test } from 'vitest';

import { loadBrowserEntry } from './lib/entries';
import type {
  AssemblyLike,
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

/** 对全局对象的受限视图（根 tsconfig 的 lib 不含 DOM，因此按需声明结构）。 */
interface GlobalView {
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
  dispatchEvent: (event: unknown) => boolean;
  Response: new (body?: unknown, init?: unknown) => unknown;
}

const globalView = globalThis as unknown as GlobalView;
const originalFetch = globalThis.fetch;
const endpoint = 'https://collect.example/ingest';
const businessUrl = 'https://api.example/data';

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const withUrl = input as { url?: unknown };
    if (typeof withUrl.url === 'string') return withUrl.url;
  }
  return String(input);
}

/** 真原生 fetch 的替身（业务请求会落到它；SDK 上报走注入的传输端口）。 */
interface NativeStub {
  readonly calls: string[];
}

function installNativeStub(): NativeStub {
  const calls: string[] = [];
  globalView.fetch = (input: unknown): Promise<unknown> => {
    calls.push(urlOf(input));
    return Promise.resolve(new globalView.Response('', { status: 200 }));
  };
  return { calls };
}

/** 第三方 APM 替身。 */
interface FakeApm {
  readonly fetchCalls: string[];
  readonly errors: unknown[];
  /** 第三方装上的那一层（用于断言"SDK 卸载后它仍在全局上"）。 */
  readonly wrapper: unknown;
  uninstall(): void;
}

function installFakeApm(): FakeApm {
  const fetchCalls: string[] = [];
  const errors: unknown[] = [];
  const underlying = globalView.fetch;
  const wrapper = (input: unknown, init?: unknown): Promise<unknown> => {
    fetchCalls.push(urlOf(input));
    return underlying(input, init);
  };
  globalView.fetch = wrapper;
  const onError = (event: unknown): void => {
    errors.push(event);
  };
  globalView.addEventListener('error', onError);
  return {
    fetchCalls,
    errors,
    wrapper,
    uninstall(): void {
      if (globalView.fetch === wrapper) globalView.fetch = underlying;
      globalView.removeEventListener('error', onError);
    },
  };
}

/** SDK 上报的观测端口（不触网）。 */
const browserEntry = await loadBrowserEntry();

interface UploadStub {
  readonly port: TransportPortLike;
  readonly requests: TransportRequestLike[];
}

function createUploadStub(): UploadStub {
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

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

function eventNames(upload: UploadStub): readonly string[] {
  return upload.requests.flatMap((request) => {
    const batch = JSON.parse(request.body) as { events?: readonly { event_name?: unknown }[] };
    return (batch.events ?? []).map((event) => String(event.event_name));
  });
}

function dispatchError(message: string): void {
  const ctor = (globalThis as unknown as Record<string, unknown>)['ErrorEvent'] as
    | (new (type: string, init: Record<string, unknown>) => unknown)
    | undefined;
  if (ctor === undefined) throw new Error('环境没有 ErrorEvent');
  globalView.dispatchEvent(new ctor('error', { message, error: new Error(message) }));
}

const assemblies: AssemblyLike[] = [];

function buildAssembly(upload: UploadStub): AssemblyLike {
  const assembly = browserEntry.createAssembly({
    appId: 'compat-app',
    endpoint,
    token: 'compat-token',
    env: 'test',
    release: '0.0.0',
    consent: 'granted',
    transport: upload.port,
    plugins: { http: true, error: true },
    startHealthReporting: false,
  });
  assemblies.push(assembly);
  return assembly;
}

afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
  globalThis.fetch = originalFetch;
});

describe('共存：先后初始化顺序各一次（Q7 第 4 条）', () => {
  test('顺序 A：第三方先装、SDK 后装——双方都看到业务请求，SDK 数据送达', async () => {
    const native = installNativeStub();
    const apm = installFakeApm();
    const upload = createUploadStub();
    const assembly = buildAssembly(upload);
    assembly.init();
    await globalView.fetch(businessUrl);
    await settle();
    assembly.flush();
    await waitFor(() => eventNames(upload).includes('web_http'));

    // 双方数据都正确：第三方看到 1 次业务请求；SDK 采集成 web_http 并送达端点。
    expect(apm.fetchCalls.filter((url) => url === businessUrl)).toHaveLength(1);
    expect(native.calls.filter((url) => url === businessUrl)).toHaveLength(1);
    expect(eventNames(upload)).toContain('web_http');

    // SDK 捕获到的"原生"引用就是第三方那一层（它先装）——因此 SDK 的真实发送会经过第三方。
    expect(assembly.nativeHttpRefs.fetch).toBe(apm.wrapper);

    assembly.destroy();
    // 卸载后第三方那一层仍在全局上（SDK 的复合函数是最后一层，还原到 chain.base = 第三方包装）。
    expect(globalView.fetch).toBe(apm.wrapper);
    await globalView.fetch(`${businessUrl}?after=destroy`);
    expect(apm.fetchCalls).toContain(`${businessUrl}?after=destroy`);
    apm.uninstall();
    probe['apm.order.apmFirst'] = true;
  });

  test('顺序 B：SDK 先装、第三方后装——双方都看到业务请求，SDK 数据送达', async () => {
    const native = installNativeStub();
    const upload = createUploadStub();
    const assembly = buildAssembly(upload);
    assembly.init();
    const apm = installFakeApm();
    await globalView.fetch(businessUrl);
    await settle();
    assembly.flush();
    await waitFor(() => eventNames(upload).includes('web_http'));

    expect(apm.fetchCalls.filter((url) => url === businessUrl)).toHaveLength(1);
    expect(native.calls.filter((url) => url === businessUrl)).toHaveLength(1);
    expect(eventNames(upload)).toContain('web_http');
    // SDK 捕获的是**未包装**的原生引用（先装）。
    expect(assembly.nativeHttpRefs.fetch).not.toBe(apm.wrapper);

    assembly.destroy();
    // 第三方的包装在 SDK 之上：SDK 卸载时**不得**覆盖它（Q7 第 4 条）。
    // 实测失败：`registry.dispose()` 无条件把 `chain.holder[key]` 还原为 `chain.base`，
    // 抹掉了第三方的包装层 → 业务请求不再经过第三方。缺陷位置与证据见报告。
    expect(globalView.fetch, '缺陷：destroy 抹掉第三方包装').toBe(apm.wrapper);
    await globalView.fetch(`${businessUrl}?after=destroy`);
    expect(apm.fetchCalls).toContain(`${businessUrl}?after=destroy`);
    expect(native.calls).toContain(`${businessUrl}?after=destroy`);
    apm.uninstall();
    probe['apm.order.sdkFirst'] = true;
  });

  test('顺序 A + 多个第三方叠加：两个第三方先装，destroy 后回到最外层第三方那一层', async () => {
    const native = installNativeStub();
    const apmOne = installFakeApm();
    const apmTwo = installFakeApm();
    const upload = createUploadStub();
    const assembly = buildAssembly(upload);
    assembly.init();
    await globalView.fetch(businessUrl);
    await settle();
    assembly.flush();
    await waitFor(() => eventNames(upload).includes('web_http'));

    // 两层第三方都看到业务请求，SDK 也采集到（请求穿过 apmTwo → apmOne → SDK 层 → 原生）。
    expect(apmOne.fetchCalls).toEqual([businessUrl]);
    expect(apmTwo.fetchCalls).toEqual([businessUrl]);
    expect(native.calls).toEqual([businessUrl]);
    expect(eventNames(upload)).toContain('web_http');
    // 注意：`assembly.nativeHttpRefs` 由 transport 按 target 缓存、进程内幂等（见
    // `packages/transport/src/sender/native.ts` 的 `captureCache`），因此这里不断言它的具体取值。

    assembly.destroy();
    // 还原到 chain.base = apmTwo 那一层：两层第三方都还在链上，业务请求仍被双方采集。
    expect(globalView.fetch).toBe(apmTwo.wrapper);
    await globalView.fetch(`${businessUrl}?after=destroy`);
    expect(native.calls).toContain(`${businessUrl}?after=destroy`);
    expect(apmOne.fetchCalls).toContain(`${businessUrl}?after=destroy`);
    expect(apmTwo.fetchCalls).toContain(`${businessUrl}?after=destroy`);
    apmTwo.uninstall();
    apmOne.uninstall();
    probe['apm.stacked.apmFirst'] = true;
  });

  test('顺序 B + 多个第三方叠加：SDK 先装、两层第三方后装，destroy 后两层都不动', async () => {
    const native = installNativeStub();
    const upload = createUploadStub();
    const assembly = buildAssembly(upload);
    assembly.init();
    const apmOne = installFakeApm();
    const apmTwo = installFakeApm();
    await globalView.fetch(businessUrl);
    await settle();
    assembly.flush();
    await waitFor(() => eventNames(upload).includes('web_http'));

    expect(apmOne.fetchCalls).toEqual([businessUrl]);
    expect(apmTwo.fetchCalls).toEqual([businessUrl]);
    expect(native.calls).toEqual([businessUrl]);
    expect(eventNames(upload)).toContain('web_http');

    assembly.destroy();
    // 当前全局值是最外层第三方（apmTwo），不是 SDK 自己那一层：SDK 一层都不许动。
    expect(globalView.fetch, '缺陷：destroy 抹掉多层第三方包装').toBe(apmTwo.wrapper);
    await globalView.fetch(`${businessUrl}?after=destroy`);
    expect(native.calls).toContain(`${businessUrl}?after=destroy`);
    expect(apmOne.fetchCalls).toContain(`${businessUrl}?after=destroy`);
    expect(apmTwo.fetchCalls).toContain(`${businessUrl}?after=destroy`);
    apmTwo.uninstall();
    apmOne.uninstall();
    probe['apm.stacked.sdkFirst'] = true;
  });

  test('错误监听链：两个 hook 都在链上，SDK 卸载后第三方仍收到 error 事件', async () => {
    installNativeStub();
    const apm = installFakeApm();
    const upload = createUploadStub();
    const assembly = buildAssembly(upload);
    assembly.init();
    dispatchError('compat-boom');
    await settle();

    // 第三方侧：监听器在链上，收到事件。
    expect(apm.errors.length).toBe(1);

    assembly.destroy();
    // SDK 卸载后第三方监听器仍在（只还原自己那一层）——Q7 第 4 条的直接判据。
    dispatchError('compat-after-destroy');
    expect(apm.errors.length).toBe(2);
    apm.uninstall();
    probe['apm.error.chain'] = true;
  });
});

describe('矩阵落盘', () => {
  test('写出 results/apm-coexistence.json', () => {
    const cells: MatrixCell[] = [
      cell('apm.order.apmFirst', {
        requirement: 'T30 验收：与第三方 APM 共存（第三方先初始化）',
        dimension: '共存 / 初始化顺序 A',
        engine: 'happy-dom（进程内，真实 hook 链）',
        evidence: '本次运行输出 + results/apm-coexistence.json',
        notes:
          '业务请求双方各计一次；SDK 批次送达且含 web_http；SDK 卸载后第三方包装仍在全局上。' +
          '实测：该顺序下 SDK 捕获的"原生"引用即第三方包装（真实发送会经过第三方）。',
      }),
      cell('apm.order.sdkFirst', {
        requirement: 'T30 验收：与第三方 APM 共存（SDK 先初始化）',
        dimension: '共存 / 初始化顺序 B',
        engine: 'happy-dom（进程内，真实 hook 链）',
        evidence: '本次运行输出 + results/apm-coexistence.json',
        notes:
          '业务请求双方各计一次、SDK 批次送达；`destroy()` 后第三方包装**仍在**全局上' +
          '（修复后：`dispose()` 仅在当前全局值仍是 SDK 自己那一层时才还原 `chain.base`）。',
      }),
      cell('apm.stacked.apmFirst', {
        requirement: 'Q7 第 4 条：卸载后 hook 链完整（多个第三方叠加）',
        dimension: '共存 / 初始化顺序 A + 两层第三方',
        engine: 'happy-dom（进程内，真实 hook 链）',
        evidence: '本次运行输出 + results/apm-coexistence.json',
        notes:
          '两个第三方都在 SDK 之前装上；`destroy()` 后全局值回到最外层第三方那一层（chain.base），' +
          '业务请求仍穿过两层第三方与 SDK 层。',
      }),
      cell('apm.stacked.sdkFirst', {
        requirement: 'Q7 第 4 条：卸载后 hook 链完整（多个第三方叠加）',
        dimension: '共存 / 初始化顺序 B + 两层第三方',
        engine: 'happy-dom（进程内，真实 hook 链）',
        evidence: '本次运行输出 + results/apm-coexistence.json',
        notes:
          'SDK 先装、两个第三方依次后装；`destroy()` 后最外层（第三方）与内层都被保留，' +
          '两层第三方与原生都仍收到业务请求。',
      }),
      cell('apm.error.chain', {
        requirement: 'Q7 第 4 条：卸载后 hook 链完整',
        dimension: '共存 / error 监听链',
        engine: 'happy-dom',
        evidence: '本次运行输出（派发 error 事件后第三方计数 1 → 2）',
        notes: 'SDK 卸载后第三方仍收到 error 事件（只还原自己那一层）。',
      }),
    ];
    const file = writeCells('apm-coexistence', cells);
    expect(file).toContain('apm-coexistence.json');
    // 状态由探针推导，本用例只校验取值合法（`fail` 是本任务要报告的真实结论，不是本用例的失败）。
    for (const entry of cells) {
      expect(['pass', 'fail', 'blocked'], entry.id).toContain(entry.status);
    }
  });
});
