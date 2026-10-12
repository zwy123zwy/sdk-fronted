import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  absolutePath,
  asArray,
  asRecord,
  compatPairsDir,
  contractsDir,
  readJsonFile,
  readTextFile,
  repoPath,
  optionalString,
  requireInteger,
  requireString,
} from './lib/fs-json';
import { compileContractRegistry } from './lib/schemas';

// examples/compat-pairs/ 是 dictionary-compat.md 判定表逐行的「旧/新」事件定义样例对（T06 产出）。
// T10 负责：① 两份定义都是合法的 K01 事件定义（event-definition.schema.json）；
// ② index.json 声明的版本变化与样例一致；③ 判定表每行都有样例覆盖。
// K01 的兼容性判定本身（verdict / 退出码）由 T22 的 K01 验收用例断言，不在契约测试里重复实现。
const registry = compileContractRegistry();
const indexPath = join(compatPairsDir, 'index.json');
const index = asRecord(readJsonFile(indexPath), 'compat-pairs/index.json');
const vocabulary = asRecord(index['verdict_vocabulary'], 'compat-pairs/index.json.verdict_vocabulary');
const pairs = asArray(index['pairs'], 'compat-pairs/index.json.pairs');
const supplementary = asArray(index['supplementary'], 'compat-pairs/index.json.supplementary');

interface CompatCase {
  readonly id: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly verdict: string;
  readonly verdictZh: string;
  readonly tableChange: string;
  readonly schemaVersionDelta: number;
  readonly versionIncremented: boolean;
  readonly changeSummary: string;
  readonly tableRow: number | undefined;
}

const toCase = (item: unknown, label: string): CompatCase => {
  const pair = asRecord(item, label);
  const expected = asRecord(pair['expected'], `${label}.expected`);
  const versionIncremented = expected['version_incremented'];
  if (typeof versionIncremented !== 'boolean') {
    throw new Error(`${label}.expected.version_incremented 必须是布尔值`);
  }
  const tableRow = pair['table_row'];
  return {
    id: requireString(pair, 'id', label),
    oldPath: repoPath(join(compatPairsDir, requireString(pair, 'old', label))),
    newPath: repoPath(join(compatPairsDir, requireString(pair, 'new', label))),
    verdict: requireString(pair, 'verdict', label),
    verdictZh: optionalString(pair, 'verdict_zh') ?? '',
    // 补充样例（99）不对应判定表行，没有 table_change。
    tableChange: optionalString(pair, 'table_change') ?? '',
    schemaVersionDelta: requireInteger(expected, 'schema_version_delta', `${label}.expected`),
    versionIncremented,
    changeSummary: requireString(pair, 'change_summary', label),
    tableRow: typeof tableRow === 'number' ? tableRow : undefined,
  };
};

const cases: readonly CompatCase[] = [
  ...pairs.map((item, index0) => toCase(item, `compat-pairs/pairs[${String(index0)}]`)),
  ...supplementary.map((item, index0) => toCase(item, `compat-pairs/supplementary[${String(index0)}]`)),
];

const readSchemaVersion = (repoRelativePath: string, label: string): number =>
  requireInteger(asRecord(readJsonFile(absolutePath(repoRelativePath)), label), 'schema_version', label);

interface DictionaryRow {
  readonly change: string;
  readonly verdict: string;
}

