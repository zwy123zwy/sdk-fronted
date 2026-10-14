/**
 * C07-AC-03（离开通道切片路径）真实浏览器验证 —— T29 之后补的**未验证**验收项。
 *
 * 验收口径（`tests/acceptance/C07.md` 第 9 行，原文，不得改写）：
 *   | C07-AC-03 | C07-F1 | 页面离开时冲刷 80 KB 数据 |
 *   使用信标通道，拆成至少两个不超过 60 KB 的请求；`Content-Type` 为 `text/plain`；令牌在 `auth` 字段 |
 *
 * 为什么必须单独验：T29（`docs/reports/e2e-real-browser.md`）实测**单次** 80 KB `sendBeacon`
 * 在 Chromium 与 WebKit 上都返回 `false`，所以 AC-03 只能按**切片路径**验证，而 T29 只测了
 * 5 个事件的 1112 B 单请求（`leave.requests=1`）——切片路径此前**没有被测过**。
 *
 * 复用 T29 的 harness（`lib/browsers.mjs` / `lib/static-server.mjs` / `lib/harness.mjs`），
 * 只在 `tests/e2e/**` 内新增文件；不改既有断言、不改各包的 `src`。
 *
 * 四个用例：
 *   1. 对照组：单次 80 KB `sendBeacon` 返回 `false`（复现 T29）、单次 32 KB 被接受；
 *   2. AC-03 原文判定：**默认配置**下页面离开冲刷 80 KB —— 实测口径见报告，本用例按原文断言；
 *   3. 切片机制隔离：把既有公开选项 `leaveBudget` 放宽（不动实现），验证 ≥2 片、每片 ≤60 KB、
 *      顺序/无重复/无丢失、令牌在 `auth`；
 *   4. 变异自检：把切片阈值调大的**变异体**必须被同一判据判为不合格（证明用例有判别力）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { resolveBrowser } from './lib/browsers.mjs';
import { startStaticServer } from './lib/static-server.mjs';
import { killMatching, launchPersistent, profilePids } from './lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** AC-03 的单请求上限（契约 §2.2「请求体不得超过 60 KB」）。 */
const BEACON_BODY_LIMIT = 60 * 1024;

/** 载荷：112 个事件 × 约 720 B ≈ 80 KB（超过单次 `sendBeacon` 上限，必须切片）。 */
const PAYLOAD = { count: 112, padBytes: 520, numericFields: 8 };

/** 放宽后的离开预算：只改「预算」这一个变量，切片逻辑不动（不是改实现）。 */
const WIDE_BUDGET = { maxBytes: 4 * 1024 * 1024, maxEvents: 20_000, maxBatches: 64, maxMs: 5_000 };

/** 变异体：只把 `BEACON_MAX_BYTES` 调大 → `sliceForBeacon` 只产出一片（等价于关掉切片）。 */
const MUTANT_GENERATED = path.join(HERE, 'probes', 'mutant-transport.js');
const MUTANT_SOURCE = path.join(REPO_ROOT, 'packages', 'transport', 'dist', 'index.js');
const MUTATION_FROM = 'var BEACON_MAX_BYTES = 60 * 1024;';
const MUTATION_TO = 'var BEACON_MAX_BYTES = 10 * 1024 * 1024;';

const REAL_TRANSPORT = '/transport/index.js';
const MUTANT_TRANSPORT = '/probes/mutant-transport.js';

/**
 * 当前运行时用的是哪个变体（默认真实产物）。
 * 变异验证：`AC03_TRANSPORT_VARIANT=mutant pnpm test:e2e --project=chromium --grep "切片机制"`。
 */
const VARIANT = process.env['AC03_TRANSPORT_VARIANT'] ?? 'real';

test.setTimeout(5 * 60_000);

// AC-03 的浏览器行为项本次只在 Chromium 上验证（任务范围；Firefox 在本机沙箱内起不来）。
test.skip(({ browserName }) => browserName !== 'chromium', 'C07-AC-03 切片路径本次只验 Chromium');

let server = null;
let receiver = null;

