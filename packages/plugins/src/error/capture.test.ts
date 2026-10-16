/**
 * C05-F1 错误采集用例（C05-AC-01、AC-02、AC-03、AC-04）。
 *
 * 口径：AC 原文照抄 `tests/acceptance/C05.md`；样本都是**格式合法的伪造数据**
 * （伪造手机号 `13800138000`、伪造 JWT、伪造输入 `user-typed-secret-1234`），不含真实个人信息。
 *
 * 责任边界（T18-plan §1）：**脱敏在 C04 完成**，本插件不重复实现。因此 AC-01 的
 * "附带脱敏后的错误栈"按真实链路验证：插件产出 → C04 的 `constrainEvent` + `createMasker`
 * → 断言敏感值消失，并用真实 Schema 校验脱敏后的产出。
 */
// 为什么走**源码入口**而不是裸包名：`@web-report-sdk/core` 的 exports `import` 条件指向
// 未构建的 `dist/index.js`，单元测试会直接 `Failed to resolve import`；而单测不应依赖
// 先跑一次全仓 build（本轮也被禁止）。这里用相对源码入口，拿到的仍是真实 C04 实现与类型。
import { C04_LIMITS, constrainEvent, createMasker } from '../../../core/src/index';
import { describe, expect, it, vi } from 'vitest';

import { compileJsError, withEnvelope } from '../contract/schemas';
import {
  BREADCRUMB_CAPACITY,
  BREADCRUMB_CONTEXT_PREFIX,
  ERROR_PLUGIN_ID,
  JS_ERROR_EVENT_NAME,
  SOURCE_UNHANDLED_REJECTION,
  SOURCE_WINDOW_ERROR,
  createBreadcrumbBuffer,
  createErrorPlugin,
} from './index';
import type { ErrorCapture, JsErrorEvent } from './index';

/** 伪造的敏感值（格式合法、无真实信息）。 */
const FAKE_MOBILE = '13800138000';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

/** 计数记录器：断言 `filtered_by_plugin` 等原因码确实被累加。 */
function createCounters(): {
  counts: Map<string, number>;
  port: {
    count: (reason: string, delta?: number) => void;
    get: () => number;
    snapshot: () => Readonly<Record<string, number>>;
    reset: () => void;
  };
} {
  const counts = new Map<string, number>();
  return {
    counts,
    port: {
      count: (reason: string, delta = 1): void => {
        counts.set(reason, (counts.get(reason) ?? 0) + delta);
      },
      get: (): number => 0,
      snapshot: (): Readonly<Record<string, number>> => ({}),
      reset: (): void => undefined,
    },
  };
}

/** 记录型安装上下文：保存 `listen` 注册的处理器，便于按类型断言。 */
function createContext(counters: ReturnType<typeof createCounters>['port']) {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    listeners,
    context: {
      pluginId: ERROR_PLUGIN_ID,
      counters,
      pipeline: {
        register: () => () => undefined,
        process: () => ({
          status: 'processed' as const,
          event: { event_name: 'x', priority: 'normal' as const, occurred_at: 0 },
        }),
        size: () => 0,
        dispose: () => undefined,
      },
      registry: {
        listen: () => () => undefined,
        listenGlobal: () => () => undefined,
        hook: () => () => undefined,
        schedule: () => () => undefined,
        scheduleRepeat: () => () => undefined,
        stats: () => ({ listeners: 0, nativeListeners: 0, hooks: 0, timers: 0 }),
        dispose: () => undefined,
      },
      capabilities: {
        register: () => () => undefined,
        has: () => false,
        get: () => undefined,
        names: () => [],
        dispose: () => undefined,
      },
      addProcessor: () => () => undefined,
      listen: (type: string, handler: (event: Event) => void): (() => void) => {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
        return () => undefined;
      },
      hook: () => () => undefined,
      schedule: () => () => undefined,
      scheduleRepeat: () => () => undefined,
      registerCapability: () => () => undefined,
      onDispose: () => undefined,
    },
  };
}

/** 装好一个错误采集实例，返回端口、事件收集数组、原因码计数与已注册监听。 */
function setup(): {
  capture: ErrorCapture;
  events: JsErrorEvent[];
  counts: Map<string, number>;
  listeners: Map<string, ((event: Event) => void)[]>;
} {
  const events: JsErrorEvent[] = [];
  const counters = createCounters();
  const harness = createContext(counters.port);
  const plugin = createErrorPlugin((event) => {
    events.push(event);
  });
  plugin.install(harness.context);
  return {
    capture: plugin.capture,
    events,
    counts: counters.counts,
    listeners: harness.listeners,
  };
}

