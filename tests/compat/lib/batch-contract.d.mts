/**
 * `batch-contract.mjs` 的类型声明（供 `tests/**\/*.ts` 静态导入该 `.mjs` 校验门）。
 */
export declare const BATCH_SCHEMA_PATH: string;

export interface ContractValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** `invalid_json`：正文不是合法 JSON；`invalid_structure`：违反冻结契约；`accepted`：通过。 */
export type BatchInspectionCode = 'accepted' | 'invalid_json' | 'invalid_structure';

export interface BatchInspectionOutcome {
  readonly ok: boolean;
  readonly code: BatchInspectionCode;
  readonly errors: readonly string[];
}

export function formatContractErrors(errors: unknown): readonly string[];
export function validateBatchAgainstContract(value: unknown): ContractValidationOutcome;
export function inspectBatchText(text: string): BatchInspectionOutcome;
