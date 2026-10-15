// 门禁自检（T08 验收）：确认每个门禁都能拦住对应的违规样例。
// 每个用例临时写入一个违规文件（`file`）、追加一段（`patch`）或就地替换一处（`replace`），
// 运行对应门禁，断言失败后恢复原状。
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (cmd) => {
  try {
    execSync(cmd, { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

const cases = [
  {
    name: 'lint 拦截 any',
    file: 'packages/core/src/__gate_any.ts',
    content: 'export const leak = (value: any): any => value;\n',
    gate: 'pnpm lint',
  },
  {
    name: 'lint 拦截 eslint-disable',
    file: 'packages/core/src/__gate_disable.ts',
    content: '// eslint-disable-next-line\nexport const x: number = 1;\n',
    gate: 'pnpm lint',
  },
  {
    name: 'lint 拦截 class',
    file: 'packages/core/src/__gate_class.ts',
    content: 'export class Tracker {}\n',
    gate: 'pnpm lint',
  },
  {
    name: 'typecheck 拦截类型错误',
    file: 'packages/core/src/__gate_type.ts',
    content: 'export const n: number = "x";\n',
    gate: 'pnpm typecheck',
  },
  {
    name: 'size 拦截超出预算',
    patch: {
      file: 'packages/core/src/index.ts',
      append: `\nexport const BLOAT = ${JSON.stringify(Array.from({ length: 4000 }, (_, i) => `k${i}-${Math.random().toString(36)}`))};\n`,
    },
    gate: 'pnpm build && pnpm size',
  },
  {
    name: 'api:check 拦截未登记的导出',
    patch: {
      file: 'packages/core/src/index.ts',
      append: '\n/** 未登记的公共 API。 */\nexport const UNREGISTERED_EXPORT = 1;\n',
    },
    gate: 'pnpm build && pnpm api:check',
  },
  {
    name: 'version:check 拦截包清单与 SDK_VERSION 漂移',
    replace: {
      file: 'packages/core/package.json',
      from: '"version": "0.0.0"',
      to: '"version": "9.9.9"',
    },
    gate: 'pnpm version:check',
  },
];

let ok = true;
for (const c of cases) {
  let original;
  let replaced;
  if (c.file) writeFileSync(join(root, c.file), c.content);
  if (c.patch) {
    original = readFileSync(join(root, c.patch.file), 'utf8');
    writeFileSync(join(root, c.patch.file), original + c.patch.append);
  }
  if (c.replace) {
    replaced = readFileSync(join(root, c.replace.file), 'utf8');
    writeFileSync(join(root, c.replace.file), replaced.replace(c.replace.from, c.replace.to));
  }
  const passed = run(c.gate);
  if (c.file && existsSync(join(root, c.file))) rmSync(join(root, c.file));
  if (c.patch) writeFileSync(join(root, c.patch.file), original);
  if (c.replace) writeFileSync(join(root, c.replace.file), replaced);
  console.log(`${passed ? 'FAIL' : 'ok  '} ${c.name}${passed ? '：门禁没有拦住违规样例' : ''}`);
  if (passed) ok = false;
}

// 恢复构建产物，避免影响后续门禁
run('pnpm build');
process.exitCode = ok ? 0 : 1;
