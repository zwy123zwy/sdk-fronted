/**
 * 仓库级守卫：**SDK 源码不得引用 `localStorage`**（D004）。
 *
 * 依据：
 * - `docs/decisions/D004-hard-kill-exposure-window.md`：离线副本必须用 IndexedDB 并以
 *   `transaction.oncomplete` 为唯一落盘点；**禁止用 `localStorage` 存 critical 副本**。
 *   理由见 `docs/poc/POC-1-storage.md`：Chromium/Firefox 的 `localStorage` 写入不是同步持久化，
 *   硬杀窗口内 100% 丢失。
 * - 该守卫原本只由编排方用 grep 人工验证过一次（见 `docs/reports/wave3-lanes.md` 的遗留义务
 *   与看板），本文件把它固化为可执行的门禁。
 *
 * 实现说明：用 **TypeScript 编译器 API 遍历 AST** 检测标识符，而不是正则扫文本——
 * 这样注释与字符串里的 `localStorage` 自动被排除（本仓库有 3 处注释专门说明"不使用它"），
 * 也不会漏掉模板字符串表达式里的真实用法。`typescript` 已是根 devDependency，未新增依赖。
 *
 * 为什么放在 `tests/contract/`：`vitest.config.ts` 只把 `packages/<pkg>/src`、`tools/<tool>/src`
 * 收进 `unit` project，把 `tests/contract/**` 收进 `contract` project；`packages/transport` 自身是
 * `types: []` 的纯浏览器包，`node:fs` 在包内无类型，所以这类仓库级扫描只能放在 `tests/` 下。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { repoPath, repoRoot } from './lib/fs-json';

/** 需要扫描的源码根目录（SDK 的四个包）。 */
const sourceRoots = ['packages/core/src', 'packages/transport/src', 'packages/plugins/src', 'packages/browser/src'];

/** 该禁用标识符。 */
const FORBIDDEN_IDENTIFIER = 'localStorage';

/**
 * 用 TypeScript 编译器解析源码，返回所有**标识符**形式的 `localStorage` 出现位置（1 基行号）。
 * 注释、字符串字面量都不会进入结果。
 */
function findForbiddenIdentifiers(sourceText: string, fileName: string): number[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === FORBIDDEN_IDENTIFIER) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

interface ScanHit {
  readonly file: string;
  readonly line: number;
}

/** 递归列出某个源码根目录下的所有**非测试** `.ts` 文件（相对仓库根的路径）。 */
function listSourceFiles(repoRelativeRoot: string): string[] {
  const absoluteRoot = join(repoRoot, repoRelativeRoot);
  const entries = readdirSync(absoluteRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => repoPath(file));
}

/** 扫描全部源码，返回命中清单。 */
function scanRepository(): { hits: ScanHit[]; scannedFiles: number } {
  const hits: ScanHit[] = [];
  let scannedFiles = 0;
  for (const root of sourceRoots) {
    for (const file of listSourceFiles(root)) {
      scannedFiles += 1;
      const lines = findForbiddenIdentifiers(readFileSync(join(repoRoot, file), 'utf8'), file);
      for (const line of lines) hits.push({ file, line });
    }
  }
  return { hits, scannedFiles };
}

describe('D004 仓库守卫：源码不得引用 localStorage', () => {
  test('SDK 四个包的源码中不存在 localStorage 标识符', () => {
    const { hits, scannedFiles } = scanRepository();

    // 反空转：先确认扫描确实覆盖了有意义的文件数，避免 glob 写错导致"扫了 0 个文件所以通过"。
    expect(scannedFiles, `扫描到的源码文件数（应远大于 0）`).toBeGreaterThanOrEqual(30);

    const reported = hits.map((hit) => `${hit.file}:${String(hit.line)}`);
    expect(
      reported,
      `以下位置引用了 localStorage（D004 禁止用 localStorage 存 critical 副本；` +
        `离线副本必须用 IndexedDB 且以 oncomplete 为唯一落盘点）：\n${reported.join('\n')}`,
    ).toEqual([]);
  });

  test('检测器本身有效（正/负向对照，证明守卫非空转）', () => {
    // 正向：真实用法必须被抓到（属性访问、元素访问、裸引用、window 前缀各一）。
    expect(findForbiddenIdentifiers(`localStorage.setItem('a', 'b');`, 'positive.ts')).toEqual([1]);
    expect(findForbiddenIdentifiers(`const x = window.localStorage;`, 'positive2.ts')).toEqual([1]);
    expect(findForbiddenIdentifiers(`localStorage['setItem']('a', 'b');`, 'positive3.ts')).toEqual([1]);
    expect(findForbiddenIdentifiers('const t = `${localStorage.length}`;', 'positive4.ts')).toEqual([1]);

    // 负向：注释里的说明、字符串里的字样，都**不得**被误报（本仓库现有 3 处这类注释）。
    expect(findForbiddenIdentifiers(`// 完全不用 localStorage（D004）`, 'negative1.ts')).toEqual([]);
    expect(findForbiddenIdentifiers(`/* 不使用 localStorage */`, 'negative2.ts')).toEqual([]);
    expect(findForbiddenIdentifiers(`const s = 'localStorage';`, 'negative3.ts')).toEqual([]);
    expect(findForbiddenIdentifiers(`/** 缓存端口；不使用 \`localStorage\` */`, 'negative4.ts')).toEqual([]);

    // 行号准确性（便于定位）。
    expect(findForbiddenIdentifiers(`const a = 1;\n\nlocalStorage.clear();`, 'lines.ts')).toEqual([3]);
  });
});
