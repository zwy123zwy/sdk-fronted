/**
 * `skip-audit.mjs` / `skip-audit-summary.mjs` 判据的**确定性自检**
 * （不需要浏览器、不需要 Playwright runner）。
 *
 * 为什么要有它：本任务的判别性要求是"故意让某条用例被跳过 / 故意写死跳过 → 新增的可见性
 * 必须报警/红"。浏览器侧的实测（`--project=firefox` 全跳过）依赖本机能不能起浏览器，
 * 不可长期复现；这里把两组判据的输入做成夹具，**红/绿两侧都钉住**：
 *   - 绿侧（负对照）：正常跑完、以及 worker 重启造成的"一段只观察到 2 条"，都必须**零** problems，
 *     否则判据就是"永远在报警"的假检查；
 *   - 红侧：旁路跳过、声明级全跳过、探测说能跑却跳了、记账超声明、run 级"一条都没跑"、
 *     run 级"少跑几条"，都必须被点名。
 *
 * 跑法：`node tests/e2e/lib/skip-audit-selftest.mjs`（exit 0 = 全过）。
 */
import { auditVerdicts } from './skip-audit.mjs';
import { summarizeReports } from './skip-audit-summary.mjs';

const SPEC = 'fixture.spec.mjs';
const DECLARED = 6;

const probeUp = { browserName: 'chromium', ready: true, stage: 'launch', reason: '' };
const probeDown = { browserName: 'firefox', ready: false, stage: 'launch', reason: 'Juggler handshake timed out' };

/** 造一份记账：`executed` 条执行 + `skipped` 条已登记跳过 + `unregistered` 条旁路跳过。 */
function entry({ executed = 0, skipped = 0, unregistered = 0, probe = probeUp } = {}) {
  return {
    probe,
    executed: Array.from({ length: executed }, (_, index) => ({ title: `run-${index}`, status: 'passed' })),
    environmentSkips: Array.from({ length: skipped }, (_, index) => ({
      title: `skip-${index}`,
      stage: 'launch',
      reason: probe.reason,
    })),
    unregisteredSkips: Array.from({ length: unregistered }, (_, index) => ({
      title: `bypass-${index}`,
      status: 'skipped',
    })),
  };
}

const VERDICT_CASES = [
  {
    name: '绿侧/负对照：6 条全部执行（正常通过的一轮）',
    perBrowser: { chromium: entry({ executed: 6 }) },
    expectProblems: 0,
  },
  {
    name: '绿侧/负对照：worker 重启后的一段只观察到 2 条（不得误判）',
    perBrowser: { chromium: entry({ executed: 2 }) },
    expectProblems: 0,
  },
  {
    name: '红侧：该浏览器上全被跳过（本机 Firefox 的真实形态）',
    perBrowser: { firefox: entry({ skipped: 6, probe: probeDown }) },
    expectProblems: 1,
    expectProblemText: '全部被跳过、执行 0 条',
  },
  {
    name: '红侧：声明级写死的跳过（一条都没观察到，也没有登记）',
    perBrowser: { chromium: entry({ executed: 0, skipped: 0 }) },
    expectProblems: 1,
    expectProblemText: '一条用例都没有执行',
  },
  {
    name: '红侧：局部旁路跳过（5 跑 + 1 条未经登记的跳过）',
    perBrowser: { chromium: entry({ executed: 5, unregistered: 1 }) },
    expectProblems: 1,
    expectProblemText: '没有经过环境探测登记',
  },
  {
    name: '红侧：探测说能跑、却仍登记了跳过（判据自相矛盾）',
    perBrowser: { chromium: entry({ executed: 5, skipped: 1, probe: probeUp }) },
    expectProblems: 1,
    expectProblemText: '判据自相矛盾',
  },
  {
    name: '红侧：观察到 7 条 > 声明 6 条（用例增删没同步记账）',
    perBrowser: { chromium: entry({ executed: 7 }) },
    expectProblems: 1,
    expectProblemText: '本 spec 的跳过记账已不可信',
  },
  {
    name: '红侧：两个浏览器各一种问题（必须逐浏览器分别点名）',
    perBrowser: {
      chromium: entry({ executed: 5, unregistered: 1 }),
      firefox: entry({ skipped: 6, probe: probeDown }),
    },
    expectProblems: 2,
  },
];

