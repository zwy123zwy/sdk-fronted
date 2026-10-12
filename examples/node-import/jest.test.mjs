import { SDK_VERSION } from '@web-report-sdk/browser';

// 接入方在 Jest（原生 ESM 模式）中导入构建产物，不需要额外 transform（指南第 4.2 节）
test('可以在 Jest 中导入 SDK', () => {
  expect(typeof SDK_VERSION).toBe('string');
});
