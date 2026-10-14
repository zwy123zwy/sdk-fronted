/**
 * 仓库级守卫二：**`tests/**` 不得 import `packages/<pkg>/src/**`**。
 *
 * ## 依据（本会话踩过两次）
 *
 * 根 `tsconfig.json` 的 `lib` 只有 `ES2022`（**无 DOM**），而它 typecheck 的正是 `tests/**`
 * （`include: ["*.ts", "tests 下的全部 .ts"]`）。一旦某个测试 import 了包**源码**，`packages/<pkg>/src`
 * 就被拉进这个无 DOM 的程序 → **成片虚假的类型错误**（本会话实测 64 条 `IDBFactory` /
 * `SubtleCrypto`）。踩过的两次：
 *
 * 1. 编排方自己写 `tests/security/t31-security.test.ts` 时 import 了 core 源码；
 * 2. T31 的撤回同意用例 import 了 `packages/browser/dist/index.js`，而该 `.d.ts` 用**裸包名**
 *    引用 `@web-report-sdk/core`，在根 `customConditions: ["source"]` 下解析回源码。
 *
 * 第 2 条揭示了本案的关键机制：**危害只发生在"模块说明符能被静态解析"时**。所以本守卫：
 *
 * - **硬失败**：`import` / `export ... from` / 字面量 `import()` / 字面量 `require()` / `vi.mock()`
 *   的说明符（相对路径、别名、或文本里带 `packages/<pkg>/src`）解析进 `packages/<pkg>/src`；
 * - **需允许清单**：说明符来自**常量标识符**（`const ENTRY = '.../src/index.ts'; await import(ENTRY)`）。
 *   TS 不静态解析变量说明符，因此这类写法**不会**污染根程序；仓库现有 5 处（`tests/bench/lib/entries.ts`
 *   3 处、`tests/contract/lib/sdk-runtime.ts` 2 处）是**刻意的逃生舱**，文件头有详细理由。
 *   本守卫把它们登记在带理由的允许清单里，**任何新增都会红**；
 * - **裸包名**：给出明确可读的报错——只有当根 tsconfig 的 `customConditions` 含 `"source"` 时，
 *   裸包名才会落到 `packages/<pkg>/src`；否则它解析到 `dist` 产物（安全）。
 *
 * 本文件**只读**，不修改任何实现，也不修改 `tests/` 下的其它文件。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { repoRoot } from '../contract/lib/fs-json';
import {
  describeBareSpecifierRisk,
  findSourceImports,
  listTestFiles,
  readRootCustomConditions,
  type ModuleReference,
  type SourceTextFile,
} from './lib/test-source-imports';

function readAllTestFiles(): SourceTextFile[] {
  return listTestFiles().map((file) => ({ file, text: readFileSync(join(repoRoot, file), 'utf8') }));
}

/**
 * 已知的**刻意**源码加载（常量标识符 + 变量说明符动态 import）允许清单。
 *
 * 这些写法**不构成**根 tsconfig 的类型污染（说明符是变量，TS 不解析），但它们确实在运行期加载
 * 源码入口。登记在此是为了：① 让"确实存在这类加载"这件事可见；② 任何**新增**的间接源码加载
 * 都会失败；③ 每条都带**为什么必须这样做**的理由。
 */
const INDIRECT_SOURCE_ALLOWLIST: readonly {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}[] = [
  {
    file: 'tests/bench/lib/entries.ts',
    specifier: '../../../packages/core/src/index.ts',
    reason: 'bench 跑的是 `exports["."].source` 指向的真实入口（性能口径必须对准源码，不能对准产物）',
  },
  {
    file: 'tests/bench/lib/entries.ts',
    specifier: '../../../packages/transport/src/index.ts',
    reason: '同上（transport 真实入口）',
  },
  {
    file: 'tests/bench/lib/entries.ts',
    specifier: '../../../packages/transport/src/offline/fixtures.ts',
    reason: 'C07 内存后端夹具不是公共导出，只存在于源码里（与 perf.test.ts 同一套夹具）',
  },
  {
    file: 'tests/contract/lib/sdk-runtime.ts',
    specifier: '../../../packages/core/src/index.ts',
    reason: '契约测试要用 Ajv 校验**真实产出**；变量说明符是文件头写明的、避免根程序 lib 冲突的手段',
  },
  {
    file: 'tests/contract/lib/sdk-runtime.ts',
    specifier: '../../../packages/transport/src/index.ts',
    reason: '同上（transport 真实入口）',
  },
];

const allowlistKey = (file: string, specifier: string): string => `${file}::${specifier}`;

/** 合成文件集（判别力用例用；**不是**真实文件，不会被仓库扫描影响）。 */
function synthetic(sources: Readonly<Record<string, string>>): SourceTextFile[] {
  return Object.entries(sources).map(([file, text]) => ({ file, text }));
}