/** 造一份 run 级报告（= 一次 `writeSkipReport()` 的产物形状）。 */
function report({ executed = 0, skipped = 0, unregistered = 0, probe = probeUp, declared = DECLARED } = {}) {
  return {
    spec: SPEC,
    declaredTests: declared,
    browsers: {
      [probe.browserName]: {
        probe,
        declared,
        observed: executed + skipped + unregistered,
        executed: Array.from({ length: executed }, (_, index) => `run-${index}`),
        skipped: Array.from({ length: skipped }, (_, index) => ({ title: `skip-${index}`, reason: probe.reason })),
        unregisteredSkips: Array.from({ length: unregistered }, (_, index) => ({ title: `bypass-${index}` })),
      },
    },
  };
}

const SUMMARY_CASES = [
  {
    name: '绿侧/负对照：3 红导致 4 个 worker 生命周期，相加仍是 6 跑 0 跳',
    reports: [report({ executed: 2 }), report({ executed: 1 }), report({ executed: 1 }), report({ executed: 2 })],
    expectProblems: 0,
    expectExecuted: 6,
  },
  {
    name: '红侧：run 级该浏览器上一条都没跑（Firefox 全跳过）',
    reports: [report({ skipped: 6, probe: probeDown })],
    expectProblems: 1,
    expectProblemText: '一条都没跑',
  },
  {
    name: '红侧：run 级有 3 条既没跑也没登记跳过（严格口径）',
    reports: [report({ executed: 3 })],
    expectProblems: 1,
    expectProblemText: '既没跑也没登记跳过',
  },
  {
    name: '绿侧/负对照：--grep 聚焦跑 + --allow-partial 才允许少跑',
    reports: [report({ executed: 3 })],
    allowPartial: true,
    expectProblems: 0,
    expectWarnings: 1,
  },
  {
    name: '红侧：run 级有未登记跳过',
    reports: [report({ executed: 5, unregistered: 1 })],
    expectProblems: 1,
    expectProblemText: '没有经过环境探测登记',
  },
  {
    name: '红侧：报告为 0 份（e2e 没跑，跳过情况无从断言）',
    reports: [],
    expectProblems: 1,
    expectProblemText: '没有任何 skip-audit 报告',
  },
];

let passed = 0;
const failures = [];

function check(name, problems, issues) {
  if (issues.length === 0) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(`${name}\n      - ${issues.join('\n      - ')}`);
    console.log(`FAIL  ${name}`);
  }
}

for (const testCase of VERDICT_CASES) {
  const { problems } = auditVerdicts({ specName: SPEC, declaredTests: DECLARED, perBrowser: testCase.perBrowser });
  const issues = [];
  if (problems.length !== testCase.expectProblems) {
    issues.push(`problems 期望 ${testCase.expectProblems} 条，实得 ${problems.length} 条：${problems.join(' / ')}`);
  }
  if (testCase.expectProblemText !== undefined && !problems.some((item) => item.includes(testCase.expectProblemText))) {
    issues.push(`problems 里没有出现期望的点名文本 ${JSON.stringify(testCase.expectProblemText)}`);
  }
  check(`[单次记账] ${testCase.name}`, problems, issues);
}

for (const testCase of SUMMARY_CASES) {
  const { groups, problems, warnings } = summarizeReports(testCase.reports, { allowPartial: testCase.allowPartial === true });
  const issues = [];
  if (problems.length !== testCase.expectProblems) {
    issues.push(`problems 期望 ${testCase.expectProblems} 条，实得 ${problems.length} 条：${problems.join(' / ')}`);
  }
  if (testCase.expectProblemText !== undefined && !problems.some((item) => item.includes(testCase.expectProblemText))) {
    issues.push(`problems 里没有出现期望的点名文本 ${JSON.stringify(testCase.expectProblemText)}`);
  }
  if (testCase.expectWarnings !== undefined && warnings.length !== testCase.expectWarnings) {
    issues.push(`warnings 期望 ${testCase.expectWarnings} 条，实得 ${warnings.length} 条：${warnings.join(' / ')}`);
  }
  if (testCase.expectExecuted !== undefined) {
    const total = groups.reduce((sum, group) => sum + group.executed, 0);
    if (total !== testCase.expectExecuted) issues.push(`run 级 executed 期望 ${testCase.expectExecuted}，实得 ${total}`);
  }
  check(`[run 级汇总] ${testCase.name}`, problems, issues);
}

console.log(`\nskip-audit 判据自检：${passed}/${VERDICT_CASES.length + SUMMARY_CASES.length} 通过`);
if (failures.length > 0) {
  console.error(`\n未通过：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
