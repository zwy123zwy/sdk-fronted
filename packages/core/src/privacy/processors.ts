/**
 * C04 的管线处理器（C02-F2 六段管线）。
 *
 * 段位分配（与 `docs/tasks/T14-plan.md` 第 1、6 点一致）：
 * - `validate` 段：字段约束（键名/键数/值长/附件/非有限数），随后是单条 16 KB 的上限处理；
 * - `enrich` 段：公共上下文富化（`page_id`/`view_id`/`url`/`context`）；
 * - `filter` 段：同意门（放行 / 缓冲 / `consent_denied`）。
 *
 * 每个处理器都遵守内核约定：**必须显式返回事件或 `stopPipeline(reason)`**；
 * 抛错由内核隔离并计 `processor_error`，不向业务冒泡。
 *
 * 三个处理器都已有用例覆盖（`processors.test.ts`），并在 `api/client.ts` 装配进真实管线。
 */
import { stopPipeline } from '../kernel';
import type { KernelEvent, Processor } from '../kernel';
import { constrainEvent } from './constraints';
import { decideConsent } from './consent-policy';
import { PRIVACY_REASON_CODES } from './reason-codes';
import type { ConsentMode, ConsentState, FieldConstraintsOptions } from './types';

/** 处理器 id（调试与异常归因用）。 */
export const PROCESSOR_IDS = {
  fieldConstraints: 'c04_field_constraints',
  eventSize: 'c04_event_size',
  contextEnrich: 'c04_context_enrich',
  consentGate: 'c04_consent_gate',
} as const;

/**
 * 字段约束处理器（`validate` 段）。
 * 处理键名、键数、值长、附件、非有限数，并按结果决定是否丢弃整条事件。
 */
export function createFieldConstraintsProcessor(options: FieldConstraintsOptions): Processor {
  return (event: KernelEvent): KernelEvent | ReturnType<typeof stopPipeline> => {
    const constrain = options.constrain ?? constrainEvent;
    const result = constrain({
      event,
      limits: options.limits,
      masker: options.masker,
      count: options.count,
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    });
    if (result.dropped) {
      const reason = result.dropReason ?? 'event_too_large';
      // 丢弃类原因码由本处理器计数（内核只对过滤段的 stop 计数）。
      options.count(reason);
      return stopPipeline(reason);
    }
    return result.event;
  };
}

/** 同意门的依赖（由 `context/consent.ts` 的 `ConsentManager` 提供）。 */
export interface ConsentGatePort {
  readonly state: () => ConsentState;
  readonly mode: () => ConsentMode;
  /** 停放到缓冲；返回是否受理。 */
  readonly buffer: (event: KernelEvent) => boolean;
}

/** 同意门处理器（`filter` 段）：放行 / 缓冲 / `stopPipeline('consent_denied')`。 */
export function createConsentFilterProcessor(gate: ConsentGatePort): Processor {
  return (event: KernelEvent): KernelEvent | ReturnType<typeof stopPipeline> => {
    const decision = decideConsent(gate.state(), gate.mode(), event);
    if (decision.action === 'deny') return stopPipeline(decision.reason ?? 'consent_denied');
    // `buffer`：事件停放在缓冲里，**必须在这里终止管线**（否则它会被当作正常事件发出）。
    // 结束段（`before_send`）必须与正常路径完全一致，因此不能在中间段吞掉事件；
    // 由于内核没有「终止但不计数」的返回值，这里用 `stopPipeline` 终止。
    // 为避免把「已缓存」误记成某条丢弃原因码，客户端在入队前**已经**做了同样的判定：
    // 走到这里的缓冲事件只会来自绕过客户端入口的内部路径（C08 等）。
    if (decision.action === 'buffer') {
      gate.buffer(event);
      return stopPipeline(PRIVACY_REASON_CODES.consentDenied);
    }
    return event;
  };
}

/** 上下文富化处理器的依赖（由 `context/store.ts` 提供）。 */
export interface ContextEnrichPort {
  /** 补齐事件缺失的 `page_id`/`view_id`/`url`/`context`（已有值不覆盖）。 */
  readonly enrich: (event: KernelEvent) => KernelEvent;
}

/** 上下文富化处理器（`enrich` 段）。 */
export function createContextEnrichProcessor(port: ContextEnrichPort): Processor {
  return (event: KernelEvent): KernelEvent => port.enrich(event);
}
