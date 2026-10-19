#!/usr/bin/env node
/**
 * 规格线台账的机器校验（`docs/reports/spec-line-ledger.md`）。
 *
 * 要解决的问题：验收规格线可以长期「有文档、没人跑」，而组织结论（「移交 T20」）
 * 看起来像交付。本脚本只接受**可执行的落点**：文件 + vitest 用例名、pnpm 脚本名、
 * 或 Playwright 用例标题；并证明它在当前仓库里**真的被收集得到**。
 *
 * 判定（任一条不满足即非零退出）：
 *   1. 台账一行都解析不出来 ⇒ 红（空转守卫；绝不把「0 条」当全绿）。
 *   2. 台账覆盖的 ID 与 `tests/acceptance/` 现行文档的 ID 不一致（漏行/多行）⇒ 红。
 *   3. `verified` 行落点为空 ⇒ 红。
 *   4. 落点不可达：
 *      - `vitest:<path> :: <name>`：文件不在 `vitest list` 里（被删 / 改名 / 移出 project）
 *        或用例名不存在 ⇒ 红；文件里有 `.skip(` / `.only(` ⇒ 红。
 *      - `script:<package.json> :: <name>`：脚本名不存在、命令入口文件不存在、
 *        或 `进 gates` 列声称的 `pnpm <step>` 不在 `gates` 链里 ⇒ 红。
 *      - `e2e:<path> :: <title>`：文件不存在、标题不在源文件里、或文件不在
 *        `playwright.config.ts` 的 `testDir` 内 ⇒ 红。
 *   5. `来源（文件:行）` 不再指向该用例行 ⇒ 红（验收文档插行/改行也会被发现）。
 *   6. `pending` 行：
 *      - 默认（严格）⇒ 红，并逐条打印 pending 原文；
 *      - `--allow-pending` ⇒ 退出码放行，但**仍然逐条打印** pending 原文（门禁用）。
 *
 * 用法：
 *   node scripts/spec-line-check.mjs                 # 严格：pending 也红
 *   node scripts/spec-line-check.mjs --allow-pending # 门禁：pending 可见地放行
 *   node scripts/spec-line-check.mjs --ledger=<path> # 自检/反证时换一份台账（默认真实台账）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const DEFAULT_LEDGER = 'docs/reports/spec-line-ledger.md';
const STATUSES = new Set(['verified', 'pending', 'gap']);
const COLUMNS = ['ID', '来源', '类型', '原文', '验证落点', '进 pnpm gates', '状态', '备注'];

const args = process.argv.slice(2);
const allowPending = args.includes('--allow-pending');
const ledgerArg = args.find((arg) => arg.startsWith('--ledger='));
const ledgerPath = ledgerArg === undefined ? DEFAULT_LEDGER : ledgerArg.slice('--ledger='.length);

/** 收集失败项；任何一项都让退出码非零。 */
const failures = [];
const fail = (message) => {
  failures.push(message);
};

const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

/** 解析台账表格行；返回 { rows, malformed }。 */
function parseLedger(text) {
  const rows = [];
  const malformed = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length === 0) continue;
    if (/^[A-Z]\d{2}-AC-\d{2}$/u.test(cells[0])) {
      if (cells.length !== COLUMNS.length) {
        malformed.push(`第 ${String(index + 1)} 行有 ${String(cells.length)} 列（期望 ${String(COLUMNS.length)}）：${cells[0]}`);
        continue;
      }
      rows.push({
        line: index + 1,
        id: cells[0],
        source: cells[1],
        type: cells[2],
        original: cells[3],
        landing: cells[4],
        gate: cells[5],
        status: cells[6],
        note: cells[7],
      });
    }
  }
  return { rows, malformed };
}

/** 从现行验收文档重新抽取 ID 与行号，用于完整性对账（不只防 0 条）。 */
function collectAcceptanceRows() {
  const collected = [];
  const directory = 'tests/acceptance';
  const files = readdirSync(join(root, directory)).filter((name) => name.endsWith('.md')).sort();
  for (const name of files) {
    if (name === 'README.md') continue;
    const relativePath = `${directory}/${name}`;
    const lines = read(relativePath).split('\n');
    // 废弃文档在文件头写明「已废弃（D001…）」：它们不是验收依据，不进入完整性对账。
    if (lines.slice(0, 6).join('\n').includes('已废弃（D001')) continue;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (cells.length < 4) continue;
      if (!/^[A-Z]\d{2}-AC-\d{2}$/u.test(cells[0])) continue;
      collected.push({ id: cells[0], source: `${relativePath}:${String(index + 1)}`, expected: cells[3] });
    }
  }
  return collected;
}

