// 版本号一致性门禁（来源：T35 发布检查表 §3.3 / 本轮发布阻塞点 ④）。
//
// 为什么单设一条门禁：`pnpm api:check` 只比公共导出面，**不比版本号**——实测把
// `packages/core/package.json` 的 `version` 改成 `9.9.9` 后 `api:check` 仍 exit 0。
// 而"发出去的 SDK 自报版本与包清单不同"是难查的发布事故，因此在 `gates` 里单独拦一道。
//
// 比对的是**四处**版本声明，任何一处与包清单版本不一致即失败：
//   ① 包清单：`packages/{core,browser,transport,plugins}/package.json` 的 `version`（四者必须相同）
//   ② 源码常量：`packages/core/src/version.ts` 的 `SDK_VERSION`（唯一常量源，browser 经 core re-export）
//   ③ 构建产物：`packages/{core,browser}/dist` 里**真实求值**出来的 `SDK_VERSION`
//      （必须 `pnpm build` 之后跑；产物缺失/过期即失败，不做跳过）
//   ④ 文档与 CHANGELOG：写死版本号的声明处（CHANGELOG 顶部条目、`docs/guides/**` 的 4 处字面量）
//
// 用法：
//   node scripts/version-check.mjs              # 一致性检查（工作区发布前也应通过）
//   node scripts/version-check.mjs --release    # 另加发布态判据：版本不得为 0.0.0、不得 private: true
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const MANIFEST_PACKAGES = ['core', 'browser', 'transport', 'plugins'];
/** 内嵌 `SDK_VERSION` 的构建产物（其余包的产物不含版本号）。 */
const ARTIFACTS = ['core', 'browser'];
/** 写死版本号的文档声明处：必须是**唯一命中**的一行，改文案会导致本门禁红（刻意如此）。 */
const DOC_CLAIMS = [
  { file: 'docs/guides/api-reference.md', pattern: /\|\s*`SDK_VERSION`\s*\|\s*`"(\d+\.\d+\.\d+)"`\s*\|/u, label: 'api-reference.md 的 SDK_VERSION 常量表' },
  { file: 'docs/guides/integration.md', pattern: /console\.log\(SDK_VERSION\);\s*\/\/ 期望：'(\d+\.\d+\.\d+)'/u, label: 'integration.md 的自检期望输出' },
  { file: 'docs/guides/README.md', pattern: /全部包 `version: (\d+\.\d+\.\d+)`/u, label: 'README.md 的包可安装性一节' },
  { file: 'docs/guides/tools.md', pattern: /WebReportSDK\.SDK_VERSION = (\d+\.\d+\.\d+)/u, label: 'tools.md 的 examples:test 期望输出' },
];

const failures = [];
const fail = (message) => {
  failures.push(message);
};
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));

// ① 包清单：四者必须一致，取 core 作为基准。
const manifests = MANIFEST_PACKAGES.map((name) => ({
  name,
  json: readJson(`packages/${name}/package.json`),
}));
const reference = manifests[0]?.json.version;
if (typeof reference !== 'string' || reference === '') {
  fail('packages/core/package.json 缺少 version');
}
for (const { name, json } of manifests) {
  if (json.version !== reference) {
    fail(`packages/${name}/package.json: ${String(json.version)} != ${String(reference)}`);
  }
}

// ② 源码常量：`SDK_VERSION` 是唯一常量源。
const versionSource = read('packages/core/src/version.ts');
const constantMatch = versionSource.match(/SDK_VERSION\s*=\s*'([^']+)'/u);
if (constantMatch === null) {
  fail('packages/core/src/version.ts: 未找到 SDK_VERSION 常量（门禁判据需同步更新）');
} else if (constantMatch[1] !== reference) {
  fail(`packages/core/src/version.ts SDK_VERSION: ${constantMatch[1]} != ${String(reference)}`);
}

// ③ 构建产物：真实求值 dist 的导出（不是 grep 字面量，避免被脱敏样例里的 `0.0.0.0` 蒙混）。
for (const name of ARTIFACTS) {
  const entry = join(root, `packages/${name}/dist/index.js`);
  if (!existsSync(entry)) {
    fail(`packages/${name}/dist/index.js 不存在：请先运行 \`pnpm build\`（本门禁不做跳过）`);
    continue;
  }
  const loaded = await import(pathToFileURL(entry).href);
  if (loaded.SDK_VERSION !== reference) {
    fail(`packages/${name}/dist/index.js SDK_VERSION: ${String(loaded.SDK_VERSION)} != ${String(reference)}（产物过期，重新 build）`);
  }
}

// ④ CHANGELOG 顶部条目 + 文档写死处。
const changelogMatch = read('CHANGELOG.md').match(/^## \[([^\]]+)\]/mu);
if (changelogMatch === null) {
  fail('CHANGELOG.md: 未找到 `## [x.y.z]` 版本条目');
} else if (changelogMatch[1] !== reference) {
  fail(`CHANGELOG.md 顶部条目: ${changelogMatch[1]} != ${String(reference)}`);
}
for (const claim of DOC_CLAIMS) {
  const matches = [...read(claim.file).matchAll(new RegExp(claim.pattern, 'gu'))];
  if (matches.length !== 1) {
    fail(`${claim.file}: ${claim.label} 命中 ${String(matches.length)} 处（期望恰好 1 处）——文案改动后需同步本门禁`);
    continue;
  }
  const found = matches[0]?.[1];
  if (found !== reference) {
    fail(`${claim.file}: ${claim.label} 写的是 ${String(found)} != ${String(reference)}`);
  }
}

// `--release`：发布态附加判据（来源 T35 §3.3 判据 ④）。
if (process.argv.includes('--release')) {
  if (reference === '0.0.0') {
    fail('发布态：版本号仍是 0.0.0（占位/未发布版本），不能用它发布');
  }
  for (const { name, json } of manifests) {
    if (json.private === true) fail(`发布态：packages/${name}/package.json 仍是 private: true`);
  }
}

if (failures.length > 0) {
  console.error('版本号不一致:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`版本号一致: ${String(reference)}`);
  console.log(`  包清单 ×${String(manifests.length)} / SDK_VERSION 常量 / 产物 ×${String(ARTIFACTS.length)} / CHANGELOG / 文档 ×${String(DOC_CLAIMS.length)}`);
}