/** 走一次 C04 的真实脱敏与字段约束（AC-01「脱敏后的错误栈」的落点）。 */
function passThroughC04(event: JsErrorEvent): JsErrorEvent {
  return constrainEvent({
    event,
    limits: C04_LIMITS,
    masker: createMasker(),
    count: () => undefined,
  }).event as unknown as JsErrorEvent;
}

describe('C05-AC-01 未捕获异常上报 web_js_error 且 source=window_error', () => {
  it('上报 web_js_error、source=window_error、附错误栈；经 C04 脱敏后敏感值消失且仍过 Schema', () => {
    const { capture, events } = setup();
    const message = `Uncaught TypeError: failed with ${FAKE_MOBILE} and Bearer ${FAKE_JWT}`;

    // 不抛错、不返回 true：AC-01 的前置是「页面抛出未捕获异常」，插件不得吞掉宿主行为
    expect(capture.handleWindowError(message, 12, 5, new TypeError(message))).toBe(false);

    // 窗口聚合：结算后才产出事件（缺省窗口 1000 ms，见 dedup.ts 的设计说明）
    capture.flush();
    expect(events, '应上报一条 web_js_error').toHaveLength(1);
    const raw = events[0];
    expect(raw?.event_name).toBe(JS_ERROR_EVENT_NAME);
    expect(raw?.dimensions.source).toBe(SOURCE_WINDOW_ERROR);
    expect(raw?.dimensions.error_type).toBe('TypeError');
    expect(raw?.attachment, '必须附带错误栈（脱敏前的原始栈）').toContain('TypeError');
    // 责任边界：插件层**不做**脱敏，脱敏属于 C04 的管线阶段
    expect(JSON.stringify(raw), '插件层不得假装脱敏').toContain(FAKE_MOBILE);

    const masked = passThroughC04(raw as JsErrorEvent);
    // C04 对 dimensions / context 的字符串值做脱敏（message 里的数字已被归一化剥离）
    expect(masked.dimensions.message, 'C04 必须脱敏 dimensions.message 中的 JWT').not.toContain(FAKE_JWT);
    expect(masked.dimensions.message).toContain('Bearer ***');
    // C04 缺口已修复（见 docs/use-cases.md 第 3 行）：`attachment` 与 `dimensions`/`context`
    // 走**同一个** masker，因此 AC-01 的「附带脱敏后的错误栈」现在由 attachment 本身成立。
    expect(masked.attachment, 'C04 必须对 attachment 脱敏（与 dimensions 同一 masker）').not.toContain(FAKE_MOBILE);
    expect(masked.attachment).not.toContain(FAKE_JWT);
    expect(masked.attachment).toContain('Bearer ***');

    // 脱敏后的产出仍然满足真实 Schema（真实链路，不是空转）
    const validate = compileJsError();
    expect(validate(withEnvelope(masked, 'error')), JSON.stringify(validate.errors)).toBe(true);
  });

  it('手动 captureError 同样产出 web_js_error（source 缺省为 window_error）', () => {
    const { capture, events } = setup();
    capture.capture(new RangeError('manual capture'));
    capture.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.dimensions.error_type).toBe('RangeError');
    expect(events[0]?.dimensions.source).toBe(SOURCE_WINDOW_ERROR);
  });
});

