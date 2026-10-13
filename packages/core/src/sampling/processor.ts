/**
 * 采样处理器（T13，C03-F3/F4）。
 *
 * 注册在管线的 `sample` 段（`kernel.registerProcessor('sample', ...)`）：
 * critical → 直接通过并置 `sample_rate = 1`；未命中会话 → `stopPipeline('sampled_out_session')`；
 * 规则 `rate: 0` → `disabled_by_rule`；规则未命中 → `sampled_out_rule`；否则置最终 `sample_rate`。
 * 丢弃计数由管线段在收到 `stopPipeline(reason)` 时自动完成，处理器内不重复计数。
 *
 * 白名单用户视作会话采样率为 1（全量采集），因此最终 `sample_rate` 仍落在 `(0, 1]`。
 */
import { stopPipeline } from '../kernel';
import type { Dispose, KernelEvent, ProcessorResult } from '../kernel';
import { SAMPLING_REASON_CODES } from './types';
import type { SamplingProcessorOptions } from './types';
import { matchFirstRule } from './rules';
import { randomUnit } from './session';

/** 创建并注册采样处理器。 */
export function createSamplingProcessor(options: SamplingProcessorOptions): Dispose {
  const { kernel, config, session } = options;
  const random = options.random ?? randomUnit;

  return kernel.registerProcessor(
    'sample',
    (event: KernelEvent): ProcessorResult => {
      if (event.priority === 'critical') {
        event['sample_rate'] = 1;
        return event;
      }
      if (!session.isHit()) {
        return stopPipeline(SAMPLING_REASON_CODES.sampledOutSession);
      }

      const sampling = config.current().sampling;
      const effectiveSessionRate = session.allowUser() ? 1 : sampling.session_rate;
      const outcome = matchFirstRule(sampling.rules, event);

      if (!outcome.matched) {
        event['sample_rate'] = effectiveSessionRate;
        return event;
      }
      if (outcome.rate <= 0) {
        return stopPipeline(SAMPLING_REASON_CODES.disabledByRule);
      }
      if (random() >= outcome.rate) {
        return stopPipeline(SAMPLING_REASON_CODES.sampledOutRule);
      }
      event['sample_rate'] = effectiveSessionRate * outcome.rate;
      return event;
    },
    { id: 'c03.sampling' },
  );
}
