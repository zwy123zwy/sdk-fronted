#!/usr/bin/env node
/**
 * K01 CLI：事件注册表校验、类型生成、规则导出与未登记事件报告。
 *
 * 退出码约定（指南第 11 节：失败时返回非零退出码，并输出可读错误）：
 * - 0：命令成功（含 `report-unregistered` 的报告结果）
 * - 1：检查未通过（校验失败、兼容性破坏性变更、未递增版本、critical 配额超限）
 * - 2：用法或运行环境错误（未知子命令、缺参数、注册表/基线/清单不可读）
 */
import { readFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { compareRegistries, formatCompatibilityReport } from './compat.js';
import { loadSchemaValidator, type DefinitionProblem, type Registry } from './definitions.js';
import { toGeneratedTypes } from './generate.js';
import { loadRegistry, rootFor } from './registry.js';
import { DEFAULT_KEEP_VERSIONS, buildValidationRules } from './rules.js';
import { archiveGitSnapshot, gitRoot, writeOutputFile } from './snapshot.js';
import {
  formatUnregisteredReport,
  parseObservedEvents,
  registryEventNames,
  toUnregisteredReport,
} from './unregistered.js';

/** CLI 子命令。 */
export type Command = 'check' | 'generate' | 'export-rules' | 'report-unregistered';

/** 解析后的命令行选项。 */
export interface CliOptions {
  command: Command;
  cwd: string;
  registry: string;
  baselineDir?: string;
  baselineGit?: string;
  allowBreaking: boolean;
  schemaPath?: string;
  out?: string;
  eventsFile?: string;
  keepVersions: number;
  registryName?: string;
  help: boolean;
}

/** CLI 输出接口。 */
export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** 退出码常量。 */
export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_USAGE = 2;

const COMMANDS: readonly Command[] = ['check', 'generate', 'export-rules', 'report-unregistered'];

/** 用法文本。 */
export const USAGE = `用法：web-report-event-registry <子命令> [选项]

子命令：
  check                校验事件定义、critical 配额与（可选）兼容性
  generate             生成 TypeScript 类型声明（K01-F4）
  export-rules         导出接收方运行期校验规则 JSON（K01-F5）
  report-unregistered  报告清单中未登记的事件及出现次数（K01-F6）

选项：
  --registry <路径>       事件定义位置，支持目录、glob（events/*.json）或单文件（默认 events/*.json）
  --cwd <目录>            工作目录：解析 --registry / --baseline-dir 与 git 仓库（默认当前目录）
  --baseline-dir <目录>   兼容性基线：一份基线注册表快照目录（与 --baseline-git 二选一）
  --baseline-git <引用>   兼容性基线：git 引用（HEAD、main、commit-ish）
  --allow-breaking        放行"已递增版本的破坏性变更"；未递增版本仍然失败（K01-AC-05）
  --schema <文件>         用自带的 JSON Schema 2020-12 文件替换内置元模型（默认内置 = 契约 0.2）
  --out <文件>            generate / export-rules 的输出文件；省略时写到标准输出
  --events <文件>         report-unregistered 的事件名清单（JSON 数组或 JSONL）
  --keep-versions <数量>  export-rules 每个事件保留的版本数（默认 ${String(DEFAULT_KEEP_VERSIONS)}，范围 1–10）
  --registry-name <名称>  export-rules / report-unregistered 写入的注册表名称（默认 workspace）
  --help                  显示本说明

退出码：0 成功；1 检查未通过；2 用法或运行环境错误。`;

/** 解析命令行参数；遇到非法用法抛出可读错误。 */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: 'check',
    cwd: process.cwd(),
    registry: 'events/*.json',
    allowBreaking: false,
    keepVersions: DEFAULT_KEEP_VERSIONS,
    help: false,
  };
  let commandSeen = false;
  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} 缺少取值`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    switch (flag) {
      case '--help':
      case '-h': {
        options.help = true;
        break;
      }
      case '--registry': {
        options.registry = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--cwd': {
        options.cwd = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--baseline-dir': {
        options.baselineDir = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--baseline-git': {
        options.baselineGit = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--allow-breaking': {
        options.allowBreaking = true;
        break;
      }
      case '--schema': {
        options.schemaPath = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--out': {
        options.out = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--events': {
        options.eventsFile = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--registry-name': {
        options.registryName = takeValue(flag, index);
        index += 1;
        break;
      }
      case '--keep-versions': {
        const raw = takeValue(flag, index);
        const parsed = Number.parseInt(raw, 10);
        if (!/^\d+$/.test(raw) || parsed < 1 || parsed > 10) {
          throw new Error(`--keep-versions 必须是 1–10 的整数：${raw}`);
        }
        options.keepVersions = parsed;
        index += 1;
        break;
      }
      default: {
        if (flag.startsWith('-')) {
          throw new Error(`未知参数：${flag}`);
        }
        if (commandSeen) {
          throw new Error(`多余的位置参数：${flag}`);
        }
        if (!(COMMANDS as readonly string[]).includes(flag)) {
          throw new Error(`未知子命令：${flag}`);
        }
        options.command = flag as Command;
        commandSeen = true;
      }
    }
  }
  if (options.baselineDir !== undefined && options.baselineGit !== undefined) {
    throw new Error('--baseline-dir 与 --baseline-git 只能选一个');
  }
  return options;
}

/** 命令主流程，返回退出码。 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`K01 用法错误：${error instanceof Error ? error.message : String(error)}`);
    io.stderr(USAGE);
    return EXIT_USAGE;
  }
  if (options.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }

  try {
    switch (options.command) {
      case 'check':
        return await runCheck(options, io);
      case 'generate':
        return await runGenerate(options, io);
      case 'export-rules':
        return await runExportRules(options, io);
      case 'report-unregistered':
        return await runReportUnregistered(options, io);
      default:
        io.stderr(`K01 未知子命令：${String(options.command)}`);
        return EXIT_USAGE;
    }
  } catch (error) {
    io.stderr(`K01 运行失败：${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }
}

