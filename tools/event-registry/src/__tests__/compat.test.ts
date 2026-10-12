/**
 * K01 验收用例：兼容性检查（K01-AC-03、04、05）。
 *
 * 判定依据只有 `docs/contracts/dictionary-compat.md` 0.2 的判定表；
 * 样例对与期望判定直接消费 T06 产出的 `docs/contracts/examples/compat-pairs/index.json`。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareRegistries, formatCompatibilityReport, type CompatibilityReport } from '../compat.js';
import { loadRegistry } from '../registry.js';
import {
  makeDefinition,
  makeTempDir,
  readCompatIndex,
  readCompatSide,
  removeTempDir,
  writeRegistry,
  type CompatPairEntry,
} from './test-support.js';

/** 一组对比快照：旧版本注册表、新版本注册表。 */
interface PairSnapshots {
  oldDir: string;
  newDir: string;
}

/**
 * 直接按样例对的两侧定义组装快照（各自一份注册表）。
 *
 * 用于判定表第 16 行这类"同版本、只改元数据"的样例。
 */
async function buildRawSnapshots(
  root: string,
  oldDefinition: Record<string, unknown>,
  newDefinition: Record<string, unknown>,
): Promise<PairSnapshots> {
  const name = String(newDefinition['event_name']);
  const oldVersion = Number(oldDefinition['schema_version']);
  const newVersion = Number(newDefinition['schema_version']);
  const oldDir = await writeRegistry(`${root}/old`, {
    [`${name}_v${String(oldVersion)}.json`]: oldDefinition,
  });
  const newDir = await writeRegistry(`${root}/new`, {
    [`${name}_v${String(newVersion)}.json`]: newDefinition,
  });
  return { oldDir, newDir };
}

/**
 * 按样例对的期望组装"新快照"。
 *
 * - 递增了版本的样例（`version_incremented: true`）：新快照同时保留旧版本与新版本，
 *   与接入方真实的 `events/` 目录一致（K01 要能同时服务未升级的客户端）。
 * - 未递增版本且改了字段的补充样例 99：新快照里只有修订后的定义（同一个 schema_version）。
 *   第 16 行只改元数据，两个版本的 JSON 完全相同，因此也走这里（内容不同时用 raw 版本）。
 */
async function buildPairSnapshots(
  root: string,
  entry: CompatPairEntry,
  oldDefinition: Record<string, unknown>,
  newDefinition: Record<string, unknown>,
): Promise<PairSnapshots> {
  const name = String(newDefinition['event_name']);
  const oldVersion = Number(oldDefinition['schema_version']);
  const newVersion = Number(newDefinition['schema_version']);
  const versionIncremented = entry.expected.version_incremented;
  const files: Record<string, unknown> = {};
  if (versionIncremented) {
    files[`${name}_v${String(oldVersion)}.json`] = oldDefinition;
    files[`${name}_v${String(newVersion)}.json`] = newDefinition;
  } else {
    files[`${name}_v${String(oldVersion)}.json`] = newDefinition;
  }
  const oldDir = await writeRegistry(`${root}/old`, {
    [`${name}_v${String(oldVersion)}.json`]: oldDefinition,
  });
  const newDir = await writeRegistry(`${root}/new`, files);
  return { oldDir, newDir };
}

async function comparePair(root: string, entry: CompatPairEntry): Promise<CompatibilityReport> {
  const oldDefinition = await readCompatSide(entry.old);
  const newDefinition = await readCompatSide(entry.new);
  // 判定表第 16 行只改元数据，两侧 JSON 一定不同；用 raw 组装才不会把修订抹掉
  const snapshots =
    entry.verdict === 'no_version_bump' && !entry.expected.version_incremented && entry.table_row === 16
      ? await buildRawSnapshots(root, oldDefinition, newDefinition)
      : await buildPairSnapshots(root, entry, oldDefinition, newDefinition);
  const oldRegistry = await loadRegistry({ eventsDir: snapshots.oldDir, repoRoot: root });
  const newRegistry = await loadRegistry({ eventsDir: snapshots.newDir, repoRoot: root });
  expect(oldRegistry.errors, `${entry.id} 基线定义必须合法`).toEqual([]);
  expect(newRegistry.errors, `${entry.id} 新定义必须合法`).toEqual([]);
  return compareRegistries(oldRegistry, newRegistry);
}

