import { expect, test } from 'vitest';
import { SDK_VERSION, createAssembly } from '@web-report-sdk/browser';

import { installBrowserGlobals, runAssemblyMinimalPath } from '../webpack/scripts/lib/verify-bundle.mjs';

// 接入方在 Vitest 中直接导入构建产物，不需要额外配置（指南第 4.2 节）。
//
// #2（2026-10-15）：此前只断言 `typeof SDK_VERSION === 'string'`——那只证明"产物被求值了"。
// 现在**真跑**装配与最小投递：Node 没有 DOM，所以临时装上与 `examples/webpack` 沙箱**同一份**
// 最小浏览器面（`installBrowserGlobals`），再用**同一份**最小路径断言（含 `batch.schema.json`
// 的 Ajv 契约校验）——不另造一套。
test('可以在 Vitest 中导入构建产物，并跑通装配与最小投递', async () => {
  expect(typeof SDK_VERSION).toBe('string');
  const browser = installBrowserGlobals();
  try {
    const minimal = await runAssemblyMinimalPath({
      createAssembly,
      appId: 'node-import-vitest',
      probeEventName: 'node_import_vitest_probe',
      probeDimensions: { probe: 'node-import-vitest' },
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
