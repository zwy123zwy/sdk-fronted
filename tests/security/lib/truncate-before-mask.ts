/**
 * 守卫一的扫描器：**同一个值先被截断/切片、后被脱敏**。
 *
 * ## 为什么用 TypeScript AST 而不是正则
 *
 * 本仓库的注释里反复出现 `truncate(...)` 与 `masker.apply(...)`（`constraints.ts` 的文件头注释
 * 就在解释"先脱敏、再截断"），正则会把说明性文本当成代码；AST 自动排除注释与字符串。
 *
 * ## 判定算法（对同一个值做值传递解析）
 *
 * 1. 遍历全文件收集**绑定**（binding）：变量声明、赋值表达式、函数/箭头函数的**形参**（含解构，
 *    一律记为"原样输入"）、函数声明名、`import` 绑定、`catch` 变量。每个绑定带**源码位置**。
 *    绑定的键（key）是"赋值目标的规范写法"：`x`、`obj.field`、`obj['field']` → `obj.field`。
 * 2. 找出所有**脱敏调用**：`X.apply(...)`（X 的名字含 `mask`）或 `X.mask/scrub/redact/sanitize(...)`，
 *    以及裸函数 `sanitizeXxx(...)` / `maskXxx(...)`。只检查**第 1 个实参**（被脱敏的值）。
 * 3. 对第 1 个实参做**值传递解析**：标识符 / 成员访问 → 查"该位置之前最近的同名绑定"→ 递归。
 *    遇到截断/切片调用（`truncate*`、`.slice/.substring/.substr/.padEnd/.padStart`）即判定违规，
 *    并给出从实参到截断点的值传递链，便于人读定位。
 *
 * 值选择器（`?:`、`??`、`||`、`&&`、`+`、模板串）会逐支解析：任一支是截断值即算违规（保守方向）。
 *
 * ## 已知边界（明确写出来，避免被误读成"全覆盖"）
 *
 * - **不做跨函数分析**：`masker.apply(build(value.slice(0, 8)))` 中截断发生在另一个函数体内时抓不到。
 * - **不传播对象字面量/数组**：`const parts = { p: url.slice(0, 9) }; masker.apply(parts.p)` 抓不到
 *   （`parts.p` 没有同名绑定）。这一条也是**不误报**的关键：`url.ts` 的 `parts.pathname` 正是这种形状，
 *   而它属于"先解析出结构、再整体脱敏"，是正确的。
 * - 位置是**文本位置**不是作用域：形参会在自己位置写入一条"原样"绑定，因此同名形参遮蔽外层截断值时
 *   不会误报（见测试 `正确 5`）。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { repoPath, repoRoot } from '../../contract/lib/fs-json';

/** 一份待扫描的源码文本（`file` 是相对仓库根的路径，仅用于报错）。 */
export interface SourceTextFile {
  readonly file: string;
  readonly text: string;
}

/** 一处「先截断后脱敏」。 */
export interface MaskOrderViolation {
  readonly file: string;
  readonly maskLine: number;
  readonly maskColumn: number;
  readonly maskedExpression: string;
  readonly truncationLine: number;
  readonly truncationExpression: string;
  /** 从被脱敏的实参到截断点的值传递链（人读用）。 */
  readonly valueChain: readonly string[];
}

/** 扫描统计（反空转断言用）。 */
export interface ScanStats {
  /** 识别到的脱敏调用点数。 */
  readonly maskingCallSites: number;
  /** 识别到的截断/切片调用点数。 */
  readonly truncationCallSites: number;
}

/** 单文件扫描结果。 */
export interface TruncateBeforeMaskResult {
  readonly violations: readonly MaskOrderViolation[];
  readonly stats: ScanStats;
}

/** `truncate` 之外，这些方法名视为截断/切片。 */
const TRUNCATION_METHODS: ReadonlySet<string> = new Set(['slice', 'substring', 'substr', 'padEnd', 'padStart']);

/** 这些方法名（配合含 mask/scrub/… 的对象名）视为脱敏。 */
const MASK_METHODS: ReadonlySet<string> = new Set(['apply', 'mask', 'scrub', 'redact', 'sanitize']);

const MASK_OBJECT_PATTERN = /mask|scrub|redact|sanit/iu;
const MASK_FUNCTION_PATTERN = /^(?:sanitize|mask|scrub|redact)/u;

/** 值传递解析的最大深度（同时防止 `a = b; b = a` 这类环）。 */
const MAX_RESOLVE_DEPTH = 16;

/** 递归列出某个源码根目录下的所有**非测试** `.ts` 文件（相对仓库根的路径）。 */
export function listSourceFiles(repoRelativeRoot: string): string[] {
  const entries = readdirSync(join(repoRoot, repoRelativeRoot), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => repoPath(file));
}

/** 取「被调用方法/函数」的名字（标识符、属性访问、元素访问的字面量键）。 */
function calledName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee)) {
    const argument = callee.argumentExpression;
    return ts.isStringLiteralLike(argument) ? argument.text : undefined;
  }
  return undefined;
}

/** 是不是截断/切片调用。 */
function isTruncationCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return /^truncate/u.test(callee.text);
  const name = calledName(callee);
  return name !== undefined && TRUNCATION_METHODS.has(name);
}

/** 是不是脱敏调用（`masker.apply` / `input.masker.apply` / `sanitizeUrl` / `maskUrl` …）。 */
function isMaskingCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return MASK_FUNCTION_PATTERN.test(callee.text);
  const name = calledName(callee);
  if (name === undefined || !MASK_METHODS.has(name)) return false;
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return MASK_OBJECT_PATTERN.test(callee.expression.getText());
  }
  return false;
}

