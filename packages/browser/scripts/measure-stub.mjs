// C01-AC-08 加载桩体积实测（T12）。
//
// 加载桩是页面头部内联的极小脚本，任务卡要求「gzip 后不超过 1 KB」。
// 这个脚本用仓库自带的打包器（tsup，见根 package.json 的 devDependencies）把
// `src/loading-stub.ts` 打成与真实交付一致的压缩 IIFE，再分别报告：
//   - 原始 TypeScript 源码
//   - 类型擦除 + 去注释（未压缩）
//   - 压缩 IIFE（真实交付形态）
//
// 用法：node packages/browser/scripts/measure-stub.mjs
// 退出码：任一形态的 gzip 超过 1 KB 时非零，便于接进 CI。
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const sourcePath = join(packageRoot, 'src', 'loading-stub.ts');
const outDir = join(packageRoot, 'dist-stub');
const MINIFIED = join(outDir, 'loading-stub.iife.js');
const LIMIT_BYTES = 1024;

const gzipSize = (text) => gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).byteLength;
const rawSize = (text) => Buffer.byteLength(text, 'utf8');

const source = readFileSync(sourcePath, 'utf8');
/** 轻量整理：去掉空行与每行首尾空白（不触碰字符串内容，桩里没有跨行模板串）。 */
const lightMinify = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

const transpiled = execFileSync(
      'node',
      [
        '-e',
        [
          "const ts=require('typescript');const fs=require('fs');",
          `const src=fs.readFileSync(${JSON.stringify(sourcePath)},'utf8');`,
          "process.stdout.write(ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.None,removeComments:true},reportDiagnostics:false}).outputText);",
        ].join(''),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
);

const rows = [
  { form: '原始 TypeScript 源码（仅供参考）', text: source, check: false },
  { form: '类型擦除 + 去注释（未压缩，仅供参考）', text: transpiled, check: false },
  { form: '类型擦除 + 轻量整理（未压缩）', text: lightMinify(transpiled), check: true },
];

try {
  execFileSync('pnpm', ['exec', 'tsup', 'src/loading-stub.ts', '--format', 'iife', '--minify', '--out-dir', 'dist-stub', '--clean', '--target', 'es2020'], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  if (!existsSync(MINIFIED)) throw new Error(`打包产物不存在：${MINIFIED}`);
  rows.push({ form: '压缩 IIFE（真实交付形态）', text: readFileSync(MINIFIED, 'utf8'), check: true });
} finally {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
}

let failed = false;
for (const row of rows) {
  const raw = rawSize(row.text);
  const gzipped = gzipSize(row.text);
  const over = row.check && gzipped > LIMIT_BYTES;
  if (over) failed = true;
  const verdict = row.check ? (over ? 'FAIL' : 'ok  ') : 'info';
  console.log(`${verdict} ${row.form}：${raw} B，gzip ${gzipped} B（上限 ${LIMIT_BYTES} B）`);
}

process.exitCode = failed ? 1 : 0;
