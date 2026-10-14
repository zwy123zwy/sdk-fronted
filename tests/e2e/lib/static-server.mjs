/**
 * T29 用的极简静态服务器：只把白名单目录挂到 127.0.0.1 的随机端口，永不访问外部网络。
 *
 * 挂载点由调用方给出，例如：
 *   ['/transport', 'packages/transport/dist']  → 真实实现（单包 build 的 ESM 产物）
 *   ['/probes', 'tests/e2e/probes']            → 探针页与探针驱动
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * @param {{repoRoot: string, mounts: Array<[string, string]>}} options
 * @returns {Promise<{url: string, close: () => Promise<void>, requests: string[]}>}
 */
export async function startStaticServer({ repoRoot, mounts }) {
  const resolved = mounts.map(([prefix, rel]) => ({
    prefix,
    dir: path.resolve(repoRoot, rel),
  }));
  for (const mount of resolved) {
    if (!fs.existsSync(mount.dir)) {
      throw new Error(`静态服务器挂载目录不存在：${mount.dir}（先跑单包 build）`);
    }
  }
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new globalThis.URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    const mount = resolved.find(
      (candidate) => url.pathname === candidate.prefix || url.pathname.startsWith(`${candidate.prefix}/`),
    );
    if (!mount) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not mounted');
      return;
    }
    const rel = url.pathname.slice(mount.prefix.length).replace(/^\/+/, '');
    const file = path.resolve(mount.dir, rel === '' ? 'index.html' : rel);
    if (!file.startsWith(mount.dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(fs.readFileSync(file));
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
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
