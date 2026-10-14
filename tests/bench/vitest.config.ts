/**
 * T20 受控基准的独立 vitest 配置。
 *
 * **这不是门禁配置**：根 `vitest.config.ts` 的三个 project（`unit` / `contract` / `security`）
 * 不包含 `tests/bench/**`，因此 `pnpm test` 与 `pnpm gates` **不会**运行本目录——
 * 基准按设计不是回归门禁（见 `docs/reports/handover.md` 第 2 节 T20 小节的口径要求）。
 *
 * 本文件只让基准可在受控条件下单独运行：
 * - `environment: node`——基准测的是本机 node 下的客户端逻辑成本，不掺 happy-dom 开销；
 * - `fileParallelism: false` + 单 worker——**串行**执行，避免同机并发把自己的调度抖动灌进样本；
 * - 关闭覆盖率与快照。
 *
 * 运行方式（见 `tests/bench/README.md`）：
 * ```
 * pnpm exec vitest run --config tests/bench/vitest.config.ts --coverage.enabled=false
 * ```
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: repoRoot,
  test: {
    name: 'bench',
    include: ['tests/bench/**/*.bench.ts'],
    environment: 'node',
    // 串行 + 单 worker：基准样本只应包含被测代码的成本
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // 微秒级指标在默认的 10 s 内跑不完高样本量；串行下也不需要隔离
    isolate: true,
    coverage: { enabled: false },
  },
});
