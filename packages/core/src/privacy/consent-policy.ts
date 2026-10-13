/**
 * 同意策略的**纯判断**（C04-F5）。
 *
 * 本文件只有判定函数，不持有状态：状态机、缓冲与补发在 `context/consent.ts`。
 * 判定同时用于**采集前**（未就绪/未初始化时的命令入队）与**发送前**（`filter` 段的同意门），
 * 保证「采集」与「发送」两侧的口径不会漂移。
 *
 * 「必要事件」清单（Q5 第 4 条；编排方 2026-10-13 确认）：
 * - `sdk_health`（`sdk_internal`：只有计数/耗时与 `sdk_version`/`state`/`config_version`）；
 * - **已脱敏的 `web_js_error`**（C01 固定 4 个内置维度、无自定义维度；再经 C04 脱敏）。
 * 其余事件一律非必要。
 *
 * 判定同时用于客户端入队前（`api/client.ts` 的 `submitToPipeline`）与管线 `filter` 段。
 */
import type { KernelEvent } from '../kernel';
import { PRIVACY_REASON_CODES } from './reason-codes';
import type { ConsentMode, ConsentState } from './types';

/** 必要事件的事件名（`event-standard.md` 第 6 节的内置事件）。 */
export const ESSENTIAL_EVENT_NAMES: readonly string[] = ['sdk_health', 'web_js_error'];

/** 判定一条事件是否属于「必要事件」。 */
export function isEssentialEvent(event: KernelEvent): boolean {
  return ESSENTIAL_EVENT_NAMES.includes(event.event_name);
}

/** 同意判定的结果。 */
export interface ConsentDecision {
  /** `emit`：直接放行；`buffer`：进内存缓冲；`deny`：不采集/不发送。 */
  readonly action: 'emit' | 'buffer' | 'deny';
  /** `deny` 时的原因码（当前只有 `consent_denied`）。 */
  readonly reason: string | undefined;
}

/**
 * 按「同意状态 × 生效 consent_mode × 事件是否必要」决定该事件如何处置。
 *
 * 规则（`docs/tasks/T14-plan.md` 第 5 点的语义表）：
 * - `granted` → 一律 `emit`；
 * - `denied` → 必要事件 `emit`，其余 `deny(consent_denied)`；
 * - `unknown` + `essential_only` → 必要事件 `emit`，其余 `deny(consent_denied)`；
 * - `unknown` + `buffer` → 必要事件 `emit`，其余 `buffer`；
 * - `unknown` + `full` → 一律 `emit`（接入方在初始化参数里声明已取得授权，D002）。
 *
 */
export function decideConsent(
  state: ConsentState,
  mode: ConsentMode,
  event: KernelEvent,
): ConsentDecision {
  if (state === 'granted' || mode === 'full') return { action: 'emit', reason: undefined };
  if (isEssentialEvent(event)) return { action: 'emit', reason: undefined };
  // `unknown` + `buffer`：非必要事件先缓存，同意后补发（AC-11）。
  if (mode === 'buffer') return { action: 'buffer', reason: undefined };
  // 其余情况（`unknown`/`denied` + `essential_only`）：非必要事件不采集、不发送（AC-10/AC-12）。
  return { action: 'deny', reason: PRIVACY_REASON_CODES.consentDenied };
}
