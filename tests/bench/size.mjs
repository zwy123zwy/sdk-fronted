/**
 * T20 体积基准（gzip / brotli）。
 *
 * 测量对象（T20.md 验收用例）：
 * - **加载桩**（`packages/browser/src/loading-stub.ts`）：用仓库自带的 tsup（esbuild）打成与真实
 *   交付一致的压缩 IIFE，再量 gzip —— 契约目标 **≤ 1 KB**（T12 任务卡）；
 * - **各包已构建产物**（`packages/*\/dist/index.js`）：core / transport / plugins / browser 的
 *   ESM 入口，量 gzip 与 brotli。
 *
 * 口径与边界（必须如实标注）：
 * 1. 本脚本**不重建任何包**（禁止全仓 build）。它读**磁盘上已有的** `dist/`，因此会同时报
 *    「产物是否比源码旧」（staleness），旧产物上的数字只能当参考；
 * 2. `size-limit` 的 `import: "*"` 会先做一次 esbuild 打包再压；本脚本直接压 `dist/index.js`
 *    文件本身。这几个包**零第三方运行时依赖**，两者差距很小，但**不完全等同门禁读数**；
 * 3. 契约目标值的口径变化：T12 任务卡写「核心包 gzip ≤ 10 KB」，但 2026-10-13 经负责人批准，
 *    `.size-limit.json` 的现行预算已被提到 core 21 KB / browser 13 KB / transport 18 KB /
 *    plugins 20 KB。本脚本**以现行已批准预算判定**，同时把 T12 的原始目标一并报出。
 *
 * 用法：`node tests/bench/size.mjs`
 * 输出：`tests/bench/results/size.json`（与 vitest 基准同一行格式，供 collect.mjs 合并）
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const resultsDir = join(here, 'results');
const tmpDir = join(here, '.tmp', 'stub');

const gzipSize = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).byteLength;
const brotliSize = (text) => brotliCompressSync(Buffer.from(text, 'utf8')).byteLength;
const bytes = (text) => Buffer.byteLength(text, 'utf8');

/** 现行已批准预算（`.size-limit.json`，2026-10-13 批准；本脚本只读该文件，不修改）。 */
const sizeLimit = JSON.parse(readFileSync(join(repoRoot, '.size-limit.json'), 'utf8'));
const limitByName = new Map();
for (const entry of sizeLimit) {
  const key = String(entry.path);
  limitByName.set(key, { limit: entry.limit, name: entry.name });
}

const rows = [];

/** 记录一行（与 tests/bench/lib/report.ts 的 BenchRow 同形）。 */
function record(row) {
  rows.push(row);
  const target = row.target;
  const verdict = target === undefined ? '仅记录' : row.value <= target ? '达标' : '不达标';
  const margin = target === undefined || row.value <= 0 ? '—' : `余量 ${(target / row.value).toFixed(2)}×`;
  console.log(
    `[size] ${row.metric}：${row.value} B，契约 ${row.target_text ?? '无'}，${margin} → ${verdict}` +
      (row.note === undefined ? '' : `（${row.note}）`),
  );
}

