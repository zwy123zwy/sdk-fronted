/**
 * K01 兼容性检查（K01-F2）。
 *
 * 判定依据只有 `docs/contracts/dictionary-compat.md` 0.2 的判定表（16 行）。
 * 本模块不做任何放宽或额外判定；判定与契约不一致时必须升级给 A01，不能在这里改。
 *
 * 版本规则（同契约正文）：
 * - 破坏性变更必须递增 `schema_version`，并列出每一处破坏性变更（K01-AC-05）
 * - 兼容变更也要递增 `schema_version`
 * - 只修改 description、trigger、owner 不递增版本（判定表第 16 行）
 * - 修改了字段却没有递增 `schema_version` → 非零退出码（K01-AC-04）
 */
import type { EventDefinition, FieldDefinition } from './definitions.js';

/** 单项变更的严重程度。 */
export type ChangeSeverity = 'compatible' | 'breaking' | 'info';

/** 兼容性对比中的一处变更。 */
export interface DefinitionChange {
  /** 契约判定表行号（1–16）；不直接对应某一行时为 null。 */
  row: number | null;
  eventName: string;
  fieldName?: string;
  /** 变更类别，用于报告与自测。 */
  category: string;
  description: string;
  severity: ChangeSeverity;
  breaking: boolean;
}

/** 对比过程中发现的违规（需要非零退出码）。 */
export interface CompatibilityProblem {
  code: 'no_version_bump' | 'version_not_increased' | 'event_removed';
  message: string;
  eventName: string;
}

/** 对比结果。 */
export interface CompatibilityReport {
  /** 总体判定，与 `index.json` 的 verdict 词汇一致。 */
  verdict: 'compatible' | 'breaking' | 'no_version_bump';
  /** 是否要求递增 `schema_version`（false 表示只有元数据变更）。 */
  requiresVersionBump: boolean;
  /** 该不该给非零退出码（不含 `--allow-breaking`）。 */
  exitCode: 0 | 1;
  /** 传入 `--allow-breaking` 后的判定；未递增版本仍然失败。 */
  allowBreakingVerdict: 'ok' | 'fail';
  changes: readonly DefinitionChange[];
  problems: readonly CompatibilityProblem[];
  /** 两侧事件名的并集。 */
  comparedEvents: readonly string[];
}

/** 严重程度排序：破坏性优先展示。 */
const SEVERITY_ORDER: Record<ChangeSeverity, number> = { breaking: 0, compatible: 1, info: 2 };

/** 脱敏严格程度：none → mask → hash → drop（契约判定表第 12、13 行）。 */
const SENSITIVITY_RANK: Record<string, number> = { none: 0, mask: 1, hash: 2, drop: 3 };

/** 只改这些元数据字段时不要求递增版本（判定表第 16 行）。 */
export const METADATA_ONLY_FIELDS = ['description', 'trigger', 'owner'] as const;

/** 汇总一组变更的判定。 */
export function summarizeChanges(changes: readonly DefinitionChange[]): CompatibilityReport['verdict'] {
  if (changes.some((change) => change.breaking)) return 'breaking';
  if (changes.every((change) => change.severity === 'info')) return 'no_version_bump';
  return 'compatible';
}

/** 对比两份注册表快照，返回逐项变更与总体判定。 */
export function compareRegistries(
  baseline: { events: readonly EventDefinition[] },
  next: { events: readonly EventDefinition[] },
): CompatibilityReport {
  const baselineIndex = indexVersions(baseline.events);
  const nextIndex = indexVersions(next.events);
  const eventNames = [...new Set([...baselineIndex.keys(), ...nextIndex.keys()])].sort();

  const changes: DefinitionChange[] = [];
  const problems: CompatibilityProblem[] = [];

  for (const eventName of eventNames) {
    const baselineVersions = baselineIndex.get(eventName) ?? new Map<number, EventDefinition>();
    const nextVersions = nextIndex.get(eventName) ?? new Map<number, EventDefinition>();
    const baselineVersion = highestVersion(baselineVersions);
    const nextVersion = highestVersion(nextVersions);

    if (baselineVersion === undefined) continue;
    if (nextVersion === undefined) {
      problems.push({
        code: 'event_removed',
        message: `事件 ${eventName} 在新版本注册表中被删除（基线最高版本 ${String(baselineVersion)}）`,
        eventName,
      });
      continue;
    }
    const baselineDefinition = baselineVersions.get(baselineVersion);
    const nextDefinition = nextVersions.get(nextVersion);
    if (baselineDefinition === undefined || nextDefinition === undefined) continue;

    const eventChanges = compareDefinition(baselineDefinition, nextDefinition);
    if (eventChanges.length === 0) continue;
    changes.push(...eventChanges);

    const versionIncreased = nextVersion > baselineVersion;
    if (!isMetadataOnly(eventChanges) && !versionIncreased) {
      problems.push({
        code: 'no_version_bump',
        message: `事件 ${eventName} 的定义相比基线发生变化，但 schema_version 仍是 ${String(baselineVersion)}；修改了字段就必须递增 schema_version（dictionary-compat.md、K01-AC-04）`,
        eventName,
      });
    }
  }

  changes.sort(compareChanges);
  const metadataOnly = changes.length > 0 && isMetadataOnly(changes);
  const verdict: CompatibilityReport['verdict'] =
    problems.length > 0 ? 'no_version_bump' : metadataOnly ? 'no_version_bump' : summarizeChanges(changes);
  const requiresVersionBump = problems.length > 0 || verdict === 'breaking' || verdict === 'compatible';
  const exitCode: 0 | 1 = problems.length > 0 || verdict === 'breaking' ? 1 : 0;
  const allowBreakingVerdict: 'ok' | 'fail' = problems.length > 0 ? 'fail' : 'ok';

  return {
    verdict,
    requiresVersionBump,
    exitCode,
    allowBreakingVerdict,
    changes,
    problems,
    comparedEvents: eventNames,
  };
}

