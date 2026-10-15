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
import { dirname, join, resolve } from 'node:path';
// 只取 `fileURLToPath`：`URL` 构造函数在 happy-dom 下会被沙箱改写（根因见下），不用它。
import { fileURLToPath } from 'node:url';

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

/** 本文件所在目录（`tests/compat/lib/`）。 */
const moduleDir = dirname(fileDirectory());

/**
 * 本模块所在目录的绝对路径，**不依赖 `URL` 构造函数**。
 *
 * ## 根因（2026-10-15 实测，逐条留证）
 *
 * `apm-coexistence.test.ts` 带 `// @vitest-environment happy-dom`。在该环境下，**在被依赖的模块里**
 * （对比实验：同一段代码写在测试文件本身里就正常）`new URL('.', import.meta.url)` 得到的 href 是
 * `http://localhost:3000/tests/compat/lib` 而不是 `file:///…/tests/compat/lib`：`import.meta.url`
 * 本身确实是 `file:`（已打印核对），但构造出来的 URL 被 happy-dom 沙箱按它的站点基址改写。
 * 把它交给 `fileURLToPath` 就抛 `TypeError: The URL must be of scheme file`（`lib/matrix.ts` 是
 * 本目录唯一出现在该文件依赖图里的路径解析点，所以这条例外一直挂在 `apm-coexistence` 上）。
 * 仓库里两处既有注释把它记成"happy-dom 替换了全局 `URL`"——**只说对了一半**：本模块显式
 * `import { URL } from 'node:url'` 也照样中招，而 `fileURLToPath(import.meta.url)`（**字符串**入参）
 * 在同一环境同一时刻正常工作。真正的分界线是"**是否经过 `new URL(...)`**"，不是"URL 取自哪里"。
 *
 * ## 修法
 *
 * 不让沙箱有机会改写协议：直接把 `import.meta.url` 的**字符串**交给 `fileURLToPath`（已实测在
 * happy-dom 下可用），拿不到 `file:` 前缀时再退回 `process.cwd()`（vitest 的 root 是仓库根）。
 */
function fileDirectory(): string {
  const url = import.meta.url;
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      // 理论上不可达；真出现非 file: 形态时走下面的 cwd 回退
    }
  }
  return resolve(process.cwd(), 'tests/compat/lib');
}
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

