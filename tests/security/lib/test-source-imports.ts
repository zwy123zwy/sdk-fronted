/**
 * 守卫二的扫描器（**第一版：故意的半成品**）。
 *
 * 这一版只认静态 `import` 声明，**不认** `export ... from` / 动态 `import()` / `require()` /
 * `vi.mock()` / 常量标识符间接说明符。先跑测试拿到断言级失败，再补齐其余形态。
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

import { repoPath, repoRoot } from '../../contract/lib/fs-json';

/** 一份待扫描的源码文本（`file` 是相对仓库根的路径）。 */
export interface SourceTextFile {
  readonly file: string;
  readonly text: string;
}

/** 说明符来源的写法。 */
export type ModuleReferenceKind = 'import' | 'export' | 'dynamic-import' | 'require' | 'vi-mock';

/** 一处模块引用（`import` / `export ... from` / `import()` / `require()` / `vi.mock()`）。 */
export interface ModuleReference {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
  readonly kind: ModuleReferenceKind;
  /** 说明符来自常量标识符（不是字面量）时记录该标识符名。 */
  readonly indirectSymbol?: string;
}

/** 说明符的归类。 */
export type SpecifierKind = 'packages-source' | 'packages-dist' | 'workspace-package' | 'relative-other' | 'external';

/**
 * 一处「文件里声明了指向 `packages/<pkg>/src` 的入口常量」。
 *
 * 这是仓库里**刻意的逃生舱**写法：`const ENTRY = '../../../packages/core/src/index.ts';`
 * 然后把这个常量当变量说明符交给 `import(ENTRY)`（往往再经一层函数参数转发）。TS 不静态解析
 * 变量说明符，所以它**不会**把源码拉进根程序；但它确实在运行期加载源码入口，必须可见、可复核。
 * 直接 `import('<字面量>')` 不算这一类（那属于静态可解析，见 `staticSourceImports`）。
 */
export interface SourceEntryConstant {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly specifier: string;
}

/** 扫描汇总。 */
export interface TestSourceImportReport {
  readonly scannedFiles: number;
  readonly referenceCount: number;
  /** 字面量说明符、静态可解析、且落在 `packages/<pkg>/src` → 硬违规。 */
  readonly staticSourceImports: readonly ModuleReference[];
  /** 常量标识符 + 变量说明符，运行期加载 `packages/<pkg>/src` → 需允许清单。 */
  readonly indirectSourceImports: readonly ModuleReference[];
  /** 声明了指向 `packages/<pkg>/src` 的常量（逃生舱写法）→ 需允许清单。 */
  readonly sourceEntryConstants: readonly SourceEntryConstant[];
  /** 裸包名（工作区包）：只有根 tsconfig 的 conditions 含 `source` 时才会落到源码。 */
  readonly bareWorkspaceImports: readonly ModuleReference[];
}

/** 递归列出 `tests/**` 下所有 `.ts` 文件（相对仓库根的路径）。 */
export function listTestFiles(): string[] {
  const entries = readdirSync(join(repoRoot, 'tests'), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => repoPath(file));
}

/** 仓库路径的归类。 */
function classifyRepoPath(path: string): SpecifierKind {
  if (/^packages\/[^/]+\/src(?:\/|$)/u.test(path)) return 'packages-source';
  if (/^packages\/[^/]+\/dist(?:\/|$)/u.test(path)) return 'packages-dist';
  return 'relative-other';
}

/** 说明符归类：相对路径按仓库解析；别名与裸包名按文本形态判定。 */
export function classifySpecifier(specifier: string, fromFile: string): SpecifierKind {
  if (specifier.startsWith('.')) {
    const baseDirectory = dirname(join(repoRoot, fromFile));
    const absolute = resolve(baseDirectory, specifier);
    return classifyRepoPath(repoPath(absolute).split(sep).join('/'));
  }
  if (/^@web-report-sdk\//u.test(specifier)) {
    if (/(?:^|\/)src(?:\/|$)/u.test(specifier)) return 'packages-source';
    if (/(?:^|\/)dist(?:\/|$)/u.test(specifier)) return 'packages-dist';
    return 'workspace-package';
  }
  if (/(?:^|\/)packages\/[^/]+\/src(?:\/|$)/u.test(specifier)) return 'packages-source';
  return 'external';
}

/* ------------------------------------------------------------------ 模块引用收集 */

/** `vi.mock` / `jest.mock` 一族：它们的参数是模块说明符。 */
const MOCK_METHODS: ReadonlySet<string> = new Set(['mock', 'doMock', 'unmock', 'importActual', 'importMock']);
const MOCK_OBJECTS: ReadonlySet<string> = new Set(['vi', 'jest']);

