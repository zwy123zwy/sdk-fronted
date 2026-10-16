#!/usr/bin/env node
/**
 * T37 终验材料包自证脚本（只读、无依赖、零外部包）。
 *
 * 做四件事：
 *  1. 解析 `README.md` 的维度明细表，抽出「状态」列与「证据」列里的相对链接；
 *  2. 把每个链接解析到仓库真实路径，断言**目标存在**（文件或目录）。`已完成` 的行必须全部通过；
 *  3. 从明细**现算**第 2 节总览的数字（条目数 / 三个状态各几条），与手写的总览表比对；
 *  4. **反证（判别性自证）**：预置 3 条「指向不存在路径」的假条目，它们必须被同一套核对逻辑报错；
 *     并对每条假条目先做**基线对照**（该路径确实不存在）。任何一条反证没被抓到 → 非 0 退出。
 *
 * 该脚本本身就是本材料包"证据路径已逐条核实"这一声明的**可复跑判据**：
 * 把上面 2 里的存在性判断去掉，第 4 步必然失败（反证抓不到）——所以它不能是空转。
 *
 * 用法：node docs/acceptance-package/verify-links.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const README = resolve(HERE, 'README.md');

const STATUS_DONE = '已完成';
const STATUS_PILOT = '待试点数据';
const STATUS_SIGN = '待签字';
const STATUSES = [STATUS_DONE, STATUS_PILOT, STATUS_SIGN];

/** 维度小节标题：`### 3.1 契约`。 */
const DIMENSION_HEADING = /^###\s+\d+\.\d+\s+(.+?)\s*$/;
/** 总览表行：`| 1 | 契约 | 12 | 9 | 3 | 0 |`（第 2 节）。 */
const OVERVIEW_ROW = /^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/;
/** 明细表行：`| 条目 | `状态` | 证据 | 结论 |`。 */
const DETAIL_ROW = /^\|\s*(.+?)\s*\|\s*`?(已完成|待试点数据|待签字)`?\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/;
/** markdown 链接。 */
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * 第 4 节按状态点名的条目清单：三行以 `N. **`状态`（K 条）**：<ID、ID…>` 开头。
 * 脚本会把点名的 ID 与明细表的实际状态**反向比对**——点名与表格不一致即判失败。
 */
const NAMED_LIST = /^\d+\.\s+\*\*`(已完成|待试点数据|待签字)`（(\d+)\s*条）[^*]*\*\*：(.+)$/;
const ID_TOKEN = /\b[KPRSCAL]-\d{2}\b/g;
/** 汇总表的表头与合计行，不能被当成维度明细。 */
const SUMMARY_ROW = /^\|\s*(维度|合计|\*\*合计\*\*)\s*\|/;

/**
 * 反证用例：evidence 必须指向**不存在**的路径（基线对照），且必须被 checkEvidence 报错。
 * 三条覆盖三种形态：普通文件、CR 目录下的 markdown、真实目录下的不存在文件。
 */
const NEGATIVE_CASES = [
  {
    name: 'N1 指向不存在的报告文件',
    dimension: '契约',
    status: STATUS_DONE,
    evidence: '[不存在的报告](../../docs/reports/this-report-does-not-exist.md)',
    conclusion: '反证用例（不写进 README，只在本脚本里跑）。',
  },
  {
    name: 'N2 指向不存在的契约变更记录',
    dimension: '契约',
    status: STATUS_DONE,
    evidence: '[不存在的 CR](../../docs/contracts/changes/CR-999-not-a-real-cr.md)',
    conclusion: '反证用例（不写进 README，只在本脚本里跑）。',
  },
  {
    name: 'N3 真实目录下的不存在文件',
    dimension: '契约',
    status: STATUS_DONE,
    evidence: '[存在的目录、不存在的文件](../../docs/reports/handover.md.nope)',
    conclusion: '反证用例（不写进 README，只在本脚本里跑）。',
  },
];

let failures = 0;

function fail(msg) {
  failures += 1;
  process.stderr.write(`FAIL ${msg}\n`);
}

function note(msg) {
  process.stdout.write(`ok   ${msg}\n`);
}

