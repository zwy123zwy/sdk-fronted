/**
 * 仓库级守卫一：**截断/切片不得早于脱敏**。
 *
 * ## 依据
 *
 * 本会话里同一个根因被独立发现**三次**（`attachment`、`client.ts` 的预截断、dimensions 的 5 处
 * 以及处理器侧的 `url`），每次都是人读或人测发现的，形状完全一样：
 *
 *   对字符串先做 `truncate` / `slice` / `substring` / `padEnd`，**再**交给 `masker.apply`。
 *
 * 截断会把敏感值从中间切开，切断后的片段不再匹配任何规则，于是以**残片**形式原样发出
 * （实测：8 KB 边界落在手机号中间时残留 `1380`）。正确的方向只有一种：**先脱敏、后截断**——
 * 敏感值整体被替换串盖住，边界怎么移动都不残留片段。
 *
 * ## 这个守卫断言什么
 *
 * 扫描 `packages/core/src/**` 与 `packages/plugins/src/**` 的**非测试** `.ts`，用 TypeScript AST
 * （不是正则）解析调用序列，断言**不存在**「同一个值先被截断、后被脱敏」的调用模式。
 *
 * 为什么是 AST 而不是正则：注释与本仓库大量存在的说明性文本里反复出现这两类调用
 * （例如 `constraints.ts` 的文件头注释就在解释"先脱敏、再截断"），正则会把它们当成代码。
 *
 * 为什么只扫 `core` + `plugins`：这两个包是脱敏与字段约束的实现面（`Masker` 的注入与唯一
 * 权威都在这里），也是本根因实际发生过的两个包。
 *
 * ## 不做误报
 *
 * 「**先脱敏、后截断**」是当前代码里的**正确**写法，且是本守卫存在的理由，必须一条都不报。
 * 用例 `不误报：先脱敏后截断的现有正确写法` 用真实形状（`client.ts` / `constraints.ts` /
 * `url.ts` 的写法）逐条钉住。
 *
 * ## 反空转
 *
 * 除了"命中为空"，还断言**扫描到的文件数**、**识别到的脱敏调用点数**、**识别到的截断调用点数**
 * 都达到有意义的量级——避免 glob 写错或识别器失效导致"什么都没扫，所以通过"。
 *
 * 本文件**只读实现代码，不修改任何实现**。样本只用格式合法的伪造数据（非真实个人信息）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { repoRoot } from '../contract/lib/fs-json';
import {
  findTruncateBeforeMask,
  listSourceFiles,
  type MaskOrderViolation,
  type SourceTextFile,
} from './lib/truncate-before-mask';

/** 被守卫的实现面：脱敏（`Masker`）与字段约束（`constraints.ts`）都在 core；plugins 是调用方。 */
const SOURCE_ROOTS = ['packages/core/src', 'packages/plugins/src'];

/** 读取全部源码（相对仓库根解析，不依赖任何机器的绝对路径）。 */
function readSources(): SourceTextFile[] {
  const files: SourceTextFile[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const file of listSourceFiles(root)) {
      files.push({ file, text: readFileSync(join(repoRoot, file), 'utf8') });
    }
  }
  return files;
}

/** 人读的报错行（文件:行 + 值传递链）。 */
function formatViolation(violation: MaskOrderViolation): string {
  const chain = violation.valueChain.length > 0 ? `（值传递链：${violation.valueChain.join(' → ')}）` : '';
  return (
    `${violation.file}:${String(violation.maskLine)} 先截断后脱敏：` +
    `masker.apply(${violation.maskedExpression}) ← ${violation.truncationExpression}` +
    `（截断在 ${violation.file}:${String(violation.truncationLine)}）${chain}`
  );
}

