/** 只服务 poc/poc-1/public 的静态页服务器，绑定 127.0.0.1:0。 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

export async function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const rel = url.pathname === '/' ? '/probe.html' : url.pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
