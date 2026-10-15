/**
 * T30 兼容矩阵的独立 vitest 配置。
 *
 * **根 `vitest.config.ts` 另有一个等价配置的 `compat` project**（2026-10-15 经负责人批准新增），
 * 因此 `pnpm test` 与 `pnpm gates` **已经**运行本目录的 5 个文件 / 28 个用例。
 * 本文件保留用于单独复跑（见 `tests/compat/README.md`）：
 * ```
 * pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false
 * # 等价的「门禁内」写法：
 * pnpm exec vitest run --project compat --coverage.enabled=false
 * ```
 * 两者等价：include 面与 `environment` 一致，且 per-file 的 `// @vitest-environment happy-dom`
 * 注解优先于 project 的 `environment`（`apm-coexistence.test.ts` 靠它跑在 happy-dom 下）。
 *
 * 前提：先 `pnpm build` 与 `pnpm examples:build`（用例 import 的是 `packages/<pkg>/dist`
 * 与 `examples/webpack/dist`）。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: repoRoot,
  test: {
    name: 'compat',
    include: ['tests/compat/**/*.test.ts'],
    // node：兼容性结论要在「接入方真实解析到的产物」上得出，不掺 happy-dom 的全局改写。
    // 需要 window/document 的用例在文件头用 `// @vitest-environment happy-dom` 单独声明。
    environment: 'node',
    coverage: { enabled: false },
  },
});