describe('K01-AC-03 判定表逐行与样例对一致', () => {
  it('K01-AC-03 样例对索引包含判定表 16 行与补充样例 99', async () => {
    const index = await readCompatIndex();
    expect(index.pairs).toHaveLength(21);
    expect(index.supplementary).toHaveLength(1);
    expect(index.supplementary[0]?.id).toBe('99-breaking-without-version-bump');
  });

  it('K01-AC-03 21 对样例的判定与规则表逐行一致', async () => {
    const index = await readCompatIndex();
    const root = await makeTempDir();
    try {
      const mismatches: string[] = [];
      for (const entry of index.pairs) {
        const report = await comparePair(join(root, entry.id), entry);
        const breaking = report.changes.filter((change) => change.breaking);
        // 期望判定 -> 本工具的判定词表：破坏性 => breaking；
        // 判定表第 16 行 => 只有元数据变更（不要求递增版本）；其余兼容行 => compatible
        const expectedVerdict =
          entry.verdict === 'breaking' ? 'breaking' : entry.verdict === 'no_version_bump' ? 'no_version_bump' : 'compatible';
        if (report.verdict !== expectedVerdict) {
          mismatches.push(`${entry.id}：期望 ${expectedVerdict}，实际 ${report.verdict}`);
        }
        if (expectedVerdict === 'breaking' && breaking.length === 0) {
          mismatches.push(`${entry.id}：期望至少一处破坏性变更，实际 0 处`);
        }
        if (expectedVerdict !== 'breaking' && breaking.length > 0) {
          mismatches.push(`${entry.id}：期望兼容，实际出现破坏性变更 ${breaking.map((change) => change.category).join('、')}`);
        }
        if (entry.verdict === 'no_version_bump' && report.changes.length === 0) {
          mismatches.push(`${entry.id}：期望报告元数据变更，实际无变更`);
        }
        if (entry.verdict !== 'no_version_bump' && !report.requiresVersionBump) {
          mismatches.push(`${entry.id}：应要求递增 schema_version`);
        }
      }
      expect(mismatches, mismatches.join('\n')).toEqual([]);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-03 每对样例的判定行号与规则表一致、只在本行描述的方面有差异', async () => {
    const index = await readCompatIndex();
    const root = await makeTempDir();
    try {
      for (const entry of index.pairs) {
        const report = await comparePair(join(root, entry.id), entry);
        const rendered = formatCompatibilityReport(report).join('\n');
        // 报告必须给出规则表行号，便于与契约逐行对照
        expect(rendered, `${entry.id} 报告缺少规则表行号`).toMatch(/规则表第 \d+ 行/);
        expect(report.changes.length, `${entry.id} 变更明细为空`).toBeGreaterThan(0);
        const rows = new Set(report.changes.map((change) => change.row));
        expect(rows.has(entry.table_row ?? -1), `${entry.id} 变更行号未覆盖第 ${String(entry.table_row)} 行`).toBe(true);
      }
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-04 修改字段而不递增 schema_version', () => {
  it('K01-AC-04 删除字段但 schema_version 不变时返回非零退出码问题', async () => {
    const index = await readCompatIndex();
    const entry = index.supplementary[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const root = await makeTempDir();
    try {
      const report = await comparePair(root, entry);
      expect(report.requiresVersionBump).toBe(true);
      expect(report.problems.map((problem) => problem.code)).toContain('no_version_bump');
      const text = report.problems.map((problem) => problem.message).join('\n');
      expect(text).toMatch(/schema_version/);
      expect(report.changes.some((change) => change.breaking)).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-04 放宽 max_length 而不递增版本同样被拦截', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition({
        fields: [
          {
            name: 'result',
            kind: 'dimension',
            type: 'string',
            required: false,
            description: '审核结论',
            max_length: 32,
            sensitivity: 'none',
          },
        ],
      });
      const newDefinition = makeDefinition({
        fields: [
          {
            name: 'result',
            kind: 'dimension',
            type: 'string',
            required: false,
            description: '审核结论',
            max_length: 64,
            sensitivity: 'none',
          },
        ],
      });
      const oldDir = await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      const newDir = await writeRegistry(`${root}/new`, { 'a.json': newDefinition });
      const oldRegistry = await loadRegistry({ eventsDir: oldDir, repoRoot: root });
      const newRegistry = await loadRegistry({ eventsDir: newDir, repoRoot: root });
      expect(oldRegistry.errors).toEqual([]);
      expect(newRegistry.errors).toEqual([]);
      const report = compareRegistries(oldRegistry, newRegistry);
      expect(report.verdict).toBe('no_version_bump');
      expect(report.requiresVersionBump).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-04 只改 description/trigger/owner 时不要求递增版本', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition();
      const newDefinition = makeDefinition({
        description: '标注任务提交成功（文案修订）',
        trigger: '提交接口返回成功、界面显示提交成功提示时上报（文案修订）',
        owner: 'team-annotation-2',
      });
      const oldDir = await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      const newDir = await writeRegistry(`${root}/new`, { 'a.json': newDefinition });
      const oldRegistry = await loadRegistry({ eventsDir: oldDir, repoRoot: root });
      const newRegistry = await loadRegistry({ eventsDir: newDir, repoRoot: root });
      const report = compareRegistries(oldRegistry, newRegistry);
      expect(report.verdict).toBe('no_version_bump');
      expect(report.requiresVersionBump).toBe(false);
      expect(report.problems).toEqual([]);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-05 破坏性变更与 --allow-breaking', () => {
  it('K01-AC-05 已递增版本的破坏性变更默认被拦截，并列出每一处破坏性变更', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition({ schema_version: 1, fields: [makeRequiredScene()] });
      const newDefinition = makeDefinition({
        schema_version: 2,
        fields: [makeRequiredScene(), makeRequiredScene('extra_scene')],
      });
      const oldDir = await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      const newDir = await writeRegistry(`${root}/new`, {
        'a.json': oldDefinition,
        'b.json': newDefinition,
      });
      const oldRegistry = await loadRegistry({ eventsDir: oldDir, repoRoot: root });
      const newRegistry = await loadRegistry({ eventsDir: newDir, repoRoot: root });
      expect(newRegistry.errors).toEqual([]);
      const report = compareRegistries(oldRegistry, newRegistry);
      expect(report.verdict).toBe('breaking');
      expect(report.requiresVersionBump).toBe(true);
      const breaking = report.changes.filter((change) => change.breaking);
      expect(breaking).toHaveLength(1);
      expect(breaking[0]?.row).toBe(2);
      const text = formatCompatibilityReport(report).join('\n');
      expect(text).toContain('extra_scene');
      expect(text).toContain('新增必填字段');
      // --allow-breaking 只放行破坏性变更，不放过未递增版本
      expect(report.allowBreakingVerdict).toBe('ok');
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-05 多处破坏性变更逐条列出', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition({
        schema_version: 1,
        fields: [
          makeRequiredScene(),
          { name: 'score_ratio', kind: 'metric', type: 'integer', required: false, description: '得分比例', unit: 'count', sensitivity: 'none' },
        ],
      });
      const newDefinition = makeDefinition({
        schema_version: 2,
        fields: [
          { name: 'scene', kind: 'dimension', type: 'enum', required: true, description: '场景', enum_values: ['a', 'b'], sensitivity: 'none' },
          { name: 'score_ratio', kind: 'metric', type: 'number', required: true, description: '得分比例', unit: 'ratio', sensitivity: 'none' },
        ],
      });
      const oldDir = await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      const newDir = await writeRegistry(`${root}/new`, { 'a.json': oldDefinition, 'b.json': newDefinition });
      const oldRegistry = await loadRegistry({ eventsDir: oldDir, repoRoot: root });
      const newRegistry = await loadRegistry({ eventsDir: newDir, repoRoot: root });
      expect(newRegistry.errors).toEqual([]);
      const report = compareRegistries(oldRegistry, newRegistry);
      const breaking = report.changes.filter((change) => change.breaking);
      expect(breaking.length).toBeGreaterThanOrEqual(3);
      expect(report.verdict).toBe('breaking');
      expect(report.requiresVersionBump).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-05 未递增版本的破坏性变更不会被 --allow-breaking 放行', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition({ fields: [makeRequiredScene()] });
      const newDefinition = makeDefinition({ fields: [] });
      const oldDir = await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      const newDir = await writeRegistry(`${root}/new`, { 'a.json': newDefinition });
      const oldRegistry = await loadRegistry({ eventsDir: oldDir, repoRoot: root });
      const newRegistry = await loadRegistry({ eventsDir: newDir, repoRoot: root });
      const report = compareRegistries(oldRegistry, newRegistry);
      expect(report.verdict).toBe('no_version_bump');
      expect(report.requiresVersionBump).toBe(true);
      expect(report.allowBreakingVerdict).toBe('fail');
    } finally {
      await removeTempDir(root);
    }
  });
});

function makeRequiredScene(name = 'scene'): Record<string, unknown> {
  return {
    name,
    kind: 'dimension',
    type: 'string',
    required: true,
    description: '场景',
    sensitivity: 'none',
  };
}
