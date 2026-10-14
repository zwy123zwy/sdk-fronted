/**
 * C05-F4 链路追踪头注入。
 *
 * 裁定（T18-plan §4，依 CR-006）：
 * - 头名用 **W3C Trace Context**：`traceparent`（必需）/ `tracestate`（可选）；
 * - **值由接入方注入**（`TraceContextProvider`）；未提供 provider 或 provider 返回 `undefined`
 *   时**不注入该头**（不伪造）；
 * - 只对**同源或命中追踪白名单**的请求注入；白名单外一律不注入，**不做降级注入**；
 * - 远程配置**只能收紧**注入范围（`narrowScope`）。
 */
import type { TraceContextProvider, TraceHeaders, TraceScope } from './types';

/** 取 URL 的源（scheme + host + port）；非法 URL 返回 `undefined`。 */
function originOf(url: string): string | undefined {
  try {
    return new URL(url, 'https://placeholder.invalid').origin;
  } catch {
    return undefined;
  }
}

/** 归一化白名单项：允许写完整源或裸域名。 */
function normalizeAllowed(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed === '') return trimmed;
  if (trimmed.includes('://')) return trimmed.replace(/\/+$/, '');
  return `https://${trimmed.replace(/\/+$/, '')}`;
}

/** 跨源请求的 Origin 判定：同源或命中白名单。 */
export function isSameOriginOrAllowed(url: string, scope: TraceScope): boolean {
  const origin = originOf(url);
  if (origin === undefined) return false;
  if (origin === scope.origin) return true;
  return scope.allowlist.some((entry) => normalizeAllowed(entry) === origin);
}

/**
 * 为目标请求计算要注入的追踪头；不允许注入时返回 `undefined`。
 *
 * 返回 `undefined` 的两种情形必须可区分于"注入空值"：
 * ① 范围不允许（不同源且不在白名单）；② 没有 provider 或 provider 返回 `undefined`。
 * 两种情形都**不写入任何头**。
 */
export function resolveTraceHeaders(
  request: { readonly url: string; readonly method: string },
  scope: TraceScope,
  provider?: TraceContextProvider,
): TraceHeaders | undefined {
  if (!isSameOriginOrAllowed(request.url, scope)) return undefined;
  if (provider === undefined) return undefined;
  const headers = provider(request);
  if (headers === undefined) return undefined;
  // 必需头为空时视为"没有可注入的上下文"，不得写入空值。
  if (headers.traceparent === '') return undefined;
  return headers.tracestate === undefined || headers.tracestate === ''
    ? { traceparent: headers.traceparent }
    : { traceparent: headers.traceparent, tracestate: headers.tracestate };
}

/**
 * 用远程配置收紧注入范围。
 *
 * 「只能收紧」：返回范围必须是入参范围的**子集**——同源判定不变，
 * 白名单只保留两侧的**交集**；远程配置无法把新的域加进白名单。
 */
export function narrowScope(base: TraceScope, remote: TraceScope): TraceScope {
  const baseAllowed = new Set(base.allowlist.map((entry) => normalizeAllowed(entry)));
  const allowlist = remote.allowlist
    .map((entry) => normalizeAllowed(entry))
    .filter((entry) => baseAllowed.has(entry));
  return { origin: base.origin, allowlist };
}