/** 事件在某个快照里的最高版本号。 */
function highestVersion(versions: ReadonlyMap<number, EventDefinition>): number | undefined {
  let highest: number | undefined;
  for (const version of versions.keys()) {
    if (highest === undefined || version > highest) highest = version;
  }
  return highest;
}

/** 变更里是否出现非元数据项（即判定表第 16 行之外的行）。 */
export function isMetadataOnlyFieldChange(changes: readonly DefinitionChange[]): boolean {
  return changes.some((change) => change.severity !== 'info');
}

/** 只有元数据变更（判定表第 16 行）。 */
export function isMetadataOnly(changes: readonly DefinitionChange[]): boolean {
  return changes.length > 0 && changes.every((change) => change.severity === 'info');
}

/** 逐字段对比两份同版本事件定义，返回判定表允许的所有变更项。 */
export function compareDefinition(
  baseline: EventDefinition,
  next: EventDefinition,
): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const eventName = next.eventName;

  for (const metadataField of METADATA_ONLY_FIELDS) {
    if (baseline[metadataField] !== next[metadataField]) {
      changes.push({
        row: 16,
        eventName,
        category: `metadata_${metadataField}`,
        description: `只修改 ${metadataField}：不要求递增 schema_version`,
        severity: 'info',
        breaking: false,
      });
    }
  }

  if (baseline.priority !== next.priority) {
    const compatible = next.priority === 'critical' || baseline.priority === 'critical';
    changes.push({
      row: next.priority === 'critical' ? 14 : 15,
      eventName,
      category: 'priority_changed',
      description: `priority 由 ${baseline.priority} 改为 ${next.priority}`,
      severity: compatible ? 'compatible' : 'breaking',
      breaking: !compatible,
    });
  }

  if (baseline.criticalReason !== next.criticalReason) {
    if (next.criticalReason === undefined) {
      // priority 降为 normal 时随之删除 critical_reason 是判定表第 15 行的一部分；
      // 仍是 critical 却删掉判定依据才违反 Schema 与 Q3 的要求
      const stillCritical = next.priority === 'critical';
      changes.push({
        row: stillCritical ? 11 : 15,
        eventName,
        category: 'critical_reason_removed',
        description: stillCritical
          ? '删除 critical_reason（critical 事件必须说明判定依据，见 Q3）'
          : 'priority 改为 normal，随之删除 critical_reason',
        severity: stillCritical ? 'breaking' : 'compatible',
        breaking: stillCritical,
      });
    } else {
      changes.push({
        row: 14,
        eventName,
        category: 'critical_reason_changed',
        description: `critical_reason ${
          baseline.criticalReason === undefined ? '被补充' : '被修改'
        }（Q3 判定标准由代码评审确认）`,
        severity: 'info',
        breaking: false,
      });
    }
  }

  const baselineFields = new Map(baseline.fields.map((field) => [field.name, field]));
  const nextFields = new Map(next.fields.map((field) => [field.name, field]));

  for (const [name, baselineField] of baselineFields) {
    const nextField = nextFields.get(name);
    if (nextField === undefined) {
      // 删除字段 —— 判定表第 3 行（删除可选字段同样是破坏性，见样例对 03）
      changes.push({
        row: 3,
        eventName,
        fieldName: name,
        category: 'field_deleted',
        description: `删除字段 ${name}（${baselineField.kind}）`,
        severity: 'breaking',
        breaking: true,
      });
      continue;
    }
    changes.push(...compareField(eventName, baselineField, nextField));
  }

  for (const [name, nextField] of nextFields) {
    if (baselineFields.has(name)) continue;
    // 新增字段 —— 判定表第 1、2 行
    const breaking = nextField.required;
    changes.push({
      row: breaking ? 2 : 1,
      eventName,
      fieldName: name,
      category: breaking ? 'field_added_required' : 'field_added_optional',
      description: `新增${breaking ? '必填' : '可选'}字段 ${name}（${nextField.kind}/${nextField.type}）`,
      severity: breaking ? 'breaking' : 'compatible',
      breaking,
    });
  }

  return changes;
}

