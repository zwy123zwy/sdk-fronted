/**
 * 覆盖缺口（T33 §11.9）：`HttpPorts.hooker`（`http/plugin.ts:262`）必须**真的被使用**。
 *
 * 病根与 `RoutePorts.hooker` 同源：既有用例注入的 `createHooker()`
 * （`capture.test.ts:111`、`trace-header.test.ts:59`）与降级实现 `createInlineHooker()`
 * **语义同形**，旧断言只覆盖"包装把请求送到宿主 + 卸载恢复原引用"，
 * 两种实现都能满足，所以"实现究竟用了哪个 hooker"在输出上完全看不出来。
 *
 * 判别口径：注入一个**自带簿记**的 hooker 桩（与 `route/hooker-port.test.ts` 同一套桩，
 * 但本文件独立断言的是 **http 插件路径**：`fetch` 与 `XMLHttpRequest` 两条包装）。
 * 桩记录每次 `hook()` 收到的 `target` 身份 / `key` / 安装前保存的原值，
 * 记住自己实际装上的那一层，并记录自己被注销的 key：
 * - 口径A（实现不读注入 hooker，改用 `createInlineHooker()`）：
 *   `keys()` 为空、`installedValue()` 为 `undefined` → 红；
 * - 口径B（调用了 `hooker.hook` 但丢弃它返回的注销函数）：
 *   卸载后 `liveCount()` 仍为 2、`disposedKeys()` 为空、`refs` 上未恢复原引用 → 红。
 *
 * 断言全部是**值/行为级**（调用参数与身份、装上层身份、两条链路上产出的
 * `web_http` 的 `status`/`method` 值、注销前后状态）。
 */
import { describe, expect, it } from 'vitest';

import { createHttpCapture } from './index';
import type { HttpEvent } from './index';
import type { Hooker } from '../internal/hooker';

/** 桩记录到的一次 `hook()` 调用。 */
interface HookCall {
  readonly target: object;
  readonly key: string;
}

/** 可观测 hooker 桩：语义同 `createInlineHooker()`，但额外留下只有注入桩才有的簿记。 */
interface ObservableHooker {
  readonly hooker: Hooker;
  /** 按调用顺序返回每次 `hook()` 收到的参数（target 身份 + key）。 */
  calls(): readonly HookCall[];
  /** 按调用顺序返回 key（便于 `toEqual` 值断言）。 */
  keys(): readonly string[];
  /** 桩实际装到 `target[key]` 上的那一层；未被调用过则为 `undefined`。 */
  installedValue(key: string): unknown;
  /** 桩在安装前保存的原值（即交给包装函数的 `original`）；未被调用过则为 `undefined`。 */
  originalValue(key: string): unknown;
  /** 尚未注销的层数；全部注销后为 0。 */
  liveCount(): number;
  /** 已被成功注销的 key（顺序）。 */
  disposedKeys(): readonly string[];
}

function createObservableHooker(): ObservableHooker {
  const calls: HookCall[] = [];
  const installed = new Map<string, unknown>();
  const originals = new Map<string, unknown>();
  const disposed: string[] = [];
  const live = new Set<string>();

  const hooker: Hooker = {
    hook<T extends object, K extends keyof T>(
      target: T,
      key: K,
      wrapper: (original: T[K]) => T[K],
    ): () => void {
      const saved = target[key];
      const wrapped = wrapper(saved);
      calls.push({ target, key: String(key) });
      originals.set(String(key), saved);
      installed.set(String(key), wrapped);
      live.add(String(key));
      target[key] = wrapped;
      return (): void => {
        // 与降级实现同一套条件恢复语义：期间被第三方替换过就不动它。
        if (target[key] === wrapped) {
          target[key] = saved;
          disposed.push(String(key));
          live.delete(String(key));
        }
      };
    },
  };

  return {
    hooker,
    calls: () => [...calls],
    keys: () => calls.map((call) => call.key),
    installedValue: (key: string) => installed.get(key),
    originalValue: (key: string) => originals.get(key),
    liveCount: () => live.size,
    disposedKeys: () => [...disposed],
  };
}

