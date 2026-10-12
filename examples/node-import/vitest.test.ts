import { expect, test } from 'vitest';
import { SDK_VERSION } from '@web-report-sdk/browser';

// 接入方在 Vitest 中直接导入构建产物，不需要额外配置（指南第 4.2 节）
test('可以在 Vitest 中导入 SDK', () => {
  expect(typeof SDK_VERSION).toBe('string');
});
