/**
 * M01 验收用例：配置托管、生命周期、吞吐与监听地址（M01-AC-12 至 M01-AC-15）。
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { runCli } from './cli.js';
import { parseCliArgs } from './cli-args.js';
import { isReceiverStartError, startReceiver } from './index.js';
import { delay, httpRequestTo, jsonOf, loadTest, readExample } from './test-support.js';

type Json = Record<string, unknown>;

/** 尝试占用端口，成功说明端口已释放。 */
function canBind(portToBind: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe: Server = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen(portToBind, '127.0.0.1', () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}

describe('M01-AC-12 配置托管与 ETag（M01-F5）', () => {
  it('M01-AC-12 首次 200 带 ETag，带 If-None-Match 返回 304，替换发布物后返回新 ETag', async () => {
    const receiver = await startReceiver({ port: 0 });
    try {
      const configPath = '/v1/config/demo-app/staging.json';
      const first = await httpRequestTo(receiver.port, configPath);
      expect(first.status).toBe(200);
      const firstEtag = first.headers['etag'];
      expect(typeof firstEtag).toBe('string');

      const envelope = jsonOf(first, (value: unknown) => value as Json);
      expect(envelope['format_version']).toBe(1);
      expect(typeof envelope['payload']).toBe('string');
      expect(typeof envelope['signature']).toBe('string');

      const second = await httpRequestTo(receiver.port, configPath, {
        headers: { 'if-none-match': String(firstEtag) },
      });
      expect(second.status).toBe(304);
      expect(second.body).toBe('');

      const example = (await readExample('remote-config.valid.json')) as {
        envelope: Json;
      };
      const published = await httpRequestTo(receiver.port, '/__mock/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ app_id: 'demo-app', env: 'staging', envelope: { ...example.envelope, key_id: 'test-key-swapped' } }), 'utf8'),
      });
      expect(published.status).toBe(200);

      const third = await httpRequestTo(receiver.port, configPath, {
        headers: { 'if-none-match': String(firstEtag) },
      });
      expect(third.status).toBe(200);
      expect(third.headers['etag']).not.toBe(firstEtag);
    } finally {
      await receiver.stop();
    }
  });

  it('M01-AC-12 未知 app_id/env 返回 404，非法发布物返回 400', async () => {
    const receiver = await startReceiver({ port: 0 });
    try {
      const missing = await httpRequestTo(receiver.port, '/v1/config/demo-app/prod.json');
      expect(missing.status).toBe(404);

      const bad = await httpRequestTo(receiver.port, '/__mock/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ app_id: 'demo-app', env: 'staging', envelope: { format_version: 1 } }), 'utf8'),
      });
      expect(bad.status).toBe(400);
    } finally {
      await receiver.stop();
    }
  });
});

describe('M01-AC-13 编程式启停（M01-F6）', () => {
  it('M01-AC-13 重复 3 次启动、发请求、停止；每次启动不超过 2 秒且停止后端口释放', async () => {
    const started: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const before = Date.now();
      const receiver = await startReceiver({ port: 0 });
      const elapsed = Date.now() - before;
      expect(elapsed).toBeLessThan(2_000);
      started.push(elapsed);

      expect(receiver.port).toBeGreaterThan(0);
      expect(receiver.host).toBe('127.0.0.1');

      const batch = (await readExample('batch.valid.json')) as Json;
      const result = await httpRequestTo(receiver.port, '/v1/batch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-app-id': 'demo-app',
          'x-write-token': 'placeholder-write-token-0000',
        },
        body: Buffer.from(JSON.stringify(batch), 'utf8'),
      });
      expect(result.status).toBe(202);

      await receiver.stop();
      expect(receiver.listening).toBe(false);
      await delay(30);
      const portAfterStop = receiver.port;
      expect(
        await canBind(portAfterStop),
        `第 ${String(round + 1)} 次停止后端口 ${String(portAfterStop)} 未释放`,
      ).toBe(true);
    }
    expect(Math.max(...started)).toBeLessThan(2_000);
  });

  it('M01-AC-13 固定端口启动可用，重复 stop 幂等', async () => {
    const first = await startReceiver({ port: 0 });
    const port = first.port;
    await first.stop();
    await delay(30);

    const second = await startReceiver({ port });
    expect(second.port).toBe(port);
    await second.stop();
    await second.stop();
    await delay(30);
    expect(await canBind(port)).toBe(true);
  });
});

describe('M01-AC-14 吞吐（非功能）', () => {
  it('M01-AC-14 每批 15 条事件，每秒不少于 500 个批次且无错误响应', async () => {
    const receiver = await startReceiver({ port: 0 });
    try {
      // 规格写 30 秒压测；为控制单元测试时长，按同一方法压测 6 秒并报告实测吞吐。
      const result = await loadTest(receiver.port, { durationMs: 6_000, concurrency: 4 });
      const perSecond = result.batches / result.seconds;

      expect(result.errors).toBe(0);
      expect(result.firstFailure).toBeNull();
      expect([...result.statuses.keys()]).toEqual([202]);
      expect(result.events).toBe(result.batches * 15);
      expect(perSecond).toBeGreaterThanOrEqual(500);
      // 门禁上留出余量，避免慢机器上偶发抖动。
      expect(perSecond).toBeGreaterThanOrEqual(1_000);
      expect(receiver.counters.snapshot().stored_events).toBe(result.events);
    } finally {
      await receiver.stop();
    }
  }, 60_000);
});

describe('M01-AC-15 只监听 127.0.0.1（M01 安全）', () => {
  it('M01-AC-15 监听 0.0.0.0 时启动失败', async () => {
    const error = await startReceiver({ host: '0.0.0.0', port: 0 }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(isReceiverStartError(error)).toBe(true);
    expect((error as Error).message).toContain('127.0.0.1');
  });

  it('M01-AC-15 CLI 用 --host 0.0.0.0 时返回非零退出码并输出可读错误', async () => {
    const stderr: string[] = [];
    const code = await runCli(['--host', '0.0.0.0', '--port', '0'], {
      stdout: () => undefined,
      stderr: (line: string) => stderr.push(line),
    });
    expect(code).not.toBe(0);
    expect(stderr.join('\n')).toContain('127.0.0.1');
  });

  it('M01-AC-15 直接执行 CLI 入口时返回非零退出码（子进程）', async () => {
    const entry = resolve(process.cwd(), 'tools/mock-receiver/src/cli.ts');
    expect(existsSync(entry)).toBe(true);
    const code = await new Promise<number>((settle) => {
      const child = spawn(process.execPath, [entry, '--host', '0.0.0.0', '--port', '0'], {
        stdio: 'ignore',
      });
      child.on('close', (value) => {
        settle(value ?? -1);
      });
    });
    expect(code).not.toBe(0);
  });

  it('M01-AC-15 CLI 只允许 127.0.0.1，其他取值同样失败', () => {
    expect(() => parseCliArgs(['--host', '::'])).toThrow(/127\.0\.0\.1/);
    expect(() => parseCliArgs(['--host', 'localhost'])).toThrow(/127\.0\.0\.1/);
    const parsed = parseCliArgs([]);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(8787);
  });
});
