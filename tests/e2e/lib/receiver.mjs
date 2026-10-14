/**
 * T29 用的本地接收端：只监听 127.0.0.1，用来在真实浏览器里驱动**真实**网络行为
 * （真实 `sendBeacon`、真实 `fetch`/XHR、真实 401、真实超时）。
 *
 * 端点：
 *   POST /ingest         → 202，记录正文（默认成功路径）
 *   POST /revoked        → 401（令牌吊销对照组）
 *   POST /hang           → 永不响应（真实超时对照组）
 *   POST /beacon         → 202（`sendBeacon` 的 no-cors POST）
 *   POST /gzip           → 202（压缩正文）
 *   OPTIONS *            → 204 + CORS 预检
 */
import http from 'node:http';

export async function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      const body = globalThis.Buffer.concat(chunks);
      const record = {
        path,
        method: req.method,
        headers: req.headers,
        bytes: body.length,
        at: Date.now(),
        accepted: true,
      };
      received.push(record);

      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      if (path === '/hang') {
        record.accepted = false;
        return; // 故意不响应
      }
      if (path === '/revoked') {
        record.accepted = false;
        res.writeHead(401, { ...cors, 'content-type': 'application/json' });
        res.end('{"error":"token_revoked"}');
        return;
      }
      res.writeHead(202, { ...cors, 'content-type': 'application/json' });
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
    received,
    hits: (path) => received.filter((item) => item.path === path),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
