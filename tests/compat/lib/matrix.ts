/**
 * T30 兼容矩阵的登记与证据落盘。
 *
 * 每一格兼容性结论都必须能回答三个问题：**测的是什么**、**怎么复跑**、**证据在哪**。
 * 本模块只做登记与写盘，不做任何断言——断言在各自的用例文件里。
 *
 * 状态取值（不得含糊，见 `tests/compat/README.md` 第 3 节）：
 * - `pass`：本机实跑过且证据落盘；
 * - `fail`：本机实跑过但不通过；
 * - `blocked`：本机做不了，必须写清「缺什么」与归属（T30 当前一律归 T29）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 兼容矩阵单元的状态。 */
export type CellStatus = 'pass' | 'fail' | 'blocked';

/** 兼容矩阵的一格。 */
export interface MatrixCell {
  /** 稳定标识，报告与 `results/*.json` 都用它引用（如 `import.esm.node`）。 */
  readonly id: string;
  /** 需求出处（T30 验收用例 / 指南 4.2 / Q7）。 */
  readonly requirement: string;
  /** 维度（接入方式、浏览器引擎、降级能力、共存顺序……）。 */
  readonly dimension: string;
  /** 环境（node / happy-dom / chromium-1223 / 真机……）。 */
  readonly engine: string;
  readonly status: CellStatus;
  /** 可复跑的命令。 */
  readonly command: string;
  /** 证据：文件路径或命令输出摘要。 */
  readonly evidence: string;
  /** 结论与局限（`blocked` 必写缺什么、归属谁）。 */
  readonly notes: string;
}

/**
 * `tests/compat/results/` 的绝对路径。
 *
 * **刻意不用 `fileURLToPath(new URL(...))`**：happy-dom 环境会把 `globalThis.URL` 换成自己的
 * 实现，`fileURLToPath` 会直接抛 `TypeError: The URL must be of scheme file`（本目录踩过）。
 * 这里只用 `import.meta.url` 的字符串形态，不依赖全局 URL。
 */
const moduleDir = dirname(decodeURIComponent(import.meta.url.replace(/^file:\/\//u, '')));
export const resultsDir = join(moduleDir, '..', 'results');

/** 把一次运行的原始证据写进 `results/<name>.json`，返回落盘路径。 */
export function writeResult(name: string, payload: unknown): string {
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

/** 把一组矩阵单元写进 `results/<name>.json`。 */
export function writeCells(name: string, cells: readonly MatrixCell[]): string {
  return writeResult(name, {
    task: 'T30',
    generatedAt: new Date().toISOString(),
    cells,
  });
}

/** 一格的登记输入（`status` / `command` / `evidence` 由调用方约定的规则补全）。 */
export interface CellInput {
  readonly requirement: string;
  readonly dimension: string;
  readonly engine: string;
  readonly evidence?: string;
  readonly notes: string;
  /**
   * 本机**做不了**时置 `true`（状态为 `blocked`，`notes` 必须写清缺什么与归属）。
   * 只允许用于"环境不可得"，不得用来掩盖失败——失败就是 `fail`。
   */
  readonly blocked?: boolean;
}

/** 探针结论表：用例实测后写入；未写入（用例抛错）视为失败。 */
export type ProbeTable = Record<string, boolean | undefined>;

/**
 * 由探针结论推导矩阵格。
 *
 * **为什么状态要由探针推导**：如果状态是硬编码的 `pass`，用例失败时矩阵仍会写「通过」——
 * 那就成了"没跑却写成通过"。用例抛错 → 探针未写入 → 该格必为 `fail`。
 */
export function derivedCell(
  probe: ProbeTable,
  command: string,
  id: string,
  input: CellInput,
): MatrixCell {
  const passed = probe[id];
  const status: CellStatus =
    input.blocked === true ? 'blocked' : passed === undefined ? 'fail' : passed ? 'pass' : 'fail';
  return {
    id,
    requirement: input.requirement,
    dimension: input.dimension,
    engine: input.engine,
    status,
    command,
    evidence: input.evidence ?? `probe:${id}`,
    notes: input.notes,
  };
}