const normalizeCell = (cell: string): string => cell.replace(/`/gu, '').trim();

/** 解析 dictionary-compat.md 判定表的数据行（排除表头与分隔行）。 */
const parseDictionaryRows = (markdown: string): readonly DictionaryRow[] => {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^\|\s*变更\s*\|\s*判定\s*\|$/u.test(line));
  if (start === -1) {
    return [];
  }
  const rows: DictionaryRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('|')) {
      break;
    }
    if (/^\|[\s|:-]+\|$/u.test(line)) {
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => normalizeCell(cell));
    const change = cells[0];
    const verdict = cells[1];
    if (change !== undefined && verdict !== undefined) {
      rows.push({ change, verdict });
    }
  }
  return rows;
};

const dictionaryRows = parseDictionaryRows(readTextFile(join(contractsDir, 'dictionary-compat.md')));

describe('compat-pairs：旧/新事件定义都是合法的事件定义（双向校验的合法侧）', () => {
  test.each([...cases])('$id 的 old 与 new 都通过 event-definition.schema.json', (compatCase) => {
    const oldDocument = readJsonFile(absolutePath(compatCase.oldPath));
    const newDocument = readJsonFile(absolutePath(compatCase.newPath));
    expect({ file: compatCase.oldPath, outcome: registry.validate('event-definition', oldDocument) }).toEqual({
      file: compatCase.oldPath,
      outcome: { valid: true, errors: [] },
    });
    expect({ file: compatCase.newPath, outcome: registry.validate('event-definition', newDocument) }).toEqual({
      file: compatCase.newPath,
      outcome: { valid: true, errors: [] },
    });
  });

  test.each([...cases])('$id 的 old 与 new 是同一个事件名', (compatCase) => {
    const oldName = requireString(
      asRecord(readJsonFile(absolutePath(compatCase.oldPath)), compatCase.oldPath),
      'event_name',
      compatCase.oldPath,
    );
    const newName = requireString(
      asRecord(readJsonFile(absolutePath(compatCase.newPath)), compatCase.newPath),
      'event_name',
      compatCase.newPath,
    );
    expect(newName).toBe(oldName);
  });
});

describe('compat-pairs：index.json 声明的版本变化与样例一致', () => {
  test.each([...cases])('$id 的 schema_version 差值与声明一致', (compatCase) => {
    const oldVersion = readSchemaVersion(compatCase.oldPath, compatCase.oldPath);
    const newVersion = readSchemaVersion(compatCase.newPath, compatCase.newPath);
    expect({ delta: newVersion - oldVersion, incremented: newVersion > oldVersion }).toEqual({
      delta: compatCase.schemaVersionDelta,
      incremented: compatCase.versionIncremented,
    });
  });

  test('verdict 取值都在 index.json 的 verdict_vocabulary 中，change_summary 非空', () => {
    for (const compatCase of cases) {
      expect(Object.keys(vocabulary)).toContain(compatCase.verdict);
      expect(compatCase.changeSummary.length).toBeGreaterThan(0);
    }
  });
});

describe('compat-pairs：判定表每一行都有样例覆盖', () => {
  test('dictionary-compat.md 判定表有 16 行，且每行都至少有一个样例对', () => {
    expect(dictionaryRows).toHaveLength(16);
    const coveredRows = new Set(pairs.map((item) => toCase(item, 'pair').tableRow));
    expect([...coveredRows].sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(
      Array.from({ length: dictionaryRows.length }, (_unused, position) => position + 1),
    );
  });

  test('每个样例对声明的 table_change / verdict_zh 与判定表对应行一致', () => {
    for (const item of pairs) {
      const pair = toCase(item, 'pair');
      const row = pair.tableRow === undefined ? undefined : dictionaryRows[pair.tableRow - 1];
      // 判定表的判定列可能带附加要求（如第 13 行「破坏性，另需接入方安全负责人批准」），
      // index.json 把附加要求放进 expected.additional_requirements，verdict_zh 只写判定本身。
      expect({ id: pair.id, change: row?.change, verdictMatches: row?.verdict.startsWith(pair.verdictZh) }).toEqual({
        id: pair.id,
        change: pair.tableChange,
        verdictMatches: true,
      });
    }
  });

  test('补充样例 99 不占用判定表行号，针对未递增版本的破坏性变更', () => {
    expect(supplementary).toHaveLength(1);
    expect(cases.filter((compatCase) => compatCase.tableRow === undefined)).toHaveLength(1);
  });
});