/** 运行 vitest list；返回 { entries, error }。entries 的 name 已还原转义引号。 */
function listVitestTests() {
  try {
    const output = execFileSync('pnpm', ['exec', 'vitest', 'list', '--reporter=verbose'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const entries = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const stripped = line.replace(/^\[\w+\] /u, '').replaceAll('\\"', '"');
      const separator = stripped.indexOf(' > ');
      if (separator < 0) continue;
      entries.push({ path: stripped.slice(0, separator), name: stripped.slice(separator + 3) });
    }
    return { entries, error: null };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    return { entries: [], error: `vitest list 失败：${stderr || stdout || String(error)}` };
  }
}

/** 校验来源行仍以该 ID 开头。 */
function checkSource(row) {
  const match = /^(tests\/acceptance\/[A-Z]\d{2}\.md):(\d+)$/u.exec(row.source);
  if (match === null) {
    fail(`${row.id} 来源格式错误（期望 tests/acceptance/<模块>.md:<行号>）：${row.source}`);
    return;
  }
  const [, file, lineText] = match;
  if (!file.endsWith(`/${row.id.slice(0, 3)}.md`)) {
    fail(`${row.id} 来源文件与 ID 前缀不一致：${row.source}`);
    return;
  }
  const lineNumber = Number(lineText);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    fail(`${row.id} 来源行号非法：${row.source}`);
    return;
  }
  if (!existsSync(join(root, file))) {
    fail(`${row.id} 来源文件不存在：${file}`);
    return;
  }
  const lines = read(file).split('\n');
  const line = lines[lineNumber - 1];
  if (line === undefined) {
    fail(`${row.id} 来源行越界：${row.source}（文件只有 ${String(lines.length)} 行）`);
    return;
  }
  if (!line.trim().startsWith(`| ${row.id} |`)) {
    fail(`${row.id} 来源行 ${row.source} 已不再指向该用例（内容：${line.trim().slice(0, 80)}）`);
  }
}

/** 校验 `进 pnpm gates` 列声称的 pnpm 步骤确实在 gates 链里。 */
function checkGateClaim(row, packageJson) {
  const gate = row.gate;
  if (!(gate.startsWith('是') || gate.startsWith('部分'))) {
    if (gate.startsWith('否')) return;
    fail(`${row.id} 的「进 pnpm gates」列无法机器核对：${gate}`);
    return;
  }
  const steps = [...gate.matchAll(/pnpm\s+([A-Za-z0-9:_-]+)/gu)].map((match) => match[1]);
  if (steps.length === 0) {
    fail(`${row.id} 声称进 gates，但没有写出可核对的 \`pnpm <step>\`：${gate}`);
    return;
  }
  const gatesScript = packageJson.scripts?.gates;
  if (typeof gatesScript !== 'string') {
    fail('package.json 没有 gates 脚本');
    return;
  }
  for (const step of steps) {
    if (!(step in (packageJson.scripts ?? {}))) {
      fail(`${row.id} 声称的门禁步骤不存在：pnpm ${step}`);
    }
    if (!gatesScript.includes(`pnpm ${step}`)) {
      fail(`${row.id} 声称的门禁步骤不在 gates 链里：pnpm ${step}`);
    }
  }
}

/** 校验一个 vitest 落点：文件被 list 收集 + 用例名存在 + 文件不含 skip/only。 */
function checkVitestLanding(row, landing, vitest) {
  const match = /^vitest:(.+?) :: (.+)$/u.exec(landing);
  if (match === null) {
    fail(`${row.id} 的 vitest 落点格式错误：${landing}`);
    return;
  }
  const [, file, name] = match;
  if (!existsSync(join(root, file))) {
    fail(`${row.id} 的 vitest 文件不存在：${file}`);
    return;
  }
  const source = read(file);
  for (const forbidden of ['.skip(', '.only(']) {
    if (source.includes(forbidden)) {
      fail(`${row.id} 的落点文件含 ${forbidden}（不得跳过/独占）：${file}`);
    }
  }
  const inProject = vitest.entries.some((entry) => entry.path === file);
  if (!inProject) {
    fail(`${row.id} 的 vitest 文件未被任何 project 收集（不在 vitest list 里）：${file}`);
    return;
  }
  const hit = vitest.entries.some((entry) => entry.path === file && entry.name === name);
  if (!hit) {
    fail(`${row.id} 的 vitest 用例名不存在（被删/改名？）：${file} :: ${name}`);
  }
}

