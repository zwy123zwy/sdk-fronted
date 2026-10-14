/**
 * 同意状态机（C04-F5）。
 *
 * 状态与缓冲都只在本模块；`consent_mode` 由配置侧（T13 的 `EffectiveConfig.privacy.consent_mode`）
 * 驱动，**C04 不重算远程 `full` 的拒绝**（T13 已计 `config_consent_mode_rejected`，D002）。
 *
 * 缓冲口径（编排方 2026-10-13 批准）：
 * - **仅内存**（同意前落盘会与 `denied` 的「清除离线数据」自相矛盾）；
 * - 上限 2,000 条 / 5 MB（对齐 T16），先到者为准；
 * - 溢出淘汰最早的 normal（对齐指南第 11 节），**不新增契约原因码**，只记 `bufferEvicted` 观测量；
 * - `denied` / `clearBuffer` 清空时按**事件条数**计 `consent_buffer_cleared`（AC-18 要求 10）。
 *
 * 全部方法同步，不存在异步窗口：`setState` 的副作用（补发/清空）在调用栈内完成。
 */
import type { KernelEvent } from '../kernel';
import type { ConsentMode, ConsentState } from '../privacy/types';
import { PRIVACY_REASON_CODES } from '../privacy/reason-codes';
import type { BatchConsent, ConsentManager, ConsentManagerOptions } from './ports';

/** 同意状态 → 批头 `consent` 的映射（批次 Schema 的枚举只有三个取值）。 */
export function toBatchConsent(state: ConsentState): BatchConsent {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'unknown';
}

/** 创建同意状态机。 */
export function createConsentManager(options: ConsentManagerOptions): ConsentManager {
  const state: ConsentState = options.state ?? 'unknown';
  let currentState = state;
  let mode: ConsentMode = options.mode;
  const buffer: KernelEvent[] = [];
  let evicted = 0;
  // 缓冲区的**运行中字节总量**：push 时加、淘汰时减。
  // 不能在每次 push 时对整个缓冲区重算（`totalBytes(buffer)`）——那使每次入队都是 O(缓冲区长度)、
  // 填满 2,000 条上限整体是 O(n²)（实测 4,000 次 push ≈ 8×10⁶ 次 `sizeOf`，空闲 1.1 s；
  // 生产里缓冲区接近上限时每次入队都要重算一遍）。
  // 等价性前提与证明：`sizeOf` 是**纯函数**（同一事件重复调用返回同一值，本仓两个注入点
  // ——`api/client.ts` 的 `byteLengthOf` 与测试注入——都是纯的）。在此前提下增量维护的
  // `bufferedBytes` 恒等于对当前缓冲区逐条重算的结果，淘汰序列逐条相同；
  // `consent.test.ts` 有用例用「每次全量重算」的参照模型做差分对照。
  let bufferedBytes = 0;

  /** 取出并清空缓冲（原子：先 splice 再逐条投递，避免重入时重复补发）。 */
  function takeBuffer(): KernelEvent[] {
    if (buffer.length === 0) return [];
    const events = buffer.splice(0, buffer.length);
    bufferedBytes = 0;
    return events;
  }

  /** 淘汰一条最早的 normal（没有 normal 时淘汰最早的 critical）。 */
  function evictOne(): void {
    let index = buffer.findIndex((event) => event['priority'] !== 'critical');
    if (index < 0) index = 0;
    const removed = buffer.splice(index, 1)[0];
    if (removed !== undefined) bufferedBytes -= options.sizeOf(removed);
    evicted += 1;
  }

  return {
    state(): ConsentState {
      return currentState;
    },
    mode(): ConsentMode {
      return mode;
    },
    headerConsent(): BatchConsent {
      return toBatchConsent(currentState);
    },
    setState(next: ConsentState): void {
      if (next === currentState) return;
      const previous = currentState;
      currentState = next;
      if (next === 'denied') {
        const cleared = takeBuffer().length;
        if (cleared > 0) options.count(PRIVACY_REASON_CODES.consentBufferCleared, cleared);
        return;
      }
      // `granted`：补发缓冲；`buffer`/`unknown`：保持缓冲不动。
      if (next === 'granted' && previous !== 'granted') {
        for (const event of takeBuffer()) options.emit(event);
      }
    },
    setMode(next: ConsentMode): void {
      mode = next;
    },
    drain(): number {
      const events = takeBuffer();
      for (const event of events) options.emit(event);
      return events.length;
    },
    clearBuffer(reason: string): number {
      const events = takeBuffer();
      if (events.length > 0 && reason === PRIVACY_REASON_CODES.consentBufferCleared) {
        options.count(reason, events.length);
      }
      return events.length;
    },
    buffer(event: KernelEvent): boolean {
      buffer.push(event);
      bufferedBytes += options.sizeOf(event);
      while (buffer.length > options.limits.maxEvents || bufferedBytes > options.limits.maxBytes) {
        if (buffer.length === 0) break;
        evictOne();
      }
      // 容量上限至少为 1，因此刚放入的事件不会被立即淘汰（除 maxEvents<=0 的异常配置）。
      return buffer.includes(event);
    },
    bufferSize(): number {
      return buffer.length;
    },
    bufferEvicted(): number {
      return evicted;
    },
  };
}
