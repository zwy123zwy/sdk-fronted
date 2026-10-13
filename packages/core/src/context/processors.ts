/**
 * 上下文模块提供的管线处理器（`enrich` / `filter` 段）。
 *
 * 处理器实现在 `privacy/processors.ts`（与字段约束同处，便于对照段位分配）；
 * 本文件只负责把 context 模块的依赖适配成那边声明的端口。
 */
import type { KernelEvent, Processor } from '../kernel';
import {
  createConsentFilterProcessor,
  createContextEnrichProcessor,
} from '../privacy/processors';
import type { ConsentMode, ConsentState } from '../privacy/types';
import type { ConsentManager, PageTracker } from './ports';

/**
 * 上下文富化处理器（`enrich` 段）：补齐 `page_id`/`view_id`/`url`/`context`。
 * 入队时已写好的值不会被覆盖（AC-03 的语义基础）。
 */
export function createEnrichProcessor(page: PageTracker): Processor {
  return createContextEnrichProcessor(page);
}

/** 同意门的依赖形状（`ConsentManager` 天然满足）。 */
export interface ConsentGateSource {
  readonly state: () => ConsentState;
  readonly mode: () => ConsentMode;
  readonly buffer: (event: KernelEvent) => boolean;
}

/** 同意门处理器（`filter` 段）。 */
export function createConsentProcessor(consent: ConsentManager): Processor {
  const gate: ConsentGateSource = {
    state: consent.state,
    mode: consent.mode,
    buffer: consent.buffer,
  };
  return createConsentFilterProcessor(gate);
}
