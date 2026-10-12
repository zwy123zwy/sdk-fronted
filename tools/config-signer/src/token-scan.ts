/**
 * 疑似令牌/密钥扫描（K02-AC-07、`remote-config.md` 第 4 节末「配置中不得包含任何密钥或令牌」）。
 *
 * 设计要点：
 * - 递归遍历正文的所有字符串**值**与对象**键名**，报告 JSON 指针路径；
 * - 报告里只给「路径 + 模式名 + 长度 + 值的 SHA-256 前 6 位」，**绝不回显原串**；
 * - 误报护栏只针对确定的良性形态（UUID、纯十进制数字串、`sha256-<hex>` 摘要），
 *   不一刀切豁免 40 位十六进制：配置正文里的 commit hash 同样要求人工确认后走
 *   `--allow-token-path`（负责人 2026-10-12 裁定）。
 */
import { createHash } from 'node:crypto';
import { checkProblem, type Problem } from './errors.js';

/** 疑似令牌的模式名。 */
export type TokenPattern =
  | 'pem_header'
  | 'jwt'
  | 'hex_secret'
  | 'base64_secret'
  | 'bearer_literal'
  | 'provider_prefix';

/** 一条命中记录（不含原串）。 */
export interface TokenFinding {
  readonly path: string;
  readonly pattern: TokenPattern;
  readonly length: number;
  readonly fingerprint: string;
}

/** 扫描结果。 */
export interface TokenScanResult {
  readonly findings: readonly TokenFinding[];
  /** 用户显式放行过、且确实命中过的路径（用于 stdout 留痕）。 */
  readonly allowlistedHits: readonly string[];
}

/** 至少 32 位连续十六进制。 */
const HEX_RUN = /[0-9a-fA-F]{32,}/gu;
/** JWT 形态：`eyJ` 开头的三段 base64url（与契约内置 jwt 脱敏规则同形）。 */
const JWT_LIKE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/u;
/** Bearer 令牌。 */
const BEARER_LIKE = /Beare?r\s+[A-Za-z0-9._~+/=-]{16,}/u;
/** 云厂商/平台的密钥前缀。 */
const PROVIDER_PREFIX = /\b(AKIA|ASIA|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_-]{8,}/u;
/** 完整 PEM 头。 */
const PEM_HEADER = /-----BEGIN [A-Z0-9 ]+-----/u;
/**
 * 已知良性形态的判定（不参与任何模式匹配）。
 *
 * 注意：32 位及以上纯十六进制串**不在这里**——K02-AC-07 字面要求
 * 「32 位以上随机十六进制串」命中即拦截，UUID 的紧凑写法也算命中；
 * 确属良性时由使用者用已批准的 `--allow-token-path <JSON 指针>` 显式放行。
 * 这里只放三类本仓库自己的确定形态：连字符 UUID、纯十进制数字串、
 * `sha256-<64hex>` 摘要（如 M01 的 ETag）。
 */
const BENIGN_PATTERNS: readonly RegExp[] = [
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u,
  /^\d+$/u,
  /^sha256-[0-9a-fA-F]{64}$/u,
];

/** base64/base64url 连续段（至少 43 字符，即解码后 >= 32 字节）。 */
const BASE64_RUN = /[A-Za-z0-9+/_-]{43,}={0,2}/gu;

/** 值是否属于已知的良性形态（不参与任何模式匹配）。 */
export function isBenignValue(value: string): boolean {
  return BENIGN_PATTERNS.some((pattern) => pattern.test(value));
}

/** 连续十六进制串是否是「疑似随机密钥」而非业务常量。 */
function isSuspiciousHexRun(run: string): boolean {
  const distinct = new Set(run.toLowerCase()).size;
  if (distinct < 10) return false;
  const letters = run.replace(/\d/gu, '').length;
  const digits = run.length - letters;
  return letters > 0 && digits > 0;
}

/** base64 段是否具备随机密钥特征（大小写与数字混合，解码后至少 32 字节）。 */
function isSuspiciousBase64Run(run: string): boolean {
  if (!/[a-z]/u.test(run) || !/[A-Z]/u.test(run) || !/\d/u.test(run)) return false;
  return Buffer.from(run, 'base64').length >= 32;
}

/** 单个字符串命中的全部模式（保持固定顺序，便于稳定输出）。 */
export function matchTokenPatterns(value: string): readonly TokenPattern[] {
  if (isBenignValue(value)) return [];
  const patterns = new Set<TokenPattern>();
  if (PEM_HEADER.test(value)) patterns.add('pem_header');
  if (JWT_LIKE.test(value)) patterns.add('jwt');
  if (BEARER_LIKE.test(value)) patterns.add('bearer_literal');
  if (PROVIDER_PREFIX.test(value)) patterns.add('provider_prefix');
  for (const match of value.matchAll(HEX_RUN)) {
    if (isSuspiciousHexRun(match[0])) patterns.add('hex_secret');
  }
  for (const match of value.matchAll(BASE64_RUN)) {
    if (isSuspiciousBase64Run(match[0])) patterns.add('base64_secret');
  }
  return [...patterns];
}

/** 值的不可逆指纹（只用于人工核对，无法据此还原原串）。 */
function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 6);
}

/** 拼接 JSON 指针路径。 */
function joinPointer(parent: string, segment: string): string {
  return `${parent}/${segment.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
}

function visit(
  value: unknown,
  pointer: string,
  allowlist: ReadonlySet<string>,
  findings: TokenFinding[],
  allowlistedHits: Set<string>,
): void {
  if (typeof value === 'string') {
    for (const pattern of matchTokenPatterns(value)) {
      if (allowlist.has(pointer)) {
        allowlistedHits.add(pointer);
        continue;
      }
      findings.push({ path: pointer, pattern, length: value.length, fingerprint: fingerprint(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      visit(item, joinPointer(pointer, String(index)), allowlist, findings, allowlistedHits);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      for (const pattern of matchTokenPatterns(key)) {
        const keyPointer = joinPointer(pointer, key);
        if (allowlist.has(keyPointer)) {
          allowlistedHits.add(keyPointer);
          continue;
        }
        findings.push({ path: keyPointer, pattern, length: key.length, fingerprint: fingerprint(key) });
      }
      visit(item, joinPointer(pointer, key), allowlist, findings, allowlistedHits);
    }
  }
}

/** 扫描一个配置正文对象。 */
export function scanSuspiciousTokens(
  value: unknown,
  options: { readonly allowPaths?: readonly string[] } = {},
): TokenScanResult {
  const allowlist = new Set(options.allowPaths ?? []);
  const findings: TokenFinding[] = [];
  const allowlistedHits = new Set<string>();
  visit(value, '', allowlist, findings, allowlistedHits);
  return { findings, allowlistedHits: [...allowlistedHits] };
}

/** 命中记录 → `Problem`（不含原串）。 */
export function toTokenProblems(findings: readonly TokenFinding[]): readonly Problem[] {
  return findings.map((finding) =>
    checkProblem(
      'suspected_token',
      `疑似令牌或密钥（模式 ${finding.pattern}，长度 ${String(finding.length)}，指纹 ${finding.fingerprint}，内容未回显）；配置中不得包含任何密钥或令牌，请改写后重试；确属良性常量可传 --allow-token-path ${finding.path}`,
      finding.path === '' ? '(root)' : finding.path,
    ),
  );
}
