// C05-AC-18 第三方 APM 双写适配器体积与产物实测（T19）。
//
// 任务卡要求「适配器 gzip 后不超过 1.5 KB」，以及「构建产物不包含任何第三方包的代码」。
// 这个脚本用仓库自带的打包器（tsup，见根 package.json 的 devDependencies）把
// `src/apm-dual-write/index.ts`（适配器的公共入口，与 plugins 包的交付形态一致：
// ESM + minify + ES2020）打成独立产物，再：
//   1. 扫描适配器源码：所有模块说明符必须是相对路径（不 import 任何第三方包）；
//   2. 扫描打包产物：不得出现裸模块说明符或 require()；
//   3. 度量 gzip（level 9）与 brotli，gzip 超过 1536 B（1.5 KB）时返回非零退出码。
//
// 用法：node packages/plugins/scripts/measure-apm-adapter.mjs
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const sourceDir = join(packageRoot, 'src', 'apm-dual-write');
const outDir = join(packageRoot, 'dist-apm-adapter');
const LIMIT_BYTES = 1536; // 1.5 KB

const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const gzipSize = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).byteLength;
const brotliSize = (text) => brotliCompressSync(Buffer.from(text, 'utf8')).byteLength;

let failed = false;

/** 1. 源码：不得 import 任何第三方包（裸模块说明符）。 */
const sourceFiles = readdirSync(sourceDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
const bareImportsInSource = [];
for (const name of sourceFiles) {
  const source = readFileSync(join(sourceDir, name), 'utf8');
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) bareImportsInSource.push(`${name}: ${specifier}`);
  }
}
if (sourceFiles.length === 0) {
  console.error('FAIL 没有找到适配器源码文件');
  failed = true;
}
if (bareImportsInSource.length > 0) {
  console.error(`FAIL 适配器源码 import 了第三方包：${bareImportsInSource.join('、')}`);
  failed = true;
}

/** 2. 打包与产物检查。 */
function buildBundle() {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsup',
      'src/apm-dual-write/index.ts',
      '--format',
      'esm',
      '--minify',
      '--out-dir',
      'dist-apm-adapter',
      '--clean',
      '--target',
      'es2020',
    ],
    { cwd: packageRoot, stdio: 'pipe' },
  );
  try {
    const bundles = existsSync(outDir)
      ? readdirSync(outDir).filter((name) => name.endsWith('.js'))
      : [];
    if (bundles.length !== 1) {
      throw new Error(`期望 1 个 .js 产物，实际 ${bundles.length} 个：${bundles.join('、')}`);
    }
    return readFileSync(join(outDir, bundles[0]), 'utf8');
  } finally {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  }
}

const code = buildBundle();

const bareImportsInBundle = /\bfrom\s*["'](?![./])/.test(code) || /\bimport\s*["'](?![./])/.test(code);
const requireCalls = /\brequire\s*\(/.test(code);
if (bareImportsInBundle || requireCalls) {
  console.error('FAIL 打包产物里出现第三方包引用（裸模块说明符或 require）');
  failed = true;
}

/** 3. 体积。 */
const raw = byteLength(code);
const gzipped = gzipSize(code);
const brotli = brotliSize(code);
const over = gzipped > LIMIT_BYTES;
if (over) failed = true;

if (!failed) {
  console.log(`第三方包检查：ok（源码 ${sourceFiles.length} 个文件、产物均无裸模块说明符）`);
}
console.log(
  `apm-dual-write 压缩 ESM（与交付形态一致）：raw ${raw} B，gzip ${gzipped} B，brotli ${brotli} B`,
);
console.log(`gzip ${gzipped} B <= ${LIMIT_BYTES} B：${over ? 'FAIL' : 'ok'}`);

process.exitCode = failed ? 1 : 0;
