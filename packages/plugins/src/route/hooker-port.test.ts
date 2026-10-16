/**
 * 覆盖缺口（T33 §11.9）：`RoutePorts.hooker`（`route/plugin.ts:194`）必须**真的被使用**。
 *
 * 病根（已由钉常量法确认，无需重新调查）：既有用例注入的 `createHooker()`
 * （`history.test.ts:50`）与降级实现 `createInlineHooker()`（`internal/hooker.ts:24`）
 * **语义同形**——都成对安装、都在"当前值仍是自己包装"时才恢复；旧断言只覆盖
 * "包装转发到原层 + 卸载恢复原引用"，这两点在**两种实现下都能满足**，
 * 所以"实现究竟用了哪个 hooker"在输出上完全看不出来。
 *
 * 判别口径：注入一个**自带簿记**的 hooker 桩。桩记录每次 `hook()` 收到的
 * `target` 身份 / `key` / 安装前保存的原值，记住自己实际装上的那一层，
 * 并记录自己被注销的 key。这些簿记**只可能由注入的桩产生**——
 * 降级实现 `createInlineHooker()` 一条都留不下：
 * - 口径A（实现不读注入 hooker，改用 `createInlineHooker()`）：
 *   `keys()` 为空、`installedValue()` 为 `undefined`、`originalValue()` 为 `undefined` → 红；
 * - 口径B（调用了 `hooker.hook` 但丢弃它返回的注销函数）：
 *   卸载后 `liveCount()` 仍为 2、`disposedKeys()` 为空、原生引用未恢复 → 红。
 *
 * 断言全部是**值/行为级**（调用的参数与身份、装上层身份、注销前后状态、通知载荷），
 * 而不是"某事件存在"。
 */
import { describe, expect, it } from 'vitest';

import { createRouteCapture } from './index';
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

type PushState = (data: unknown, unused: string, url?: string | URL | null) => void;

interface TestHistory {
  pushState: PushState;
  replaceState: PushState;
}

/** 伪造 history：两个方法都是函数属性，便于 `toBe` 比较身份。 */
function createFakeHistory(): {
  history: TestHistory;
  originalPush: PushState;
  originalReplace: PushState;
} {
  const originalPush: PushState = () => undefined;
  const originalReplace: PushState = () => undefined;
  return {
    history: { pushState: originalPush, replaceState: originalReplace },
    originalPush,
    originalReplace,
  };
}

describe('RoutePorts.hooker 必须真的被使用（注入桩的可观测簿记）', () => {
  it('pushState/replaceState 各经过注入 hooker 一次；装的是桩那一层；卸载后桩的层全部注销', () => {
    const fake = createFakeHistory();
    const stub = createObservableHooker();
    const changes: string[] = [];

    const capture = createRouteCapture({
      history: fake.history,
      hooker: stub.hooker,
      listen: () => () => undefined,
      currentUrl: () => ({ pathname: '/task/123', hash: '' }),
      options: { mode: 'history', templates: ['/task/:id'] },
    });
    capture.onRouteChange((change) => changes.push(change.template));

    // ① 注入的 hooker 真的被调用：次数、顺序、key、target 身份、保存的原值都是预期的
    expect(stub.keys(), '注入 hooker 必须被调用两次（pushState/replaceState）').toEqual([
      'pushState',
      'replaceState',
    ]);
    expect(stub.calls().map((call) => call.target)).toEqual([fake.history, fake.history]);
    expect(stub.originalValue('pushState')).toBe(fake.originalPush);
    expect(stub.originalValue('replaceState')).toBe(fake.originalReplace);

    // ② 当前装在 history 上的那一层**就是注入桩装的那一层**（不是降级实现装的那层）
    expect(fake.history.pushState, 'pushState 必须由注入 hooker 安装').toBe(
      stub.installedValue('pushState'),
    );
    expect(fake.history.replaceState, 'replaceState 必须由注入 hooker 安装').toBe(
      stub.installedValue('replaceState'),
    );

    // ③ 行为级：桩装上来的包装被调用后确实按模板通知（值断言）
    fake.history.pushState({}, '', '/task/123');
    expect(changes).toEqual(['/task/:id']);
    expect(stub.liveCount(), '未卸载前两层都在').toBe(2);

    // ④ 桩返回的注销函数必须被真的用上：卸载后层数为 0、注销被记录、原生引用恢复
    capture.uninstall();
    expect(stub.liveCount(), '卸载后注入 hooker 装上的层必须全部注销').toBe(0);
    expect(stub.disposedKeys()).toEqual(['pushState', 'replaceState']);
    expect(fake.history.pushState, '卸载后必须恢复原生 pushState').toBe(fake.originalPush);
    expect(fake.history.replaceState, '卸载后必须恢复原生 replaceState').toBe(fake.originalReplace);
  });
});
