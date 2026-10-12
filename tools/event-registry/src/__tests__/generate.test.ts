/**
 * K01 验收用例：类型声明生成（K01-AC-08、09）与运行期校验规则导出（K01-AC-10）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { toGeneratedTypes } from '../generate.js';
import { loadRegistry } from '../registry.js';
import { RUNTIME_RULES_SCHEMA, RUNTIME_RULES_SCHEMA_ID, buildValidationRules, validateRuntimeRules } from '../rules.js';
import {
  REPO_ROOT,
  VALID_DEFINITION_PATH,
  dimension,
  makeDefinition,
  makeTempDir,
  metric,
  readJsonFile,
  removeTempDir,
  writeRegistry,
} from './test-support.js';

/** 由生成的类型组成的调用样例：全部应当编译通过（按与 T12 约定的字典形状书写）。 */
const ADMISSIBLE_TYPES = `import type {
  DimensionsPayload,
  EventDefinitions,
  EventEntry,
  EventName,
  EventPayload,
  EventRegistry,
  FieldSpec,
  MetricsPayload,
  OptionalFieldNames,
  PickOptional,
  PickRequired,
  RequiredFieldNames,
} from './generated-types.js';

// 字典是「事件名 -> 事件定义」的映射，事件名保留为字面量
declare const definitions: EventDefinitions;
export type RegisteredName = keyof EventDefinitions;
export const name: EventName = 'task_submit_complete';
export const allNames: EventName[] = ['task_submit_complete', 'media_play_start'];
export const registryKeys: (keyof EventRegistry)[] = ['task_submit_complete', 'media_play_start'];

// 每个事件定义携带 priority 与 schema_version 字面量（Q3：业务代码不能在调用时改变等级）
export const priority: 'normal' = definitions.task_submit_complete.priority;
export const version: 1 = definitions.task_submit_complete.schema_version;
export const entry: EventEntry<'task_submit_complete'> = definitions.task_submit_complete;

// 字段规格：enum 是字面量联合、必填为 true、可选为 false
export const taskType: FieldSpec<'label' | 'review' | 'qa', true> =
  definitions.task_submit_complete.dimensions.task_type;
export const requiredFlag: true = definitions.task_submit_complete.dimensions.task_type.required;
export const optionalFlag: false = definitions.task_submit_complete.dimensions.result!.required;
export const duration: FieldSpec<number, true> = definitions.task_submit_complete.metrics.duration_ms;
export const autoplay: FieldSpec<boolean, true> = definitions.media_play_start.dimensions.can_autoplay;

// README 5.2 的两种投影写法都必须可用（消费侧可选性探测）
export type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
export type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
export type Dims = EventEntry<'task_submit_complete'>['dimensions'];
export const requiredKeys: RequiredKeys<Dims>[] = ['task_type'];
export const optionalKeys: OptionalKeys<Dims>[] = ['result'];
export const requiredProjection: PickRequired<Dims> = { task_type: 'review' };
export const optionalProjection: PickOptional<Dims> = { result: 'pass' };
export type RequiredNames = RequiredFieldNames<Dims>;
export type OptionalNames = OptionalFieldNames<Dims>;
export const requiredNames: RequiredNames[] = ['task_type'];
export const optionalNames: OptionalNames[] = ['result'];
export type DimensionsOnly = DimensionsPayload<'task_submit_complete'>;
export type MetricsOnly = MetricsPayload<'task_submit_complete'>;
export const dimsOnly: DimensionsOnly = { task_type: 'review' };
export const metricsOnly: MetricsOnly = { duration_ms: 1 };

// 负载类型：必填字段必需、可选字段带 ?、enum 为字面量、boolean 维度为 boolean
export const full: EventPayload<'task_submit_complete'> = {
  dimensions: { task_type: 'review' },
  metrics: { duration_ms: 1200 },
};

export const withOptionals: EventPayload<'task_submit_complete'> = {
  dimensions: { task_type: 'label', result: 'pass' },
  metrics: { duration_ms: 0, item_count: 3 },
};

export const booleanDimension: EventPayload<'media_play_start'> = {
  dimensions: { can_autoplay: true },
  metrics: {},
};
`;

