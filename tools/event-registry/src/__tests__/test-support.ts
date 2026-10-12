/**
 * K01 测试支持（非 `.test.ts`，不会被 Vitest 收集）。
 *
 * 只用 Node 内置模块：定位仓库契约样例、读写临时目录、组装注册表夹具。
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（`temp/wt-T22`）。 */
export const REPO_ROOT = resolveRepoRoot();

function resolveRepoRoot(): string {
  try {
    const candidate = fileURLToPath(new URL('../../../../', import.meta.url));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {
    // happy-dom 下 import.meta.url 可能不是 file: URL，走 cwd 兜底
  }
  const candidate = resolve(process.cwd());
  if (existsSync(join(candidate, 'package.json'))) return candidate;
  throw new Error('找不到仓库根目录，请在仓库根目录运行测试');
}

/** 事件定义元模型（契约 0.2）。 */
export const CONTRACT_SCHEMA_PATH = join(REPO_ROOT, 'docs/contracts/schemas/event-definition.schema.json');
/** 合法的单事件定义样例。 */
export const VALID_DEFINITION_PATH = join(REPO_ROOT, 'docs/contracts/examples/event-definition.valid.json');
/** 非法事件定义样例集合。 */
export const INVALID_DEFINITIONS_PATH = join(REPO_ROOT, 'docs/contracts/examples/event-definition.invalid.json');
/** 兼容性规则样例对目录（T06 产出）。 */
export const COMPAT_PAIRS_DIR = join(REPO_ROOT, 'docs/contracts/examples/compat-pairs');

/** 读取 JSON 文件。 */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** 兼容性规则样例对索引中的一条。 */
export interface CompatPairEntry {
  id: string;
  verdict: 'compatible' | 'breaking' | 'no_version_bump';
  verdict_zh: string;
  old: string;
  new: string;
  expected: {
    schema_version_delta: number;
    version_incremented: boolean;
    k01_exit_code: string;
  };
  change_summary: string;
  table_row?: number;
}

/** 兼容性规则样例对索引。 */
export interface CompatIndex {
  pairs: CompatPairEntry[];
  supplementary: CompatPairEntry[];
}

/** 读取兼容性规则样例对索引。 */
export async function readCompatIndex(): Promise<CompatIndex> {
  return (await readJsonFile(join(COMPAT_PAIRS_DIR, 'index.json'))) as CompatIndex;
}

/** 读取样例对中的某一侧定义。 */
export async function readCompatSide(file: string): Promise<Record<string, unknown>> {
  return (await readJsonFile(join(COMPAT_PAIRS_DIR, file))) as Record<string, unknown>;
}

/** 建一个临时目录，并在用例结束后删除。 */
export async function makeTempDir(prefix = 'k01-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 删除临时目录（失败时不抛出，避免污染测试结果）。 */
export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** 把事件定义写进 `<root>/events/*.json`。 */
export async function writeRegistry(
  root: string,
  files: Readonly<Record<string, unknown>>,
): Promise<string> {
  const eventsDir = join(root, 'events');
  await mkdir(eventsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(eventsDir, name), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  }
  return eventsDir;
}

/** 事件定义夹具的可覆盖字段。 */
export interface DefinitionOverrides {
  event_name?: string;
  schema_version?: number;
  event_type?: string;
  description?: string;
  owner?: string;
  trigger?: string;
  priority?: string;
  critical_reason?: string;
  status?: string;
  app_ids?: string[];
  fields?: unknown[];
  change_note?: string;
  replaces_version?: number;
}

/** 组装一份合法的事件定义夹具（默认 normal + active，可覆盖任意字段）。 */
export function makeDefinition(overrides: DefinitionOverrides = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event_name: 'task_submit_complete',
    schema_version: 1,
    event_type: 'custom',
    description: '标注任务提交成功',
    owner: 'team-annotation',
    trigger: '提交接口返回成功、界面显示提交成功提示时上报一次',
    priority: 'normal',
    status: 'active',
    fields: [
      {
        name: 'task_type',
        kind: 'dimension',
        type: 'enum',
        required: true,
        description: '任务类型',
        enum_values: ['label', 'review', 'qa'],
        sensitivity: 'none',
      },
      {
        name: 'duration_ms',
        kind: 'metric',
        type: 'integer',
        required: true,
        description: '从打开任务到提交的耗时',
        minimum: 0,
        unit: 'ms',
        sensitivity: 'none',
      },
    ],
  };
  return { ...base, ...overrides };
}

/** 组装一个 dimension 字段。 */
export function dimension(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    kind: 'dimension',
    type: 'string',
    required: false,
    description: `字段 ${name}`,
    sensitivity: 'none',
    ...overrides,
  };
}

/** 组装一个 metric 字段。 */
export function metric(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    kind: 'metric',
    type: 'integer',
    required: false,
    description: `字段 ${name}`,
    unit: 'count',
    sensitivity: 'none',
    ...overrides,
  };
}

/** 生成 `count` 份互不重名的合法事件定义（用于配额与性能用例）。 */
export function makeDefinitions(count: number, prefix = 'perf'): Record<string, unknown>[] {
  const list: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    list.push(
      makeDefinition({
        event_name: `${prefix}_event_${String(index).padStart(4, '0')}`,
        schema_version: 1,
        description: `性能用例事件 ${String(index)}`,
        owner: 'team-perf',
        trigger: '本地性能用例触发一次',
        fields: [dimension('scene', { required: true, max_length: 32 }), metric('elapsed_ms', { unit: 'ms' })],
      }),
    );
  }
  return list;
}
