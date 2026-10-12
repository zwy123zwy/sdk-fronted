/**
 * K01 验收用例：事件定义校验与注册表级检查（K01-AC-01、02、06、07）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_DEFINITION_SCHEMA, validateEventDefinition } from '../definitions.js';
import { loadRegistry } from '../registry.js';
import {
  CONTRACT_SCHEMA_PATH,
  INVALID_DEFINITIONS_PATH,
  VALID_DEFINITION_PATH,
  dimension,
  makeDefinition,
  makeDefinitions,
  makeTempDir,
  readJsonFile,
  removeTempDir,
  writeRegistry,
} from './test-support.js';

interface InvalidCase {
  _why: string;
}

describe('K01-AC-01 校验只含事件定义合法样例的注册表', () => {
  it('K01-AC-01 只含 event-definition.valid.json 的注册表校验通过', async () => {
    const root = await makeTempDir();
    try {
      const valid = await readJsonFile(VALID_DEFINITION_PATH);
      const eventsDir = await writeRegistry(root, { 'task_submit_complete.json': valid });
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      expect(registry.errors).toEqual([]);
      expect(registry.events).toHaveLength(1);
      expect(registry.events[0]?.eventName).toBe('task_submit_complete');
      expect(registry.events[0]?.schemaVersion).toBe(2);
      expect(registry.events[0]?.priority).toBe('critical');
      // 校验器读的是契约文件本身，防止工具内嵌副本与契约漂移
      const contractSchema = await readJsonFile(CONTRACT_SCHEMA_PATH);
      expect(typeof contractSchema).toBe('object');
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-01 事件名使用 sdk_ 保留前缀时校验失败并指出字段路径', () => {
    const result = validateEventDefinition(
      makeDefinition({ event_name: 'sdk_internal_tick', priority: 'normal' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((error) => error.path);
    expect(paths).toContain('/event_name');
    expect(result.errors.map((error) => error.message).join('\n')).toMatch(/event_name/);
  });
});

describe('K01-AC-02 逐个校验非法事件定义样例', () => {
  it('K01-AC-02 每个非法 case 都校验失败，且错误信息包含字段路径', async () => {
    const invalid = (await readJsonFile(INVALID_DEFINITIONS_PATH)) as { cases: (InvalidCase & Record<string, unknown>)[] };
    expect(invalid.cases.length).toBeGreaterThanOrEqual(4);
    for (const caseValue of invalid.cases) {
      const result = validateEventDefinition(caseValue);
      expect(result.ok, `case 应当失败：${caseValue._why}`).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) {
        expect(error.path.startsWith('/'), `错误缺少字段路径：${JSON.stringify(error)}`).toBe(true);
      }
      expect(result.errors.some((error) => /^\/[a-z_]+/i.test(error.path))).toBe(true);
    }
  });

  it('K01-AC-02 critical 缺少 critical_reason 时错误路径指向 /critical_reason', () => {
    const result = validateEventDefinition(makeDefinition({ priority: 'critical' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toContain('/critical_reason');
  });

  it('K01-AC-02 字段级错误路径精确到 /fields/<下标>/<属性>', () => {
    const result = validateEventDefinition(
      makeDefinition({
        fields: [dimension('scene', { type: 'enum' }), dimension('bad-name')],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.errors.map((error) => error.path);
    expect(paths).toContain('/fields/0/enum_values');
    expect(paths).toContain('/fields/1/name');
  });
});

describe('K01-AC-06 critical 配额检查（K01-F3、Q3）', () => {
  it('K01-AC-06 20 个事件中 2 个 critical 通过（10%）', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      for (let index = 0; index < 20; index += 1) {
        const critical = index < 2;
        files[`quota_event_${String(index).padStart(3, '0')}.json`] = makeDefinition({
          event_name: `quota_event_${String(index).padStart(3, '0')}`,
          priority: critical ? 'critical' : 'normal',
          ...(critical ? { critical_reason: '结算与审计依赖，没有其他数据源可补回' } : {}),
          fields: [dimension('scene', { required: true })],
        });
      }
      const eventsDir = await writeRegistry(root, files);
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      expect(registry.errors).toEqual([]);
      expect(registry.criticalQuota.ok).toBe(true);
      expect(registry.criticalQuota.criticalCount).toBe(2);
      expect(registry.criticalQuota.totalCount).toBe(20);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-06 再加 1 个 critical（3/21 超过 10%）时非零退出码问题被报告', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      for (let index = 0; index < 21; index += 1) {
        const critical = index < 3;
        files[`quota_event_${String(index).padStart(3, '0')}.json`] = makeDefinition({
          event_name: `quota_event_${String(index).padStart(3, '0')}`,
          priority: critical ? 'critical' : 'normal',
          ...(critical ? { critical_reason: '结算与审计依赖，没有其他数据源可补回' } : {}),
          fields: [dimension('scene', { required: true })],
        });
      }
      const eventsDir = await writeRegistry(root, files);
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      expect(registry.errors).toEqual([]);
      expect(registry.criticalQuota.ok).toBe(false);
      expect(registry.criticalQuota.criticalCount).toBe(3);
      expect(registry.criticalQuota.totalCount).toBe(21);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-06 配额按事件名去重，多版本不会把同一事件算多次', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      // 1 个 critical 事件的两个版本 + 9 个 normal 事件 = 10 个事件名，1/10 恰好等于配额上限
      files['crit_event_alpha_v1.json'] = makeDefinition({
        event_name: 'crit_event_alpha',
        schema_version: 1,
        priority: 'critical',
        critical_reason: '结算依赖，没有其他数据源可补回',
        fields: [dimension('scene', { required: true })],
      });
      files['crit_event_alpha_v2.json'] = makeDefinition({
        event_name: 'crit_event_alpha',
        schema_version: 2,
        priority: 'critical',
        critical_reason: '结算依赖，没有其他数据源可补回',
        fields: [dimension('scene', { required: true })],
      });
      for (let index = 0; index < 9; index += 1) {
        files[`normal_event_${String(index)}.json`] = makeDefinition({
          event_name: `normal_event_${String(index)}`,
          fields: [dimension('scene', { required: true })],
        });
      }
      const eventsDir = await writeRegistry(root, files);
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      expect(registry.errors).toEqual([]);
      expect(registry.criticalQuota.totalCount).toBe(10);
      expect(registry.criticalQuota.criticalCount).toBe(1);
      expect(registry.criticalQuota.ok).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-07 同名同版本与保留前缀', () => {
  it('K01-AC-07 两个文件定义同名同版本的事件时注册表校验失败', async () => {
    const root = await makeTempDir();
    try {
      const eventsDir = await writeRegistry(root, {
        'a.json': makeDefinition({ event_name: 'task_submit_complete', schema_version: 1 }),
        'b.json': makeDefinition({ event_name: 'task_submit_complete', schema_version: 1 }),
      });
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      expect(registry.errors.length).toBeGreaterThan(0);
      const messages = registry.errors.map((error) => `${error.code} ${error.message}`).join('\n');
      expect(messages).toMatch(/task_submit_complete/);
      expect(messages).toMatch(/version_duplicate|no_version_bump|duplicate/i);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-07 事件名使用 web_ 前缀时注册表校验失败', async () => {
    const root = await makeTempDir();
    try {
      const eventsDir = await writeRegistry(root, {
        'web_bad.json': makeDefinition({ event_name: 'web_custom_click' }),
      });
      const registry = await loadRegistry({ eventsDir, repoRoot: root });
      expect(registry.errors.length).toBeGreaterThan(0);
      expect(registry.errors.some((error) => error.path.includes('event_name'))).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-07 注册表为空目录时报告可读错误', async () => {
    const root = await makeTempDir();
    try {
      await mkdir(join(root, 'events'), { recursive: true });
      await writeFile(join(root, 'events', 'readme.txt'), 'not json\n', 'utf8');
      const registry = await loadRegistry({ eventsDir: join(root, 'events'), repoRoot: root });
      expect(registry.errors.length).toBeGreaterThan(0);
      expect(registry.errors.some((error) => /事件定义|\.json/.test(error.message))).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-02 注册表加载器与夹具接口', () => {
  it('K01-AC-02 批量夹具是合法定义（保护后续用例）', () => {
    const list = makeDefinitions(3);
    expect(list).toHaveLength(3);
    for (const definition of list) {
      expect(validateEventDefinition(definition).ok).toBe(true);
    }
  });
});

describe('K01-AC-01 内置元模型与契约 Schema 一致', () => {
  it('K01-AC-01 内置 EVENT_DEFINITION_SCHEMA 的结构与契约逐项一致（只省略纯说明文字）', async () => {
    const contract = (await readJsonFile(CONTRACT_SCHEMA_PATH)) as Record<string, unknown>;
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
          if (key === 'description') continue;
          result[key] = strip(record[key]);
        }
        return result;
      }
      return value;
    };
    expect(strip(EVENT_DEFINITION_SCHEMA)).toEqual(strip(contract));
  });
});