/** 每一项只违反一条规则，必须编译失败。 */
const REJECTED_TYPES: Readonly<Record<string, string>> = {
  'unregistered-event-payload': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'task_submit_completed'> = { dimensions: {}, metrics: {} };
`,
  'unregistered-event-key': `import type { EventDefinitions } from './generated-types.js';
declare const definitions: EventDefinitions;
export const bad = definitions.task_submit_completed;
`,
  'reserved-prefix-name': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'web_custom_click'> = { dimensions: {}, metrics: {} };
`,
  'missing-required-field': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'task_submit_complete'> = {
  dimensions: { result: 'pass' },
  metrics: { duration_ms: 1 },
};
`,
  'missing-required-dimension-only': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'task_submit_complete'> = {
  metrics: { duration_ms: 1 },
};
`,
  'missing-required-metric-only': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'task_submit_complete'> = {
  dimensions: { task_type: 'review' },
};
`,
  'wrong-field-types': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'task_submit_complete'> = {
  dimensions: { task_type: 'review' },
  metrics: { duration_ms: '1200' },
};
`,
  'unknown-field': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'task_submit_complete'> = {
  dimensions: { task_type: 'review', unknown_scene: 'x' },
  metrics: { duration_ms: 1 },
};
`,
  'enum-value-not-in-list': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'task_submit_complete'> = {
  dimensions: { task_type: 'spot_check' },
  metrics: { duration_ms: 1 },
};
`,
  'boolean-dimension-wrong-type': `import type { EventPayload } from './generated-types.js';
export const bad: EventPayload<'media_play_start'> = {
  dimensions: { can_autoplay: 'yes' },
  metrics: {},
};
`,
  'priority-not-literal': `import type { TaskSubmitCompleteEntry } from './generated-types.js';
declare const entry: TaskSubmitCompleteEntry;
export const bad: 'critical' = entry.priority;
`,
  'version-not-literal': `import type { TaskSubmitCompleteEntry } from './generated-types.js';
declare const entry: TaskSubmitCompleteEntry;
export const bad: 2 = entry.schema_version;
`,
  'fieldspec-linear-string': `import type { EventPayload } from './generated-types.js';
// 维度值被宽化成 string 时，enum 校验就失效了；这里断言它没有被宽化
export const bad: EventPayload<'task_submit_complete'> = {
  dimensions: { task_type: 'review' },
  metrics: { duration_ms: 1 },
};
export type Widened = EventPayload<'task_submit_complete'>['dimensions']['task_type'];
export const widened: Widened = 'not_in_enum';
`,
};

const COMPILER_OPTIONS = {
  target: 'ES2020',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  lib: ['ES2022'],
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

/** 起子进程调用 tsc，返回退出码与输出。 */
async function compileWithTsc(directory: string, source: string): Promise<{ code: number; output: string }> {
  const fileName = `sample-${Math.random().toString(36).slice(2, 10)}.ts`;
  const filePath = join(directory, fileName);
  await writeFile(filePath, source, 'utf8');
  const configPath = join(directory, `tsconfig-${fileName.replace('.ts', '')}.json`);
  const config = { compilerOptions: COMPILER_OPTIONS, files: [fileName] };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const tscPath = join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
  expect(existsSync(tscPath), 'typescript 必须已安装').toBe(true);
  return new Promise((settle) => {
    const child = spawn(process.execPath, [tscPath, '-p', configPath], { cwd: directory });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      settle({ code: code ?? -1, output });
    });
  });
}

/** 生成类型到临时目录，返回生成的声明文本与目录。 */
async function generateTypesFor(
  root: string,
  files: Readonly<Record<string, unknown>>,
): Promise<{ typesText: string; directory: string }> {
  const eventsDir = await writeRegistry(root, files);
  const registry = await loadRegistry({ eventsDir, repoRoot: root });
  expect(registry.errors).toEqual([]);
  const typesText = toGeneratedTypes(registry.events);
  const directory = join(root, 'types');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'generated-types.ts'), typesText, 'utf8');
  return { typesText, directory };
}

