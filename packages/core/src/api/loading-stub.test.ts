/**
 * C01 加载桩（C01-F3）验收用例：C01-AC-06、C01-AC-07、C01-AC-08。
 * 加载桩是独立于主包的普通脚本（`packages/browser/src/loading-stub.ts`），
 * 这里在 vm 沙箱里模拟浏览器执行它，再把缓存的命令交给真实客户端回放。
 *
 * 说明：`packages/core/tsconfig.json` 的 `"types": []` 不引入 Node 类型（SDK 源码必须零运行时依赖），
 * 所以本文件只声明测试真正用到的那几个 Node 能力，不做 `any` 转换、不关闭任何检查。
 */

/** Node 全局能力的最小声明：测试环境由 Node 提供，SDK 源码本身零运行时依赖。 */
interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
}
interface NodeZlib {
  gzipSync(data: Uint8Array, options: { level: number }): Uint8Array;
}
type VmContext = { readonly __vmContextBrand?: never };
interface NodeVm {
  createContext(sandbox: object): VmContext;
  runInContext(code: string, context: VmContext, options?: { filename?: string }): unknown;
}
declare const process: { getBuiltinModule(id: string): unknown };
// Node 22.3+ 的 process.getBuiltinModule 是唯一不需要静态 import 的取内置模块方式，
// 这样 `types: []` 的包也能在测试里用 Node，而不会给 SDK 源码引入 Node 类型依赖。
const nodeFs = process.getBuiltinModule('node:fs') as NodeFs;
const nodeZlib = process.getBuiltinModule('node:zlib') as NodeZlib;
const nodeVm = process.getBuiltinModule('node:vm') as NodeVm;

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { KernelEvent } from '../kernel';
import { STATE_CAPABILITY, STUB_BRIDGE_CAPABILITY, createClient } from './index';
import type { ClientState, StubCommand } from './types';

/**
 * 去掉 TypeScript 语法糖，得到可在浏览器/vm 里直接执行的脚本。
 * 用仓库已有的 TypeScript 编译器完成，避免手写正则漏掉边角情况。
 */
function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
      removeComments: true,
    },
    reportDiagnostics: false,
  }).outputText;
}

/** 加载桩源码目录：`.../packages/core/src/api` → `.../packages/browser/src`。 */
function stubPath(): string {
  const url = import.meta.url;
  const here = url.startsWith('file://') ? url.slice('file://'.length) : url;
  const dir = here.slice(0, here.lastIndexOf('/'));
  return `${dir}/../../../browser/src/loading-stub.ts`;
}

const STUB_TYPESCRIPT = nodeFs.readFileSync(stubPath(), 'utf8');
const STUB_SOURCE = stripTypes(STUB_TYPESCRIPT);

interface StubGlobal {
  init(options?: unknown): void;
  track(name: string, input?: unknown): void;
  log(level: string, message: string, input?: unknown): void;
  captureError(error: unknown, input?: unknown): void;
  setUser(id: string, options?: unknown): void;
  clearUser(): void;
  setContext(key: string, value: string): void;
  removeContext(key: string): void;
  setPage(pageId: string): void;
  setConsent(state: string): void;
  flush(): void;
  destroy(): void;
  getQueueLength(): number;
  drain(): readonly StubCommand[];
  readonly queueLimit: number;
  ready: boolean;
}

