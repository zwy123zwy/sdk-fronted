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
import { isReceiverStartError, startReceiver, type MockReceiver, type ReceiverOptions } from './index.js';
import { delay, httpRequestTo, jsonOf, loadTest, readExample, type LoadResult } from './test-support.js';

type Json = Record<string, unknown>;

/** 门禁内压测轮数（取奇数，便于直接取正中一个作为中位数）。 */
const THROUGHPUT_ROUNDS = 5;

/** 每轮压测时长；5 × 1.2 秒 = 6 秒，与既有门禁内口径一致（规格是 30 秒）。 */
const THROUGHPUT_ROUND_MS = 1_200;

/**
 * 每批的 **CPU 成本**回归护栏（毫秒/批）——**负载无关**，见本文件 M01-AC-14 的注释。
 *
 * 取值依据（本机 10 核实测，2026-10-19）：5 轮 × 1.2 秒、并发 4、每批 15 条事件，
 * `process.cpuUsage()` 差值 / 批次数 = **0.2067 ms/批（空闲）**、**0.2116 ms/批（覆盖率开）**；
 * 护栏 2.5 ms/批 ≈ **11.8 倍余量**于带覆盖率实测最差值，等价于「每 CPU 秒 ≥ 400 批」。
 */
const THROUGHPUT_CPU_MS_PER_BATCH_GUARD = 2.5;

/**
 * 启动的 **CPU 时间**预算（毫秒）——负载无关的等价守卫，见本文件 M01-AC-13 的注释。
 * 实测（20 次）中位数 0.131 ms、最大 3.201 ms（覆盖率开）⇒ 50 ms 预算约 380 倍余量于中位数、
 * 15.6 倍于采样最大值；它只用于抓「启动路径被加了重计算」这类癌变，不参与墙钟判据。
 */
const START_CPU_BUDGET_MS = 50;

/**
 * 启动期间允许的最长定时器等待（毫秒）：**结构守卫**。
 * 它堵死「在启动路径里 sleep 一段时间再返回」这种把慢启动藏起来的做法。
 */
const START_LONG_TIMER_BUDGET_MS = 50;

/** 一次被审计的启动样本。 */
interface StartSample {
  readonly receiver: MockReceiver;
  /** 本次启动的墙钟耗时（毫秒）——契约判据用。 */
  readonly wallMs: number;
  /** 本次启动消耗的进程 CPU 时间（毫秒）——负载无关。 */
  readonly cpuMs: number;
  /** 启动期间被安排的、≥ `START_LONG_TIMER_BUDGET_MS` 的定时器延时（毫秒）。 */
  readonly longTimers: readonly number[];
}

/**
 * 启动一次接收服务并审计三件事：
 * 1. 墙钟（`M01-AC-13` 的 2 秒契约判据，**口径不变**）；
 * 2. 本次启动消耗的**进程 CPU 时间**（负载无关，先例见
 *    `tools/config-signer/src/__tests__/performance.test.ts`）；
 * 3. 启动期间是否安排了 ≥50 ms 的定时器等待（结构守卫）。
 *
 * 只审计「启动」这一小段：审计窗口在 `startReceiver()` 返回后立即关闭，
 * `globalThis.setTimeout` 一定在 `finally` 里还原。
 */
async function startWithAudit(options: ReceiverOptions): Promise<StartSample> {
  // 只声明真正用到的能力（与 `mask-adversarial.test.ts` 的「最小声明」同一手法），
  // 避免把 Node 的 `setTimeout.__promisify__` 之类内部形状拖进断言。
  type TimerFn = (
    callback: (...args: never[]) => void,
    delayMs?: number,
    ...args: never[]
  ) => NodeJS.Timeout;
  const globalTimers = globalThis as unknown as { setTimeout: TimerFn };
  const originalSetTimeout = globalTimers.setTimeout;
  const longTimers: number[] = [];
  const auditor: TimerFn = (callback, delayMs, ...args) => {
    if (typeof delayMs === 'number' && delayMs >= START_LONG_TIMER_BUDGET_MS) {
      longTimers.push(delayMs);
    }
    return originalSetTimeout(callback, delayMs, ...args);
  };
  const cpuStarted = process.cpuUsage();
  const wallStarted = Date.now();
  globalTimers.setTimeout = auditor;
  try {
    const receiver = await startReceiver(options);
    const cpuDelta = process.cpuUsage(cpuStarted);
    return {
      receiver,
      wallMs: Date.now() - wallStarted,
      cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
      longTimers,
    };
  } finally {
    globalTimers.setTimeout = originalSetTimeout;
  }
}