/** 只收信标、保留**原始正文**的接收端（判定用的片大小/片内容/令牌位置都从原始正文读）。 */
async function startAc03Receiver() {
  const requests = [];
  const serverInstance = http.createServer((req, res) => {
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
      res.writeHead(202, {
        'access-control-allow-origin': '*',
        'content-type': 'application/json',
      });
      res.end('{"accepted":true}');
    });
  });
  await new Promise((resolve, reject) => {
    serverInstance.once('error', reject);
    serverInstance.listen(0, '127.0.0.1', resolve);
  });
  const address = serverInstance.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        serverInstance.closeAllConnections?.();
        serverInstance.close(() => resolve());
      }),
  };
}

test.beforeAll(async () => {
  // 变异体：从真实产物**复制 + 一处替换**（改完不碰 src；每次运行重新生成，不会过期）。
  const source = fs.readFileSync(MUTANT_SOURCE, 'utf8');
  if (!source.includes(MUTATION_FROM)) {
    throw new Error(
      `变异体生成失败：真实产物里找不到 ${JSON.stringify(MUTATION_FROM)}（产物已变？先跑 pnpm --filter @web-report-sdk/transport run build）`,
    );
  }
  fs.writeFileSync(MUTANT_GENERATED, source.replace(MUTATION_FROM, MUTATION_TO));

  server = await startStaticServer({
    repoRoot: REPO_ROOT,
    mounts: [
      ['/transport', 'packages/transport/dist'],
      ['/probes', 'tests/e2e/probes'],
    ],
  });
  receiver = await startAc03Receiver();
});

test.afterAll(async () => {
  await server?.close();
  await receiver?.close();
});

