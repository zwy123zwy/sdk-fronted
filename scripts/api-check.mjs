// 公共 API 审计（指南第 6 节 pnpm api:check）
// 对每个 SDK 包运行 API Extractor，把公共 API 与 etc/<包名>.api.md 比对；不一致时失败。
// 有意变更 API 时运行 `pnpm api:update` 更新报告，并在合入请求中说明（指南第 8 节）。
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

const local = process.argv.includes('--local');
const root = resolve(import.meta.dirname, '..');
const baseConfig = join(root, 'scripts', 'api-extractor.base.json');
const packagesDir = join(root, 'packages');

let failed = false;
for (const name of readdirSync(packagesDir)) {
  const projectFolder = join(packagesDir, name);
  const packageJsonFullPath = join(projectFolder, 'package.json');
  if (!existsSync(packageJsonFullPath)) continue;
  if (!existsSync(join(projectFolder, 'dist', 'index.d.ts'))) {
    console.error(`[api:check] ${name}: 缺少 dist/index.d.ts，请先运行 pnpm build`);
    failed = true;
    continue;
  }

  mkdirSync(join(projectFolder, 'etc'), { recursive: true });
  const config = ExtractorConfig.prepare({
    configObject: {
      ...ExtractorConfig.loadFile(baseConfig),
      projectFolder,
    },
    configObjectFullPath: baseConfig,
    packageJsonFullPath,
  });

  const result = Extractor.invoke(config, { localBuild: local, showVerboseMessages: false });
  if (result.succeeded) {
    console.log(`[api:check] ${name}: ok`);
  } else {
    console.error(
      `[api:check] ${name}: 失败（错误 ${result.errorCount}，警告 ${result.warningCount}）` +
        (result.apiReportChanged ? '；公共 API 与 etc/ 中的报告不一致，有意变更时运行 pnpm api:update' : ''),
    );
    failed = true;
  }
}

process.exitCode = failed ? 1 : 0;
