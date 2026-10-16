/**
 * 跳过审计的 **run 级汇总**：把 `test-results/skip-audit/*.json`（每次 `afterAll` 调用一份）
 * 相加，给出"本次 e2e 运行里，每个 spec × 每个浏览器到底跑了几条、跳了几条"的**唯一**
 * 权威数字，并在"该浏览器上一条都没跑"时判红。
 *
 * 为什么需要单独一步：Playwright 在**每个失败用例之后会重启 worker 进程**，`afterAll` 因此
 * 按 worker 生命周期被调用多次（见 `skip-audit.mjs` 顶部）。单份记账只看得见它那一小段，
 * 只有相加之后才能回答"整轮里 C07-AC-03 在 Firefox 上跑了几条"。
 *
 * 跑法：`node tests/e2e/lib/skip-audit-summary.mjs [报告目录] [--allow-partial]`
 *   - 默认：只要某个 (spec, 浏览器) 的 `executed + skipped < declared`（有声明过的用例
 *     既没跑也没登记跳过）就**判红** —— 这正是"到处都不跑、整轮仍绿"的形态；
 *   - `--allow-partial`：把"少跑几条"降级为告警，只用于 `--grep` 聚焦跑（此时少跑是预期的）。
 *     该 flag 必须显式给，不给就是严格判定。
 * 退出码：0 = 无不通过项；1 = 有。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPORT_DIR = path.resolve(HERE, '..', '..', '..', 'test-results', 'skip-audit');

/**
 * 纯函数：把若干份报告相加。`reports` 是解析后的 JSON 数组（也可以是别的 spec 的运行）。
 * @returns {{ groups: object[], problems: string[], warnings: string[] }}
 */
export function summarizeReports(reports, { allowPartial = false } = {}) {
  const groups = new Map();
  if (reports.length === 0) {
    return { groups: [], problems: ['没有任何 skip-audit 报告：e2e 一轮都没跑，跳过情况无从断言'], warnings: [] };
  }
  for (const report of reports) {
    const spec = String(report.spec ?? '(未知 spec)');
    const declared = Number(report.declaredTests ?? 0);
    for (const [browserName, entry] of Object.entries(report.browsers ?? {})) {
      const key = `${spec}::${browserName}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { spec, browserName, declared, executed: 0, skipped: 0, unregistered: 0, invocations: 0, probes: [] };
        groups.set(key, group);
      }
      group.declared = Math.max(group.declared, declared);
      group.executed += (entry.executed ?? []).length;
      group.skipped += (entry.skipped ?? []).length;
      group.unregistered += (entry.unregisteredSkips ?? []).length;
      group.invocations += 1;
      if (entry.probe != null) {
        group.probes.push({ ready: entry.probe.ready, reason: entry.probe.reason, stage: entry.probe.stage });
      }
    }
  }

  const problems = [];
  const warnings = [];
  const list = [...groups.values()].sort((left, right) =>
    `${left.spec}${left.browserName}`.localeCompare(`${right.spec}${right.browserName}`),
  );

  for (const group of list) {
    const tag = `${group.spec} [${group.browserName}]`;
    // 未登记跳过也算"观察到了"（它确实被跳过了，只是没有正当理由）——否则同一件事会
    // 同时报"未登记跳过"和"少跑几条"两条问题，读者会以为是两个缺陷。
    const observed = group.executed + group.skipped + group.unregistered;
    if (group.unregistered > 0) {
      problems.push(`${tag}：run 级共 ${group.unregistered} 条跳过没有经过环境探测登记（写死的 .skip）`);
    }
    if (group.executed === 0 && group.skipped > 0) {
      const reason = group.probes.find((probe) => probe.ready === false)?.reason ?? '未记录原因';
      problems.push(
        `${tag}：run 级 executed=0 / skipped=${group.skipped} —— 该浏览器上本 spec **一条都没跑**。` +
          `这不是用例失败，是环境阻塞：${reason}。补测：换一台能起 ${group.browserName} 的机器` +
          `（或 PW_${group.browserName.toUpperCase()}_EXE=/path/to/binary）后重跑` +
          ` \`pnpm test:e2e --project=${group.browserName}\`；本轮不得被读成通过`,
      );
    }
    if (observed > group.declared) {
      problems.push(`${tag}：run 级 observed=${observed} > declared=${group.declared}（记账重复或 declaredTests 过期）`);
    }
    if (observed < group.declared && group.executed > 0) {
      const text =
        `${tag}：run 级 declared=${group.declared}，只观察到 ${observed} 条（executed=${group.executed}、` +
        `skipped=${group.skipped}）—— 有声明过的用例既没跑也没登记跳过`;
      if (allowPartial) warnings.push(`${text}（--allow-partial：按 --grep 聚焦跑解释，不判红）`);
      else problems.push(`${text}；若这是 --grep 聚焦跑，请显式加 --allow-partial`);
    }
  }

  return { groups: list, problems, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const allowPartial = args.includes('--allow-partial');
  const dir = args.find((item) => !item.startsWith('--')) ?? DEFAULT_REPORT_DIR;

  if (!fs.existsSync(dir)) {
    console.error(`[skip-audit-summary] 找不到报告目录：${dir}（e2e 没跑过？test-results 被清掉了？）`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    console.error(`[skip-audit-summary] ${dir} 里没有任何报告：e2e 一轮都没跑，跳过情况无从断言`);
    process.exit(1);
  }
  const reports = files.map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  const { groups, problems, warnings } = summarizeReports(reports, { allowPartial });

  console.log(`[skip-audit-summary] 报告 ${files.length} 份（${dir}）`);
  for (const group of groups) {
    console.log(
      `[skip-audit-summary] spec=${group.spec} browser=${group.browserName} declared=${group.declared} ` +
        `executed=${group.executed} skipped=${group.skipped} unregistered=${group.unregistered} ` +
        `invocations=${group.invocations} probeReady=${JSON.stringify(group.probes.map((probe) => probe.ready))}`,
    );
  }
  for (const warning of warnings) console.warn(`⚠ [skip-audit-summary] ${warning}`);
  if (problems.length > 0) {
    console.error(
      `[skip-audit-summary] run 级跳过可见性判据不通过（${problems.length} 条）——\n` +
        problems.map((item) => `  - ${item}`).join('\n'),
    );
    process.exit(1);
  }
  console.log('[skip-audit-summary] run 级：无未登记跳过、无"该浏览器上一条都没跑"');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
