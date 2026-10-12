import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * T10 契约测试的路径常量与 JSON 读取工具。
 *
 * 契约（docs/contracts/**）是只读的：本目录的代码只读取契约文件，绝不写入。
 * 所有路径都相对仓库根目录解析，测试与工作树位置无关。
 */
export const repoRoot = resolve(import.meta.dirname, '../../..');
export const contractsDir = join(repoRoot, 'docs/contracts');
export const schemasDir = join(contractsDir, 'schemas');
export const examplesDir = join(contractsDir, 'examples');
export const builtinExamplesDir = join(examplesDir, 'builtin-events');
export const compatPairsDir = join(examplesDir, 'compat-pairs');
export const receiverRequirementsFile = join(contractsDir, 'receiver-requirements.md');

/** 绝对路径 → 相对仓库根目录的路径（用于测试名与清单，保持可读）。 */
export const repoPath = (absoluteFilePath: string): string => relative(repoRoot, absoluteFilePath);

/** 相对仓库根目录的路径 → 绝对路径。 */
export const absolutePath = (repoRelativePath: string): string => join(repoRoot, repoRelativePath);

/** 读取并解析一个 JSON 文件。JSON.parse 的 any 在此显式收窄为 unknown。 */
export const readJsonFile = (absoluteFilePath: string): unknown => {
  const text = readFileSync(absoluteFilePath, 'utf8');
  return JSON.parse(text) as unknown;
};

/** 读取一个 UTF-8 文本文件（用于解析契约 Markdown）。 */
export const readTextFile = (absoluteFilePath: string): string => readFileSync(absoluteFilePath, 'utf8');

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value;
};

export const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 数组`);
  }
  return value;
};

export const requireString = (record: Record<string, unknown>, key: string, label: string): string => {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`${label}.${key} 必须是字符串`);
  }
  return value;
};

export const requireInteger = (record: Record<string, unknown>, key: string, label: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label}.${key} 必须是整数`);
  }
  return value;
};

export const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
};
