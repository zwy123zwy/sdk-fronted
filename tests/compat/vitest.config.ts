/**
 * T30 兼容矩阵的独立 vitest 配置。
 *
 * **这不是门禁配置**：根 `vitest.config.ts` 的三个 project（`unit` / `contract` / `security`）不包含
 * `tests/compat/**`，因此 `pnpm test` 与 `pnpm gates` **不会**运行本目录——兼容性结论是**证据**，
 * 不是回归门禁（新增 vitest project 属门禁配置变更，需负责人批准）。
 *
 * 运行方式（见 `tests/compat/README.md`）：
 * ```
 * pnpm exec vitest run --config tests/compat/vitest.config.ts --coverage.enabled=false
 * ```
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
