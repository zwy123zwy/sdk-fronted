/**
 * 跳过审计（"跳过不可能静默"）。
 *
 * 为什么需要它：`leave-slice.spec.mjs` 的 C07-AC-03 用例在浏览器**起不来**时按设计跳过
 * （环境事实，不是引擎名单）。但"跳过"如果只是少跑几条、整轮仍然绿，那它和"写死的跳过"
 * 在**信号上**没有区别 —— `docs/reports/t33-access-blockers.md` 记的正是这个形态
 * （"在 CI 上照样跳过、整轮仍绿"）。本模块把跳过变成一等、可见、可断言的输出：
 *
 *   1. **唯一入口**：每条被跳过的用例都必须经 `skipUnavailableBrowser()` 登记，并带上
 *      真实原因（启动探测的真实报错）。旁路跳过（在 spec 里直接写 `.skip`）由 `afterEach`
 *      抓到并**判红**；`.skip` 本身在 `.mjs` 用例里也被 eslint 拦（见 `eslint.config.js`）。
 *   2. **汇总**：每次 `afterAll` 都输出一行机器可读的汇总（`declared` / `observed` /
 *      `executed` / `skipped` / `probeReady` / `worker` / `report`），并落一份 JSON。
 *   3. **本 spec 在该浏览器上一条都没跑就判红**（理由见 `auditVerdicts()` 注释）。
 *
 * ⚠ 计数范围（实测教训，必须知道）：记账是**按 worker 生命周期**的，不是按整轮的。
 *   Playwright 在**每个失败的用例之后会丢弃整个 worker 进程、为后续用例起一个全新的 worker**，
 *   而本模块的状态是进程内的 —— 所以同一个 spec 文件在一次运行里会产生多份互不相干的记账
 *   （实测：`leave-slice.spec.mjs --project=chromium` 6 条用例 3 红 ⇒ 4 份记账，observed 2/1/1/2）。
 *   因此本模块**不**在 `afterAll` 里做 run 级判定，只判"本次观察到的这些用例"；
 *   run 级数字由 `node tests/e2e/lib/skip-audit-summary.mjs` 把
 *   `test-results/skip-audit/*.json` 相加后给出。两个命令合起来才是完整的"跳过不可静默"。
 *
 * 判定逻辑（`auditVerdicts()`）是不依赖浏览器的纯函数，判据本身另有一份确定性自检：
 * `node tests/e2e/lib/skip-audit-selftest.mjs`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
/** 报告目录（`test-results/` 在 .gitignore 面内，不会污染工作区）。 */
export const REPORT_DIR = path.join(REPO_ROOT, 'test-results', 'skip-audit');

/** 一条记账里"观察到"的用例数（执行 + 已登记跳过 + 未登记跳过）。 */
export function observedCount(entry) {
  return entry.executed.length + entry.environmentSkips.length + entry.unregisteredSkips.length;
}

/**
 * 纯判据：给定**一次** `afterAll` 调用（= 一个 worker 生命周期）观察到的记账，
 * 返回必须让本轮变红的 `problems`。
 *
 * 为什么"该浏览器上一条都没跑"必须**显式失败**而不是只告警：
 *   本模块要消灭的缺陷原话是"8 个用例在 Firefox 上到处都不跑，而整轮仍绿"。只打一行告警
 *   仍然会留下一个**绿色的整轮**，而这正是"把未运行的检查读成通过"的形态（指南第 6 节）。
 *   逐条 `test.skip` 仍然保留（环境起不来是事实，不该伪装成 6 条用例失败）；`afterAll` 再补一记
 *   **明确标注"这是环境阻塞、不是用例失败"**的失败，让"该浏览器上一条都没跑"不可能是绿的。
 *   判据只看**本次观察到的**用例，因此与 worker 切分/重启无关。
 */
