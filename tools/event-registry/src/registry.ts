/**
 * 注册表加载与注册表级检查（K01-F1、K01-F3）。
 *
 * 读取 `events/*.json`，逐个按契约 Schema 校验（Ajv 2020），再检查：
 * - 同名同版本重复定义（K01-AC-07）
 * - critical 事件配额不超过事件总数的 10%（K01-F3、Q3）
 * - metric 字段名后缀与 unit 一致（契约 `unit` 描述）
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ValidateFunction } from 'ajv';
import {
  checkSemanticRules,
  computeCriticalQuota,
  parseEventDefinition,
  validateEventDefinition,
  type DefinitionProblem,
  type EventDefinition,
  type Registry,
} from './definitions.js';

/** 注册表加载选项。 */
export interface LoadRegistryOptions {
  /** 事件定义路径：目录、glob（`events/*.json`）或单个文件。 */
  eventsDir: string;
  /** 输出相对路径时使用的根目录。 */
  repoRoot: string;
  /** 只用 Schema 校验器（默认是与契约一致的 Ajv 2020 校验器）。 */
  schemaValidator?: ValidateFunction;
  /** 只加载满足条件的文件（相对路径）。 */
  include?: (relativePath: string) => boolean;
}

/** 默认不参与注册表的文件名（工具的导出物或索引）。 */
const DEFAULT_EXCLUDED_NAMES = new Set(['registry.index.json', '.registry.json']);

/**
 * 把 glob 模式展开成文件列表。
 *
 * 支持：目录（自动展开为 `<目录>/*.json`）、`dir/*.json`、`dir/子目录/*.json`
 * 与单个文件路径。
 */
export async function resolveGlobFiles(pattern: string): Promise<string[]> {
  const resolved = resolve(pattern);
  if (await directoryExists(resolved)) {
    return resolveGlobFiles(join(resolved, '*.json'));
  }
  if (!resolved.includes('*')) {
    return [resolved];
  }
  const starIndex = resolved.indexOf('*');
  const prefix = resolved.slice(0, starIndex);
  const lastSlash = prefix.lastIndexOf(sep);
  const baseDir = lastSlash <= 0 ? sep : prefix.slice(0, lastSlash);
  const patternText = `*${resolved.slice(prefix.length)}`;
  const matches: string[] = [];
  await collectMatches(baseDir, patternText, matches);
  return matches.sort();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function collectMatches(directory: string, patternText: string, matches: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectMatches(fullPath, patternText, matches);
    } else if (entry.isFile() && matchesGlob(entry.name, patternText)) {
      matches.push(fullPath);
    }
  }
}

/**
 * 单层文件名 glob：`*` 匹配任意字符（包括点，因此 `*.json` 能匹配
 * `checkout_order_complete.v3.json`），`?` 匹配单个字符。
 *
 * 目录层级由 `collectMatches` 的递归处理；`**` 与多段模式不看这个函数。
 */
export function matchesGlob(name: string, patternText: string): boolean {
  return globToRegExp(patternText).test(name);
}

/** 把单层 glob 编译成正则（只处理 `*` 与 `?`）。 */
export function globToRegExp(patternText: string): RegExp {
  const escaped = patternText.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** 加载并校验一个注册表。 */
export async function loadRegistry(options: LoadRegistryOptions): Promise<Registry> {
  const { eventsDir, repoRoot } = options;
  const globRoot = rootFor(eventsDir, repoRoot);
  const isIncluded = options.include ?? ((path: string) => !DEFAULT_EXCLUDED_NAMES.has(path.split(sep).at(-1) ?? ''));
  const errors: DefinitionProblem[] = [];
  const events: EventDefinition[] = [];
  const files: string[] = [];

  const candidates = await resolveGlobFiles(eventsDir);
  const jsonFiles: string[] = [];
  for (const file of candidates) {
    if (!file.endsWith('.json')) continue;
    if (!isIncluded(relative(globRoot, file))) continue;
    jsonFiles.push(file);
  }

  const directFile = !eventsDir.includes('*') && jsonFiles.length === 1;
  if (jsonFiles.length === 0 || (directFile && !(await fileExists(jsonFiles[0] ?? '')))) {
    return {
      events: [],
      files: [],
      errors: [
        {
          code: 'registry_empty',
          message: `没有找到任何事件定义：${eventsDir}（期望 events/*.json）`,
          path: '',
          file: eventsDir,
        },
      ],
      criticalQuota: computeCriticalQuota([]),
    };
  }

  for (const file of jsonFiles) {
    const relativePath = relativePathOf(file, repoRoot);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      errors.push({
        code: 'file_unreadable',
        message: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        path: '',
        file: relativePath,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({
        code: 'invalid_json',
        message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        path: '/(根)',
        file: relativePath,
      });
      continue;
    }
    const validation =
      options.schemaValidator === undefined
        ? validateEventDefinition(parsed)
        : validateEventDefinition(parsed, options.schemaValidator);
    if (!validation.ok) {
      for (const problem of validation.errors) {
        errors.push({ ...problem, file: relativePath });
      }
      continue;
    }
    const definition = parseEventDefinition(parsed, relativePath);
    errors.push(...checkSemanticRules(definition).map((problem) => ({ ...problem, file: relativePath })));
    events.push(definition);
    files.push(relativePath);
  }

  errors.push(...findDuplicateVersions(events));

  return {
    events: sortEvents(events),
    files: [...new Set(files)].sort(),
    errors,
    criticalQuota: computeCriticalQuota(events),
  };
}

/** 同名同版本的重复定义（K01-AC-07）。 */
export function findDuplicateVersions(events: readonly EventDefinition[]): DefinitionProblem[] {
  const seen = new Map<string, EventDefinition>();
  const problems: DefinitionProblem[] = [];
  for (const event of events) {
    const key = `${event.eventName}@${String(event.schemaVersion)}`;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, event);
      continue;
    }
    problems.push({
      code: 'version_duplicate',
      message: `事件 ${event.eventName} 的 schema_version ${String(event.schemaVersion)} 被重复定义：${previous.sourceFile} 与 ${event.sourceFile}`,
      path: '/schema_version',
      eventName: event.eventName,
      file: event.sourceFile,
    });
  }
  return problems;
}

/** 稳定排序：事件名升序、版本升序。 */
export function sortEvents(events: readonly EventDefinition[]): EventDefinition[] {
  return [...events].sort((left, right) => {
    if (left.eventName !== right.eventName) return left.eventName < right.eventName ? -1 : 1;
    return left.schemaVersion - right.schemaVersion;
  });
}

/** 取路径相对仓库根目录的展示形式。 */
export function relativePathOf(file: string, repoRoot: string): string {
  const absolute = resolve(file);
  const root = resolve(repoRoot);
  if (absolute === root) return '.';
  if (absolute.startsWith(root + sep)) return relative(root, absolute);
  return absolute;
}

/** glob 的根目录（用于计算相对展示路径）。 */
export function rootFor(pattern: string, repoRoot: string): string {
  const absolute = resolve(pattern);
  const starIndex = absolute.indexOf('*');
  if (starIndex < 0) return dirname(absolute);
  const prefix = absolute.slice(0, starIndex);
  const lastSlash = prefix.lastIndexOf(sep);
  return lastSlash <= 0 ? repoRoot : prefix.slice(0, lastSlash);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