describe('K01-AC-08 用 tsc --noEmit 编译生成类型的调用样例', () => {
  it('K01-AC-08 正确调用样例编译通过，错误样例全部报错', async () => {
    const root = await makeTempDir();
    try {
      const { typesText, directory } = await generateTypesFor(root, {
        'task.json': makeDefinition({
          event_name: 'task_submit_complete',
          priority: 'normal',
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
              name: 'result',
              kind: 'dimension',
              type: 'string',
              required: false,
              description: '审核结论',
              max_length: 32,
              sensitivity: 'none',
            },
            {
              name: 'duration_ms',
              kind: 'metric',
              type: 'integer',
              required: true,
              description: '提交耗时',
              minimum: 0,
              unit: 'ms',
              sensitivity: 'none',
            },
            {
              name: 'item_count',
              kind: 'metric',
              type: 'integer',
              required: false,
              description: '提交条数',
              unit: 'count',
              sensitivity: 'none',
            },
          ],
        }),
        'media.json': makeDefinition({
          event_name: 'media_play_start',
          description: '媒体开始播放',
          owner: 'team-media',
          trigger: '播放器进入播放状态时上报一次',
          fields: [dimension('can_autoplay', { type: 'boolean', required: true })],
        }),
      });

      const ok = await compileWithTsc(directory, ADMISSIBLE_TYPES);
      expect(ok.output, `正确样例不应报错：\n${ok.output}`).toBe('');
      expect(ok.code).toBe(0);

      for (const [label, source] of Object.entries(REJECTED_TYPES)) {
        const result = await compileWithTsc(directory, source);
        expect(result.output.length, `错误样例 ${label} 应当有错误信息`).toBeGreaterThan(0);
        expect(result.code, `错误样例 ${label} 应当编译失败`).not.toBe(0);
      }

      // 生成的文件只含类型声明：没有任何运行期值导出或表达式
      expect(typesText).toContain('export interface EventRegistry {');
      expect(typesText).toContain('export type EventDefinitions = EventRegistry;');
      expect(typesText).not.toMatch(/\bexport (const|let|var|function|class)\b/);
      expect(typesText).not.toMatch(/\b(function|class|=>|async|let|var|if|for|while|require)\b/);
    } finally {
      await removeTempDir(root);
    }
  }, 180_000);

  it('K01-AC-08 契约合法样例生成的类型也能被 tsc 接受', async () => {
    const root = await makeTempDir();
    try {
      const valid = await readJsonFile(VALID_DEFINITION_PATH);
      const { typesText } = await generateTypesFor(root, { 'task.json': valid });
      expect(typesText).toContain("'task_submit_complete'");
      expect(typesText).toContain('task_type');
    } finally {
      await removeTempDir(root);
    }
  }, 60_000);
});

