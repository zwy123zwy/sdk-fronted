/**
 * @packageDocumentation
 * K01 事件注册表与类型生成 CLI（T22）。
 *
 * 对外导出可复用的纯函数与类型；命令行入口见 `cli.ts`，
 * 子命令、退出码与接入方式见 `tools/event-registry/README.md`。
 */

/** 工具标识。 */
export const TOOL_ID = 'K01';

export {
  CRITICAL_QUOTA_RATIO,
  CONTRACT_SCHEMA_RELATIVE_PATH,
  EVENT_DEFINITION_SCHEMA,
  UNIT_SUFFIX_RULE,
  ajvErrorsToProblems,
  checkSemanticRules,
  computeCriticalQuota,
  createSchemaValidator,
  latestVersions,
  loadSchemaValidator,
  parseEventDefinition,
  unitSuffixMatches,
  validateEventDefinition,
} from './definitions.js';
export type {
  CriticalQuota,
  DefinitionProblem,
  EventDefinition,
  EventPriority,
  EventStatus,
  FieldDefinition,
  FieldKind,
  FieldTypeName,
  FieldUnit,
  Registry,
  Sensitivity,
  ValidationResult,
} from './definitions.js';

export {
  findDuplicateVersions,
  globToRegExp,
  loadRegistry,
  matchesGlob,
  relativePathOf,
  resolveGlobFiles,
  rootFor,
  sortEvents,
} from './registry.js';
export type { LoadRegistryOptions } from './registry.js';

export {
  METADATA_ONLY_FIELDS,
  compareDefinition,
  compareRegistries,
  formatCompatibilityReport,
  indexVersions,
  isMetadataOnly,
  summarizeChanges,
} from './compat.js';
export type {
  ChangeSeverity,
  CompatibilityProblem,
  CompatibilityReport,
  DefinitionChange,
} from './compat.js';

export {
  entryTypeName,
  fieldSpecGroupText,
  fieldValueTypeText,
  latestActiveEvents,
  pascalCase,
  toGeneratedTypes,
} from './generate.js';

export {
  DEFAULT_KEEP_VERSIONS,
  RUNTIME_RULES_SCHEMA,
  RUNTIME_RULES_SCHEMA_ID,
  buildValidationRules,
  validateRuntimeRules,
} from './rules.js';
export type {
  BuildRulesOptions,
  RuntimeEventRule,
  RuntimeFieldRule,
  RuntimeRules,
  RuntimeVersionRule,
} from './rules.js';

export {
  collectUnregistered,
  formatUnregisteredReport,
  parseObservedEvents,
  registryEventNames,
  toUnregisteredReport,
} from './unregistered.js';
export type { UnregisteredEntry, UnregisteredReport } from './unregistered.js';

export {
  archiveGitSnapshot,
  directoryExists,
  gitRoot,
  listTrackedFiles,
  toNativeSubPath,
  writeOutputFile,
} from './snapshot.js';
export type { GitArchiveOptions, SnapshotDirectory } from './snapshot.js';

export { EXIT_CHECK_FAILED, EXIT_OK, EXIT_USAGE, USAGE, parseCliArgs, runCli } from './cli.js';
export type { CliIo, CliOptions, Command } from './cli.js';