function localLinks(evidence) {
  const out = [];
  LINK.lastIndex = 0;
  let m = LINK.exec(evidence);
  while (m !== null) {
    const target = m[2];
    if (!/^(https?:|mailto:|#)/.test(target)) {
      out.push({ label: m[1], target });
    }
    m = LINK.exec(evidence);
  }
  return out;
}

/** 链接目标 -> 仓库内绝对路径（去掉 #Lnn 锚点）。 */
function targetPath(target) {
  const noAnchor = target.split('#')[0];
  return isAbsolute(noAnchor) ? noAnchor : resolve(HERE, noAnchor);
}

/** 核对一条证据：返回 { links, bad }；bad = 指向不存在路径的链接。 */
function checkEvidence(evidence) {
  const links = localLinks(evidence);
  const bad = [];
  for (const link of links) {
    const abs = targetPath(link.target);
    // 存在性核对：文件或目录都可以（本包的证据既有文件也有目录）。
    if (!existsSync(abs)) {
      bad.push({ ...link, abs: relative(REPO, abs) });
    }
  }
  return { links, bad };
}

const text = readFileSync(README, 'utf8');

// ---- 解析 ----
const overview = [];
const details = [];
let currentDimension = null;
let section = null;

for (const line of text.split('\n')) {
  if (/^##\s+2\./.test(line)) {
    section = 'overview';
    currentDimension = null;
    continue;
  }
  if (/^##\s+3\./.test(line)) {
    section = 'detail';
    currentDimension = null;
    continue;
  }
  const heading = DIMENSION_HEADING.exec(line);
  if (heading !== null) {
    currentDimension = heading[1];
    continue;
  }
  if (section === 'overview') {
    const row = OVERVIEW_ROW.exec(line);
    if (row !== null) {
      overview.push({
        name: row[2],
        total: Number(row[3]),
        counts: { [STATUS_DONE]: Number(row[4]), [STATUS_PILOT]: Number(row[5]), [STATUS_SIGN]: Number(row[6]) },
      });
    }
    continue;
  }
  if (section === 'detail') {
    if (SUMMARY_ROW.test(line)) {
      continue;
    }
    const row = DETAIL_ROW.exec(line);
    if (row !== null && currentDimension !== null) {
      details.push({
        dimension: currentDimension,
        name: row[1],
        status: row[2],
        evidence: row[3],
        conclusion: row[4],
      });
    }
  }
}

if (details.length === 0) {
  fail('README 里没有解析到任何维度明细行——核对会变成空转，直接判失败');
}
if (overview.length === 0) {
  fail('README 里没有解析到第 2 节总览行——数字比对无法进行');
}

// ---- 1/2. 逐条核对证据链接 ----
let linkTotal = 0;
let missingTotal = 0;
for (const row of details) {
  const { links, bad } = checkEvidence(row.evidence);
  linkTotal += links.length;
  if (links.length === 0) {
    fail(`明细「${row.name}」（${row.dimension}）证据列没有任何本地链接——证据必须是可点击路径`);
  }
  for (const b of bad) {
    missingTotal += 1;
    fail(`证据不存在：${b.abs}（条目「${row.name}」，状态 ${row.status}）`);
  }
  if (row.status === STATUS_DONE && bad.length > 0) {
    fail(`「${row.name}」标为 ${STATUS_DONE} 但证据缺文件——状态与证据不符`);
  }
}

// ---- 3. 现算总览并与手写表比对 ----
const computed = new Map();
for (const row of details) {
  const entry = computed.get(row.dimension) ??
    { total: 0, counts: { [STATUS_DONE]: 0, [STATUS_PILOT]: 0, [STATUS_SIGN]: 0 } };
  entry.total += 1;
  entry.counts[row.status] += 1;
  computed.set(row.dimension, entry);
}

const normalize = (s) => s.replace(/[（(].*$/, '').trim();
const overviewByKey = new Map(overview.map((o) => [normalize(o.name), o]));

for (const [dimension, entry] of computed) {
  const o = overviewByKey.get(normalize(dimension));
  if (o === undefined) {
    fail(`维度「${dimension}」有 ${entry.total} 条明细，但第 2 节总览里没有对应行`);
    continue;
  }
  if (o.total !== entry.total) {
    fail(`维度「${dimension}」总览写 ${o.total} 条，明细实为 ${entry.total} 条`);
  }
  for (const status of STATUSES) {
    if (o.counts[status] !== entry.counts[status]) {
      fail(`维度「${dimension}」状态「${status}」总览写 ${o.counts[status]}，明细实为 ${entry.counts[status]}`);
    }
  }
}
for (const o of overview) {
  if (![...computed.keys()].some((d) => normalize(d) === normalize(o.name))) {
    fail(`第 2 节总览的「${o.name}」在明细里没有对应小节`);
  }
}

// ---- 3b. 第 4 节点名清单与明细状态的反向比对 ----
const actualById = new Map();
for (const row of details) {
  const id = (row.name.match(/^[KPRSCAL]-\d{2}/) ?? [])[0];
  if (id === undefined) {
    fail(`明细条目「${row.name}」没有可识别的编号（应为 K-/P-/R-/S-/C-/A-/L- + 两位数字）`);
    continue;
  }
  if (actualById.has(id)) {
    fail(`明细表里编号 ${id} 出现了多次`);
  }
  actualById.set(id, row.status);
}

let namedTotal = 0;
let namedStatuses = 0;
for (const line of text.split('\n')) {
  const named = NAMED_LIST.exec(line);
  if (named === null) {
    continue;
  }
  namedStatuses += 1;
  const status = named[1];
  const declaredCount = Number(named[2]);
  const ids = named[3].match(ID_TOKEN) ?? [];
  namedTotal += ids.length;
  if (ids.length !== declaredCount) {
    fail(`第 4 节「${status}」点名 ${ids.length} 个 ID，但括号里写的是 ${declaredCount} 条`);
  }
  const inTable = details.filter((r) => r.status === status).length;
  if (inTable !== declaredCount) {
    fail(`第 4 节「${status}」写 ${declaredCount} 条，明细表实为 ${inTable} 条`);
  }
  for (const id of ids) {
    const actual = actualById.get(id);
    if (actual === undefined) {
      fail(`第 4 节点名的 ${id} 在明细表里不存在`);
    } else if (actual !== status) {
      fail(`第 4 节点名 ${id} 为「${status}」，而明细表里它是「${actual}」`);
    }
  }
}
if (namedStatuses !== STATUSES.length) {
  fail(`第 4 节只点名了 ${namedStatuses}/${STATUSES.length} 个状态——有点名清单缺失`);
}
const idTotal = [...computed.values()].reduce((a, e) => a + e.total, 0);
if (namedTotal !== idTotal) {
  fail(`第 4 节共点名 ${namedTotal} 个 ID，明细表共 ${idTotal} 条`);
}

// ---- 4. 反证 ----
let negativesCaught = 0;
for (const c of NEGATIVE_CASES) {
  const baselineBad = checkEvidence(c.evidence).bad.length > 0;
  if (!baselineBad) {
    fail(`反证基线不成立：${c.name} 的路径竟然存在——请换一个确实不存在的路径`);
    continue;
  }
  const { links, bad } = checkEvidence(c.evidence);
  if (links.length === 0) {
    fail(`反证 ${c.name} 没解析出链接——反证本身失效`);
    continue;
  }
  if (bad.length > 0) {
    negativesCaught += 1;
    note(`反证被抓到：${c.name} → ${bad.map((b) => b.abs).join(', ')}`);
  } else {
    fail(`反证**没有**被抓到：${c.name}——存在性核对是空转`);
  }
}
if (negativesCaught !== NEGATIVE_CASES.length) {
  fail(`反证只抓到 ${negativesCaught}/${NEGATIVE_CASES.length}`);
}

// ---- 汇总 ----
process.stdout.write('\n');
process.stdout.write(`维度数：${computed.size}；明细条目：${details.length}；本地证据链接：${linkTotal}\n`);
for (const [dimension, entry] of computed) {
  const c = entry.counts;
  process.stdout.write(
    `  ${dimension}：共 ${entry.total}（已完成 ${c[STATUS_DONE]} / 待试点数据 ${c[STATUS_PILOT]} / 待签字 ${c[STATUS_SIGN]}）\n`,
  );
}
process.stdout.write(`指向不存在路径的证据：${missingTotal}\n`);
process.stdout.write(`反证：${negativesCaught}/${NEGATIVE_CASES.length} 被抓到\n`);
process.stdout.write(failures === 0
  ? '\n结果：PASS（全部证据路径存在、总览与明细一致、3 条反证全部被抓到）\n'
  : `\n结果：FAIL（${failures} 条，见上面 FAIL 行）\n`);

if (failures > 0) {
  process.exitCode = 1;
}