/** 中位数（回归护栏用的稳健统计量；对单轮被进程抢占的抖动不敏感）。 */
function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

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

/**
 * M01-AC-13 的口径（2026-10-19 收口）：
 *
 * - **「每次启动不超过 2 秒」是墙钟契约判据，不能被换成 CPU 时间**：原文在
 *   `tests/acceptance/M01.md:19`（"每次启动不超过 2 秒"），并作为非功能目标写在
 *   `docs/tasks/T09.md:34`。它约束的是**用户可见的启动时延**，不是"实现消耗了多少 CPU"。
 * - 它**没有第二处验证**：`tests/bench/` 只有 C01–C08 与 K02（无 M01），
 *   `docs/reports/reliability-reconciliation.md` 自报「M01 侧零数据」。因此按
 *   「不许把契约要求偷偷换成 CPU 时间」的要求，**墙钟断言原样保留**（阈值 2,000 ms 未动）。
 * - 另外两条是**同一契约的负载无关等价守卫**，只用来在墙钟被抢占噪声淹没时仍能抓住
 *   "实现变慢"（`README.md:200` 的策略为「**规格线不进单元门禁。** 仓库策略是：单元门禁只保留
 *   **带文档余量的回归护栏**，…」，本条即按该策略补的护栏；墙钟判据本身不降级）：
 *   ① 启动的**进程 CPU 时间**中位数 ≤ `START_CPU_BUDGET_MS`（实测中位数 0.131 ms、
 *      覆盖率开时最大 3.201 ms ⇒ 约 760 倍余量）；先例
 *      `tools/config-signer/src/__tests__/performance.test.ts` 与
 *      `packages/core/src/privacy/mask-adversarial.test.ts`；
 *   ② **结构守卫**：启动期间不得安排 ≥ `START_LONG_TIMER_BUDGET_MS` 的定时器等待——
 *      "在启动路径里 sleep 一下"这条把慢启动藏起来的路被直接堵死。
 */
