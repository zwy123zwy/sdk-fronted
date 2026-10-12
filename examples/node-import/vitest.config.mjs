import { defineConfig } from 'vitest/config';

// 模拟接入方：不使用 source 条件，解析到 dist 产物
export default defineConfig({
  test: { include: ['vitest.test.ts'], environment: 'node' },
});
