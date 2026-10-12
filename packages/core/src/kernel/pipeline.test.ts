/**
 * C02-F2 六段处理管线、C02-F3 处理器异常隔离验收测试（C02-AC-04、C02-AC-05、C02-AC-06）。
 */
import { describe, expect, it, vi } from 'vitest';

import { PIPELINE_STAGES, createKernel, stopPipeline } from '../index';
import type { KernelEvent, PipelineStage } from '../index';

function makeEvent(overrides: Record<string, unknown> = {}): KernelEvent {
  const base: KernelEvent = {
    event_name: 'test_event',
    priority: 'normal',
    occurred_at: 1_700_000_000_000,
  };
  return Object.assign(base, overrides);
}

function marksOf(event: KernelEvent): readonly string[] {
  return (event['marks'] as readonly string[] | undefined) ?? [];
}

function addMark(event: KernelEvent, mark: string): void {
  event['marks'] = [...marksOf(event), mark];
}

function runningKernel(): ReturnType<typeof createKernel> {
  const kernel = createKernel();
  kernel.init();
  kernel.start();
  kernel.markConfigReady();
  return kernel;
}

describe('C02-F2 六段处理管线', () => {
  it('C02-AC-04 事件按校验、富化、过滤、采样、构建、发送前的顺序经过处理器', () => {
    const kernel = runningKernel();
    const visited: PipelineStage[] = [];
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    expect([...PIPELINE_STAGES]).toEqual([
      'validate',
      'enrich',
      'filter',
      'sample',
      'build',
      'before_send',
    ]);

    for (const stage of PIPELINE_STAGES) {
      kernel.registerProcessor(stage, (event) => {
        visited.push(stage);
        addMark(event, stage);
        return event;
      });
    }

    kernel.report(makeEvent());

    expect(visited).toEqual([...PIPELINE_STAGES]);
    expect(marksOf(delivered[0] ?? makeEvent())).toEqual([...PIPELINE_STAGES]);
  });

  it('C02-AC-05 过滤段返回终止原因码时不进入后续段并计数', () => {
    const kernel = runningKernel();
    const visited: string[] = [];
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    kernel.registerProcessor('enrich', (event) => {
      visited.push('enrich');
      return event;
    });
    kernel.registerProcessor('filter', () => {
      visited.push('filter');
      return stopPipeline('filtered_by_plugin');
    });
    kernel.registerProcessor('sample', (event) => {
      visited.push('sample');
      return event;
    });

    kernel.report(makeEvent());

    expect(visited).toEqual(['enrich', 'filter']);
    expect(delivered).toHaveLength(0);
    expect(kernel.counters.get('filtered_by_plugin')).toBe(1);
  });

  it('C02-AC-06 处理器抛错被跳过，事件继续，计数 processor_error 且不进入 window.onerror', () => {
    const kernel = runningKernel();
    const visited: string[] = [];
    const delivered: KernelEvent[] = [];
    const onError = vi.fn();
    kernel.setOutput((event) => {
      delivered.push(event);
    });
    window.addEventListener('error', onError);

    try {
      kernel.registerProcessor('enrich', () => {
        visited.push('boom');
        throw new Error('processor boom');
      });
      kernel.registerProcessor('enrich', () => {
        visited.push('after');
        return makeEvent();
      });
      kernel.registerProcessor('before_send', () => {
        visited.push('before_send');
        throw new Error('late boom');
      });

      kernel.report(makeEvent());
    } finally {
      window.removeEventListener('error', onError);
    }

    expect(visited).toEqual(['boom', 'after', 'before_send']);
    expect(delivered).toHaveLength(1);
    expect(kernel.counters.get('processor_error')).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('C02-F2 管线补充单元测试', () => {
  it('处理器可以返回替换后的事件，后续段看到新事件', () => {
    const kernel = runningKernel();
    const delivered: KernelEvent[] = [];
    kernel.setOutput((event) => {
      delivered.push(event);
    });

    kernel.registerProcessor('enrich', (event) => ({ ...event, enriched: true }));
    kernel.registerProcessor('filter', (event) => {
      expect(event['enriched']).toBe(true);
      return event;
    });

    kernel.report(makeEvent());
    expect(delivered[0]?.['enriched']).toBe(true);
  });

  it('取消注册处理器后不再执行，销毁后管线清空', () => {
    const kernel = runningKernel();
    const visited: string[] = [];
    const off = kernel.registerProcessor('validate', (event) => {
      visited.push('validate');
      return event;
    });
    expect(kernel.pipeline.size('validate')).toBe(1);

    off();
    off();
    expect(kernel.pipeline.size('validate')).toBe(0);
    expect(kernel.pipeline.size()).toBe(0);

    kernel.registerProcessor('validate', (event) => {
      visited.push('validate');
      return event;
    });
    kernel.report(makeEvent());
    expect(visited).toEqual(['validate']);

    kernel.destroy();
    expect(kernel.pipeline.size()).toBe(0);
    expect(() => {
      kernel.pipeline.process(makeEvent());
    }).not.toThrow();
  });

  it('管线运行期间自注销的处理器不影响本次遍历', () => {
    const kernel = runningKernel();
    const visited: string[] = [];
    const off = kernel.registerProcessor('validate', (event) => {
      visited.push('first');
      off();
      return event;
    });
    kernel.registerProcessor('validate', (event) => {
      visited.push('second');
      return event;
    });

    kernel.report(makeEvent());
    expect(visited).toEqual(['first', 'second']);
    expect(kernel.pipeline.size('validate')).toBe(1);
  });

  it('重复注册同一处理器 id 各自独立，管线遍历顺序为注册顺序', () => {
    const kernel = runningKernel();
    const visited: string[] = [];
    kernel.registerProcessor('enrich', (event) => {
      visited.push('a');
      return event;
    }, { id: 'same' });
    kernel.registerProcessor('enrich', (event) => {
      visited.push('b');
      return event;
    }, { id: 'same' });

    kernel.report(makeEvent());
    expect(visited).toEqual(['a', 'b']);
    expect(kernel.pipeline.size('enrich')).toBe(2);
  });

  it('管线销毁后注册被计数 destroyed，契约外的段名按内部异常计数', () => {
    const destroyedKernel = runningKernel();
    destroyedKernel.destroy();
    const offDestroyed = destroyedKernel.pipeline.register('validate', (event) => event);
    expect(() => {
      offDestroyed();
    }).not.toThrow();
    expect(destroyedKernel.counters.get('destroyed')).toBe(1);

    const freshKernel = runningKernel();
    const offInvalid = freshKernel.pipeline.register(
      'not_a_stage' as unknown as PipelineStage,
      (event) => event,
    );
    expect(() => {
      offInvalid();
    }).not.toThrow();
    expect(freshKernel.counters.get('processor_error')).toBe(1);
    expect(freshKernel.pipeline.size()).toBe(0);
  });
});