/** 单字段对比。 */
function compareField(
  eventName: string,
  baseline: FieldDefinition,
  next: FieldDefinition,
): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const fieldName = next.name;

  if (baseline.type !== next.type || baseline.kind !== next.kind) {
    // 判定表第 4 行
    changes.push({
      row: 4,
      eventName,
      fieldName,
      category: 'field_type_or_kind_changed',
      description: `字段 ${fieldName} 的 ${baseline.type === next.type ? 'kind' : 'type'} 由 ${baseline.type}/${baseline.kind} 改为 ${next.type}/${next.kind}`,
      severity: 'breaking',
      breaking: true,
    });
  }

  if (baseline.required !== next.required) {
    if (next.required) {
      // 判定表第 5 行：可选改为必填
      changes.push({
        row: 5,
        eventName,
        fieldName,
        category: 'optional_to_required',
        description: `字段 ${fieldName} 由可选改为必填`,
        severity: 'breaking',
        breaking: true,
      });
    } else {
      // 判定表第 6 行：必填改为可选
      changes.push({
        row: 6,
        eventName,
        fieldName,
        category: 'required_to_optional',
        description: `字段 ${fieldName} 由必填改为可选`,
        severity: 'compatible',
        breaking: false,
      });
    }
  }

  changes.push(...compareEnumValues(eventName, fieldName, baseline, next));
  changes.push(...compareBounds(eventName, fieldName, baseline, next));

  if (baseline.unit !== next.unit && (baseline.unit !== undefined || next.unit !== undefined)) {
    // 判定表第 11 行
    changes.push({
      row: 11,
      eventName,
      fieldName,
      category: 'unit_changed',
      description: `字段 ${fieldName} 的 unit 由 ${baseline.unit ?? '(无)'} 改为 ${next.unit ?? '(无)'}`,
      severity: 'breaking',
      breaking: true,
    });
  }

  if (baseline.sensitivity !== next.sensitivity) {
    const stricter = (SENSITIVITY_RANK[next.sensitivity] ?? 0) > (SENSITIVITY_RANK[baseline.sensitivity] ?? 0);
    // 判定表第 12、13 行
    changes.push({
      row: stricter ? 12 : 13,
      eventName,
      fieldName,
      category: stricter ? 'sensitivity_stricter' : 'sensitivity_looser',
      description: `字段 ${fieldName} 的 sensitivity 由 ${baseline.sensitivity} 改为 ${next.sensitivity}（${stricter ? '更严格，兼容' : '更宽松，破坏性且需安全负责人批准'}）`,
      severity: stricter ? 'compatible' : 'breaking',
      breaking: !stricter,
    });
  }

  return changes;
}

/** enum_values 的增删（判定表第 7、8 行）。 */
function compareEnumValues(
  eventName: string,
  fieldName: string,
  baseline: FieldDefinition,
  next: FieldDefinition,
): DefinitionChange[] {
  const baselineValues = baseline.enum_values ?? [];
  const nextValues = next.enum_values ?? [];
  if (baselineValues.length === 0 && nextValues.length === 0) return [];
  const changes: DefinitionChange[] = [];
  const added = nextValues.filter((value) => !baselineValues.includes(value));
  const removed = baselineValues.filter((value) => !nextValues.includes(value));
  if (added.length > 0) {
    changes.push({
      row: 7,
      eventName,
      fieldName,
      category: 'enum_values_added',
      description: `字段 ${fieldName} 的 enum_values 增加取值：${added.join('、')}`,
      severity: 'compatible',
      breaking: false,
    });
  }
  if (removed.length > 0) {
    changes.push({
      row: 8,
      eventName,
      fieldName,
      category: 'enum_values_removed',
      description: `字段 ${fieldName} 的 enum_values 删除取值：${removed.join('、')}`,
      severity: 'breaking',
      breaking: true,
    });
  }
  return changes;
}