/** 加载桩交接：主包通过内部能力（不是公共 API）回放缓存命令。 */
function stubBridge(client: ReturnType<typeof createClient>): (command: StubCommand) => void {
  const capability = client.kernel.getCapability(STUB_BRIDGE_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('未注册加载桩交接能力');
  return capability as (command: StubCommand) => void;
}

/** 把加载桩缓存的命令交给主包实例回放。 */
function replayInto(client: ReturnType<typeof createClient>, commands: readonly StubCommand[]): void {
  const bridge = stubBridge(client);
  for (const command of commands) bridge(command);
  client.flush();
}

/** 读取实例状态快照（走内核能力，不占用公共 API 方法）。 */
function stateOf(client: ReturnType<typeof createClient>): ClientState {
  const capability = client.kernel.getCapability(STATE_CAPABILITY);
  if (typeof capability !== 'function') throw new Error('未注册状态能力');
  return (capability as () => ClientState)();
}

/**
 * 在沙箱里执行加载桩。沙箱的 `globalThis` 就是页面的 `window`（与浏览器一致），
 * 这样加载桩挂到 `globalThis.WebReportSDK` 的对象，测试也能从 `window` 上取到。
 */
function createPage(): {
  readonly window: Record<string, unknown>;
  readonly context: VmContext;
  readonly dispatch: (type: string, event: unknown) => void;
} {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const window: Record<string, unknown> = {
    console: { warn: () => undefined },
    // 调用当时的 URL 快照由加载桩读取 location.href 得到
    location: { href: 'https://a.example/p/1' },
    // 加载桩会在 window 上注册捕获阶段的 error 监听（尽早捕获首屏错误）
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
  };
  return {
    window,
    context: nodeVm.createContext(window),
    dispatch: (type: string, event: unknown): void => {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
  };
}

function loadStub(): {
  readonly window: Record<string, unknown>;
  readonly context: VmContext;
  readonly sdk: StubGlobal;
  readonly dispatch: (type: string, event: unknown) => void;
} {
  const page = createPage();
  nodeVm.runInContext(STUB_SOURCE, page.context, { filename: 'loading-stub.ts' });
  const sdk = page.window['WebReportSDK'];
  if (typeof sdk !== 'object' || sdk === null) throw new Error('加载桩没有安装 WebReportSDK');
  return {
    window: page.window,
    context: page.context,
    sdk: sdk as unknown as StubGlobal,
    dispatch: page.dispatch,
  };
}

describe('C01 加载桩', () => {
  it('C01-AC-06 主包延迟加载期间缓存的调用按原顺序回放到主包实例', () => {
    const { sdk } = loadStub();

    sdk.init({ appId: 'app-a', consent: 'granted' });
    sdk.track('task_complete', { dimensions: { task_id: 't-1' } });
    sdk.setUser('user-1');
    expect(sdk.getQueueLength()).toBe(3);

    const queue = sdk.drain();
    expect(queue).toHaveLength(3);
    expect(queue[0]?.kind).toBe('init');
    expect(queue[1]?.kind).toBe('track');
    expect(queue[1]?.name).toBe('task_complete');
    expect(queue[1]?.url).toBe('https://a.example/p/1');
    expect(queue[1]?.occurredAt).toBeTypeOf('number');
    expect(queue[2]?.kind).toBe('setUser');

    // 模拟主包（例如延迟 3 秒）加载完成
    const events: KernelEvent[] = [];
    const client = createClient({ onEvent: (event) => events.push(event) });
    replayInto(client, queue);

    expect(events.map((event) => event['event_name'])).toEqual(['task_complete']);
    expect(events[0]?.['dimensions']).toEqual({ task_id: 't-1' });
    // 事件体只含 batch.schema.json $defs/event 允许的键（app_id 属于批次头，不在事件体）
    expect(events[0]?.['event_id']).toBe(queue[1]?.eventId);
    expect(events[0]?.['schema_version']).toBe(1);
    expect(events[0]?.['priority']).toBe('normal');
    expect(Object.prototype.hasOwnProperty.call(events[0] ?? {}, 'app_id')).toBe(false);
    expect(events[0]?.['url']).toBe('https://a.example/p/1');
    expect(stateOf(client).user?.id).toBe('user-1');
    client.destroy();
  });

  it('C01-AC-06 缓存期间抛出的 JS 错误与 track 都被上报', () => {
    const { sdk } = loadStub();

    sdk.init({ appId: 'app-a', consent: 'granted' });
    sdk.track('page_before_error');
    sdk.captureError(new Error('首屏错误'));
    sdk.track('page_after_error');

    const events: KernelEvent[] = [];
    const client = createClient({ onEvent: (event) => events.push(event) });
    replayInto(client, sdk.drain());

    expect(events.map((event) => event['event_name'])).toEqual([
      'page_before_error',
      'web_js_error',
      'page_after_error',
    ]);
    expect(events[1]?.['dimensions']).toMatchObject({ message: '首屏错误' });
    client.destroy();
  });

  it('C01-AC-07 主包加载失败（404）时加载桩不抛错、不影响页面且队列不超过上限', () => {
    const { window, sdk } = loadStub();

    // 主包 404：没有任何后续脚本，只有加载桩生效
    expect(() => {
      sdk.init({ appId: 'app-a', consent: 'granted' });
      for (let index = 0; index < 250; index += 1) {
        sdk.track(`queue_event_${String(index)}`);
      }
    }).not.toThrow();

    expect(sdk.queueLimit).toBe(200);
    expect(sdk.getQueueLength()).toBe(200);
    expect(sdk.ready).toBe(false);
    // 页面其他脚本照常工作
    expect(window['WebReportSDK']).toBeDefined();
  });

  it('C01-AC-08 加载桩 gzip 后不超过 1 KB', () => {
    // 度量对象：类型擦除 + 去注释 + 轻量整理（去空行/行首尾空白）后的脚本。
    // 真实交付是 `packages/browser/scripts/measure-stub.mjs` 输出的压缩 IIFE，只会更小
    // （实测约 781 B）；这里用未压缩的保守形态作为常驻守卫。
    const light = STUB_SOURCE.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
    const encoded = new TextEncoder().encode(light);
    const bytes = encoded.byteLength;
    const gzipped = nodeZlib.gzipSync(encoded, { level: 9 }).byteLength;

    expect(bytes).toBeGreaterThan(0);
    expect(gzipped).toBeLessThanOrEqual(1024);
  });

  it('C01-AC-06 加载桩重复执行时不重置已有队列', () => {
    const { context, sdk } = loadStub();
    sdk.track('first_event');

    nodeVm.runInContext(STUB_SOURCE, context, { filename: 'loading-stub.ts' });

    expect(sdk.getQueueLength()).toBe(1);
    expect(sdk.drain()).toHaveLength(1);
  });
});