export function auditVerdicts({ specName, declaredTests, perBrowser }) {
  const problems = [];
  const browsers = Object.entries(perBrowser);
  if (browsers.length === 0) {
    problems.push(`${specName}：没有任何浏览器维度的记账（beforeEach/afterEach 没跑？用例都被声明级跳过？）`);
    return { problems };
  }

  for (const [browserName, entry] of browsers) {
    const observed = observedCount(entry);
    const tag = `${specName} [${browserName}]`;

    if (entry.unregisteredSkips.length > 0) {
      problems.push(
        `${tag}：${entry.unregisteredSkips.length} 条用例被判为跳过，但没有经过环境探测登记：` +
          `${entry.unregisteredSkips.map((item) => `「${item.title}」`).join('、')}` +
          '；跳过只能由 `skipUnavailableBrowser()`（运行时启动探测）产生并带真实原因',
      );
    }

    if (observed === 0) {
      problems.push(
        `${tag}：一条用例都没有执行、也没有登记任何跳过。声明级/写死的跳过会让整轮仍然绿，故判红` +
          '（若这是 `--grep` 把本文件全部用例过滤掉了，请显式指定要跑的用例）',
      );
      continue;
    }

    if (observed > declaredTests) {
      problems.push(
        `${tag}：本次观察到 ${observed} 条 > 声明的 ${declaredTests} 条 —— 用例增删后没有同步 ` +
          '`declaredTests`，本 spec 的跳过记账已不可信',
      );
    }

    if (entry.probe !== null && entry.probe.ready === true && entry.environmentSkips.length > 0) {
      problems.push(
        `${tag}：启动探测说该浏览器**可以跑**，但仍有 ${entry.environmentSkips.length} 条被登记为环境跳过 —— 判据自相矛盾`,
      );
    }

    if (entry.executed.length === 0 && entry.environmentSkips.length > 0) {
      problems.push(
        `${tag}：本次观察到的 ${entry.environmentSkips.length} 条**全部被跳过、执行 0 条** —— ` +
          `该浏览器在本机起不来，这批用例一条都没跑。这不是用例失败，是环境阻塞：` +
          `${entry.probe?.reason ?? '未记录原因'}。` +
          `补测：换一台能起 ${browserName} 的机器（或 PW_${browserName.toUpperCase()}_EXE=/path/to/binary）` +
          `后重跑 \`pnpm test:e2e --project=${browserName}\`；本轮**不得**被读成通过`,
      );
    }
  }

  return { problems };
}

function slug(text) {
  return text.replaceAll(/[^A-Za-z0-9._-]/g, '-');
}

let reportSeq = 0;

/**
 * 落一份机器可断言的 JSON。**每一次 afterAll 调用一份**：文件名带 `pid`（worker 进程在每个
 * 失败用例后会被 Playwright 重启，`pid` 才是真正唯一的），所以多份记账不会互相覆盖，
 * run 级汇总（`skip-audit-summary.mjs`）可以把它们相加。
 */