/** 伪造 XHR 实例只用到的成员。 */
interface XhrStub {
  status: number;
  open: (method: string, url: string) => void;
  addEventListener: (type: string, listener: () => void) => void;
}

/** 伪造的引用容器（形状同 `NativeHttpRefs`，`XMLHttpRequest` 声明为 unknown）。 */
interface HttpRefsStub {
  fetch: (...args: readonly unknown[]) => Promise<unknown>;
  XMLHttpRequest: unknown;
}

describe('HttpPorts.hooker 必须真的被使用（注入桩的可观测簿记）', () => {
  it('fetch 与 XMLHttpRequest 两条路径都经过注入 hooker；装的是桩那一层；卸载后桩的层全部注销', async () => {
    const events: HttpEvent[] = [];
    const xhrListeners: (() => void)[] = [];
    const originalFetch = (...args: readonly unknown[]): Promise<unknown> =>
      Promise.resolve({ status: 200, args });
    function FakeXhr(): XhrStub {
      return {
        status: 0,
        open: () => undefined,
        addEventListener: (type, listener) => {
          if (type === 'loadend') xhrListeners.push(listener);
        },
      };
    }
    const holder: HttpRefsStub = { fetch: originalFetch, XMLHttpRequest: FakeXhr };
    const stub = createObservableHooker();

    const capture = createHttpCapture((event) => events.push(event), {
      refs: holder,
      hooker: stub.hooker,
      now: () => 1_700_000_000_000,
    });

    // ① 注入 hooker 被调用两次，key/target 身份/保存的原值都是预期的
    expect(stub.keys(), '注入 hooker 必须覆盖 fetch 与 XMLHttpRequest 两条路径').toEqual([
      'fetch',
      'XMLHttpRequest',
    ]);
    expect(stub.calls().map((call) => call.target)).toEqual([holder, holder]);
    expect(stub.originalValue('fetch')).toBe(originalFetch);
    expect(stub.originalValue('XMLHttpRequest')).toBe(FakeXhr);

    // ② 装在 refs 上的那一层**就是注入桩装的那一层**（不是降级实现装的那层）
    expect(holder.fetch, 'fetch 必须由注入 hooker 安装').toBe(stub.installedValue('fetch'));
    expect(holder.XMLHttpRequest, 'XMLHttpRequest 必须由注入 hooker 安装').toBe(
      stub.installedValue('XMLHttpRequest'),
    );

    // ③ 行为级：桩装上的两层都在请求路径上，产出值为预期的 web_http
    await holder.fetch('https://app.example.com/api/task/1?token=fake-token-abcdef');
    // 单次类型断言（同 `capture.test.ts:227`）：容器上的 XHR 已被注入 hooker 换成可 `new` 的包装。
    const XhrCtor = holder.XMLHttpRequest as new () => XhrStub;
    const xhr = new XhrCtor();
    xhr.status = 201;
    xhr.open('POST', 'https://app.example.com/api/create?token=fake-token-abcdef');
    for (const listener of xhrListeners) listener();

    expect(events.map((event) => event.metrics.status)).toEqual([200, 201]);
    expect(events.map((event) => event.dimensions.method)).toEqual(['GET', 'POST']);
    expect(events.map((event) => event.dimensions.url_template)).toEqual([
      'https://app.example.com/api/task/1',
      'https://app.example.com/api/create',
    ]);
    expect(stub.liveCount(), '未卸载前两层都在').toBe(2);

    // ④ 桩返回的注销函数必须被真的用上
    capture.uninstall();
    expect(stub.liveCount(), '卸载后注入 hooker 装上的层必须全部注销').toBe(0);
    expect(stub.disposedKeys()).toEqual(['fetch', 'XMLHttpRequest']);
    expect(holder.fetch, '卸载后必须恢复注入的原 fetch').toBe(originalFetch);
    expect(holder.XMLHttpRequest, '卸载后必须恢复原 XMLHttpRequest').toBe(FakeXhr);
  });
});