/** 赋值目标的规范键：`x` / `obj.field` / `obj['field']` → `obj.field`；动态键返回 undefined。 */
function targetKey(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = targetKey(node.expression);
    return base === undefined ? undefined : `${base}.${node.name.text}`;
  }
  if (ts.isElementAccessExpression(node)) {
    const base = targetKey(node.expression);
    const argument = node.argumentExpression;
    if (base === undefined || !ts.isStringLiteralLike(argument)) return undefined;
    return `${base}.${argument.text}`;
  }
  return undefined;
}

/** 绑定名里的全部标识符（含解构模式）。 */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

/** 一条绑定：`key` 在 `position` 之后生效，取值为 `value`（undefined 表示"原样输入"）。 */
interface Binding {
  readonly key: string;
  readonly position: number;
  readonly value: ts.Expression | undefined;
}

/** 按源码位置升序收集全部绑定。 */
function collectBindings(sourceFile: ts.SourceFile): Binding[] {
  const bindings: Binding[] = [];
  const add = (name: ts.BindingName, value: ts.Expression | undefined, position: number): void => {
    for (const key of bindingNames(name)) bindings.push({ key, position, value });
  };
  const raw = (name: ts.Identifier, position: number): void => {
    bindings.push({ key: name.text, position, value: undefined });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      add(node.name, node.initializer, node.getStart(sourceFile));
    } else if (ts.isParameter(node)) {
      // 形参一律记为"原样输入"：这既是事实（调用方给什么就是什么），也承担**遮蔽**语义。
      add(node.name, undefined, node.getStart(sourceFile));
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      raw(node.name, node.getStart(sourceFile));
    } else if (ts.isImportDeclaration(node) && node.importClause !== undefined) {
      const position = node.getStart(sourceFile);
      const clause = node.importClause;
      if (clause.name !== undefined) raw(clause.name, position);
      const named = clause.namedBindings;
      if (named !== undefined) {
        if (ts.isNamespaceImport(named)) raw(named.name, position);
        else for (const element of named.elements) raw(element.name, position);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const key = targetKey(node.left);
      if (key !== undefined) bindings.push({ key, position: node.getStart(sourceFile), value: node.right });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings.sort((left, right) => left.position - right.position);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** 该位置之前**最近**的同名绑定。 */
function bindingBefore(bindings: readonly Binding[], key: string, position: number): Binding | undefined {
  let found: Binding | undefined;
  for (const binding of bindings) {
    if (binding.position >= position) break; // bindings 已按位置升序
    if (binding.key === key) found = binding;
  }
  return found;
}

/** 值传递解析的命中结果：截断调用点 + 值传递链。 */
interface Origin {
  readonly node: ts.CallExpression;
  readonly chain: readonly string[];
}

/** 沿值传递链找截断点。 */
function resolveTruncation(
  node: ts.Expression,
  position: number,
  bindings: readonly Binding[],
  sourceFile: ts.SourceFile,
  chain: readonly string[],
  depth: number,
): Origin | undefined {
  if (depth > MAX_RESOLVE_DEPTH) return undefined;
  const expression = ts.isParenthesizedExpression(node) ? node.expression : node;

  if (ts.isCallExpression(expression) && isTruncationCallee(expression.expression)) {
    return { node: expression, chain };
  }

  if (ts.isConditionalExpression(expression)) {
    return (
      resolveTruncation(expression.whenTrue, position, bindings, sourceFile, chain, depth + 1) ??
      resolveTruncation(expression.whenFalse, position, bindings, sourceFile, chain, depth + 1)
    );
  }

  if (ts.isBinaryExpression(expression)) {
    const kind = expression.operatorToken.kind;
    const isValueSelector =
      kind === ts.SyntaxKind.PlusToken ||
      kind === ts.SyntaxKind.QuestionQuestionToken ||
      kind === ts.SyntaxKind.BarBarToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandToken;
    if (!isValueSelector) return undefined;
    return (
      resolveTruncation(expression.left, position, bindings, sourceFile, chain, depth + 1) ??
      resolveTruncation(expression.right, position, bindings, sourceFile, chain, depth + 1)
    );
  }

  if (ts.isTemplateExpression(expression)) {
    for (const span of expression.templateSpans) {
      const found = resolveTruncation(span.expression, position, bindings, sourceFile, chain, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const key = targetKey(expression);
  if (key === undefined) return undefined;
  const binding = bindingBefore(bindings, key, position);
  if (binding?.value === undefined) return undefined;
  const label = `${key} = ${binding.value.getText(sourceFile)}（第 ${String(lineOf(sourceFile, binding.value))} 行）`;
  return resolveTruncation(
    binding.value,
    binding.position,
    bindings,
    sourceFile,
    [...chain, label],
    depth + 1,
  );
}

/** 扫描单个文件。 */
export function findTruncateBeforeMask(sourceText: string, fileName: string): TruncateBeforeMaskResult {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = collectBindings(sourceFile);
  const violations: MaskOrderViolation[] = [];
  let maskingCallSites = 0;
  let truncationCallSites = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isTruncationCallee(node.expression)) truncationCallSites += 1;
      if (isMaskingCallee(node.expression)) {
        maskingCallSites += 1;
        const argument = node.arguments[0];
        if (argument !== undefined) {
          const position = argument.getStart(sourceFile);
          const origin = resolveTruncation(argument, position, bindings, sourceFile, [], 0);
          if (origin !== undefined) {
            violations.push({
              file: fileName,
              maskLine: lineOf(sourceFile, node),
              maskColumn: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).character + 1,
              maskedExpression: argument.getText(sourceFile),
              truncationLine: lineOf(sourceFile, origin.node),
              truncationExpression: origin.node.getText(sourceFile),
              valueChain: origin.chain,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { violations, stats: { maskingCallSites, truncationCallSites } };
}