/** 校验并返回注册表；Schema/文件问题写进 `problems`。 */
async function loadRegistryOrReport(
  options: CliOptions,
  problems: DefinitionProblem[],
): Promise<Registry> {
  const cwd = resolve(options.cwd);
  const validator = options.schemaPath === undefined ? undefined : loadSchemaValidator(resolve(cwd, options.schemaPath));
  const registry = await loadRegistry({
    eventsDir: resolve(cwd, options.registry),
    repoRoot: cwd,
    ...(validator === undefined ? {} : { schemaValidator: validator }),
  });
  problems.push(...registry.errors);
  if (registry.events.length === 0 && registry.errors.length === 0) {
    problems.push({
      code: 'registry_empty',
      message: `没有找到任何事件定义：${resolve(cwd, options.registry)}（期望 events/*.json）`,
      path: '',
      file: options.registry,
    });
  }
  return registry;
}

/** `check`：校验 + 配额 + 可选兼容性对比。 */
async function runCheck(options: CliOptions, io: CliIo): Promise<number> {
  const problems: DefinitionProblem[] = [];
  const registry = await loadRegistryOrReport(options, problems);

  io.stdout(`注册表：${String(registry.files.length)} 个事件定义文件，${String(registry.events.length)} 个事件（含历史版本）`);
  io.stdout(`critical 配额：${registry.criticalQuota.message}`);
  if (!registry.criticalQuota.ok) {
    problems.push({
      code: 'critical_quota_exceeded',
      message: registry.criticalQuota.message,
      path: '/priority',
    });
  }

  if (options.baselineDir !== undefined || options.baselineGit !== undefined) {
    const baseline = await loadBaseline(options);
    if (baseline !== null) {
      problems.push(...baseline.problems);
      const report = compareRegistries(baseline.registry, registry);
      for (const line of formatCompatibilityReport(report)) io.stdout(line);
      const breaking = report.changes.filter((change) => change.breaking);
      const blocking = report.problems.length > 0 || (breaking.length > 0 && !options.allowBreaking);
      if (blocking) {
        const reason =
          report.problems.length > 0
            ? '存在未递增 schema_version 的字段修改'
            : '存在破坏性变更，未传 --allow-breaking';
        problems.push({
          code: 'compatibility_failed',
          message: `兼容性检查未通过：${reason}（dictionary-compat.md；未递增版本必须递增版本，破坏性变更需评审批准）`,
          path: '',
        });
      } else if (breaking.length > 0) {
        io.stdout('提示：破坏性变更已被 --allow-breaking 放行，仍需接入方数据负责人在代码评审中批准。');
      }
    }
  } else if (registry.errors.length === 0) {
    io.stdout('兼容性检查：未提供基线（--baseline-git 或 --baseline-dir），已跳过');
  }

  if (problems.length > 0) {
    io.stderr(`K01 check 失败：${String(problems.length)} 个问题`);
    for (const problem of problems) io.stderr(`  - ${formatProblem(problem)}`);
    return EXIT_CHECK_FAILED;
  }
  io.stdout('K01 check 通过');
  return EXIT_OK;
}

/** `generate`：生成 TypeScript 类型声明。 */
async function runGenerate(options: CliOptions, io: CliIo): Promise<number> {
  const problems: DefinitionProblem[] = [];
  const registry = await loadRegistryOrReport(options, problems);
  if (problems.length > 0) {
    io.stderr(`K01 generate 失败：注册表校验未通过（${String(problems.length)} 个问题）`);
    for (const problem of problems) io.stderr(`  - ${formatProblem(problem)}`);
    return EXIT_CHECK_FAILED;
  }
  const text = toGeneratedTypes(registry.events);
  if (options.out === undefined) {
    io.stdout(text);
  } else {
    const out = resolve(resolve(options.cwd), options.out);
    await writeOutputFile(out, text);
    io.stdout(`已生成类型声明：${relative(resolve(options.cwd), out)}（${String(registry.events.length)} 个事件定义，含历史版本）`);
  }
  return EXIT_OK;
}