/** 校验一个 script 落点：脚本名存在 + 命令入口文件存在。 */
function checkScriptLanding(row, landing) {
  const match = /^script:(.+?) :: (.+)$/u.exec(landing);
  if (match === null) {
    fail(`${row.id} 的 script 落点格式错误：${landing}`);
    return;
  }
  const [, manifestPath, scriptName] = match;
  if (!existsSync(join(root, manifestPath))) {
    fail(`${row.id} 的脚本清单不存在：${manifestPath}`);
    return;
  }
  const manifest = readJson(manifestPath);
  const command = manifest.scripts?.[scriptName];
  if (typeof command !== 'string') {
    fail(`${row.id} 的 pnpm script 名不存在：${scriptName}（${manifestPath}）`);
    return;
  }
  const packageDir = dirname(join(root, manifestPath));
  const segments = command.split(/(?:&&|\|\|)/u).map((segment) => segment.trim()).filter(Boolean);
  let firstEntry = null;
  for (const segment of segments) {
    const nodeRun = /^(?:node|tsx|ts-node)\s+(?:--[^\s]+\s+)*([^\s]+)/u.exec(segment);
    if (nodeRun !== null) {
      firstEntry = firstEntry ?? nodeRun[1];
      const entry = resolve(packageDir, nodeRun[1]);
      if (!existsSync(entry)) {
        fail(`${row.id} 的脚本入口不存在：${nodeRun[1]}（来自 ${manifestPath} 的 ${scriptName}）`);
      }
      continue;
    }
    const tool = /^(tsc|tsup|vitest|eslint|size-limit)\b/u.exec(segment);
    if (tool !== null) {
      const localBin = join(packageDir, 'node_modules/.bin', tool[1]);
      const rootBin = join(root, 'node_modules/.bin', tool[1]);
      if (!existsSync(localBin) && !existsSync(rootBin)) {
        fail(`${row.id} 的脚本工具不存在：${tool[1]}（${manifestPath} 的 ${scriptName}）`);
      }
    }
  }
  // 传递性：包脚本若声称由 `pnpm build`（根链）执行，包的 build 必须真的调用同一个入口。
  if (manifestPath !== 'package.json' && row.gate.includes('pnpm build') && firstEntry !== null) {
    const buildScript = manifest.scripts?.build;
    if (typeof buildScript !== 'string') {
      fail(`${row.id} 声称经 pnpm build 执行，但 ${manifestPath} 没有 build 脚本`);
    } else if (!buildScript.includes(firstEntry)) {
      fail(`${row.id} 声称经 pnpm build 执行，但 ${manifestPath} 的 build 未调用 ${firstEntry}`);
    }
  }
}

/** 校验一个 e2e 落点：文件存在 + 标题字面量存在 + 文件在 playwright testDir 内。 */
function checkE2eLanding(row, landing, playwrightConfig) {
  const match = /^e2e:(.+?) :: (.+)$/u.exec(landing);
  if (match === null) {
    fail(`${row.id} 的 e2e 落点格式错误：${landing}`);
    return;
  }
  const [, file, title] = match;
  if (!existsSync(join(root, file))) {
    fail(`${row.id} 的 e2e 文件不存在：${file}`);
    return;
  }
  if (!read(file).includes(title)) {
    fail(`${row.id} 的 e2e 用例标题不存在（被删/改名？）：${file} :: ${title}`);
  }
  const testDirMatch = /testDir\s*:\s*['"]([^'"]+)['"]/u.exec(playwrightConfig);
  if (testDirMatch === null) {
    fail('无法从 playwright.config.ts 解析 testDir，e2e 落点不可判定');
    return;
  }
  const testDir = testDirMatch[1].replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!(file === testDir || file.startsWith(`${testDir}/`))) {
    fail(`${row.id} 的 e2e 文件不在 playwright testDir（${testDir}）内：${file}`);
  }
}

