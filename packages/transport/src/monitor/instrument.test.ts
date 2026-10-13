/**
 * C08-F1 / C08-F2 的装饰器实现用例（本模块内已实现并测试；装配根接线归 T18）：
 * - `createCallCounter`：包装客户端公开方法统计 `calls_total`（只计公共方法，不计接线方法）；
 * - `createLatencyDecorators`：包装 `track`/`log`/`captureError`、`pipeline.process`、
 *   任意同步函数，把耗时分别记到 `track` / `pipeline` / `serialize`；
 * - 用注入的 `now()` 做确定性计时，不依赖墙钟。
 */
import { describe, expect, test } from 'vitest';
import {
  COUNTED_CALL_METHODS,
  createCallCounter,
  createLatencyDecorators,
} from './instrument';
import { createLatencyWindow } from './latency';
import { buildHealthMetrics } from './metrics';

function createFakeClient(): {
  readonly calls: string[];
  track(name: string): undefined;
  log(level: string, message: string): undefined;
  captureError(error: string): undefined;
  onEvent(): undefined;
  readonly version: string;
} {
  const calls: string[] = [];
  return {
    calls,
    version: '1.0.0',
    track(name: string): undefined {
      calls.push(`track:${name}`);
      return undefined;
    },
    log(level: string, message: string): undefined {
      calls.push(`log:${level}:${message}`);
      return undefined;
    },
    captureError(error: string): undefined {
      calls.push(`captureError:${error}`);
      return undefined;
    },
    onEvent(): undefined {
      calls.push('onEvent');
      return undefined;
    },
  };
}

describe('createCallCounter（C08-F1 calls_total）', () => {
  test('只统计公共方法，接线方法（onEvent）不计入', () => {
    const client = createFakeClient();
    const counter = createCallCounter(client);
    counter.client.track('a');
    counter.client.log('warn', 'b');
    counter.client.captureError('c');
    counter.client.onEvent();
    expect(counter.take()).toEqual({ calls_total: 3 });
  });

  test('take 后清零，再次 take 为空（窗口增量语义）', () => {
    const client = createFakeClient();
    const counter = createCallCounter(client);
    counter.client.track('a');
    expect(counter.take()).toEqual({ calls_total: 1 });
    expect(counter.take()).toEqual({});
  });

  test('保留返回值、参数与非方法属性', () => {
    const calls: string[] = [];
    const client = {
      version: '1.0.0',
      flush(): string {
        calls.push('flush');
        return 'flushed';
      },
    };
    const counter = createCallCounter(client);
    expect(counter.client.version).toBe('1.0.0');
    expect(counter.client.flush()).toBe('flushed');
    expect(calls).toEqual(['flush']);
    expect(counter.take()).toEqual({ calls_total: 1 });
  });

  test('可自定义统计的方法名集合', () => {
    const client = createFakeClient();
    const counter = createCallCounter(client, { methods: ['track'] });
    counter.client.track('a');
    counter.client.log('warn', 'b');
    expect(counter.take()).toEqual({ calls_total: 1 });
    expect(COUNTED_CALL_METHODS).toHaveLength(12);
  });
});

describe('createLatencyDecorators（C08-F2 三个阶段）', () => {
  test('wrapCalls 把 track/log/captureError 的同步耗时记到 track', () => {
    const recorded: { stage: string; ms: number }[] = [];
    let clock = 100;
    const decorators = createLatencyDecorators({
      recorder: { record: (stage, ms) => recorded.push({ stage, ms }) },
      now: () => clock,
    });
    const calls: string[] = [];
    const client = {
      track(name: string): undefined {
        calls.push(`track:${name}`);
        clock += 3;
        return undefined;
      },
      log(level: string, message: string): undefined {
        calls.push(`log:${level}:${message}`);
        clock += 4;
        return undefined;
      },
      captureError(error: string): undefined {
        calls.push(`captureError:${error}`);
        return undefined;
      },
    };
    const wrapped = decorators.wrapCalls(client);
    wrapped.track('a');
    wrapped.log('warn', 'b');
    wrapped.captureError('c');
    expect(recorded).toEqual([
      { stage: 'track', ms: 3 },
      { stage: 'track', ms: 4 },
      { stage: 'track', ms: 0 },
    ]);
    expect(calls).toEqual(['track:a', 'log:warn:b', 'captureError:c']);
  });

  test('wrapCalls 只包装指定的方法（缺省 track/log/captureError）', () => {
    let clock = 0;
    const decorators = createLatencyDecorators({
      recorder: { record: () => undefined },
      now: () => clock,
    });
    const client = createFakeClient();
    const wrapped = decorators.wrapCalls(client);
    clock = 5;
    wrapped.onEvent();
    expect(() => {
      wrapped.track('a');
    }).not.toThrow();
  });

  test('被包装方法抛错时仍记录耗时并把异常原样抛出', () => {
    const recorded: number[] = [];
    let clock = 0;
    const decorators = createLatencyDecorators({
      recorder: { record: (_stage, ms) => recorded.push(ms) },
      now: () => clock,
    });
    const wrapped = decorators.wrapCalls({
      track(name: string): undefined {
        clock = 9;
        throw new Error(`boom:${name}`);
      },
    });
    expect(() => {
      wrapped.track('a');
    }).toThrow('boom:a');
    expect(recorded).toEqual([9]);
    clock = 20;
  });

  test('wrapPipeline 把整条管线耗时记到 pipeline', () => {
    const recorded: { stage: string; ms: number }[] = [];
    let clock = 0;
    const decorators = createLatencyDecorators({
      recorder: { record: (stage, ms) => recorded.push({ stage, ms }) },
      now: () => clock,
    });
    const pipeline = {
      process(event: { readonly event_name: string }): { readonly status: string } {
        clock = 6;
        return { status: `processed:${event.event_name}` };
      },
    };
    const wrapped = decorators.wrapPipeline(pipeline);
    const outcome = wrapped.process({ event_name: 'demo' });
    expect(outcome).toEqual({ status: 'processed:demo' });
    expect(recorded).toEqual([{ stage: 'pipeline', ms: 6 }]);
  });

  test('wrapFunction 把任意同步函数耗时记到 serialize', () => {
    const recorded: { stage: string; ms: number }[] = [];
    let clock = 0;
    const decorators = createLatencyDecorators({
      recorder: { record: (stage, ms) => recorded.push({ stage, ms }) },
      now: () => clock,
    });
    const wrapped = decorators.wrapFunction((text: string, times: number): string => {
      clock = 2;
      return text.repeat(times);
    });
    expect(wrapped('ab', 2)).toBe('abab');
    expect(recorded).toEqual([{ stage: 'serialize', ms: 2 }]);
  });

  test('装饰器 + 采样器 + P99 聚合器产出可上报的耗时指标', () => {
    const window = createLatencyWindow({ sampled: true });
    let clock = 0;
    const decorators = createLatencyDecorators({ recorder: window, now: () => clock });
    const wrapped = decorators.wrapFunction((value: number): number => {
      clock += value;
      return value;
    });
    for (let index = 1; index <= 100; index += 1) wrapped(index);
    const metrics = buildHealthMetrics({
      counters: {},
      windowMs: 60_000,
      latency: window.take(),
    });
    expect(metrics.serialize_p99_ms).toBe(99);
  });
});