const locations = (references: readonly ModuleReference[]): string[] =>
  references.map((reference) => `${reference.file}:${String(reference.line)}`);

describe('守卫二：tests/** 不得 import packages/<pkg>/src/**', () => {
  test('不存在可直接静态解析到 packages/<pkg>/src 的 import', () => {
    const report = findSourceImports(readAllTestFiles());

    // 反空转：确实扫到了 `tests/**` 的全部文件，并且确实解析到了有意义的说明符数量。
    expect(report.scannedFiles, '扫描到的测试源码文件数').toBeGreaterThanOrEqual(25);
    expect(report.referenceCount, '解析到的模块说明符数量（import/export/import()/require/vi.mock）').toBeGreaterThanOrEqual(60);

    const reported = report.staticSourceImports.map(
      (reference) =>
        `${reference.file}:${String(reference.line)} ${reference.kind} '${reference.specifier}'` +
        ` → 解析进 packages/<pkg>/src（根 tsconfig 的 lib 无 DOM，会把源码拉进测试程序并产生成片虚假类型错误；` +
        `测试应 import 构建产物 '../packages/<pkg>/dist/index.js'）`,
    );
    expect(reported, `以下位置 import 了包源码：\n${reported.join('\n')}`).toEqual([]);
  });

  test('声明指向源码的入口常量（逃生舱写法）：只允许已登记的 5 处', () => {
    const report = findSourceImports(readAllTestFiles());
    const allowed = new Set(INDIRECT_SOURCE_ALLOWLIST.map((entry) => allowlistKey(entry.file, entry.specifier)));
    const observed = new Set(
      report.sourceEntryConstants.map((constant) => allowlistKey(constant.file, constant.specifier)),
    );

    // 反空转：这条断言的判别力来自"两侧都要相等"——观察集不能有清单外的新增，清单也不能有失效条目。
    // 只查一个方向会让"扫描器根本没识别出这类常量"变成静默通过。
    const unexpected = report.sourceEntryConstants.filter(
      (constant) => !allowed.has(allowlistKey(constant.file, constant.specifier)),
    );
    const reported = unexpected.map(
      (constant) =>
        `${constant.file}:${String(constant.line)} 声明了指向源码的常量 '${constant.name} = ${constant.specifier}'` +
        `（这是"变量说明符"逃生舱；新增必须先在这里登记理由）`,
    );
    expect(reported, `以下位置新增了未登记的源码入口常量：\n${reported.join('\n')}`).toEqual([]);

    const stale = [...allowed].filter((key) => !observed.has(key));
    expect(
      stale,
      `守卫二的允许清单里有已不存在的条目（请同步删除，或恢复对应的逃生舱写法）：\n${stale.join('\n')}`,
    ).toEqual([]);

    // 直接以常量作为 `import()` 说明符的写法（说明符不是字面量 → 不是静态违规）目前仓库里没有；
    // 一旦出现，也必须显式登记，而不是靠"TS 不解析"混过去。
    const indirect = report.indirectSourceImports.map(
      (reference) =>
        `${reference.file}:${String(reference.line)} '${reference.indirectSymbol ?? '?'}' → ${reference.specifier}`,
    );
    expect(indirect, `以下位置用常量作动态 import 说明符加载源码（需显式登记）：\n${indirect.join('\n')}`).toEqual([]);
  });

  test('裸包名 import：给出明确可读的报错（含修复方向）', () => {
    const report = findSourceImports(readAllTestFiles());
    const conditions = readRootCustomConditions();
    const risk = describeBareSpecifierRisk(report.bareWorkspaceImports, conditions);
    expect(
      risk,
      `tests/** 里出现裸包名 import，而根 tsconfig 的 customConditions 含 "source"：` +
        `裸包名会按 source 条件解析到 packages/<pkg>/src（无 DOM 程序）→ 成片虚假类型错误。` +
        `请改为 import 构建产物（'../packages/<pkg>/dist/index.js'），或移除根 tsconfig 的 "source" 条件。\n${risk ?? ''}`,
    ).toBeUndefined();
  });

  test('判别力：合成反例必须被抓到（静态与间接两条路径）', () => {
    // 反例 1：静态 import（相对路径）。
    expect(
      locations(
        findSourceImports(
          synthetic({
            'tests/synthetic/a.test.ts': "import { x } from '../../packages/core/src/index.js';",
          }),
        ).staticSourceImports,
      ),
    ).toEqual(['tests/synthetic/a.test.ts:1']);

    // 反例 2：export ... from。
    expect(
      locations(
        findSourceImports(
          synthetic({
            'tests/synthetic/b.test.ts': "export { y } from '../../packages/plugins/src/route/index.js';",
          }),
        ).staticSourceImports,
      ),
    ).toEqual(['tests/synthetic/b.test.ts:1']);

    // 反例 3：import type（同样会拉进根程序，必须抓）。
    expect(
      locations(
        findSourceImports(
          synthetic({
            'tests/synthetic/c.test.ts': "import type { T } from '../../packages/transport/src/index.js';",
          }),
        ).staticSourceImports,
      ),
    ).toEqual(['tests/synthetic/c.test.ts:1']);

    // 反例 4：字面量动态 import。
    expect(
      locations(
        findSourceImports(
          synthetic({
            'tests/synthetic/d.test.ts': "const m = await import('../../packages/browser/src/index.js');",
          }),
        ).staticSourceImports,
      ),
    ).toEqual(['tests/synthetic/d.test.ts:1']);

    // 反例 5：字面量 require。
    expect(
      locations(
        findSourceImports(
          synthetic({
            'tests/synthetic/e.test.ts': "const m = require('../../packages/core/src/kernel/index.js');",
          }),
        ).staticSourceImports,
      ),
    ).toEqual(['tests/synthetic/e.test.ts:1']);

    // 反例 6：vi.mock。
    expect(
      locations(
        findSourceImports(
          synthetic({
            'tests/synthetic/f.test.ts': "vi.mock('../../packages/core/src/privacy/mask.js');",
          }),
        ).staticSourceImports,
      ),
    ).toEqual(['tests/synthetic/f.test.ts:1']);

    // 反例 7：别名形式（不走相对路径）。
    expect(
      locations(
        findSourceImports(
          synthetic({
            'tests/synthetic/g.test.ts': "import { z } from '@web-report-sdk/core/src/index.js';",
          }),
        ).staticSourceImports,
      ),
    ).toEqual(['tests/synthetic/g.test.ts:1']);

    // 反例 8：常量标识符 + 变量说明符 → 记为间接（不是静态，但必须被**识别**出来）。
    const indirect = findSourceImports(
      synthetic({
        'tests/synthetic/h.test.ts': [
          "const ENTRY = '../../packages/core/src/index.ts';",
          'const loaded = await import(ENTRY);',
        ].join('\n'),
      }),
    );
    expect(locations(indirect.staticSourceImports)).toEqual([]);
    expect(locations(indirect.indirectSourceImports)).toEqual(['tests/synthetic/h.test.ts:2']);
  });

  test('不做误报：dist 产物、node 内置、第三方、以及"只是字符串"的路径都不算', () => {
    const report = findSourceImports(
      synthetic({
        'tests/security/ok.test.ts': [
          "import { a } from '../../packages/core/dist/index.js';",
          "import { b } from '../../packages/transport/dist/index.js';",
          "import type { c } from '../../packages/browser/dist/index.js';",
          "import { readFileSync } from 'node:fs';",
          "import { describe } from 'vitest';",
          "import { d } from '../contract/lib/fs-json';",
          'const p = `packages/core/src/index.ts`;',
          "const q = 'generated from packages/core/src by hand';",
          'const r = 1;',
        ].join('\n'),
      }),
    );
    expect(report.staticSourceImports).toEqual([]);
    expect(report.indirectSourceImports).toEqual([]);
    expect(report.referenceCount, '前 6 条 import 都应被解析到').toBe(6);
  });

  test('README 式反例：裸包名在 customConditions 含 source 时报告可读错误', () => {
    const bare: ModuleReference[] = [
      { file: 'tests/synthetic/i.test.ts', line: 1, specifier: '@web-report-sdk/core', kind: 'import' },
    ];
    // 当前根 tsconfig 的 customConditions 不含 source → 不报（解析到 dist，安全）。
    expect(describeBareSpecifierRisk(bare, [])).toBeUndefined();
    expect(describeBareSpecifierRisk(bare, ['import'])).toBeUndefined();
    // 一旦有人把 source 条件加回来 → 必须报，并且报错里要有包名与修复方向。
    const message = describeBareSpecifierRisk(bare, ['source']);
    expect(typeof message).toBe('string');
    expect(message).toContain('@web-report-sdk/core');
    expect(message).toContain('tests/synthetic/i.test.ts:1');
    expect(message).toContain('dist');
    // 没有裸包名时，即使 conditions 含 source 也不报（空的输入不产生噪音）。
    expect(describeBareSpecifierRisk([], ['source'])).toBeUndefined();
  });

  test('分类器本身：dist / source / 裸包名 / 外部，四类分得清', () => {
    const report = findSourceImports(
      synthetic({
        'tests/synthetic/j.test.ts': [
          "import { a } from '../../packages/core/dist/index.js';",
          "import { b } from '@web-report-sdk/core';",
          "import { c } from 'node:path';",
          "import { d } from '../contract/lib/fs-json';",
        ].join('\n'),
      }),
    );
    expect(locations(report.bareWorkspaceImports)).toEqual(['tests/synthetic/j.test.ts:2']);
    expect(report.referenceCount).toBe(4);
  });
});