export function writeSkipReport({ specName, declaredTests, perBrowser, problems }) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  reportSeq += 1;
  const worker = process.env['TEST_WORKER_INDEX'] ?? 'x';
  const browserNames = Object.keys(perBrowser).sort();
  const file = path.join(
    REPORT_DIR,
    `${slug(specName)}.${slug(browserNames.join('+'))}.w${slug(worker)}.p${String(process.pid)}.${reportSeq}.json`,
  );
  const payload = {
    spec: specName,
    declaredTests,
    worker,
    pid: process.pid,
    seq: reportSeq,
    at: new Date().toISOString(),
    problems,
    browsers: Object.fromEntries(
      Object.entries(perBrowser).map(([browserName, entry]) => [
        browserName,
        {
          probe: entry.probe,
          declared: declaredTests,
          observed: observedCount(entry),
          executed: entry.executed.map((item) => item.title),
          skipped: entry.environmentSkips,
          unregisteredSkips: entry.unregisteredSkips,
        },
      ]),
    ),
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 建一份 spec 级的跳过记账。
 * @param {{ specName: string, declaredTests: number }} options `declaredTests` 是本 spec 声明的
 *   用例条数（钉住的常量）：它是**完整性**判据的上界，并写进 JSON 供 run 级汇总对齐。
 */
export function createSkipAudit({ specName, declaredTests }) {
  const perBrowser = new Map();

  function entryFor(browserName) {
    let entry = perBrowser.get(browserName);
    if (entry === undefined) {
      entry = { probe: null, executed: [], environmentSkips: [], unregisteredSkips: [] };
      perBrowser.set(browserName, entry);
    }
    return entry;
  }

  function snapshot() {
    return Object.fromEntries(
      [...perBrowser].map(([browserName, entry]) => [
        browserName,
        {
          probe: entry.probe,
          executed: [...entry.executed],
          environmentSkips: [...entry.environmentSkips],
          unregisteredSkips: [...entry.unregisteredSkips],
        },
      ]),
    );
  }

  return {
    /** 记下启动探测的结果（可用/不可用都要记 —— 汇总、JSON、"判据自相矛盾"检查都要它）。 */
    noteProbe(browserName, probe) {
      entryFor(browserName).probe = probe;
    },

    /**
     * **唯一**的跳过入口，由运行时探测结果驱动。
     *
     * 第一个参数必须是运行时值（`!probe.ready`）而不是字面量：`eslint.config.js` 对本文件
     * 只放行这一种形状，`test.skip(true, …)` 这种写死的跳过在本文件里同样会被 lint 拦下。
     * @returns {boolean} 是否跳过了（`test.skip` 在运行中的用例里会抛错，故正常不返回）
     */
    skipUnavailableBrowser(browserName, testInfo, probe, note) {
      const entry = entryFor(browserName);
      entry.probe = probe;
      if (probe.ready) return false;
      entry.environmentSkips.push({ title: testInfo.title, stage: probe.stage, reason: probe.reason });
      // imperative 的 reason 在 list reporter 里不打印（实测），annotation 进 HTML 报告，
      // 再补一行 stdout，保证命令行上"为什么跳过"一眼可见。
      testInfo.annotations.push({ type: 'skipped-browser', description: note });
      console.log(`⚠ [skip-audit] 跳过 [${browserName}] ${testInfo.title}：${note}`);
      test.skip(!probe.ready, note);
      return true;
    },

    /** 装上守卫：`afterEach` 抓旁路跳过，`afterAll` 汇总 + 落盘 + 判红。 */
    install() {
      test.afterEach(({ browserName }, testInfo) => {
        const entry = entryFor(browserName);
        if (testInfo.status === 'skipped') {
          const registered = entry.environmentSkips.some((item) => item.title === testInfo.title);
          if (!registered) {
            entry.unregisteredSkips.push({ title: testInfo.title, status: 'skipped' });
            throw new Error(
              `[skip-audit] ${specName} [${browserName}]：用例「${testInfo.title}」被跳过了，` +
                '但它没有经过环境探测登记 —— 这条跳过是旁路来的（写死的 .skip？）。' +
                '跳过只能由 `skipUnavailableBrowser()`（运行时启动探测 + 真实原因）产生。',
            );
          }
          return;
        }
        entry.executed.push({ title: testInfo.title, status: testInfo.status });
      });

      test.afterAll(() => {
        const recorded = snapshot();
        const { problems } = auditVerdicts({ specName, declaredTests, perBrowser: recorded });
        const report = writeSkipReport({ specName, declaredTests, perBrowser: recorded, problems });

        for (const [browserName, entry] of Object.entries(recorded)) {
          const probeState = entry.probe === null ? 'unknown' : String(entry.probe.ready);
          console.log(
            `[skip-audit] spec=${specName} browser=${browserName} worker=${process.env['TEST_WORKER_INDEX'] ?? 'x'} ` +
              `pid=${String(process.pid)} declared=${declaredTests} observed=${observedCount(entry)} ` +
              `executed=${entry.executed.length} skipped=${entry.environmentSkips.length} ` +
              `unregistered=${entry.unregisteredSkips.length} probeReady=${probeState} report=${report}`,
          );
          if (entry.probe !== null && entry.probe.ready === false) {
            console.log(`[skip-audit]   ${browserName} 起不来，真实原因：${entry.probe.reason}`);
          }
        }
        console.log(
          '[skip-audit] 以上是**本次 afterAll 调用**（= 一个 worker 生命周期）的记账；' +
            'run 级数字跑 `node tests/e2e/lib/skip-audit-summary.mjs`',
        );
        if (problems.length > 0) {
          throw new Error(
            `[skip-audit] ${specName}：跳过可见性判据不通过（${problems.length} 条）——\n` +
              problems.map((item) => `  - ${item}`).join('\n'),
          );
        }
      });
    },
  };
}