describe('C05-AC-02 未处理拒绝的两种拒绝值都上报', () => {
  it('Error 对象与字符串拒绝值各上报一次，source 均为 unhandled_rejection', () => {
    const { capture, events } = setup();
    capture.handleRejection(new Error('promise failed'));
    capture.handleRejection('plain string rejection');
    capture.flush();

    expect(events, 'Error 与字符串两种拒绝值都必须上报').toHaveLength(2);
    for (const event of events) {
      expect(event.event_name).toBe(JS_ERROR_EVENT_NAME);
      expect(event.dimensions.source).toBe(SOURCE_UNHANDLED_REJECTION);
    }
    expect(events[1]?.dimensions.message.length, '字符串拒绝值也必须归一化出非空 message').toBeGreaterThan(0);
    expect(events[1]?.dimensions.message).toContain('plain string rejection');
  });

  it('两种拒绝值都能通过真实 Schema', () => {
    const { capture, events } = setup();
    capture.handleRejection(new Error('promise failed'));
    capture.handleRejection('string rejection');
    capture.flush();
    const validate = compileJsError();
    for (const event of events) {
      expect(validate(withEnvelope(event, 'error')), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});

describe('C05-AC-03 同指纹去重且 count 记总次数', () => {
  it('100 次同指纹只上报 1 条，metrics.count 为 100，并计数 filtered_by_plugin', () => {
    const { capture, events, counts } = setup();
    for (let index = 0; index < 100; index += 1) {
      capture.handleWindowError('Uncaught TypeError: same error', 12, 5, new TypeError('same error'));
    }
    // 窗口内不产出任何事件（这正是「上报次数受控」的来源）
    expect(events, '窗口未结算前不得上报').toHaveLength(0);

    capture.flush();
    expect(events, '100 次同指纹只上报 1 条').toHaveLength(1);
    expect(events[0]?.metrics.count, 'metrics.count 记录总次数').toBe(100);
    expect(counts.get('filtered_by_plugin') ?? 0, '99 次折叠必须计数 filtered_by_plugin').toBe(99);
  });

  it('判别力对照：100 条**不同**消息（非数字差异）必须上报 100 条', () => {
    const { capture, events } = setup();
    // 注意：差异必须是**非数字**的——归一化会剥离数字，用序号差异会被正确折叠
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (let index = 0; index < 100; index += 1) {
      const suffix = `${letters[index % 26] ?? 'a'}${letters[Math.floor(index / 26)] ?? 'a'}`;
      capture.handleWindowError(`Uncaught TypeError: distinct failure ${suffix}`, 1, 1);
    }
    capture.flush();
    expect(events, '不同指纹各自成窗口，必须全部上报').toHaveLength(100);
  });

  it('判别力：windowMs 生效——传 10 ms 时窗口内合并、到 10 ms 结算、窗口外另起一条', () => {
    const events: JsErrorEvent[] = [];
    const counters = createCounters();
    const harness = createContext(counters.port);
    const scheduled: (() => void)[] = [];
    const context = {
      ...harness.context,
      scheduleRepeat: (handler: () => void): (() => void) => {
        scheduled.push(handler);
        return () => undefined;
      },
    };
    let clock = 1_700_000_000_000;
    // 必须传一个**与缺省 1000 不同值**的窗口：传 1000（= 缺省）时「传了」与「缺省」不可区分。
    const plugin = createErrorPlugin((event) => events.push(event), {
      now: () => clock,
      windowMs: 10,
    });
    plugin.install(context);
    const tick = (): void => {
      for (const handler of scheduled) handler();
    };

    plugin.capture.handleWindowError('Uncaught Error: tight window', 1, 2, new Error('tight window'));
    clock += 5;
    plugin.capture.handleWindowError('Uncaught Error: tight window', 1, 2, new Error('tight window'));
    tick();
    expect(events, '距首条 5 ms（< windowMs=10）不得结算：窗口内必须合并').toHaveLength(0);

    clock += 5; // 距首条 10 ms，恰好到期
    tick();
    expect(events, '到 windowMs=10 必须结算（缺省 1000 ms 在此刻不会结算）').toHaveLength(1);
    expect(events[0]?.metrics.count, '窗口内两条必须合并为 count=2').toBe(2);

    // 窗口外：同一指纹在结算后必须重新开窗并另报一条，而不是被无限并进上一条。
    plugin.capture.handleWindowError('Uncaught Error: tight window', 1, 2, new Error('tight window'));
    tick();
    expect(events, '新窗口未到期不得结算').toHaveLength(1);
    clock += 10;
    tick();
    expect(events, '窗口外的同指纹必须另起一条').toHaveLength(2);
    expect(events[1]?.metrics.count).toBe(1);
  });

  it('窗口到期自动结算（1 秒后上报），无需显式 flush', () => {
    const events: JsErrorEvent[] = [];
    const counters = createCounters();
    const harness = createContext(counters.port);
    // 用真实定时器语义（happy-dom 环境下 setTimeout 可用）验证 windowMs 到点结算
    const scheduled: (() => void)[] = [];
    const context = {
      ...harness.context,
      scheduleRepeat: (handler: () => void): (() => void) => {
        scheduled.push(handler);
        return () => undefined;
      },
    };
    let clock = 1_700_000_000_000;
    const plugin = createErrorPlugin((event) => events.push(event), {
      now: () => clock,
      windowMs: 1000,
    });
    plugin.install(context);

    plugin.capture.handleWindowError('Uncaught Error: windowed', 1, 2, new Error('windowed'));
    expect(events).toHaveLength(0);
    // 窗口处理器被注册到内核定时器上（归还内核管理）
    expect(scheduled.length, '必须把窗口结算挂到内核定时器').toBeGreaterThan(0);
    // 未到期时不结算（判别力：不是「一到点就无条件上报」）
    for (const handler of scheduled) handler();
    expect(events, '窗口未到期不得上报').toHaveLength(0);
    clock += 1000;
    for (const handler of scheduled) handler();
    expect(events, '窗口结算后上报').toHaveLength(1);
    expect(events[0]?.metrics.count).toBe(1);
  });

  it('页面离开（pagehide/隐藏）时必须结算窗口，避免"离开前的错误"丢失', () => {
    const events: JsErrorEvent[] = [];
    const onLeaveCallbacks: (() => void)[] = [];
    const plugin = createErrorPlugin((event) => events.push(event), {
      onLeave: (callback) => {
        onLeaveCallbacks.push(callback);
        return () => undefined;
      },
    });
    const harness = createContext(createCounters().port);
    plugin.install(harness.context);

    plugin.capture.handleWindowError('Uncaught Error: just before leave', 1, 2, new Error('leave'));
    expect(events, '窗口未结算前不上报').toHaveLength(0);
    expect(onLeaveCallbacks.length, '必须注册页面离开结算钩子').toBeGreaterThan(0);
    for (const callback of onLeaveCallbacks) callback();
    expect(events, '页面离开必须结算窗口').toHaveLength(1);
    expect(events[0]?.metrics.count).toBe(1);
  });

  it('未注入 onLeave 端口时，用 pagehide 与 visibilitychange 兜底', () => {
    const { capture, events, listeners } = setup();
    capture.handleWindowError('Uncaught Error: fallback leave', 1, 2, new Error('fallback'));
    expect([...listeners.keys()]).toContain('pagehide');
    expect([...listeners.keys()]).toContain('visibilitychange');
    for (const handler of listeners.get('pagehide') ?? []) {
      handler({ type: 'pagehide' } as Event);
    }
    expect(events, 'pagehide 必须结算窗口').toHaveLength(1);
  });

  it('卸载会先结算未到期窗口（不丢已采集的错误）', () => {
    const { capture, events } = setup();
    capture.handleWindowError('Uncaught Error: before uninstall', 1, 2, new Error('before uninstall'));
    expect(events).toHaveLength(0);
    capture.uninstall();
    expect(events, '卸载必须结算而不是丢弃').toHaveLength(1);
  });
});

describe('C05-AC-04 面包屑取最近 20 条且不含输入框内容', () => {
  it('25 次操作后只保留 20 条，且输入框的 value 不出现在面包屑里', () => {
    const now = vi.fn<() => number>(() => 1_700_000_000_000);
    const buffer = createBreadcrumbBuffer(now);
    const input = document.createElement('input');
    input.value = 'user-typed-secret-1234';
    const button = document.createElement('button');
    button.textContent = 'submit';

    for (let index = 0; index < 25; index += 1) {
      buffer.push(index % 2 === 0 ? button : input, 'click');
    }

    const crumbs = buffer.snapshot();
    expect(crumbs, '容量固定为 20 条').toHaveLength(BREADCRUMB_CAPACITY);
    expect(JSON.stringify(crumbs), '输入框内容绝不出现在面包屑中').not.toContain('user-typed-secret-1234');
  });

  it('错误事件**附带**最近 20 条面包屑，且输入框内容不在事件里', () => {
    const { capture, events, listeners } = setup();
    // 安装期必须接上点击面包屑（否则动作轨迹根本不会被采集）
    expect([...listeners.keys()], '必须监听 click 以采集行为面包屑').toContain('click');

    const input = document.createElement('input');
    input.value = 'user-typed-secret-1234';
    const button = document.createElement('button');
    button.setAttribute('data-track', 'submit');

    for (let index = 0; index < 25; index += 1) {
      capture.breadcrumbs().push(index % 2 === 0 ? button : input, 'click');
      if (index === 24) capture.breadcrumbs().pushRoute('/task/42?token=fake-token-abcdef');
    }

    capture.handleWindowError('Uncaught Error: after interactions', 3, 4, new Error('after interactions'));
    capture.flush();

    expect(events).toHaveLength(1);
    const context = events[0]?.context ?? {};
    const keys = Object.keys(context).filter((key) => key.startsWith(BREADCRUMB_CONTEXT_PREFIX));
    expect(keys, '错误事件必须附带 20 条面包屑').toHaveLength(BREADCRUMB_CAPACITY);

    const serialized = JSON.stringify(events[0]);
    expect(serialized, '输入框内容绝不进事件').not.toContain('user-typed-secret-1234');
    expect(serialized, '路由面包屑不得带查询参数（可能含令牌）').not.toContain('fake-token-abcdef');
    expect(serialized).toContain('button[submit]');
  });
});
