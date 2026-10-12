import { asArray, asRecord, requireString } from './fs-json';

export type RequirementLevel = '必须' | '应该' | '可以';

export interface ReceiverRequirement {
  readonly id: string;
  readonly level: RequirementLevel;
  readonly requirement: string;
}

const LEVELS: readonly RequirementLevel[] = ['必须', '应该', '可以'];
const ID_PATTERN = /^RR-\d+$/u;

const toLevel = (value: string | undefined): RequirementLevel | undefined =>
  LEVELS.find((level) => level === value);

/**
 * 解析 receiver-requirements.md 的 Markdown 表格，取回每条 RR-x 的编号、级别与要求原文。
 *
 * 第 5 节「自查」的表格只有编号没有级别，会被忽略；同一编号只取第一次出现（带级别的那张表）。
 */
export const parseReceiverRequirements = (markdown: string): readonly ReceiverRequirement[] => {
  const found = new Map<string, ReceiverRequirement>();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0];
    const level = cells.map((cell) => toLevel(cell)).find((candidate) => candidate !== undefined);
    const requirement = cells[1];
    if (id === undefined || requirement === undefined || level === undefined || !ID_PATTERN.test(id)) {
      continue;
    }
    if (!found.has(id)) {
      found.set(id, { id, level, requirement });
    }
  }
  return [...found.values()];
};

export interface SamplePackCheck {
  readonly id: string;
  readonly requirement: string;
  readonly level: string;
  readonly check_kind: string;
  readonly samples: readonly SamplePackSample[];
  readonly self_check: string;
}

export interface SamplePackSample {
  readonly path: string;
  /** 校验该样例的契约 Schema（相对仓库根目录）；行为类条目没有样例，因此没有 Schema。 */
  readonly schema: string | undefined;
  readonly expect: string;
}

export const parseSamplePackCheck = (value: unknown, label: string): SamplePackCheck => {
  const record = asRecord(value, label);
  const samples = asArray(record['samples'], `${label}.samples`).map((sample, index) =>
    parseSamplePackSample(sample, `${label}.samples[${String(index)}]`),
  );
  return {
    id: requireString(record, 'id', label),
    requirement: requireString(record, 'requirement', label),
    level: requireString(record, 'level', label),
    check_kind: requireString(record, 'check_kind', label),
    samples,
    self_check: requireString(record, 'self_check', label),
  };
};

const parseSamplePackSample = (value: unknown, label: string): SamplePackSample => {
  const record = asRecord(value, label);
  const schema = record['schema'];
  if (schema !== undefined && typeof schema !== 'string') {
    throw new Error(`${label}.schema 必须是字符串`);
  }
  return {
    path: requireString(record, 'path', label),
    schema,
    expect: requireString(record, 'expect', label),
  };
};

export const parseSamplePackChecks = (value: unknown, label: string): readonly SamplePackCheck[] =>
  asArray(value, label).map((item, index) => parseSamplePackCheck(item, `${label}[${String(index)}]`));