describe('K01-AC-09 生成类型的形态', () => {
  it('K01-AC-09 每个事件名携带 priority 与 schema_version 字面量类型', async () => {
    const root = await makeTempDir();
    try {
      const valid = await readJsonFile(VALID_DEFINITION_PATH);
      const { typesText } = await generateTypesFor(root, { 'task.json': valid });
      expect(typesText).toContain("readonly priority: 'critical';");
      expect(typesText).toContain('readonly schema_version: 2;');
      expect(typesText).toContain('export interface TaskSubmitCompleteEntry');
      expect(typesText).toContain("'task_submit_complete': TaskSubmitCompleteEntry;");
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-09 只包含 active 事件的最新版本', async () => {
    const root = await makeTempDir();
    try {
      const { typesText } = await generateTypesFor(root, {
        'active_v1.json': makeDefinition({ event_name: 'active_event', schema_version: 1, fields: [dimension('scene', { required: true })] }),
        'active_v3.json': makeDefinition({ event_name: 'active_event', schema_version: 3, fields: [dimension('scene', { required: true })] }),
        'draft_v1.json': makeDefinition({ event_name: 'draft_event', schema_version: 1, status: 'draft', fields: [dimension('scene', { required: true })] }),
        'in_review_v1.json': makeDefinition({ event_name: 'review_event', schema_version: 1, status: 'in_review', fields: [dimension('scene', { required: true })] }),
        'deprecated_v1.json': makeDefinition({ event_name: 'deprecated_event', schema_version: 1, status: 'deprecated', fields: [dimension('scene', { required: true })] }),
        'retired_v1.json': makeDefinition({ event_name: 'retired_event', schema_version: 1, status: 'retired', fields: [dimension('scene', { required: true })] }),
      });
      expect(typesText).toContain('schema_version: 3');
      expect(typesText).not.toContain('schema_version: 1');
      expect(typesText).not.toContain('draft_event');
      expect(typesText).not.toContain('review_event');
      expect(typesText).not.toContain('deprecated_event');
      expect(typesText).not.toContain('retired_event');
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-09 必填字段为必需属性、enum 为字面量联合、boolean 维度为 boolean', async () => {
    const root = await makeTempDir();
    try {
      const { typesText } = await generateTypesFor(root, {
        'event.json': makeDefinition({
          event_name: 'shape_check',
          fields: [
            {
              name: 'kind',
              kind: 'dimension',
              type: 'enum',
              required: true,
              description: '类型',
              enum_values: ['alpha', 'beta'],
              sensitivity: 'none',
            },
            dimension('note'),
            dimension('flag', { type: 'boolean', required: true }),
            metric('latency_ms', { type: 'number', required: true, unit: 'ms' }),
          ],
        }),
      });
      expect(typesText).toMatch(/kind: FieldSpec<'alpha' \| 'beta', true>;/);
      expect(typesText).toMatch(/flag: FieldSpec<boolean, true>;/);
      expect(typesText).toMatch(/latency_ms: FieldSpec<number, true>;/);
      expect(typesText).toMatch(/note\?: FieldSpec<string, false>;/);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-10 导出运行期校验规则 JSON', () => {
  it('K01-AC-10 导出结果符合工具自带的规则 Schema，且每个事件保留最近 3 个版本', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      for (const version of [1, 2, 3, 4]) {
        files[`versioned_v${String(version)}.json`] = makeDefinition({
          event_name: 'versioned_event',
          schema_version: version,
          fields: [dimension('scene', { required: true }), metric('elapsed_ms', { unit: 'ms' })],
        });
      }
      files['single_v1.json'] = makeDefinition({
        event_name: 'single_event',
        schema_version: 1,
        fields: [dimension('scene', { required: true })],
      });
      const eventsDir = await writeRegistry(root, files);
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      expect(registry.errors).toEqual([]);

      const rules = buildValidationRules(registry.events, {
        registryName: 'ac10',
        generatedAt: 1_700_000_000_000,
      });
      expect(rules.keep_versions).toBe(3);
      const versioned = rules.events.find((entry) => entry.event_name === 'versioned_event');
      expect(versioned).toBeDefined();
      expect(versioned?.versions.map((item) => item.schema_version)).toEqual([4, 3, 2]);
      const single = rules.events.find((entry) => entry.event_name === 'single_event');
      expect(single?.versions.map((item) => item.schema_version)).toEqual([1]);

      expect(validateRuntimeRules(rules)).toBeNull();
      expect(RUNTIME_RULES_SCHEMA_ID).toContain('runtime-validation-rules');
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const compiled = ajv.compile(RUNTIME_RULES_SCHEMA);
      const ok = compiled(rules);
      expect(compiled.errors, JSON.stringify(compiled.errors)).toBeNull();
      expect(ok).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-10 规则保留字段的脱敏方式、单位与取值域，供接收方运行期校验', async () => {
    const root = await makeTempDir();
    try {
      const valid = await readJsonFile(VALID_DEFINITION_PATH);
      const eventsDir = await writeRegistry(root, { 'task.json': valid });
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      const rules = buildValidationRules(registry.events, { registryName: 'contract', generatedAt: 0 });
      const entry = rules.events[0];
      expect(entry?.priority).toBe('critical');
      const version = entry?.versions[0];
      expect(version?.schema_version).toBe(2);
      const taskType = version?.fields.find((field) => field.name === 'task_type');
      expect(taskType?.enum_values).toEqual(['label', 'review', 'qa']);
      expect(taskType?.required).toBe(true);
      expect(taskType?.kind).toBe('dimension');
      const duration = version?.fields.find((field) => field.name === 'duration_ms');
      expect(duration?.unit).toBe('ms');
      expect(duration?.sensitivity).toBe('none');
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-10 校验器会拒绝不符合规则的导出结果', () => {
    const missingTimestamp = validateRuntimeRules({
      export_version: 1,
      registry_name: 'x',
      keep_versions: 3,
      retention: { keep_versions: 3, note: '示例' },
      events: [],
    });
    expect(missingTimestamp).not.toBeNull();
    expect(missingTimestamp?.length).toBeGreaterThan(0);
    const badKeep = validateRuntimeRules({
      export_version: 1,
      registry_name: 'x',
      generated_at: 0,
      keep_versions: 5,
      retention: { keep_versions: 5, note: '错误示例' },
      events: [],
    });
    expect(badKeep).not.toBeNull();
  });
});
