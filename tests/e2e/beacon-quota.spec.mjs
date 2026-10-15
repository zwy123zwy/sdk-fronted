/**
 * 信标累计额度**特性刻画**（C07-AC-03 修复取数的依据；与实现无关）。
 *
 * 为什么单独一个文件：`docs/reports/e2e-real-browser.md` 的 AC-03 追加节实测出 Chromium 除
 * 单次上限外还有「累计在途额度」（`[40K,40K] → [true,false]`），但没有回答
 * 「分成几次、每次多大 / 间隔多久才稳定送达 80 KB」。修复要改的数值
 * （切片上限、片间节流）都必须有本机实测支撑，不能凭感觉取数。
 *
 * 本用例**只做观测**（把原始返回值与接收端到达字节写进 annotation + `results/*.json`），
 * 断言只覆盖「浏览器特性本身没有变」这一层——避免把特性刻画伪装成 AC-03 判定。
 * AC-03 的判定在 `tests/e2e/leave-slice.spec.mjs`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { resolveBrowser } from './lib/browsers.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { startBeaconReceiver, settleBeaconRequests } from './lib/beacon-receiver.mjs';
import { killMatching, launchPersistent, profilePids } from './lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const KB = 1024;

test.setTimeout(6 * 60_000);

let server = null;
let receiver = null;

test.beforeAll(async () => {
  server = await startStaticServer({ repoRoot: REPO_ROOT, mounts: [['/probes', 'tests/e2e/probes']] });
  receiver = await startBeaconReceiver();
});

test.afterAll(async () => {
  await server?.close();
  await receiver?.close();
});

function describe(rows) {
  return rows
    .map(
      (row) =>
        `${row.label} 计划 ${row.sizesBytes.map((value) => `${value / KB}K`).join('+')}` +
        `（${row.sizesBytes
          .map((_, index) => (row.delayMs[index] > 0 ? `隔${row.delayMs[index]}ms` : row.sync[index] ? '同步' : 'rAF'))
          .join(',')}）` +
        ` → 返回值 ${JSON.stringify(row.accepted)}，到达 ${JSON.stringify(row.arrivedBytes.map((value) => `${value}B`))}` +
        `，总耗时 ${row.elapsedMs}ms`,
    )
    .join('\n');
}

for (const browserName of ['chromium', 'webkit']) {
  test(`C07-AC-03 取数：${browserName} 信标单次上限 + 累计在途额度 + 片间节流`, async () => {
    const info = await resolveBrowser(browserName);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ac03-quota-${browserName}-`));
    const context = await launchPersistent(info, dir);
    const rows = [];
    // 只在 try 内赋值、且异常时不会走到下面的读取，故不写死初始值（否则是无效赋值）。
    let config;
    try {
      const page = await context.newPage();
      await page.goto(`${server.url}/probes/beacon-quota.html`, { waitUntil: 'load' });
      await page.waitForFunction(() => globalThis.window.__beaconQuotaReady === true);
      config = await page.evaluate(() => globalThis.window.__beaconQuota.config());

      const run = async (label, steps) => {
        const before = receiver.requests.length;
        const result = await page.evaluate((options) => globalThis.window.__beaconQuota.plan(options), {
          url: `${receiver.url}/beacon?probe=${label}`,
          steps,
        });
        await settleBeaconRequests(receiver.requests);
        rows.push({
          label,
          sizesBytes: steps.map((step) => step.bytes),
          delayMs: steps.map((step) => step.delayMs ?? 0),
          sync: steps.map((step) => step.sync === true),
          accepted: result.steps.map((step) => step.accepted),
          arrivedBytes: receiver.requests.slice(before).map((item) => item.bytes),
          elapsedMs: Math.round(result.steps.at(-1)?.elapsedMs ?? 0),
        });
      };

      // ① 单次上限（T29 已实测 80 KB → false；这里量出「多大还能被接受」）。
      for (const bytes of [64 * KB, 60 * KB, 56 * KB, 48 * KB, 40 * KB, 32 * KB, 24 * KB, 16 * KB]) {
        await run(`single-${bytes / KB}K`, [{ bytes, sync: true }]);
      }
      // ② 同一同步回合内连续多片（累计额度）。
      for (const sizes of [
        [40 * KB, 40 * KB],
        [32 * KB, 32 * KB],
        [32 * KB, 32 * KB, 32 * KB],
        [28 * KB, 28 * KB, 28 * KB],
        [24 * KB, 24 * KB, 24 * KB, 24 * KB],
        [21 * KB, 21 * KB, 21 * KB, 21 * KB],
        [16 * KB, 16 * KB, 16 * KB, 16 * KB],
        [12 * KB, 12 * KB, 12 * KB, 12 * KB],
      ]) {
        await run(`sync-${sizes.map((value) => value / KB).join('x')}`, sizes.map((bytes) => ({ bytes, sync: true })));
      }
      // ③ 每个片之间让出一个渲染帧（切到下一个任务）。
      for (const sizes of [
        [40 * KB, 40 * KB],
        [32 * KB, 32 * KB],
        [28 * KB, 28 * KB, 28 * KB],
        [21 * KB, 21 * KB, 21 * KB, 21 * KB],
      ]) {
        await run(`raf-${sizes.map((value) => value / KB).join('x')}`, sizes.map((bytes) => ({ bytes })));
      }
      // ④ 片间定时器间隔（0 / 10 / 25 / 50 ms）。
      for (const delayMs of [0, 10, 25, 50]) {
        await run(`delay${delayMs}-21x4`, [0, 1, 2, 3].map(() => ({ bytes: 21 * KB, delayMs })));
      }
      // ⑤ 候选切片上限在同步回合里能连发几片（决定「最小片数」是否可达）。
      for (const bytes of [32 * KB, 24 * KB, 21 * KB, 16 * KB, 12 * KB]) {
        await run(`cap4-${bytes / KB}x4`, [0, 1, 2, 3].map(() => ({ bytes, sync: true })));
      }
    } finally {
      try {
        await context.close();
      } catch {
        /* 已退出 */
      }
      killMatching(profilePids(dir));
      fs.rmSync(dir, { recursive: true, force: true });
    }

    test.info().annotations.push({
      type: 'measurement',
      description:
        `浏览器=${browserName}；UA=${String(config?.userAgent ?? '').slice(0, 90)}\n${describe(rows)}\n` +
        `全部被接受的计划：${JSON.stringify(rows.filter((row) => row.accepted.every(Boolean)).map((row) => row.label))}`,
    });

    fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(HERE, 'results', `beacon-quota-${browserName}.json`),
      `${JSON.stringify({ browser: browserName, at: new Date().toISOString(), userAgent: config?.userAgent ?? null, rows }, null, 2)}\n`,
    );

    // 断言只覆盖「浏览器特性本身」：真实 sendBeacon 可用；单次 64 KB 被接受；
    // 存在一个「多片全部被接受」的计划（否则切片方案不成立，修复必须换通道）。
    expect(config?.hasSendBeacon, '前置：必须是真的 navigator.sendBeacon').toBe(true);
    expect(rows.find((row) => row.label === 'single-64K')?.accepted[0], '单次 64 KB 必须被接受').toBe(true);
    expect(
      rows.some((row) => row.sizesBytes.length > 1 && row.accepted.every(Boolean)),
      '必须存在一个「多片全部被接受」的计划，否则切片方案不成立',
    ).toBe(true);
  });
}
