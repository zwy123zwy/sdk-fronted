/**
 * 接收端：直接复用已验收的 M01（tools/mock-receiver，T09），不另写 mock。
 * 通过 Node 24 原生类型剥离 + lib/register.mjs 的 .js→.ts 解析钩子加载其源码。
 */
import { startReceiver } from '../../../tools/mock-receiver/src/index.ts';

export const APP_ID = 'poc-app';
export const WRITE_TOKEN = 'placeholder-write-token-0000';
export const ENDPOINT_PATH = '/v1/batch';

export async function startPocReceiver() {
  const receiver = await startReceiver({ port: 0 });
  return {
    raw: receiver,
    port: receiver.port,
    baseUrl: `http://127.0.0.1:${receiver.port}`,
    endpoint: `http://127.0.0.1:${receiver.port}${ENDPOINT_PATH}`,
    counters() {
      return receiver.counters.snapshot();
    },
    clearCounters() {
      receiver.counters.clear();
    },
    clearEvents() {
      receiver.events.clear();
    },
    /** 已入库事件（不带 auth） */
    events(appId = APP_ID) {
      return receiver.events.list(appId);
    },
    storedIdSet(appId = APP_ID) {
      return new Set(receiver.events.list(appId).map((e) => e.event_id));
    },
    injection: receiver.injection,
    async stop() {
      await receiver.stop();
    }
  };
}

/** 断言没有任何被拒批次/超限事件，防止把协议错误误当丢失。 */
export function protocolProblems(counters) {
  const problems = {};
  for (const [k, v] of Object.entries(counters)) {
    if ((k.startsWith('rejected_') || k === 'failed_storage') && v > 0) problems[k] = v;
  }
  return problems;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}
