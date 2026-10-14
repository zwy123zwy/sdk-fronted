/**
 * 自建批次接收端（HTTP，`POST /ingest`）：T30 核心路径脚本与判别性用例共用的接收端实现。
 *
 * 这段实现从 `tests/compat/scripts/browser-core-path.mjs` 的**内联 `/ingest` 处理**里抽取出来，
 * 目的是让"接收端到底校验了什么"成为**可被单独驱动、可被注入违约批次**的对象
 * （内联在脚本里时只能靠真实 Chromium 才能跑到，见 D-06）。
 *
 * 口径（D-06）：**声称端到端送达的接收端必须按 `batch.schema.json` 校验结构**。
 * 本实现通过唯一校验门 `batch-contract.mjs` 做 Ajv 校验；结构违约一律 400 拒收并逐条记录
 * Ajv 错误（判别性证据见 `tests/compat/receiver-contract-gate.test.ts`）。
 */
import { createServer } from 'node:http';

import { inspectBatchText } from './batch-contract.mjs';

/** 安全地把正文解析出来用于记录（解析失败时为 `undefined`，不抛错）。 */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 创建接收端的请求处理函数与账本。
 *
 * 返回的 `handle(request, response)` 在**本接收端负责该请求**时返回 `true`（供调用方组合进
 * 自己的 `createServer` 回调），否则返回 `false` 让调用方继续路由。
 */
export function createBatchIngestHandler() {
  /** 收到的全部批次（含被拒的）。 */
  const batches = [];
  const accepted = [];
  const rejected = [];

  function handle(request, response) {
    const url = (request.url ?? '').split('?')[0];
    if (url !== '/ingest' || request.method !== 'POST') return false;

    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      // 用 `globalThis.Buffer`（本仓库 eslint 在 node 语境的 .mjs 里未声明 Buffer 全局）。
      const raw = globalThis.Buffer.concat(chunks).toString('utf8');
      const outcome = inspectBatchText(raw);
      const record = {
        at: new Date().toISOString(),
        bytes: raw.length,
        body: safeParse(raw),
        schemaOk: outcome.ok,
        code: outcome.code,
        errors: outcome.errors,
      };
      batches.push(record);
      const headers = { 'content-type': 'application/json', 'x-server-time': String(Date.now()) };
      if (outcome.ok) {
        accepted.push(record);
        response.writeHead(202, headers);
        response.end('{"ok":true}');
        return;
      }
      rejected.push(record);
      response.writeHead(400, headers);
      response.end(JSON.stringify({ ok: false, error: outcome.code, errors: outcome.errors }));
    });
    return true;
  }

  return { handle, batches, accepted, rejected };
}

/** 独立起一个只服务 `POST /ingest` 的接收端（其余路径 404），供判别性用例直接压。 */
export async function startBatchIngestReceiver() {
  const state = createBatchIngestHandler();
  const server = createServer((request, response) => {
    if (state.handle(request, response)) return;
    response.writeHead(404).end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    ...state,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