/** `export-rules`：导出运行期校验规则 JSON。 */
async function runExportRules(options: CliOptions, io: CliIo): Promise<number> {
  const problems: DefinitionProblem[] = [];
  const registry = await loadRegistryOrReport(options, problems);
  if (problems.length > 0) {
    io.stderr(`K01 export-rules 失败：注册表校验未通过（${String(problems.length)} 个问题）`);
    for (const problem of problems) io.stderr(`  - ${formatProblem(problem)}`);
    return EXIT_CHECK_FAILED;
  }
  const rules = buildValidationRules(registry.events, {
    registryName: options.registryName ?? 'workspace',
    generatedAt: Date.now(),
    keepVersions: options.keepVersions,
  });
  const text = `${JSON.stringify(rules, null, 2)}\n`;
  if (options.out === undefined) {
    io.stdout(text.trimEnd());
  } else {
    const cwd = resolve(options.cwd);
    const out = resolve(cwd, options.out);
    await writeOutputFile(out, text);
    io.stdout(
      `已导出运行期校验规则：${relative(cwd, out)}（${String(rules.events.length)} 个事件，每个保留最近 ${String(rules.keep_versions)} 个版本）`,
    );
  }
  return EXIT_OK;
}

/** `report-unregistered`：报告清单中未登记的事件。 */
async function runReportUnregistered(options: CliOptions, io: CliIo): Promise<number> {
  if (options.eventsFile === undefined) {
    io.stderr('K01 用法错误：report-unregistered 需要 --events <清单文件>');
    io.stderr(USAGE);
    return EXIT_USAGE;
  }
  const problems: DefinitionProblem[] = [];
  const registry = await loadRegistryOrReport(options, problems);
  if (problems.length > 0) {
    io.stderr(`K01 report-unregistered 失败：注册表校验未通过（${String(problems.length)} 个问题）`);
    for (const problem of problems) io.stderr(`  - ${formatProblem(problem)}`);
    return EXIT_CHECK_FAILED;
  }
  const cwd = resolve(options.cwd);
  let text: string;
  try {
    text = await readFile(resolve(cwd, options.eventsFile), 'utf8');
  } catch (error) {
    io.stderr(
      `K01 运行失败：无法读取事件名清单 ${options.eventsFile}：${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_USAGE;
  }
  const parsed = parseObservedEvents(text);
  for (const parseError of parsed.errors) io.stderr(`清单解析提示：${parseError}`);
  const report = toUnregisteredReport({
    registryNames: registryEventNames(registry.events),
    observed: parsed.names,
    registryName: options.registryName ?? 'workspace',
    keepVersions: options.keepVersions,
  });
  for (const line of formatUnregisteredReport(report)) io.stdout(line);
  return EXIT_OK;
}

/** 读取基线快照（目录或 git 引用）。读不到时返回 `null` 并把问题写进 `problems`。 */
async function loadBaseline(
  options: CliOptions,
): Promise<{ registry: Registry; problems: DefinitionProblem[] } | null> {
  const cwd = resolve(options.cwd);
  const problems: DefinitionProblem[] = [];
  if (options.baselineDir !== undefined) {
    const baselineDir = resolve(cwd, options.baselineDir);
    const registry = await loadRegistry({ eventsDir: baselineDir, repoRoot: cwd });
    if (registry.events.length === 0 && registry.errors.length === 0) {
      problems.push({
        code: 'baseline_missing',
        message: `基线目录里没有事件定义：${options.baselineDir}`,
        path: '',
        file: options.baselineDir,
      });
    }
    return { registry, problems };
  }
  // `--registry` 可能是 glob（events/*.json）；git 基线要的是目录，取 glob 的根。
  // 两边都取真实路径，避免 macOS 的 /var 与 /private/var 被当成两棵不同的树。
  const registryRoot = await realpath(rootFor(resolve(cwd, options.registry), cwd));
  const repoRoot = await gitRoot(cwd);
  const subPath = relative(repoRoot, registryRoot).split('\\').join('/');
  const snapshot = await archiveGitSnapshot({
    cwd,
    gitRef: options.baselineGit ?? 'HEAD',
    subPath,
  });
  try {
    const registry = await loadRegistry({ eventsDir: snapshot.directory, repoRoot: cwd });
    return { registry, problems };
  } finally {
    await snapshot.cleanup();
  }
}

/** 渲染一个问题：文件名 + 字段路径 + 说明。 */
function formatProblem(problem: DefinitionProblem): string {
  const file = problem.file === undefined ? '' : problem.file;
  const path = problem.path === '' ? '' : ` 字段路径 ${problem.path}`;
  const event = problem.eventName === undefined ? '' : `（事件 ${problem.eventName}）`;
  return `${problem.code}：${file}${event}${path} —— ${problem.message}`;
}

/** 直接执行 `cli.js`（或源码 `cli.ts`）时运行命令。 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const name = entry.slice(entry.lastIndexOf('/') + 1);
  return name === 'cli.js' || name === 'cli.ts';
}

if (isMainModule()) {
  runCli(process.argv.slice(2), {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`K01 未捕获错误：${String(error)}\n`);
      process.exitCode = EXIT_USAGE;
    });
}
