import { SDK_VERSION, createAssembly } from '@web-report-sdk/browser';

import { installBrowserGlobals, runAssemblyMinimalPath } from '../webpack/scripts/lib/verify-bundle.mjs';

// 接入方在 Jest（原生 ESM 模式）中导入构建产物，不需要额外 transform（指南第 4.2 节）。
//
// #2（2026-10-15）：此前只断言 `typeof SDK_VERSION === 'string'`。现在与 Vitest 用例跑**同一套**
// 最小投递路径（`runAssemblyMinimalPath`，含契约 Schema 校验），只把 `appId`/探针事件名区分开，
// 这样"Jest 里能用"和"Vitest 里能用"是同一个口径下的两条独立证据。
test('可以在 Jest 中导入构建产物，并跑通装配与最小投递', async () => {
  expect(typeof SDK_VERSION).toBe('string');
  const browser = installBrowserGlobals();
  try {
    const minimal = await runAssemblyMinimalPath({
      createAssembly,
      appId: 'node-import-jest',
      probeEventName: 'node_import_jest_probe',
      probeDimensions: { probe: 'node-import-jest' },
    });
    expect(minimal.minimalPathError).toBeNull();
    expect(minimal.checks).toMatchObject({
      assemblyCreated: true,
      assemblyClientHasTrack: true,
      uploadStubReceivedRequest: true,
      batchPassesContractSchema: true,
      batchHasEvents: true,
      batchContainsProbeEvent: true,
      minimalPathRan: true,
    });
  } finally {
    browser.restore();
  }
});