/** 校验一个 bench 落点：文件存在 + 匹配 bench 配置的 include + 名称字面量存在。 */
function checkBenchLanding(row, landing) {
  const match = /^bench:(.+?) :: (.+)$/u.exec(landing);
  if (match === null) {
    fail(`${row.id} 的 bench 落点格式错误：${landing}`);
    return;
  }
  const [, file, name] = match;
  if (!existsSync(join(root, file))) {
    fail(`${row.id} 的 bench 文件不存在：${file}`);
    return;
  }
  if (!file.startsWith('tests/bench/') || !file.endsWith('.bench.ts')) {
    fail(`${row.id} 的 bench 落点不在 tests/bench/**/*.bench.ts：${file}`);
    return;
  }
  if (!read(file).includes(name)) {
    fail(`${row.id} 的 bench 用例名不存在：${file} :: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

if (!existsSync(join(root, ledgerPath))) {
  console.error(`[spec-line-check] 台账不存在：${ledgerPath}`);
  process.exit(1);
}

const ledgerText = read(ledgerPath);
const { rows, malformed } = parseLedger(ledgerText);

// 空转守卫：解析出 0 条 ⇒ 必红。绝不把「0 条」当全绿。
if (rows.length === 0) {
  console.error('[spec-line-check] 空转守卫触发：台账解析出 0 条规格线。');
  console.error('[spec-line-check] 这通常意味着表头/表结构被改坏、解析器坏了，或台账被清空；不得当作通过。');
  if (malformed.length > 0) for (const item of malformed) console.error(`  - ${item}`);
  process.exit(1);
}
for (const item of malformed) fail(`台账行格式错误：${item}`);

// 完整性对账：台账的 ID 集合必须与现行验收文档一致（防「漏一条也算绿」）。
const acceptanceRows = collectAcceptanceRows();
const acceptanceById = new Map(acceptanceRows.map((row) => [row.id, row]));
const ledgerIds = new Set(rows.map((row) => row.id));
for (const id of ledgerIds) {
  if (!acceptanceById.has(id)) fail(`台账里有现行验收文档中不存在的 ID：${id}`);
}
for (const id of acceptanceById.keys()) {
  if (!ledgerIds.has(id)) fail(`现行验收文档的 ID 未进入台账：${id}`);
}
if (rows.length !== new Set(rows.map((row) => row.id)).size) {
  fail('台账存在重复 ID');
}

const packageJson = readJson('package.json');
const playwrightConfig = read('playwright.config.ts');
const vitest = listVitestTests();
if (vitest.error !== null) fail(vitest.error);

const pending = [];
for (const row of rows) {
  if (!STATUSES.has(row.status)) {
    fail(`${row.id} 的状态非法：${row.status}（只允许 verified / pending / gap）`);
    continue;
  }
  if (row.type !== '数值' && row.type !== '功能') {
    fail(`${row.id} 的类型非法：${row.type}（只允许 数值 / 功能）`);
  }
  checkSource(row);
  checkGateClaim(row, packageJson);

  const landings = row.landing === '—' || row.landing === '' ? [] : row.landing.split(' ;; ').map((item) => item.trim()).filter(Boolean);

  if (row.status === 'pending') {
    if (row.note === '' || row.note === '—') {
      fail(`${row.id} 标了 pending 但备注为空；pending 必须写明「为什么没有落点、等谁补」`);
    }
    pending.push(row);
    // pending 的落点若写了，也照样校验，避免「pending 成为坏落点的避风港」。
  } else if (landings.length === 0) {
    fail(`${row.id}（${row.status}）落点为空；无落点的规格线必须显式标 pending`);
    continue;
  }

  for (const landing of landings) {
    if (landing.startsWith('vitest:')) checkVitestLanding(row, landing, vitest);
    else if (landing.startsWith('script:')) checkScriptLanding(row, landing);
    else if (landing.startsWith('e2e:')) checkE2eLanding(row, landing, playwrightConfig);
    else if (landing.startsWith('bench:')) checkBenchLanding(row, landing);
    else fail(`${row.id} 的落点种类未知（只允许 vitest / script / e2e / bench）：${landing}`);
  }
}

const numeric = rows.filter((row) => row.type === '数值').length;
const verified = rows.filter((row) => row.status === 'verified').length;

console.log(`[spec-line-check] 台账：${ledgerPath}`);
console.log(`[spec-line-check] 规格线 ${String(rows.length)} 条（数值 ${String(numeric)} / 功能 ${String(rows.length - numeric)}）；verified ${String(verified)}；pending ${String(pending.length)}；gap ${String(rows.filter((row) => row.status === 'gap').length)}`);

for (const row of pending) {
  console.log(`[pending] ${row.id}（${row.source}）：${row.note}`);
}
if (pending.length > 0) {
  console.log(`[spec-line-check] pending：${String(pending.length)} 条，已逐条列出（ID：${pending.map((row) => row.id).join(', ')}）。`);
}

if (!allowPending && pending.length > 0) {
  fail(`严格模式：存在 ${String(pending.length)} 条 pending（无落点）。要进 gates 必须显式加 --allow-pending，且 pending 仍会逐条打印。`);
}
if (allowPending && pending.length > 0) {
  console.log('[spec-line-check] --allow-pending 生效：pending 不计入退出码，但上面已逐条列出（不静默）。');
}

if (failures.length > 0) {
  console.error('');
  console.error(`[spec-line-check] 红：${String(failures.length)} 项失败`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log('[spec-line-check] 绿：所有非 pending 规格线的落点都可达；pending 已显式列账。');
process.exit(0);