const profiles = [];
async function withContext(fn) {
  const info = await resolveBrowser('chromium');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac03-slice-'));
  profiles.push({ info, dir });
  const context = await launchPersistent(info, dir);
  try {
    return await fn(context, info);
  } finally {
    try {
      await context.close();
    } catch {
      /* 已退出 */
    }
    killMatching(profilePids(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function openProbe(context, variant) {
  const transport = variant === 'mutant' ? MUTANT_TRANSPORT : REAL_TRANSPORT;
  const page = await context.newPage();
  await page.goto(`${server.url}/probes/leave-slice.html?transport=${transport}`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.window.__ac03Ready === true);
  return page;
}

/** 等接收端收敛（信标没有完成回调，只能按请求数静默收敛）。 */
async function settleAc03({ quietMs = 400, timeoutMs = 8_000 } = {}) {
  const started = Date.now();
  let last = -1;
  let lastChange = Date.now();
  for (;;) {
    const count = receiver.requests.length;
    if (count !== last) {
      last = count;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= quietMs) return count;
    if (Date.now() - started > timeoutMs) return count;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
}

/** 发一次离开通道批次（真实 `channel: 'page_leave'`），返回 SDK 观测量 + 接收端逐请求原始数字。 */
async function measureLeave(page, options = {}) {
  const before = receiver.requests.length;
  const measured = await page.evaluate(
    (opts) => globalThis.window.__ac03.sliceSend(opts),
    {
      url: `${receiver.url}/beacon`,
      count: PAYLOAD.count,
      padBytes: PAYLOAD.padBytes,
      numericFields: PAYLOAD.numericFields,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
  );
  await settleAc03();
  const slices = receiver.requests.slice(before).map((request) => {
    const body = JSON.parse(request.raw);
    const ids = (body.events ?? []).map((event) => event.event_id);
    const firstIndex = ids.length > 0 ? Number(ids[0].split('-')[1]) : Number.POSITIVE_INFINITY;
    return {
      bytes: request.bytes,
      contentType: String(request.headers['content-type'] ?? ''),
      headerToken: request.headers['x-write-token'] ?? null,
      authAppId: body.auth?.app_id ?? null,
      authWriteToken: body.auth?.write_token ?? null,
      batchId: body.batch_id ?? null,
      ids,
      firstIndex,
      eventBytes: ids.length,
    };
  });
  return { measured, slices };
}

/** 按 AC-03 原文逐条判不合格（返回全部问题，不做「首个失败就返回」）。 */
function ac03Violations(measured, slices) {
  const problems = [];
  if (slices.length < 2) {
    problems.push(`信标请求数 ${slices.length} < 2（AC-03 要求「拆成至少两个」）`);
  }
  slices.forEach((slice, index) => {
    if (slice.bytes > BEACON_BODY_LIMIT) {
      problems.push(`第 ${index + 1} 片 ${slice.bytes} B > 60 KB（${BEACON_BODY_LIMIT} B）`);
    }
    if (!slice.contentType.startsWith('text/plain')) {
      problems.push(`第 ${index + 1} 片 Content-Type=${JSON.stringify(slice.contentType)}（要求 text/plain）`);
    }
    if (slice.authWriteToken !== 'tok-ac03' || slice.authAppId !== 'ac03') {
      problems.push(
        `第 ${index + 1} 片 auth 字段不对：app_id=${String(slice.authAppId)} write_token=${String(slice.authWriteToken)}`,
      );
    }
    if (slice.headerToken !== null) {
      problems.push(`第 ${index + 1} 片令牌出现在请求头（x-write-token），AC-03 要求令牌在 auth 字段`);
    }
  });

  // 顺序 / 无重复 / 无丢失：按每片首事件的下标排序后拼接，必须与原始事件序列逐项相等。
  const rebuilt = [...slices]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .flatMap((slice) => slice.ids);
  const expected = measured.expectedIds;
  if (rebuilt.length !== expected.length) {
    problems.push(`重组事件数 ${rebuilt.length} ≠ 原始 ${expected.length}（丢失 ${expected.length - rebuilt.length}）`);
  } else if (JSON.stringify(rebuilt) !== JSON.stringify(expected)) {
    const dup = rebuilt.length - new Set(rebuilt).size;
    problems.push(`重组序列与原始序列不一致（重复 ${dup} 条，或顺序错乱）`);
  }
  if ((measured.counters['retry_network'] ?? 0) > 0) {
    problems.push(`浏览器拒绝了 ${measured.counters['retry_network']} 次信标（sendBeacon 返回 false）`);
  }
  return problems;
}

function describeSlices(slices) {
  return slices
    .map((slice, index) => `#${index + 1} ${slice.bytes} B / ${slice.eventBytes} 事件 / 起 ${String(slice.firstIndex)}`)
    .join('；');
}

test('C07-AC-03 对照：单次 80 KB 信标返回 false（复现 T29），单次 32 KB 被接受', async () => {
  const result = await withContext(async (context) => {
    const page = await openProbe(context, 'real');
    const config = await page.evaluate(() => globalThis.window.__ac03.config());
    const large = await page.evaluate(
      (url) => globalThis.window.__ac03.rawBeacon(url, 80 * 1024),
      `${receiver.url}/beacon`,
    );
    const medium = await page.evaluate(
      (url) => globalThis.window.__ac03.rawBeacon(url, 32 * 1024),
      `${receiver.url}/beacon`,
    );
    await settleAc03();
    return { config, large, medium, hits: receiver.requests.filter((item) => item.bytes === 32 * 1024).length };
  });

  expect(result.config.hasSendBeacon, '前置：必须是真的 navigator.sendBeacon').toBe(true);
  expect(result.config.leaveBudget, '前置：必须能读到真实实现导出的 LEAVE_BUDGET').not.toBeNull();
  expect(result.large.accepted, '复现 T29：单次 80 KB sendBeacon 必须被浏览器拒绝（false）').toBe(false);
  expect(result.medium.accepted, '对照：单次 32 KB sendBeacon 必须被接受（true）').toBe(true);
  expect(result.hits, '对照：被接受的 32 KB 信标必须真的到达接收端').toBeGreaterThanOrEqual(1);

  test.info().annotations.push({
    type: 'measurement',
    description:
      `真实 sendBeacon：80 KB accepted=${String(result.large.accepted)}；32 KB accepted=${String(result.medium.accepted)}（到达 ${result.hits} 次）；` +
      `LEAVE_BUDGET=${JSON.stringify(result.config.leaveBudget)}`,
  });
});

test('C07-AC-03 默认配置：页面离开冲刷 80 KB（验收项原文判定）', async () => {
  const { measured, slices } = await withContext(async (context) => {
    const page = await openProbe(context, 'real');
    return await measureLeave(page, {});
  });

  const problems = ac03Violations(measured, slices);
  test.info().annotations.push({
    type: 'measurement',
    description:
      `默认预算：原始批次 ${measured.eventCount} 事件 / 序列化 ${measured.wholeBatchJsonBytes} B` +
      `（估算 ${measured.eventsEstimateBytes} B，单事件估算 ${measured.oneEventEstimateBytes} B ≥ 实际 ${measured.oneEventActualBytes} B）；` +
      `接收端 ${slices.length} 片：${describeSlices(slices)}；` +
      `接收字节合计 ${slices.reduce((sum, item) => sum + item.bytes, 0)} B；` +
      `SDK 侧 leave.stats=${JSON.stringify(measured.leave)}（sent/skipped 为**事件数**）counters=${JSON.stringify(measured.counters)}；` +
      `AC-03 不合格项：${problems.length === 0 ? '无' : problems.join(' / ')}`,
  });

  // 先验载荷成立：原始批次必须超过单次信标上限（否则这条用例没意义）。
  expect(
    measured.wholeBatchJsonBytes,
    `载荷必须超过单次 sendBeacon 上限（实测 ${measured.wholeBatchJsonBytes} B）`,
  ).toBeGreaterThan(BEACON_BODY_LIMIT);
  // 实现自己的口径：估算值不小于实际序列化长度（`src/queue/size.ts` 头部说明）。
  expect(
    measured.oneEventEstimateBytes,
    '实现口径：单事件估算字节必须 ≥ 实际序列化字节',
  ).toBeGreaterThanOrEqual(measured.oneEventActualBytes);

  // 按 AC-03 原文判定（全部以软断言列出，便于一次看清所有不合格项）。
  // 本用例在 T29 之后首次执行；若为红，说明该验收项**不满足**（见报告追加节），不是用例写错。
  expect.soft(slices.length, 'AC-03：必须拆成至少两个信标请求').toBeGreaterThanOrEqual(2);
  for (const [index, slice] of slices.entries()) {
    expect.soft(slice.bytes, `AC-03：第 ${index + 1} 片不得超过 60 KB`).toBeLessThanOrEqual(BEACON_BODY_LIMIT);
    expect.soft(slice.contentType, `AC-03：第 ${index + 1} 片必须是 text/plain`).toContain('text/plain');
    expect.soft(slice.authWriteToken, `AC-03：第 ${index + 1} 片令牌必须在 auth 字段`).toBe('tok-ac03');
  }
  expect.soft(problems, 'AC-03 原文判定：不得有不合格项').toEqual([]);
});

test('C07-AC-03 SDK 侧切片形状：放宽离开预算后 `leave.requests` ≥ 2、无跳过（机制本身）', async () => {
  const { measured, slices } = await withContext(async (context) => {
    const page = await openProbe(context, VARIANT === 'mutant' ? 'mutant' : 'real');
    return await measureLeave(page, { budget: WIDE_BUDGET });
  });

  test.info().annotations.push({
    type: 'measurement',
    description:
      `预算放宽（leaveBudget=${JSON.stringify(WIDE_BUDGET)}）+ 变体 ${VARIANT}：` +
      `原始 ${measured.eventCount} 事件 / 序列化 ${measured.wholeBatchJsonBytes} B；` +
      `SDK 侧 leave.stats=${JSON.stringify(measured.leave)}（requests=信标尝试数、sent/skipped=事件数）` +
      ` counters=${JSON.stringify(measured.counters)}；接收端 ${slices.length} 片：${describeSlices(slices)}`,
  });

  expect(measured.wholeBatchJsonBytes, '载荷必须超过单次信标上限').toBeGreaterThan(BEACON_BODY_LIMIT);
  // 机制层：`sliceForBeacon` 必须真的把 80 KB 切成多片**尝试**发出，且预算没有参与淘汰。
  // （这一步只看 SDK 侧观测量：切片之后的送达由下一个用例判定。）
  expect(
    measured.leave.requests,
    `切片机制必须产出 ≥2 次信标尝试（实测 requests=${measured.leave.requests}，接收端 ${slices.length} 片）`,
  ).toBeGreaterThanOrEqual(2);
  expect(measured.leave.skipped, '预算放宽后不得有被预算跳过的切片').toBe(0);
  expect(measured.leave.sent, 'SDK 侧计数必须覆盖全部事件').toBe(measured.eventCount);
});

test('C07-AC-03 接收端送达：放宽预算后每片 ≤60 KB、顺序/无重复/无丢失（AC-03 原文判定）', async () => {
  const { measured, slices } = await withContext(async (context) => {
    const page = await openProbe(context, VARIANT === 'mutant' ? 'mutant' : 'real');
    return await measureLeave(page, { budget: WIDE_BUDGET });
  });

  const problems = ac03Violations(measured, slices);
  test.info().annotations.push({
    type: 'measurement',
    description:
      `预算放宽 + 变体 ${VARIANT}：接收端 ${slices.length} 片（${describeSlices(slices)}）；` +
      `接收字节合计 ${slices.reduce((sum, item) => sum + item.bytes, 0)} B / 原始事件序列 ${measured.eventCount} 条；` +
      `SDK 侧 leave.stats=${JSON.stringify(measured.leave)} counters=${JSON.stringify(measured.counters)}；` +
      `AC-03 不合格项：${problems.length === 0 ? '无' : problems.join(' / ')}`,
  });

  // AC-03 原文：≥2 片、每片 ≤60 KB、text/plain、令牌在 auth，且顺序/无重复/无丢失。
  expect(slices.length, `AC-03：接收端必须收到至少两个信标请求（实测 ${describeSlices(slices)}）`).toBeGreaterThanOrEqual(2);
  expect(problems, `AC-03 切片路径不合格项（实测 ${describeSlices(slices)}）`).toEqual([]);

  // AC-03 的「总字节与原始一致」：分片各自带 envelope/auth，故按**事件字节合计**核对。
  const receivedEventBytes = slices.reduce(
    (sum, slice) => sum + slice.ids.reduce((inner, id) => inner + id.length, 0),
    0,
  );
  expect(receivedEventBytes, '收到的 event_id 总字符数必须与原始一致（无重复/无丢失的独立复核）').toBe(
    measured.expectedIds.join('').length,
  );
});

test('C07-AC-03 根因对照：连续多次真实 sendBeacon 的浏览器额度（与实现无关）', async () => {
  const SEQUENCES = [
    [60 * 1024],
    [40 * 1024, 40 * 1024],
    [30 * 1024, 30 * 1024],
    [49 * 1024, 34 * 1024],
  ];
  const result = await withContext(async (context) => {
    const page = await openProbe(context, 'real');
    const observations = [];
    for (const sizes of SEQUENCES) {
      const before = receiver.requests.length;
      const accepted = await page.evaluate(
        (options) => globalThis.window.__ac03.rawBeaconSequence(options.url, options.sizes),
        { url: `${receiver.url}/beacon`, sizes },
      );
      await new Promise((resolve) => globalThis.setTimeout(resolve, 900));
      observations.push({
        sizes,
        accepted,
        arrived: receiver.requests.slice(before).map((item) => item.bytes),
      });
    }
    return observations;
  });

  test.info().annotations.push({
    type: 'measurement',
    description: result
      .map(
        (item) =>
          `[${item.sizes.map((value) => `${value / 1024}K`).join('+')}] → 返回值 ${JSON.stringify(item.accepted)}，` +
          `到达 ${JSON.stringify(item.arrived.map((value) => `${value}B`))}`,
      )
      .join('；'),
  });

  // 只做特性刻画（不伪装成 AC-03 判定）：每个序列的**第一次**信标必须被接受；
  // 其余按实测如实记录。AC-03 的判定在「接收端送达」用例里。
  for (const item of result) {
    expect(item.accepted[0], `序列 ${JSON.stringify(item.sizes)} 的第一次信标必须被接受`).toBe(true);
  }
});

test('C07-AC-03 变异自检：把切片阈值调大的变异体必须被同一判据判为不合格', async () => {
  const { measured, slices } = await withContext(async (context) => {
    const page = await openProbe(context, 'mutant');
    return await measureLeave(page, { budget: WIDE_BUDGET });
  });

  const problems = ac03Violations(measured, slices);
  test.info().annotations.push({
    type: 'measurement',
    description:
      `变异体（${MUTATION_FROM} → ${MUTATION_TO}）实测：接收端 ${slices.length} 片` +
      `（${describeSlices(slices)}）；counters=${JSON.stringify(measured.counters)}；` +
      `判据给出的不合格项：${problems.length === 0 ? '无（判别力失效！）' : problems.join(' / ')}`,
  });

  // 变异体只改切片阈值：必须被**同一套** AC-03 判据抓住（否则说明用例没有判别力）。
  expect(problems, '变异体（关掉切片）必须被 AC-03 判据判为不合格').not.toEqual([]);
});
