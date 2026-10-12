/**
 * 正文来源的抽取：文件可以是裸正文、契约合法样例的 `decoded_payload`，
 * 或契约非法样例的 `cases` 数组（K02-AC-01）。
 */
import type { Problem } from './errors.js';

/** 抽取成功。 */
export interface ExtractedBodies {
  readonly ok: true;
  /** 逐个待校验的配置正文。 */
  readonly bodies: readonly Record<string, unknown>[];
  /** 是否来自 `cases` 文档（多份正文，不适合做单一递增检查）。 */
  readonly caseDocument: boolean;
  /** 给用户的提示（如契约样例里的 `_note`）。 */
  readonly notes: readonly string[];
}

/** 抽取失败（属于「用法错误」，CLI 按退出码 2 处理）。 */
export interface ExtractFailure {
  readonly ok: false;
  readonly kind: 'usage';
  readonly problem: Problem;
}

/** 抽取结果。 */
export type ExtractResult = ExtractedBodies | ExtractFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, path = ''): ExtractFailure {
  return { ok: false, kind: 'usage', problem: { code, kind: 'usage', message, path } };
}

/**
 * 从已解析的 JSON 中抽取正文。
 *
 * - `{ "cases": [...] }`：每个元素是一份正文；元素里的 `_why` 是样例说明，先剔除。
 * - `{ "decoded_payload": {...} }`：契约合法样例只校验 `decoded_payload`；
 *   若同时存在 `_note`，作为提示返回。
 * - 其他对象：视为裸正文。
 */
export function extractBodies(input: unknown): ExtractResult {
  if (!isRecord(input)) {
    return fail('body_invalid', '正文必须是 JSON 对象');
  }
  const rawCases = input['cases'];
  if (Array.isArray(rawCases)) {
    const bodies: Record<string, unknown>[] = [];
    const notes: string[] = [];
    for (const [index, entry] of rawCases.entries()) {
      if (!isRecord(entry)) {
        return fail('body_invalid', `cases[${String(index)}] 不是 JSON 对象`, `/cases/${String(index)}`);
      }
      const copy = { ...entry };
      delete copy['_why'];
      bodies.push(copy);
      const why = entry['_why'];
      notes.push(typeof why === 'string' ? `cases[${String(index)}]：${why}` : '');
    }
    if (bodies.length === 0) {
      return fail('body_invalid', 'cases 数组为空，没有可校验的正文', '/cases');
    }
    return { ok: true, bodies, caseDocument: true, notes };
  }
  const decoded = input['decoded_payload'];
  if (isRecord(decoded)) {
    const note = input['_note'];
    return {
      ok: true,
      bodies: [decoded],
      caseDocument: false,
      notes: typeof note === 'string' ? [note] : [],
    };
  }
  return { ok: true, bodies: [input], caseDocument: false, notes: [] };
}
