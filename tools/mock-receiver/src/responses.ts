/**
 * HTTP 响应与 CORS 辅助（RR-07、RR-08、M01-AC-08）。
 */
import type { ServerResponse } from 'node:http';

/** RR-08 列出的请求头。 */
export const ALLOWED_HEADERS = [
  'Content-Type',
  'Content-Encoding',
  'X-App-Id',
  'X-Write-Token',
  'X-Request-Id',
] as const;

const ALLOWED_HEADERS_VALUE = ALLOWED_HEADERS.join(', ');
const EXPOSED_HEADERS_VALUE = 'Retry-After, X-Server-Time, X-Request-Id';
const DEFAULT_ORIGIN = '*';

export interface ResponseContext {
  origin: string;
  requestId: string;
  serverTime: number;
}

/** 所有响应共有的头。 */
export function baseHeaders(context: ResponseContext): Record<string, string> {
  return {
    'X-Server-Time': String(context.serverTime),
    'X-Request-Id': context.requestId,
    'Access-Control-Allow-Origin': context.origin,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS_VALUE,
    Vary: 'Origin',
  };
}

export interface SendOptions {
  /** 429 / 503 使用，整数秒。 */
  retryAfter?: number;
  headers?: Record<string, string>;
}

/** 发送 JSON 响应。 */
export function sendJson(
  response: ServerResponse,
  context: ResponseContext,
  status: number,
  payload: unknown,
  options: SendOptions = {},
): void {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers: Record<string, string> = {
    ...baseHeaders(context),
    'Content-Type': 'application/json;charset=UTF-8',
    ...options.headers,
  };
  if (options.retryAfter !== undefined) headers['Retry-After'] = String(Math.trunc(options.retryAfter));
  response.writeHead(status, headers);
  response.end(body);
}

/** 发送空响应（304 等）。 */
export function sendEmpty(
  response: ServerResponse,
  context: ResponseContext,
  status: number,
  options: SendOptions = {},
): void {
  const headers: Record<string, string> = {
    ...baseHeaders(context),
    ...options.headers,
  };
  if (options.retryAfter !== undefined) headers['Retry-After'] = String(Math.trunc(options.retryAfter));
  response.writeHead(status, headers);
  response.end();
}

/** 错误响应体：`{ error, message }`（ingest-protocol 3.3）。 */
export function sendError(
  response: ServerResponse,
  context: ResponseContext,
  status: number,
  error: string,
  message: string,
  options: SendOptions = {},
): void {
  sendJson(response, context, status, { error, message }, options);
}

/** CORS 预检响应。 */
export function sendPreflight(response: ServerResponse, context: ResponseContext): void {
  response.writeHead(204, {
    ...baseHeaders(context),
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS_VALUE,
    'Access-Control-Max-Age': '600',
  });
  response.end();
}

/** 读取 `Origin`，缺省时用 `*`（M01 不是生产实现，不做域名白名单）。 */
export function originOf(header: string | string[] | undefined): string {
  if (Array.isArray(header)) return header[0] ?? DEFAULT_ORIGIN;
  return header === undefined || header.length === 0 ? DEFAULT_ORIGIN : header;
}

/** 读取单值请求头。 */
export function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
