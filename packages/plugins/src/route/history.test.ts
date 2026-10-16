/**
 * C05-AC-08 History 模式：`pushState`、`replaceState`、后退各自路由变化都上报 `web_pageview`，
 * `page_id` 为**路由模板**（T18-plan §3 裁定：自动路由插件，可卸载、恢复原生方法）。
 *
 * 本用例驱动注入的伪造 `history` 与伪造注册表，因此能确定性断言：
 * ① 三种变化各通知一次；② 模板匹配生效；③ 卸载后原生方法被恢复；
 * ④ 若第三方在本 SDK 之后又替换了方法，卸载**不得**误删第三方 hook（§6 的叠加规则）。
 */
import { describe, expect, it } from 'vitest';

import { createRouteCapture } from './index';
import type { RouteChange } from './index';

type PushState = (data: unknown, unused: string, url?: string | URL | null) => void;

/** 测试用的 `history` 形状：两个方法都是**函数属性**（不是方法签名），便于 `toBe` 比较。 */
interface TestHistory {
  pushState: PushState;
  replaceState: PushState;
}

/** 伪造的 `history`：记录调用，供断言包装是否转发。 */
function createFakeHistory(): {
  history: TestHistory;
  calls: string[];
  originalPush: PushState;
  originalReplace: PushState;
} {
  const calls: string[] = [];
  const originalPush: PushState = () => {
    calls.push('original:push');
  };
  const originalReplace: PushState = () => {
    calls.push('original:replace');
  };
  return {
    history: { pushState: originalPush, replaceState: originalReplace },
    calls,
    originalPush,
    originalReplace,
  };
}

/**
 * 注入式注册表：成对恢复语义与 C02 `GlobalRegistry.hook` 一致。
 *
 * 关键点：注销时**仅当当前值仍是自己的包装**才写回保存的引用；
 * 若期间第三方又替换了它，则不动（否则会误删第三方 hook）。
 */
function createHooker(): RouteHookerForTest {
  return {
    hook<T extends object, K extends keyof T>(
      target: T,
      key: K,
      wrapper: (original: T[K]) => T[K],
    ): () => void {
      const saved = target[key];
      const wrapped = wrapper(saved);
      target[key] = wrapped;
      return (): void => {
        if (target[key] === wrapped) target[key] = saved;
      };
    },
  };
}

/** 测试用注册表端口类型（与 `route/plugin` 的 `RouteHooker` 同构）。 */
interface RouteHookerForTest {
  hook<T extends object, K extends keyof T>(
    target: T,
    key: K,
    wrapper: (original: T[K]) => T[K],
  ): () => void;
}

describe('C05-AC-08 History 三种变化各上报一次且 page_id 为模板', () => {
  it('pushState / replaceState / 后退 三种变化各通知一次，模板为 /task/:id', () => {
    const fake = createFakeHistory();
    const hooker = createHooker();
    const changes: string[] = [];
    const listeners: (() => void)[] = [];

    const capture = createRouteCapture({
      history: fake.history,
      hooker,
      listen: (_type, handler) => {
        listeners.push(handler);
        return () => undefined;
      },
      currentUrl: () => ({ pathname: '/task/123', hash: '' }),
      now: () => 1_700_000_000_000,
      options: { mode: 'history', templates: ['/task/:id'] },
    });
    capture.onRouteChange((change) => {
      changes.push(change.template);
    });

    // 包装必须转发到保存的那一层（不改变原生行为）
    fake.history.pushState({}, '', '/task/123');
    fake.history.replaceState({}, '', '/task/456');
    // 后退（popstate）由原生监听触发
    for (const handler of listeners) handler();

    expect(changes, '三种路由变化各上报一次').toHaveLength(3);
    expect(changes).toEqual(['/task/:id', '/task/:id', '/task/:id']);
    expect(fake.calls, '包装必须调用保存的那一层').toContain('original:push');
    expect(fake.calls).toContain('original:replace');

    capture.uninstall();
    const restoredPush: PushState = fake.history.pushState;
    const restoredReplace: PushState = fake.history.replaceState;
    expect(restoredPush, '卸载后必须恢复原生方法').toBe(fake.originalPush);
    expect(restoredReplace, '卸载后必须恢复原生方法').toBe(fake.originalReplace);
  });

  it('卸载时若第三方又替换了 pushState，则不得误删第三方 hook', () => {
    const fake = createFakeHistory();
    const capture = createRouteCapture({
      history: fake.history,
      hooker: createHooker(),
      listen: () => () => undefined,
      currentUrl: () => ({ pathname: '/', hash: '' }),
      options: { mode: 'history' },
    });

    const thirdParty: PushState = () => undefined;
    fake.history.pushState = thirdParty;
    capture.uninstall();
    const current: PushState = fake.history.pushState;
    expect(current, '当前值不是自己的包装时不得还原').toBe(thirdParty);
  });

  it('重复卸载幂等，且不吞宿主抛出的异常', () => {
    const fake = createFakeHistory();
    // 宿主自己的 pushState 会抛错：包装不得吞掉它
    const throwingOriginal: PushState = () => {
      throw new Error('host error');
    };
    fake.history.pushState = throwingOriginal;
    const capture = createRouteCapture({
      history: fake.history,
      hooker: createHooker(),
      listen: () => () => undefined,
      currentUrl: () => ({ pathname: '/', hash: '' }),
      options: { mode: 'history' },
    });

    expect(() => {
      fake.history.pushState({}, '', '/');
    }, '宿主抛出的异常不得被包装吞掉').toThrow('host error');
    capture.uninstall();
    expect(() => {
      capture.uninstall();
    }).not.toThrow();
  });
});

/**
 * 覆盖缺口（T33 §11.8 第 1 处）：`RouteChange.at` 必须来自注入的 `now` 端口。
 *
 * 判别口径：注入一个**不可能自然出现**的时间戳（`4102444800000` = 2100-01-01T00:00:00Z），
 * 断言产出的 `change.at` **等于该注入值**。此前多处用例注入了 `now` 却只断言
 * `via`/`path`/`template`，因此"不调用注入值（改用 `Date.now`）"与"调用了但丢弃
 * 返回值"两种接线错误都不会变红；本用例断言的是**值**。
 */
describe('RouteChange.at 必须来自注入的 now', () => {
  it('push / replace / pop 三种变化的 change.at 都等于注入值 4102444800000', () => {
    const injectedNow = 4_102_444_800_000;
    const fake = createFakeHistory();
    const listeners: (() => void)[] = [];
    const changes: RouteChange[] = [];

    const capture = createRouteCapture({
      history: fake.history,
      hooker: createHooker(),
      listen: (_type, handler) => {
        listeners.push(handler);
        return () => undefined;
      },
      currentUrl: () => ({ pathname: '/task/123', hash: '' }),
      now: () => injectedNow,
      options: { mode: 'history', templates: ['/task/:id'] },
    });
    capture.onRouteChange((change) => {
      changes.push(change);
    });

    fake.history.pushState({}, '', '/task/123');
    fake.history.replaceState({}, '', '/task/456');
    for (const handler of listeners) handler();

    expect(changes, '三种路由变化各产生一条 change').toHaveLength(3);
    expect(
      changes.map((change) => change.at),
      `change.at 必须是注入 now 的返回值 ${String(injectedNow)}（Date.now 或丢弃返回值都会在此变红）`,
    ).toEqual([injectedNow, injectedNow, injectedNow]);
    for (const change of changes) {
      expect(change.at, 'change.at 不得是 Date.now()').not.toBe(Date.now());
    }
  });
});