/** max_length / minimum / maximum 的放宽与收紧（判定表第 9、10 行）。 */
function compareBounds(
  eventName: string,
  fieldName: string,
  baseline: FieldDefinition,
  next: FieldDefinition,
): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const numericBound = (
    label: string,
    baselineValue: number | undefined,
    nextValue: number | undefined,
    relaxedWhen: (baselineValue: number, nextValue: number) => boolean,
  ): void => {
    if (baselineValue === nextValue) return;
    if (nextValue === undefined) {
      // 去掉上/下界是放宽
      pushBound(9, `${label} 被移除（放宽）`, false);
      return;
    }
    if (baselineValue === undefined) {
      // 新增上/下界是收紧
      pushBound(10, `${label} 新增为 ${String(nextValue)}（收紧）`, true);
      return;
    }
    const relaxed = relaxedWhen(baselineValue, nextValue);
    pushBound(relaxed ? 9 : 10, `${label} 由 ${String(baselineValue)} ${relaxed ? '放宽' : '收紧'}到 ${String(nextValue)}`, !relaxed);
  };
  const pushBound = (row: number, description: string, breaking: boolean): void => {
    changes.push({
      row,
      eventName,
      fieldName,
      category: breaking ? 'bound_tightened' : 'bound_widened',
      description: `字段 ${fieldName} 的 ${description}`,
      severity: breaking ? 'breaking' : 'compatible',
      breaking,
    });
  };

  numericBound('max_length', baseline.max_length, next.max_length, (oldValue, newValue) => newValue >= oldValue);
  numericBound('minimum', baseline.minimum, next.minimum, (oldValue, newValue) => newValue <= oldValue);
  numericBound('maximum', baseline.maximum, next.maximum, (oldValue, newValue) => newValue >= oldValue);
  return changes;
}

function compareChanges(left: DefinitionChange, right: DefinitionChange): number {
  if (left.eventName !== right.eventName) return left.eventName < right.eventName ? -1 : 1;
  const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severity !== 0) return severity;
  const leftField = left.fieldName ?? '';
  const rightField = right.fieldName ?? '';
  if (leftField !== rightField) return leftField < rightField ? -1 : 1;
  return left.category < right.category ? -1 : left.category > right.category ? 1 : 0;
}

/** 按事件名 + 版本号建索引。 */
export function indexVersions(
  events: readonly EventDefinition[],
): Map<string, Map<number, EventDefinition>> {
  const index = new Map<string, Map<number, EventDefinition>>();
  for (const event of events) {
    const versions = index.get(event.eventName) ?? new Map<number, EventDefinition>();
    versions.set(event.schemaVersion, event);
    index.set(event.eventName, versions);
  }
  return index;
}

/** 渲染可读的兼容性报告（CLI 输出）。 */
export function formatCompatibilityReport(report: CompatibilityReport): string[] {
  const lines: string[] = [];
  const breaking = report.changes.filter((change) => change.breaking);
  const compatible = report.changes.filter((change) => !change.breaking && change.severity === 'compatible');
  const metadata = report.changes.filter((change) => change.severity === 'info');

  if (report.changes.length === 0) {
    lines.push('兼容性检查：与基线相比没有变更');
  } else {
    const counts = `破坏性 ${String(breaking.length)} 处，兼容 ${String(compatible.length)} 处，仅元数据 ${String(metadata.length)} 处`;
    lines.push(`兼容性检查：${counts}`);
  }

  if (breaking.length > 0) {
    lines.push('破坏性变更（必须递增 schema_version，并由接入方数据负责人在代码评审中批准）：');
    for (const change of breaking) {
      lines.push(`  - [规则表第 ${String(change.row ?? '?')} 行] ${change.description}`);
    }
  }
  if (compatible.length > 0) {
    lines.push('兼容变更（仍须递增 schema_version）：');
    for (const change of compatible) {
      lines.push(`  - [规则表第 ${String(change.row ?? '?')} 行] ${change.description}`);
    }
  }
  if (metadata.length > 0) {
    lines.push('仅元数据变更（不递增版本）：');
    for (const change of metadata) {
      lines.push(`  - [规则表第 16 行] ${change.description}`);
    }
  }

  for (const problem of report.problems) {
    lines.push(`错误：${problem.message}`);
  }

  if (report.problems.length > 0) {
    lines.push('结论：需要递增 schema_version 后再提交（K01-AC-04）');
  } else if (breaking.length > 0) {
    lines.push('结论：存在破坏性变更，CI 默认失败；确认已批准后可传 --allow-breaking（K01-AC-05）');
  } else {
    lines.push('结论：兼容性检查通过');
  }
  return lines;
}
