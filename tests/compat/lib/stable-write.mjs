/**
 * 幂等的证据落盘：**只有"实质内容"变化时才重写文件**。
 *
 * ## 为什么需要它
 *
 * `tests/compat/results/*.json` 由门禁（`pnpm test` → 4 份进程内矩阵、`pnpm examples:build`
 * / `examples:test` → 2 份 webpack 证据）**每次都重写**，而其中只有一部分字段是"每次运行
 * 必然不同"的（时间戳、耗时、随机端口）。结果是：**跑完门禁工作区永远是脏的**——于是要么
 * 每次提交都带上无意义的 churn，要么有人顺手把它们 checkout 掉、从而掩盖真实改动。
 *
 * ## 语义（本模块定下的口径）
 *
 * `generatedAt` 的含义从"**上次运行时间**"改为"**本产物上次实质变化的时间**"：
 * 除 `volatilePaths` 列出的易变字段外，其余内容与磁盘上现有文件一致时，**不重写**——
 * 因此磁盘上的 `generatedAt` / `evaluatedMs` / `origin` 都停留在**上一次实质变化的那次运行**。
 *
 * ## 为什么是"易变字段清单"而不是"只比 `generatedAt`"
 *
 * 实测（2026-10-16，逐次运行对比，见 `docs/reports/t33-access-blockers.md` 第十二节）：
 * 各产物的**每次运行都会变**的字段并不只有时间戳——
 * - `webpack-production.json`：`generatedAt`、`sandbox.evaluatedMs`（墙钟耗时）；
 * - `webpack-dev-server.json`：`generatedAt`、`origin`、`sandbox.bundlePath`（`port: 0` 随机端口）、
 *   `sandbox.evaluatedMs`。
 *
 * 只比 `generatedAt` 的话，这两份文件仍会**每次**因耗时与端口而重写。清单是**显式**的：
 * 新增一个易变字段时，本清单不会自动吸收它——文件会重新变脏并**暴露**出来（宁可吵，不可静默）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { redactPaths } from './redact-paths.mjs';

/** 解析 `sandbox.evaluatedMs` / `cells[0].status` 形态的路径为段序列（数字段转 number）。 */
function parsePath(path) {
  return [...path.matchAll(/[^.[\]]+/gu)].map(([segment]) =>
    /^\d+$/u.test(segment) ? Number(segment) : segment,
  );
}

/**
 * 去掉 `volatilePaths` 指向的叶子后，把载荷序列化成字符串，用于"实质内容"比较。
 * 用 JSON 往返克隆，因为载荷按定义就是 JSON。
 */
function project(payload, volatilePaths) {
  const copy = JSON.parse(JSON.stringify(payload));
  for (const path of volatilePaths) {
    const segments = parsePath(path);
    let node = copy;
    for (const segment of segments.slice(0, -1)) {
      if (node === null || typeof node !== 'object') {
        node = undefined;
        break;
      }
      node = node[segment];
    }
    if (node !== null && typeof node === 'object') {
      // 用赋 `undefined` 代替 `delete`：本函数的唯一消费者是 `JSON.stringify`，
      // 而它**同样省略值为 `undefined` 的属性** ⇒ 语义等价；
      // 本仓 eslint 禁止动态 delete（`no-dynamic-delete`）。
      node[segments[segments.length - 1]] = undefined;
    }
  }
  return JSON.stringify(copy);
}

/**
 * 把 `payload` 写进 `file`，**幂等**。
 *
 * - 文件不存在 / 不是合法 JSON / 实质内容有变 → 写盘；
 * - 与磁盘内容逐字节相同，或**只差 `volatilePaths` 指向的字段** → 不写盘，保留上一次的字段值。
 *
 * **写入前脱敏**：载荷先过 `redact-paths.mjs`（绝对路径 → `<repo>` / `<ms-playwright>` /
 * `<home>` / `<tmp>`），再参与"实质内容"比较与落盘。于是证据文件不会把本机用户名提交进仓库，
 * 且重跑一次门禁就自然产出干净证据——这正是"改写入者、不改产物"的落点。
 *
 * 返回落盘路径与是否真的写了盘（`written: false` 即"这次运行没有让产物变化"）。
 *
 * @param {string} file 目标文件（绝对路径）
 * @param {unknown} payload 本次运行的载荷（必须是 JSON 可序列化对象）
 * @param {readonly string[]} [volatilePaths] 允许逐次变化的字段路径，默认 `['generatedAt']`
 * @returns {{ file: string, written: boolean, reason: 'identical' | 'only-volatile-fields-changed' | 'content-changed' }}
 */
export function writeJsonStable(file, payload, volatilePaths = ['generatedAt']) {
  const safe = redactPaths(payload);
  const text = `${JSON.stringify(safe, null, 2)}\n`;
  try {
    const previousText = readFileSync(file, 'utf8');
    if (previousText === text) return { file, written: false, reason: 'identical' };
    const previous = JSON.parse(previousText);
    if (project(previous, volatilePaths) === project(safe, volatilePaths)) {
      return { file, written: false, reason: 'only-volatile-fields-changed' };
    }
  } catch {
    // 文件不存在或不是合法 JSON：按"内容变了"处理，正常落盘。
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return { file, written: true, reason: 'content-changed' };
}