/** 文件里"名字 → 字符串字面量"的常量表（被重新赋值即失效；用于识别间接说明符）。 */
function collectStringConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isStringLiteralLike(initializer)) constants.set(node.name.text, initializer.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      constants.delete(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constants;
}

/**
 * 收集一个文件里的全部**模块引用**：
 *
 * - `import ... from 'x'`（含 `import type`——它同样把源码拉进根程序）；
 * - `export ... from 'x'`；
 * - 动态 `import('x')`（**字面量**说明符）；
 * - `require('x')`；
 * - `vi.mock('x')` / `jest.mock('x')` 一族；
 * - 上述形态里说明符是**常量标识符**时（`const ENTRY = '...'; await import(ENTRY)`），
 *   记为 `indirectSymbol`。TS 不静态解析变量说明符，所以这类不是"静态 import"，
 *   但它们确实在运行期加载源码入口，需要单独可见。
 */
export function collectModuleReferences(sourceText: string, fileName: string): ModuleReference[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = collectStringConstants(sourceFile);
  const references: ModuleReference[] = [];

  const record = (node: ts.Node, specifierNode: ts.Expression, kind: ModuleReferenceKind): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    if (ts.isStringLiteralLike(specifierNode)) {
      references.push({ file: fileName, line, specifier: specifierNode.text, kind });
      return;
    }
    if (ts.isIdentifier(specifierNode)) {
      const resolved = constants.get(specifierNode.text);
      if (resolved !== undefined) {
        references.push({ file: fileName, line, specifier: resolved, kind, indirectSymbol: specifierNode.text });
      }
    }
  };

  /** 取第一个实参（说明符所在位置）。 */
  const firstArgument = (node: ts.CallExpression): ts.Expression | undefined => node.arguments[0];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      record(node, node.moduleSpecifier, 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      record(node, node.moduleSpecifier, 'export');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = firstArgument(node);
        if (argument !== undefined) record(node, argument, 'dynamic-import');
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        const argument = firstArgument(node);
        if (argument !== undefined) record(node, argument, 'require');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        MOCK_OBJECTS.has(callee.expression.text) &&
        MOCK_METHODS.has(callee.name.text)
      ) {
        const argument = firstArgument(node);
        if (argument !== undefined) record(node, argument, 'vi-mock');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

/**
 * 收集「文件里声明了指向 `packages/<pkg>/src` 的字符串常量」。
 *
 * 这类常量通常随后被当作变量说明符交给 `import()` / `require()`（见 `SourceEntryConstant` 的注释）。
 * 只认直接赋值给**标识符**的字符串字面量：数组元素（如守卫自己登记的 `sourceRoots = ['packages/core/src', …]`）
 * 与模板串（`${repoRoot}packages/…/dist/…`）都不算，避免把"只是提到路径的字符串"当成加载。
 */
export function collectSourceEntryConstants(sourceText: string, fileName: string): SourceEntryConstant[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: SourceEntryConstant[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isStringLiteralLike(initializer)) {
        const specifier = initializer.text;
        if (classifySpecifier(specifier, fileName) === 'packages-source') {
          found.push({
            file: fileName,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            name: node.name.text,
            specifier,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** 扫描全部测试文件，汇总各类发现。 */
export function findSourceImports(files: readonly SourceTextFile[]): TestSourceImportReport {
  const staticSourceImports: ModuleReference[] = [];
  const indirectSourceImports: ModuleReference[] = [];
  const sourceEntryConstants: SourceEntryConstant[] = [];
  const bareWorkspaceImports: ModuleReference[] = [];
  let referenceCount = 0;

  for (const file of files) {
    sourceEntryConstants.push(...collectSourceEntryConstants(file.text, file.file));
    for (const reference of collectModuleReferences(file.text, file.file)) {
      referenceCount += 1;
      const kind = classifySpecifier(reference.specifier, reference.file);
      if (kind === 'packages-source') {
        if (reference.indirectSymbol === undefined) staticSourceImports.push(reference);
        else indirectSourceImports.push(reference);
      } else if (kind === 'workspace-package') {
        bareWorkspaceImports.push(reference);
      }
    }
  }
  return {
    scannedFiles: files.length,
    referenceCount,
    staticSourceImports,
    indirectSourceImports,
    sourceEntryConstants,
    bareWorkspaceImports,
  };
}

/** 根 `tsconfig.json` 的 `customConditions`（用于判断裸包名会不会落到源码）。 */
export function readRootCustomConditions(): string[] {
  const result = ts.readConfigFile(join(repoRoot, 'tsconfig.json'), (path) => ts.sys.readFile(path)) as {
    readonly config?: { readonly compilerOptions?: { readonly customConditions?: unknown } };
  };
  const conditions = result.config?.compilerOptions?.customConditions;
  if (!Array.isArray(conditions)) return [];
  return conditions.filter((item): item is string => typeof item === 'string');
}

/**
 * 裸包名的可读报错：只有 `customConditions` 含 `"source"` 时才会落到 `packages/<pkg>/src`。
 * 返回 `undefined` 表示当前条件下安全（解析到 `dist` 产物）。
 */
export function describeBareSpecifierRisk(
  references: readonly ModuleReference[],
  customConditions: readonly string[],
): string | undefined {
  if (references.length === 0 || !customConditions.includes('source')) return undefined;
  const list = references
    .map((reference) => `  ${reference.file}:${String(reference.line)} ${reference.kind} '${reference.specifier}'`)
    .join('\n');
  return (
    `tests/** 里有 ${String(references.length)} 处**裸包名** import，而根 tsconfig.json 的 ` +
    `customConditions 含 "source" → 这些裸包名会按 source 条件解析到 packages/<pkg>/src（无 DOM 程序），` +
    `产生成片虚假类型错误。修复：① 改为 import 构建产物（'../packages/<pkg>/dist/index.js'）；` +
    `② 或移除根 tsconfig.json 的 "source" 条件。\n${list}`
  );
}
