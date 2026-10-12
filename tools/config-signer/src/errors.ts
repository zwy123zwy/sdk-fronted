/**
 * K02 共用类型、退出码与问题渲染。
 *
 * 安全约束（指南第 11 节）：K02 不得读取、打印或提交私钥内容。为此
 * `Problem` 只允许携带 `code`、`kind`、字段路径与人工编写的说明，
 * **没有承载原始值的字段**，所有输出统一经 `renderProblem()`，
 * 从类型上避免把配置正文或密钥材料带进日志。
 *
 * 错误传递约定：K02 不使用自定义异常类型（指南第 11 节禁止 class），
 * 内部一律返回 `Problem`；只有 CLI 顶层用普通 `Error` 做兜底。
 */

/** 退出码：与 K01 一致，便于接入方 CI 判断。 */
export const EXIT_OK = 0;
/** 检查未通过：校验失败、版本未递增、疑似令牌、验签失败。 */
export const EXIT_CHECK_FAILED = 1;
/** 用法或运行环境错误：未知子命令、缺参数、文件不可读、密钥不可解析。 */
export const EXIT_USAGE = 2;

/** 问题的性质：`check` 是检查未通过（退出码 1），`usage` 是用法/环境错误（退出码 2）。 */
export type ProblemKind = 'check' | 'usage';

/** 一个问题：只有机器可读码、字段路径与可读说明。 */
export interface Problem {
  /** 机器可读问题码，如 `schema_invalid`、`config_version_not_increasing`。 */
  readonly code: string;
  /** 问题性质，决定 CLI 退出码。 */
  readonly kind: ProblemKind;
  /** JSON 指针风格的字段路径；没有具体字段时为空串。 */
  readonly path: string;
  /** 面向人的说明；不得包含配置正文或密钥材料的原文。 */
  readonly message: string;
}

/** CLI 输出接口。 */
export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** 构造「检查未通过」问题（退出码 1）。 */
export function checkProblem(code: string, message: string, path = ''): Problem {
  return { code, kind: 'check', path, message };
}

/** 构造「用法或环境错误」问题（退出码 2）。 */
export function usageProblem(code: string, message: string, path = ''): Problem {
  return { code, kind: 'usage', path, message };
}

/** 判断一个未知值是否是 `Problem`。 */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['code'] === 'string' &&
    (record['kind'] === 'check' || record['kind'] === 'usage')
  );
}

/** 渲染一个问题为一行输出（有字段路径时一并输出）。 */
export function renderProblem(problem: Problem): string {
  const path = problem.path === '' ? '' : ` 字段路径 ${problem.path}`;
  const label = problem.kind === 'usage' ? 'K02 错误' : 'K02 问题';
  return `${label} [${problem.code}]${path} —— ${problem.message}`;
}

/**
 * 把内部抛出的异常转成用法/环境错误。
 *
 * 只输出错误的 `name` 与 `message`；抛出方必须自行保证 message 里没有敏感材料
 * （K02 内部抛错时统一使用 `usageProblem(...).message` 的文案）。
 */
export function toUsageProblem(error: unknown): Problem {
  if (isProblem(error)) return error;
  if (error instanceof Error) {
    return usageProblem('internal_error', `${error.name}: ${error.message}`);
  }
  return usageProblem('internal_error', '未知错误');
}
