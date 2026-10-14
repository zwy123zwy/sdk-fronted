/**
 * D-06 守卫的**扫描器**：找出 `tests/compat/**`、`tests/e2e/**`、`examples/**` 里
 * "会接收上报批次"的实现面，供 `guard-e2e-receivers-validate-contract.test.ts` 逐个人工归类。
 *
 * ## 为什么用文本特征而不是类型/AST
 *
 * 这三棵目录里混着 `.mjs`（node 直接跑）、`.ts`（vitest）、`.js`（探针）与内联的传输替身，
 * 没有统一的类型面可依赖。D-06 的漏洞形状是**行为**的（只解析不校验），所以扫描器的任务不是
 * "判定对错"，而是**保证不静默漏掉任何一个接收端**：
 *
 * - `http-body-receiver`：自己起 http 服务并读**请求**正文（`createServer(` + `req|request.on('data'`）。
 *   这是"自建端点"的准确形状；只管读**响应**正文的客户端（如 `dev-server.mjs` 的 `httpGet`）
 *   不会被误报。
 * - `transport-stub-receiver`：自己实现传输 `send(request)` 并碰 `request.body`。这是注入式
 *   接收替身的形状（examples 沙箱桩、compat 用例替身）。
 *
 * 扫描结果必须与守卫里**带理由的清单**逐项对齐：扫到但没登记 → 红（新增未归类），
 * 登记了但没扫到 → 红（清单失效/扫描器失灵）。
 *
 * 排除项（各带理由，见守卫正文）：`node_modules`、构建产物 `dist`、证据 `results`、
 * 生成物 `mutant-*`（T29 的变异体由 spec 在 `beforeAll` 从真实产物生成，是**被测实现**，
 * 不是接收端，而且不保证在磁盘上存在）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot, repoPath } from '../../contract/lib/fs-json';

/** 被扫描的三棵目录（D-06 的点名范围）。 */
export const SCAN_ROOTS: readonly string[] = ['tests/compat', 'tests/e2e', 'examples'];

/** 不进入扫描的目录名（构建产物/依赖/证据，都不是接收端实现面）。 */
export const SKIPPED_DIRECTORY_NAMES: readonly string[] = [
  'node_modules',
  'dist',
  'results',
  'coverage',
  '.vite',
  'test-results',
  'playwright-report',
];

/** 只看代码文件；`.d.mts` 是声明，不是实现。 */
const CODE_SUFFIXES: readonly string[] = ['.mjs', '.ts', '.js', '.cjs'];

/** 生成物文件名前缀（T29 的变异体：真实产物的单点变异，属于被测实现，不保证存在）。 */
const GENERATED_FILE_PREFIXES: readonly string[] = ['mutant-'];

/** 一个接收端接收面的形态。 */
export type ReceiverScanKind = 'http-body-receiver' | 'transport-stub-receiver';

export interface ReceiverCandidate {
  /** 相对仓库根的路径（与守卫清单里的写法一致）。 */
  readonly file: string;
  readonly scans: readonly ReceiverScanKind[];
}

const HTTP_SERVER = /createServer\s*\(/u;
const HTTP_REQUEST_BODY = /\b(req|request)\.on\(\s*['"]data['"]/u;
const TRANSPORT_SEND = /send\s*\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?::[^)]*)?\)/u;
const TRANSPORT_BODY = /\.body\b/u;

function isCodeFile(name: string): boolean {
  if (!CODE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  if (/\.d\.[cm]?ts$/u.test(name)) return false;
  return !GENERATED_FILE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function walk(absoluteDirectory: string, found: string[]): void {
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolute = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORY_NAMES.includes(entry.name)) walk(absolute, found);
      continue;
    }
    if (isCodeFile(entry.name)) found.push(absolute);
  }
}

/** 扫描三棵目录，返回"会接收批次"的实现面及其形态。 */
export function discoverReceiverCandidates(): readonly ReceiverCandidate[] {
  const absoluteFiles: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root), absoluteFiles);

  const candidates: ReceiverCandidate[] = [];
  for (const absolute of absoluteFiles.sort()) {
    const text = readFileSync(absolute, 'utf8');
    const scans: ReceiverScanKind[] = [];
    if (HTTP_SERVER.test(text) && HTTP_REQUEST_BODY.test(text)) {
      scans.push('http-body-receiver');
    }
    if (TRANSPORT_SEND.test(text) && TRANSPORT_BODY.test(text)) {
      scans.push('transport-stub-receiver');
    }
    if (scans.length > 0) candidates.push({ file: repoPath(absolute), scans });
  }
  return candidates;
}

/** 读一个仓库相对路径的文本（守卫做静态核对用）。 */
export function readRepoText(file: string): string {
  return readFileSync(join(repoRoot, file), 'utf8');
}