describe('M01-AC-13 编程式启停（M01-F6）', () => {
  it('M01-AC-13 重复 3 次启动、发请求、停止；每次启动不超过 2 秒且停止后端口释放', async () => {
    const walls: number[] = [];
    const cpus: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const sample = await startWithAudit({ port: 0 });
      const receiver = sample.receiver;
      try {
        walls.push(sample.wallMs);
        cpus.push(sample.cpuMs);

        // 契约墙钟判据（原文 M01.md:19）：阈值 2,000 ms 原样保留。
        expect(
          sample.wallMs,
          `第 ${String(round + 1)} 次启动墙钟 ${String(sample.wallMs)} ms（契约判据 2,000 ms）`,
        ).toBeLessThan(2_000);
        // 结构守卫：启动不得靠 sleep 达标。
        expect(
          sample.longTimers,
          `第 ${String(round + 1)} 次启动安排了 ≥${String(START_LONG_TIMER_BUDGET_MS)} ms 的定时器：${sample.longTimers.join(', ')}`,
        ).toEqual([]);
        // 负载无关的等价守卫：启动消耗的 CPU 时间。
        expect(
          sample.cpuMs,
          `第 ${String(round + 1)} 次启动 CPU 时间 ${sample.cpuMs.toFixed(3)} ms（护栏 ${String(START_CPU_BUDGET_MS)} ms）`,
        ).toBeLessThanOrEqual(START_CPU_BUDGET_MS);

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
      } finally {
        if (receiver.listening) await receiver.stop();
      }
    }
    expect(Math.max(...walls)).toBeLessThan(2_000);
    const cpuMedian = median(cpus);
    expect(
      cpuMedian,
      `3 次启动的 CPU 时间中位数 ${cpuMedian.toFixed(3)} ms（护栏 ${String(START_CPU_BUDGET_MS)} ms；样本 ${cpus.map((value) => value.toFixed(3)).join(' / ')}）`,
    ).toBeLessThanOrEqual(START_CPU_BUDGET_MS);
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

/**
 * M01-AC-14 的口径（2026-10-19 收口）：
 *
 * - **规格线**（`tests/acceptance/M01.md:20`、`docs/tasks/T09.md:34`）：本地压测 **30 秒**、
 *   每批 15 条事件，每秒处理不少于 **500 个批次**且无错误响应。**本文件不断言它**
 *   （`README.md:200`："**规格线不进单元门禁。** 仓库策略是：单元门禁只保留**带文档余量的
 *   回归护栏**，…"）。
 * - **这条规格线现在实际上没有第二处验证**（本轮核对，必须记录，不能假设它有人接）：
 *   `tests/bench/` 只有 C01–C08 与 K02 的客户端基准（无 M01）；T32 的
 *   `docs/reports/reliability-reconciliation.md` 自报「M01 侧零数据」；README §8 的 30 秒
 *   数字是**树外一次性脚本**（不可复跑）。⇒ 见 `docs/reports/t33-access-blockers.md` §13。
 * - **原来的「5 轮吞吐中位数 ≥ 40 批/秒」是测试自定的经验值，不是契约线**：40 这个数来自
 *   README §7 的余量推算（10.7 倍于有负载实测），而它量的是**墙钟吞吐**——负载一变就红
 *   （本轮实测红过 24.1 / 32.8 批/秒）。同一实现上实测 1 条连接 5,277–6,017 批/秒、
 *   4 条连接 5,968–6,834 批/秒（比值 **1.07–1.28**）⇒ **本实现在吞吐上是 CPU 受限，
 *   不是并发受限**；因此"吞吐随并发线性增长"这类相对判据在这里会恒红，**不要写**。
 * - **本文件的替代护栏是「每批的 CPU 成本」**（`process.cpuUsage()` 差值 / 批次数）：
 *   它把「单位时间的量」里的时间换成 **CPU 时间**，与机器被抢占多久无关。
 *   实测（5 轮 × 1.2 秒、并发 4、每批 15 条）：**0.2067 ms/批（空闲）**、
 *   **0.2116 ms/批（覆盖率开）**；护栏 `THROUGHPUT_CPU_MS_PER_BATCH_GUARD` = 2.5 ms/批
 *   ≈ **11.8 倍余量**，等价于「每 CPU 秒 ≥ 400 批」。
 * - **它仍守住什么**：每批处理路径的病态回归——校验/序列化变成超线性、每批多一次同步 I/O、
 *   每批多一次整表扫描，都会把 CPU/批抬上去（>12 倍即红）。它**不**再守「这台机器此刻有多快」
 *   （那本来就不是代码属性，且规格线归受控口径）。
 */
describe('M01-AC-14 吞吐（非功能，负载无关护栏：每批 CPU 成本）', () => {
  it('M01-AC-14 五轮压测每批 CPU 成本不高于护栏，且全程无错误响应（规格线「30 秒 ≥ 500 批/秒」不在单元门禁，见注释）', async () => {
    const receiver = await startReceiver({ port: 0 });
    try {
      const cpuStarted = process.cpuUsage();
      const rounds: LoadResult[] = [];
      for (let round = 0; round < THROUGHPUT_ROUNDS; round += 1) {
        rounds.push(
          await loadTest(receiver.port, {
            durationMs: THROUGHPUT_ROUND_MS,
            concurrency: 4,
            // loadTest 每轮都把事件序号从 0 重新开始；去重键是「app_id + event_id」，
            // 因此每轮用不同的 app_id，轮与轮之间不会互相判重，`stored_events === events`
            // 这条确定性断言（以及真实的入库路径）才成立。
            appId: `demo-app-r${String(round + 1)}`,
          }),
        );
      }
      const cpuDelta = process.cpuUsage(cpuStarted);
      const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000;

      const perSecond = median(rounds.map((result) => result.batches / result.seconds));
      const batches = rounds.reduce((sum, result) => sum + result.batches, 0);
      const events = rounds.reduce((sum, result) => sum + result.events, 0);
      const errors = rounds.reduce((sum, result) => sum + result.errors, 0);
      const firstFailure =
        rounds.find((result) => result.firstFailure !== null)?.firstFailure ?? null;
      const statuses = new Set(rounds.flatMap((result) => [...result.statuses.keys()]));
      const cpuMsPerBatch = cpuMs / batches;

      // 确定性断言：这些才是真正的门禁，与吞吐高低无关。
      expect(errors).toBe(0);
      expect(firstFailure).toBeNull();
      expect([...statuses]).toEqual([202]);
      expect(events).toBe(batches * 15);
      expect(receiver.counters.snapshot().stored_events).toBe(events);

      // 负载无关护栏：每批 CPU 成本（墙钟吞吐只放在消息里作为诊断，不断言）。
      expect(
        cpuMsPerBatch,
        `每批 CPU ${cpuMsPerBatch.toFixed(4)} ms（护栏 ${String(THROUGHPUT_CPU_MS_PER_BATCH_GUARD)} ms/批；` +
          `${String(batches)} 批耗 CPU ${cpuMs.toFixed(1)} ms；墙钟 ${perSecond.toFixed(0)} 批/秒，仅诊断）`,
      ).toBeLessThanOrEqual(THROUGHPUT_CPU_MS_PER_BATCH_GUARD);
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
