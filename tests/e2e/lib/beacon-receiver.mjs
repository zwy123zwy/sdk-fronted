/**
 * C07-AC-03 测量用的**极简信标接收端** + 计划执行器（harness 复用）。
 *
 * 为什么不用 `lib/receiver.mjs`（T29 的对账接收端）：实测发现它在 Chromium 上
 * 「连续两个大信标（如 40 KB + 40 KB）」时会让**第二个 `sendBeacon` 永不返回**
 * （`page.evaluate` 挂死；黑洞地址上的同一计划 9ms 返回 `[true,false]`）。这是
 * harness 侧的问题，不是本次修复范围（`lib/**` 不在可写范围内），故测量与 AC-03
 * 断言都使用与 `leave-slice.spec.mjs` 相同的极简接收端：只读原始正文、立即 202。
 *
 * 只读观测：保留逐请求的原始正文、头、到达顺序，判定全部交给 spec。
 */
import http from 'node:http';

/**
 * @param {{responseCode?: number}} [options]
 * @returns {Promise<{url: string, requests: Array<{path: string, method: string|undefined, headers: Record<string, string|string[]|undefined>, bytes: number, raw: string, at: number}>, close: () => Promise<void>}>}
 */
export async function startBeaconReceiver(options = {}) {
  const responseCode = options.responseCode ?? 202;
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = globalThis.Buffer.concat(chunks);
      requests.push({
        path: (req.url ?? '/').split('?')[0],
        method: req.method,
        headers: req.headers,
        bytes: body.length,
        raw: body.toString('utf8'),
        at: Date.now(),
      });
      res.writeHead(responseCode, {
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
      });
      res.end('{"accepted":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * 等接收端静默收敛（信标没有完成回调，只能按请求数收敛）。
 * @param {{length: number}} requests
 */
export async function settleBeaconRequests(requests, { quietMs = 350, timeoutMs = 6_000 } = {}) {
  const started = Date.now();
  let last = -1;
  let lastChange = Date.now();
  for (;;) {
    if (requests.length !== last) {
      last = requests.length;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= quietMs) return requests.length;
    if (Date.now() - started > timeoutMs) return requests.length;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
}
