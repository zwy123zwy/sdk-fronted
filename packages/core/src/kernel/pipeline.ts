/**
 * 六段处理管线（C02-F2）与处理器异常隔离（C02-F3）。
 * 顺序固定为校验 → 富化 → 过滤 → 采样 → 构建 → 发送前。
 * 处理器抛错时跳过该处理器、事件继续流转、计数 `processor_error`，异常不向业务冒泡。
 */
import { PIPELINE_STAGES, REASON_CODES } from './constants';
import type { PipelineStage } from './constants';
import type {
  Counters,
  Dispose,
  KernelEvent,
  Pipeline,
  PipelineStop,
  ProcessOutcome,
  Processor,
  ProcessorResult,
  RegisterOptions,
} from './types';

const NOOP_DISPOSE: Dispose = () => undefined;

interface ProcessorEntry {
  readonly id: string;
  readonly processor: Processor;
}

export interface PipelineServices {
  readonly counters: Counters;
}

function isPipelineStop(result: ProcessorResult): result is PipelineStop {
  return typeof result === 'object' && 'stop' in result && result.stop === true;
}

/** 创建六段处理管线。 */
export function createPipeline(services: PipelineServices): Pipeline {
  const { counters } = services;
  const stages = new Map<PipelineStage, ProcessorEntry[]>();
  for (const stage of PIPELINE_STAGES) stages.set(stage, []);
  let disposed = false;
  let sequence = 0;

  function register(
    stage: PipelineStage,
    processor: Processor,
    options: RegisterOptions = {},
  ): Dispose {
    if (disposed) {
      counters.count(REASON_CODES.destroyed);
      return NOOP_DISPOSE;
    }
    const entries = stages.get(stage);
    if (entries === undefined) {
      // 运行期传入了契约外的段名，按内部异常计数并忽略。
      counters.count(REASON_CODES.processorError);
      return NOOP_DISPOSE;
    }
    const id = options.id ?? `processor_${String(sequence)}`;
    sequence += 1;
    const entry: ProcessorEntry = { id, processor };
    entries.push(entry);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    };
  }

  function process(event: KernelEvent): ProcessOutcome {
    if (disposed) {
      counters.count(REASON_CODES.destroyed);
      return { status: 'stopped', event, reason: REASON_CODES.destroyed };
    }

    let current = event;
    for (const stage of PIPELINE_STAGES) {
      const entries = stages.get(stage);
      if (entries === undefined) continue;
      // 复制一份，允许处理器在运行期间注册或注销自己。
      for (const entry of [...entries]) {
        let result: ProcessorResult;
        try {
          result = entry.processor(current, { stage, counters, processorId: entry.id });
        } catch {
          counters.count(REASON_CODES.processorError);
          continue;
        }
        if (isPipelineStop(result)) {
          counters.count(result.reason);
          return { status: 'stopped', event: current, reason: result.reason };
        }
        current = result;
      }
    }
    return { status: 'processed', event: current };
  }

  return {
    register,
    process,
    size(stage?: PipelineStage): number {
      if (stage !== undefined) return stages.get(stage)?.length ?? 0;
      let total = 0;
      for (const entries of stages.values()) total += entries.length;
      return total;
    },
    dispose(): void {
      disposed = true;
      for (const stage of PIPELINE_STAGES) stages.set(stage, []);
    },
  };
}
