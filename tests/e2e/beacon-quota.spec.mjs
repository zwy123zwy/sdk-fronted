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
 *
 * 浏览器维度（2026-10-16 复核，本 lane 修复）：此前这里是
 *   `for (const browserName of ['chromium', 'webkit']) { test(...) }`
 * ——**写死的引擎名单**，而且它**不用** Playwright project 的 `browserName`。后果不是"被跳过"，
 * 而是**测错了引擎**：`--project=firefox` 下这两条用例照样跑，但跑的是 Chromium 与 WebKit
 * （实测：`pnpm test:e2e --project=chromium tests/e2e/beacon-quota.spec.mjs` 报 **2 passed**，
 * 标题分别是 `[chromium] … 取数：chromium …` 与 `[chromium] … 取数：webkit …`），
 * Gecko 的信标额度**永远取不到数**，`results/beacon-quota-firefox.json` 也不会产生。
 * 现在改成与 `leave-slice.spec.mjs` **同一套口径**（唯一实现在 `lib/browser-availability.mjs`）：
 *   - 用例只声明**一条**，浏览器由 project 的 `browserName` 决定（判据里没有任何引擎名单）；
 *   - 该浏览器**真启动探测**通过就真的跑；起不来才经 `lib/skip-audit.mjs` 登记跳过（带真实报错）；
 *   - 旁路跳过（写死 `.skip`）由 `afterEach` 判红；**整 spec 在某浏览器上一条都没跑**由 `afterAll` 判红。
 * 判别性证明：`E2E_FORCE_RUN_BROWSER=<name>` 强制走"能跑"分支（本机 Firefox 起不来 ⇒ 真红而非跳过）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { resolveBrowser } from './lib/browsers.mjs';
import { createBrowserAvailability, requireBrowser } from './lib/browser-availability.mjs';
import { createSkipAudit } from './lib/skip-audit.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { startBeaconReceiver, settleBeaconRequests } from './lib/beacon-receiver.mjs';
import { killMatching, launchPersistent, profilePids } from './lib/harness.mjs';
import { redactPaths } from '../compat/lib/redact-paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const KB = 1024;

/**
 * 本 spec 声明的用例条数（钉住的常量）。
 * 增删用例必须同步这里：`lib/skip-audit.mjs` 用它算"整 spec 是否全部跳过"与"记账是否可信"。
 */
const DECLARED_QUOTA_TESTS = 1;

test.setTimeout(6 * 60_000);

/** 浏览器可用性：真启动探测，能跑就跑（唯一实现，`leave-slice.spec.mjs` 共用）。 */
const availability = createBrowserAvailability({ tag: 'beacon-quota-probe' });

/** 跳过审计：让"跳过"不可能静默（唯一跳过入口 + afterEach 抓旁路 + afterAll 汇总/判红）。 */
const skipAudit = createSkipAudit({ specName: 'beacon-quota.spec.mjs', declaredTests: DECLARED_QUOTA_TESTS });
skipAudit.install();

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

test('C07-AC-03 取数：信标单次上限 + 累计在途额度 + 片间节流', async ({ browserName }) => {
  // 浏览器由 project 决定（不是写死的引擎名单）：起得来就跑，起不来才登记跳过并带真实报错。
  const probe = await availability.ready(browserName);
  requireBrowser(browserName, test.info(), probe, skipAudit);

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
      `浏览器=${browserName}（project=${test.info().project.name}）；UA=${String(config?.userAgent ?? '').slice(0, 90)}\n` +
      `${describe(rows)}\n` +
      `全部被接受的计划：${JSON.stringify(rows.filter((row) => row.accepted.every(Boolean)).map((row) => row.label))}`,
  });

  fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
  fs.writeFileSync(
    path.join(HERE, 'results', `beacon-quota-${browserName}.json`),
    `${JSON.stringify(
      // 落盘前脱敏：证据要提交进仓库，绝对路径会泄露本机用户名（口径见 tests/compat/lib/redact-paths.mjs）。
      redactPaths({
        browser: browserName,
        project: test.info().project.name,
        driver: info.driverId,
        executablePath: info.executablePath,
        at: new Date().toISOString(),
        userAgent: config?.userAgent ?? null,
        rows,
      }),
      null,
      2,
    )}\n`,
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