/** `13 KB` / `1.5 KB` / `1536 B` → 字节数。 */
function parseLimit(text) {
  const match = /^([\d.]+)\s*(KB|kB|B)$/u.exec(String(text).trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  return match[2] === 'B' ? value : Math.round(value * 1024);
}

/** 最新源码修改时间（用于判断 dist 是否过期）。 */
function newestMtime(dir, extensions) {
  let newest = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      newest = Math.max(newest, newestMtime(path, extensions));
      continue;
    }
    if (!extensions.some((extension) => name.name.endsWith(extension))) continue;
    newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/* ---------------------------------------------------------------- 1. 加载桩 */

const stubSource = join(repoRoot, 'packages', 'browser', 'src', 'loading-stub.ts');
if (!existsSync(stubSource)) {
  console.error(`FAIL 找不到加载桩源码：${stubSource}`);
  process.exitCode = 1;
} else {
  /** tsup 从仓库根运行时输出 `loading-stub.global.js`（iife 的默认后缀）。 */
  const stubOut = join(tmpDir, 'loading-stub.global.js');
  const stubOutAlt = join(tmpDir, 'loading-stub.iife.js');
  try {
    mkdirSync(tmpDir, { recursive: true });
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsup',
        'packages/browser/src/loading-stub.ts',
        '--format',
        'iife',
        '--minify',
        '--out-dir',
        'tests/bench/.tmp/stub',
        '--clean',
        '--target',
        'es2020',
      ],
      { cwd: repoRoot, stdio: 'pipe' },
    );
    const builtPath = existsSync(stubOut) ? stubOut : existsSync(stubOutAlt) ? stubOutAlt : null;
    if (builtPath === null) throw new Error(`打包产物不存在：${stubOut}`);
    const minified = readFileSync(builtPath, 'utf8');
    record({
      metric: '加载桩 gzip（压缩 IIFE，真实交付形态）',
      value: gzipSize(minified),
      target: 1024,
      target_text: '≤ 1 KB（T12 任务卡）',
      source: 'docs/tasks/T12.md 非功能目标',
      note: `原始 ${bytes(minified)} B；brotli ${brotliSize(minified)} B`,
    });
    const light = readFileSync(stubSource, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
    record({
      metric: '加载桩 gzip（未压缩源码整理版，参考）',
      value: gzipSize(light),
      note: '未压缩形态，仅作参考',
    });
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- 2. 各包产物 */

/**
 * 复现 `size-limit` 的 `import: "*"` 口径：用 esbuild（经 tsup）对入口做一次
 * **打包 + minify**，再 gzip。直接压未压缩的 `dist/index.js` 会得到完全不同量级的数字，
 * 与 `.size-limit.json` 的预算无法比较——第一版本脚本正是这么错的。
 */
function bundledGzip(entry, outDir) {
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'pnpm',
    ['exec', 'tsup', entry, '--format', 'esm', '--minify', '--out-dir', outDir, '--clean', '--target', 'es2020'],
    { cwd: repoRoot, stdio: 'pipe' },
  );
  const produced = readdirSync(outDir).filter((name) => name.endsWith('.js'));
  if (produced.length === 0) throw new Error(`打包 ${entry} 没有产出 js：${outDir}`);
  const text = readFileSync(join(outDir, produced[0]), 'utf8');
  const result = { text, bytes: bytes(text), gzip: gzipSize(text), brotli: brotliSize(text) };
  rmSync(outDir, { recursive: true, force: true });
  return result;
}

const bundleRoot = join(here, '.tmp', 'bundle');

for (const entry of sizeLimit) {
  const absolute = join(repoRoot, entry.path);
  if (!existsSync(absolute)) {
    console.log(`[size] 跳过 ${entry.path}：产物不存在（本脚本不重建包）`);
    continue;
  }
  const naive = readFileSync(absolute, 'utf8');
  const bundled = bundledGzip(entry.path, join(bundleRoot, String(entry.path).replace(/[^a-zA-Z0-9]+/gu, '_')));
  const target = parseLimit(entry.limit);
  const packageDir = String(entry.path).split('/').slice(0, 2).join('/');
  const stale = newestMtime(join(repoRoot, packageDir, 'src'), ['.ts']) > statSync(absolute).mtimeMs;
  record({
    metric: `size-limit 口径 gzip（打包+minify）：${entry.path}`,
    value: bundled.gzip,
    ...(target === undefined ? {} : { target }),
    target_text: `${entry.limit}（.size-limit.json 现行预算）`,
    source: '.size-limit.json（2026-10-13 批准）',
    note:
      `打包后 ${bundled.bytes} B；brotli ${bundled.brotli} B；` +
      `未打包的 dist 文件 gzip=${gzipSize(naive)} B（不同口径）；本包产物比源码旧=${String(stale)}` +
      (packageDir === 'packages/browser'
        ? '；⚠ browser 入口正被 T18 装配根改造，该行仅供参考、不据此判定' : ''),
  });
}

// `<script>` 全量 IIFE 不是 size-limit 的测量对象，按交付形态直接量
const iifePath = join(repoRoot, 'packages', 'browser', 'dist', 'web-report-sdk.iife.js');
if (existsSync(iifePath)) {
  const text = readFileSync(iifePath, 'utf8');
  record({
    metric: '<script> 全量 IIFE gzip（packages/browser/dist/web-report-sdk.iife.js）',
    value: gzipSize(text),
    source: 'docs/guides（<script> 引入产物）',
    note: `原始 ${bytes(text)} B；brotli ${brotliSize(text)} B；无独立契约目标，仅记录`,
  });
}

mkdirSync(resultsDir, { recursive: true });
const runId = process.env.BENCH_RUN_ID ?? `run-${new Date().toISOString()}`;
const payload = {
  bench: 'size',
  run_id: runId,
  generated_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpus: (await import('node:os')).cpus().length,
  rows,
};
writeFileSync(join(resultsDir, 'size.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`[size] 已写入 tests/bench/results/size.json（${rows.length} 行）`);
