/**
 * node-import 示例的**构建产物验证**（#1，2026-10-15）。
 *
 * 为什么需要它：本示例的 `build` 此前是 `node -e "process.exit(0)"`——**空脚本**。
 * 而 `pnpm examples:build` 是门禁步骤（`package.json` 的 `gates` 与 `.github/workflows/ci.yml`
 * 的 gates job 都跑它），所以"examples 全部构建通过"这句话对本示例**什么都没证明**：
 * 产物不存在、指向 `src`、甚至包根本没被构建，它都返回 0。
 *
 * 本示例的产物形态是**包导入**（不是 bundle）：接入方写
 * `import { createAssembly } from '@web-report-sdk/browser'`，由 Node 按
 * `packages/browser/package.json` 的 `exports` 条件解析到 **dist 产物**
 * （`vitest.config.mjs` 的注释同义：不使用 `source` 条件）。因此这里的"构建验证"
 * 就是**接入方真正会踩的那条路**：
 *
 *   1. 用 `import.meta.resolve()` 按真实条件解析入口（**不写死路径**）；
 *   2. 入口必须在 `dist/` 下、存在且非空——挡住"解析回 `src/*.ts`"与"产物没构建"；
 *   3. **真的加载它**（裸包名 `import`）并断言导出面：`SDK_VERSION` 与包清单一致、
 *      `createAssembly` 是函数。
 *
 * 行为级验证（真跑 `createAssembly → init → track → flush`，并要求批次通过
 * `batch.schema.json` 的 Ajv 校验）属于 `test`，由 `vitest.test.ts` / `jest.test.mjs`
 * 复用 `runAssemblyMinimalPath` 完成——**本节不重造**，只回答"产物在不在、能不能加载"。
 *
 * 不在这里重跑 `packages/browser` 的构建：`gates` / CI 都在本步骤之前先跑 `pnpm build`，
 * 重跑只会把"产物缺失"变成"我刚把它建出来"（检查会失去判别力）。产物缺失时本脚本
 * 直接 exit 1 并提示先跑 `pnpm build`。
 *
 * 判别性证明（实测）：把 `packages/browser/dist/index.js` 移走后运行本脚本 →
 * `entryExists=false` → **exit 1**；恢复后 exit 0。
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expectedSdkVersion } from '../../webpack/scripts/lib/verify-bundle.mjs';

const entryUrl = import.meta.resolve('@web-report-sdk/browser');
const entryPath = fileURLToPath(entryUrl);
const expectedVersion = expectedSdkVersion();

const checks = {
  // 反空转：解析出来的必须是**构建产物**，而不是 `src` 里的 TypeScript 源。
  entryIsDistArtifact: /\/dist\//u.test(entryPath),
  entryExists: false,
  entryNonEmpty: false,
  sdkVersionIsString: false,
  sdkVersionMatchesPackage: false,
  createAssemblyIsFunction: false,
};

const stats = statSync(entryPath, { throwIfNoEntry: false });
checks.entryExists = stats !== undefined && stats.isFile();
checks.entryNonEmpty = checks.entryExists && stats.size > 0;

let sdk;
let loadError = null;
if (checks.entryNonEmpty) {
  try {
    // 用**裸包名**导入（不是 file URL）：这正是接入方写的那一行。
    sdk = await import('@web-report-sdk/browser');
  } catch (error) {
    loadError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}
checks.sdkVersionIsString = typeof sdk?.SDK_VERSION === 'string' && sdk.SDK_VERSION.length > 0;
checks.sdkVersionMatchesPackage = sdk?.SDK_VERSION === expectedVersion;
checks.createAssemblyIsFunction = typeof sdk?.createAssembly === 'function';

const result = {
  task: 'example-node-import',
  form: 'package-import',
  entryPath,
  expectedSdkVersion: expectedVersion,
  loadError,
  checks,
  status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
};
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'pass') {
  console.error(
    'node-import 示例构建验证失败：入口必须是 packages/browser 的 dist 产物、存在、可加载，' +
      '且导出 SDK_VERSION（与包清单一致）与 createAssembly；产物缺失时先运行 pnpm build',
  );
  process.exitCode = 1;
}