describe('守卫一：截断/切片不得早于脱敏', () => {
  test('core 与 plugins 的源码中不存在「先截断后脱敏」', () => {
    const sources = readSources();
    // 逐文件扫描，汇总（同时拿到反空转所需的计数）。
    const violations: MaskOrderViolation[] = [];
    let maskingCallSites = 0;
    let truncationCallSites = 0;
    for (const source of sources) {
      const result = findTruncateBeforeMask(source.text, source.file);
      violations.push(...result.violations);
      maskingCallSites += result.stats.maskingCallSites;
      truncationCallSites += result.stats.truncationCallSites;
    }

    // 反空转（1）：确实扫到了两个包的全部非测试源码。
    expect(sources.length, '扫描到的源码文件数').toBeGreaterThanOrEqual(70);
    expect(
      new Set(sources.map((source) => source.file.split('/').slice(0, 3).join('/'))),
      '两个源码根都必须被覆盖',
    ).toEqual(new Set(SOURCE_ROOTS));
    // 反空转（2）：确实识别到了脱敏调用点（否则「无违规」只是因为脱敏调用没被认出来）。
    expect(maskingCallSites, '识别到的脱敏调用点数（masker.apply / sanitizeUrl / maskUrl 等）').toBeGreaterThanOrEqual(5);
    // 反空转（3）：确实识别到了截断/切片调用点。
    expect(truncationCallSites, '识别到的截断/切片调用点数').toBeGreaterThanOrEqual(10);

    const reported = violations.map(formatViolation);
    expect(
      reported,
      `以下位置先截断后脱敏（截断会把敏感值切成不再匹配规则的残片，残片会原样上线；` +
        `正确方向是 truncate(masker.apply(value), max)）：\n${reported.join('\n')}`,
    ).toEqual([]);
  });

  test('判别力：合成的「先截断后脱敏」反例必须被抓到', () => {
    // 反例 1：先 slice 到变量，再把变量交给 masker（本根因最常见的形状）。
    const sliceThenMask = [
      'function f(input: string, masker: Masker) {',
      '  const cut = input.slice(0, 8);',
      '  return masker.apply(cut);',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(sliceThenMask, 'synthetic-slice.ts').violations.map((v) => v.maskLine)).toEqual([3]);

    // 反例 2：先 truncate（自有函数），再脱敏。
    const truncateThenMask = [
      'function f(value: string, maxLength: number, masker: Masker) {',
      '  const shortened = truncate(value, maxLength);',
      '  return masker.apply(shortened);',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(truncateThenMask, 'synthetic-truncate.ts').violations.map((v) => v.maskLine)).toEqual([3]);

    // 反例 3：直接嵌套（不经过变量）。
    const nested = 'const out = masker.apply(value.substring(0, 2048));';
    expect(findTruncateBeforeMask(nested, 'synthetic-nested.ts').violations.map((v) => v.maskLine)).toEqual([1]);

    // 反例 4：事件字段（元素访问 / 成员访问）先截断、后脱敏——dimensions 与 attachment 的形状。
    const eventField = [
      'function handle(event: KernelEvent, masker: Masker) {',
      "  event['attachment'] = event['attachment'].slice(0, 8192);",
      "  const masked = masker.apply(event['attachment']);",
      '  return masked;',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(eventField, 'synthetic-event.ts').violations.map((v) => v.maskLine)).toEqual([3]);

    // 反例 5：padEnd 先把值补齐/撑开，再脱敏。
    const padThenMask = 'const padded = token.padEnd(64, "*");\nconst masked = masker.apply(padded);';
    expect(findTruncateBeforeMask(padThenMask, 'synthetic-pad.ts').violations.map((v) => v.maskLine)).toEqual([2]);

    // 反例 6：经过条件分支的截断值。
    const conditional = [
      'function f(value: string, masker: Masker) {',
      '  const maybe = value.length > 8 ? value.slice(0, 8) : value;',
      '  return masker.apply(maybe);',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(conditional, 'synthetic-conditional.ts').violations.map((v) => v.maskLine)).toEqual([3]);

    // 反例 7：跨赋值链（截断值先赋给第 2 个变量）。
    const chained = [
      'function f(value: string, masker: Masker) {',
      '  const first = value.slice(0, 4);',
      '  const second = first;',
      '  return masker.apply(second);',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(chained, 'synthetic-chain.ts').violations.map((v) => v.maskLine)).toEqual([4]);

    // 反例 8：裸的脱敏函数（`sanitizeXxx` / `maskXxx`）收到截断值。
    const bareMasker = [
      'function f(url: string) {',
      '  const cut = url.slice(0, 2048);',
      '  return sanitizeUrl(cut, [], createMasker());',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(bareMasker, 'synthetic-bare.ts').violations.map((v) => v.maskLine)).toEqual([3]);
  });

  test('不误报：先脱敏后截断的现有正确写法一条都不许报', () => {
    // 正确 1：client.ts 的 `clampAndTrack` —— 脱敏是截断的实参。
    const nested = 'function clampAndTrack(value: string, maxLength: number, masker: Masker) {\n  return truncate(masker.apply(value), maxLength);\n}';
    expect(findTruncateBeforeMask(nested, 'correct-nested.ts').violations).toEqual([]);

    // 正确 2：constraints.ts 的 `constrainStringMap` —— 先脱敏到变量，再按长度截断。
    const maskedThenTruncate = [
      'function f(entry: string, masker: Masker, max: number) {',
      '  const masked = masker.apply(entry);',
      '  if (masked.length > max) return truncateUtf16Safe(masked, max);',
      '  return masked;',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(maskedThenTruncate, 'correct-masked.ts').violations).toEqual([]);

    // 正确 3：constraints.ts 的 `clampAttachment` —— 事件字段先脱敏、再按字节截断。
    const attachment = [
      'function clampAttachment(event: KernelEvent, masker: Masker, maxBytes: number) {',
      "  const attachment = event['attachment'];",
      '  const masked = masker.apply(attachment);',
      "  event['attachment'] = truncateToBytes(masked, maxBytes);",
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(attachment, 'correct-attachment.ts').violations).toEqual([]);

    // 正确 4：url.ts 的 `sanitizeUrl` —— 解析出的路径/参数值先脱敏，重建后才截断。
    const url = [
      'function sanitizeUrl(url: string, allowlist: readonly string[], masker: Masker, maxLength: number) {',
      '  const parts = parseUrlParts(url);',
      '  const maskedPath = masker.apply(parts.pathname);',
      '  const queryText = parts.query.map(([key, value]) => `${key}=${masker.apply(value)}`).join("&");',
      '  const rebuilt = `${parts.origin}${maskedPath}${queryText}`;',
      '  return rebuilt.length > maxLength ? truncateUtf16Safe(rebuilt, maxLength) : rebuilt;',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(url, 'correct-url.ts').violations).toEqual([]);

    // 正确 5：同一个名字先被截断、后又被同名**形参**遮蔽 —— 遮蔽后的值是原样输入，不得报。
    const shadowed = [
      'const cut = value.slice(0, 8);',
      'function f(cut: string, masker: Masker) {',
      '  return masker.apply(cut);',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(shadowed, 'correct-shadow.ts').violations).toEqual([]);

    // 正确 6：值本身没有截断，只是后来被截断 —— 脱敏的实参仍是原值。
    const maskThenSlice = [
      'function f(value: string, max: number, masker: Masker) {',
      '  const masked = masker.apply(value);',
      '  return masked.slice(0, max);',
      '}',
    ].join('\n');
    expect(findTruncateBeforeMask(maskThenSlice, 'correct-order.ts').violations).toEqual([]);
  });
});
