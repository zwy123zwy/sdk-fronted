/**
 * 配置正文校验（K02-F1、K02-F2、K02-AC-07）。
 *
 * 顺序：抽取正文 → Schema 校验 → D002 专属提示 → 疑似令牌扫描 → 版本递增检查。
 * 返回值只含 `Problem`（无原始取值），由 CLI 统一渲染。
 */
import {
  EXIT_CHECK_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  checkProblem,
  usageProblem,
  type Problem,
} from './errors.js';
import { extractBodies } from './payload.js';
import { getBodyValidator, toSchemaProblems } from './schema.js';
import { scanSuspiciousTokens, toTokenProblems } from './token-scan.js';
import { checkVersionIncreasing } from './version.js';

/** D002 的专属提示（负责人 2026-10-12 确认：这是 D002 的明文要求，不是警告）。 */
export const CONSENT_FULL_MESSAGE =
  '远程配置不接受 consent_mode: full（D002，见 docs/decisions/D002-consent-full-mode.md、docs/contracts/remote-config.md 第 2.1 节）：full 只能在接入方页面代码的初始化参数中设置，远程配置只能收紧为 buffer 或 essential_only。';

/** 校验请求。 */
export interface ValidateRequest {
  /** 已解析的 JSON（可能包含 `decoded_payload` 或 `cases` 包装）。 */
  readonly raw: unknown;
  /** 上一份发布物的 config_version；`null` 表示未提供 `--previous`。 */
  readonly previous?: number | null;
  /** 用户显式放行的令牌路径（JSON 指针）。 */
  readonly allowTokenPaths?: readonly string[];
}

/**
 * 校验结果。
 *
 * 失败时 `problems` 里每一项自带 `kind`：`usage` 表示用法/环境错误（退出码 2），
 * `check` 表示检查未通过（退出码 1）。`exitCode` 是汇总后的退出码。
 */
export interface ValidationResult {
  readonly ok: boolean;
  /** 汇总退出码：成功为 0；有 `usage` 问题为 2；否则为 1。 */
  readonly exitCode: number;
  readonly problems: readonly Problem[];
  /** 正常摘要与留痕信息（stdout）。 */
  readonly messages: readonly string[];
  /** 被放行的路径（用于留痕）。 */
  readonly allowlistedHits: readonly string[];
  /** 抽取出的正文个数（cases 文档会有多个）。 */
  readonly bodyCount: number;
}

/** 只把 string/number 转成展示用字符串，避免 stringify 对象。 */
function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** consent_mode 是否为远程配置不接受的 `full`。 */
function isConsentFull(body: Record<string, unknown>): boolean {
  const privacy = body['privacy'];
  if (typeof privacy !== 'object' || privacy === null || Array.isArray(privacy)) return false;
  return (privacy as Record<string, unknown>)['consent_mode'] === 'full';
}

/** 校验单份正文。 */
function validateBody(
  body: Record<string, unknown>,
  problems: Problem[],
): void {
  const validate = getBodyValidator();
  const valid = validate(body);
  if (valid) return;
  const schemaProblems = toSchemaProblems(validate.errors);
  if (!isConsentFull(body)) {
    problems.push(...schemaProblems);
    return;
  }
  // full 在 Schema 层已经失败（枚举不含它）；这里只把该条换成 D002 专属说明。
  let replaced = false;
  for (const problem of schemaProblems) {
    if (problem.path === '/privacy/consent_mode') {
      problems.push(checkProblem('consent_mode_full_rejected', CONSENT_FULL_MESSAGE, problem.path));
      replaced = true;
      continue;
    }
    problems.push(problem);
  }
  if (!replaced) {
    problems.push(checkProblem('consent_mode_full_rejected', CONSENT_FULL_MESSAGE, '/privacy/consent_mode'));
  }
}

/** 校验一份或多份正文。 */
export function validateConfig(request: ValidateRequest): ValidationResult {
  const extracted = extractBodies(request.raw);
  if (!extracted.ok) {
    return {
      ok: false,
      exitCode: EXIT_USAGE,
      problems: [extracted.problem],
      messages: [],
      allowlistedHits: [],
      bodyCount: 0,
    };
  }
  const problems: Problem[] = [];
  const messages: string[] = [];
  const allowTokenPaths = request.allowTokenPaths ?? [];
  if (allowTokenPaths.length > 0) {
    messages.push(`已启用令牌白名单（${String(allowTokenPaths.length)} 条路径），每次放行都会在下面留痕。`);
  }
  const isCaseDocument = extracted.caseDocument;
  if (isCaseDocument && request.previous !== undefined && request.previous !== null) {
    return {
      ok: false,
      exitCode: EXIT_USAGE,
      problems: [
        usageProblem('usage_error', 'cases 文档包含多份正文，无法使用 --previous 做递增检查'),
      ],
      messages: [],
      allowlistedHits: [],
      bodyCount: extracted.bodies.length,
    };
  }

  const allowlistedHits = new Set<string>();
  let singleVersion: number | null = null;
  for (const body of extracted.bodies) {
    validateBody(body, problems);
    const scan = scanSuspiciousTokens(body, { allowPaths: allowTokenPaths });
    problems.push(...toTokenProblems(scan.findings));
    for (const path of scan.allowlistedHits) allowlistedHits.add(path);
    const version = body['config_version'];
    if (typeof version === 'number' && Number.isInteger(version)) singleVersion = version;
  }

  if (!isCaseDocument && request.previous !== undefined && request.previous !== null) {
    const version = singleVersion;
    if (version === null) {
      problems.push(
        checkProblem('config_version_missing', '正文缺少整数 config_version，无法做递增检查', '/config_version'),
      );
    } else {
      const check = checkVersionIncreasing(version, request.previous);
      if (check.status === 'not_increasing') {
        problems.push(
          checkProblem(
            'config_version_not_increasing',
            `config_version 必须严格大于上一份发布物：上一份 ${String(check.previous)}，本次 ${String(check.next)}。相等会被 SDK 判为 config_version_stale（remote-config.md 第 3 节），更小还会导致旧发布物回放。`,
            '/config_version',
          ),
        );
      } else if (check.status === 'ok') {
        messages.push(`config_version 递增检查通过：${String(check.previous)} → ${String(check.next)}`);
      }
    }
  } else if (!isCaseDocument) {
    messages.push('未提供 --previous，已跳过 config_version 递增检查。');
  }

  if (problems.length > 0) {
    return {
      ok: false,
      exitCode: problems.some((problem) => problem.kind === 'usage') ? EXIT_USAGE : EXIT_CHECK_FAILED,
      problems,
      messages,
      allowlistedHits: [...allowlistedHits],
      bodyCount: extracted.bodies.length,
    };
  }

  const first = extracted.bodies[0];
  if (!isCaseDocument && first !== undefined) {
    messages.push(
      `K02 validate 通过：app_id=${scalar(first['app_id'])} env=${scalar(first['env'])} config_version=${scalar(first['config_version'])}`,
    );
  } else {
    messages.push(`K02 validate 通过：${String(extracted.bodies.length)} 份正文全部符合 Schema`);
  }
  return {
    ok: true,
    exitCode: EXIT_OK,
    problems,
    messages,
    allowlistedHits: [...allowlistedHits],
    bodyCount: extracted.bodies.length,
  };
}
