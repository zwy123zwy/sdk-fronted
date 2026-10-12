/**
 * @packageDocumentation
 * K02 配置签名 CLI（`@web-report-sdk/config-signer`）。
 *
 * 子命令：`validate`（Schema 校验 + `config_version` 递增 + 疑似令牌扫描）、
 * `sign`（ES256/P1363 发布物）、`verify`（发布前自检）、`keygen`（测试密钥对）。
 *
 * 安全约束（指南第 11 节）：K02 不得读取、打印或提交私钥内容。私钥接触面集中在
 * `signer-source.ts`：`local-file` 只用于测试；生产签名走 `--sign-command`，
 * K02 进程完全不接触私钥。
 */

/** 工具标识。 */
export const TOOL_ID = 'K02';

export {
  EXIT_CHECK_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  checkProblem,
  isProblem,
  renderProblem,
  toUsageProblem,
  usageProblem,
  type CliIo,
  type Problem,
  type ProblemKind,
} from './errors.js';
export { errorPath, getBodyValidator, getEnvelopeValidator, type Envelope } from './schema.js';
export { extractBodies, type ExtractResult, type ExtractedBodies } from './payload.js';
export { checkVersionIncreasing, pickPreviousVersion, type VersionCheck } from './version.js';
export {
  isBenignValue,
  matchTokenPatterns,
  scanSuspiciousTokens,
  toTokenProblems,
  type TokenFinding,
  type TokenPattern,
  type TokenScanResult,
} from './token-scan.js';
export {
  CONSENT_FULL_MESSAGE,
  validateConfig,
  type ValidateRequest,
  type ValidationResult,
} from './validate.js';
export {
  renderEnvelope,
  serializeEnvelope,
  signConfig,
  verifySignatureWithJwk,
  type SignRequest,
  type SignResult,
} from './sign.js';
export {
  createSigner,
  createSignerFromCommand,
  createSignerFromFile,
  isRawSignature,
  sanitizeExternalOutput,
  SIGNATURE_LENGTH,
  type SignCommand,
  type Signer,
  type SignerSource,
} from './signer-source.js';
export {
  envelopeConfigVersion,
  verifyEnvelope,
  type VerifyRequest,
  type VerifyResult,
} from './verify.js';
export {
  generateKeyPairFiles,
  readPublicKeys,
  PRIVATE_KEY_MODE,
  type KeygenOptions,
  type KeygenResult,
  type PublicKeys,
} from './keys.js';
export { parseCliArgs, runCli, USAGE, type CliOptions, type Command } from './cli.js';
