/**
 * D-06（方法论）的**判别性用例**：`"端到端通过" ≠ "端到端按契约通过"`。
 *
 * ## 这个文件防的是什么
 *
 * 既有"端到端送达"验证的接收端**只解析、不按 `docs/contracts/schemas/batch.schema.json`
 * 校验结构**。后果是 D-01（`common.page_id: null`，违反冻结契约）逃过了 T30 的 45 格矩阵、
 * T29 多个 spec 与全部 examples 验证，只在"真的按契约校验的接收方"（M01）面前暴露。
 *
 * ## 判别性（本文件的核心，不接受"只跑通"）
 *
 * 每个声称端到端送达的接收端都要能扛住**人为注入的违约批次**：
 *
 * 1. 基线：SDK **真实产出**的批次通过契约校验（否则用例本身是空转）；
 * 2. 注入 D-01 形态（`common.page_id = null`）→ 接收端必须拒收（HTTP 400）、且错误必须指到
 *    `/common/page_id`；
 * 3. 注入"删掉 required 字段"（`batch_id`）→ 同样必须拒收；
 * 4. 恢复合法批次 → 必须重新接受（证明拒收判的是内容，不是接收端坏了）。
 *
 * 注入方式**不修改 SDK**：把真实批次正文变形后再交给接收端（HTTP 直接 POST；传输替身直接
 * 调 `port.send`）。这样"守卫真的在守"这件事有独立证据。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import { createUploadStub, runBundleInSandbox } from '../../examples/webpack/scripts/lib/verify-bundle.mjs';
import { validateBatchAgainstContract } from './lib/batch-contract.mjs';
import { loadBrowserEntry } from './lib/entries';
import type { AssemblyLike, TransportRequestLike, TransportResponseLike } from './lib/entries';
import { startBatchIngestReceiver } from './lib/ingest-receiver.mjs';

const browserEntry = await loadBrowserEntry();
const endpoint = 'https://collect.invalid/ingest';
const assemblies: AssemblyLike[] = [];

afterEach(() => {
  for (const assembly of assemblies.splice(0)) assembly.destroy();
});

/** 用**真实 SDK 产物**产出一个批次，返回其正文（唯一的事实来源，不做任何改写）。 */
async function captureRealBatch(): Promise<string> {
  const requests: TransportRequestLike[] = [];
  const response: TransportResponseLike = { status: 202, headers: {} };
  const assembly = browserEntry.createAssembly({
    appId: 'compat-contract',
    endpoint,
    token: 'compat-contract-token',
    env: 'test',
    release: '0.0.0',
    consent: 'granted',
    transport: {
      send(request: TransportRequestLike): Promise<TransportResponseLike> {
        requests.push(request);
        return Promise.resolve(response);
      },
    },
    startHealthReporting: false,
  });
  assemblies.push(assembly);
  assembly.init();
  assembly.client.track('contract_probe', { dimensions: { probe: 'contract-gate' } });
  assembly.flush();
  const deadline = Date.now() + 2000;
  while (requests.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  const body = requests[0]?.body;
  if (body === undefined) throw new Error('SDK 没有产出批次（用例前提不成立）');
  return body;
}

/** D-01 形态：把 `common.page_id` 改成 `null`。 */
function withNullPageId(batchJson: string): string {
  const batch = JSON.parse(batchJson) as { common?: Record<string, unknown> };
  batch.common = { ...(batch.common ?? {}), page_id: null };
  return JSON.stringify(batch);
}

/** 删掉一个 `required` 字段。 */
function withoutRequiredField(batchJson: string): string {
  const batch = JSON.parse(batchJson) as Record<string, unknown>;
  delete batch['batch_id'];
  return JSON.stringify(batch);
}

async function postBatch(url: string, body: string): Promise<number> {
  const response = await fetch(`${url}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return response.status;
}

function requestOf(body: string): { url: string; headers: Record<string, string>; body: string } {
  return { url: endpoint, headers: { 'content-type': 'application/json' }, body };
}

describe('D-06 基线：真实 SDK 产出本身就是契约合法的（否则下面的判别性用例是空转）', () => {
  test('真实批次通过 batch.schema.json；同一批次改坏后必须被同一个校验门拒绝', async () => {
    const valid = await captureRealBatch();
    const ok = validateBatchAgainstContract(JSON.parse(valid) as unknown);
    expect(ok.errors).toEqual([]);
    expect(ok.ok).toBe(true);

    const bad = validateBatchAgainstContract(JSON.parse(withNullPageId(valid)) as unknown);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toContain('/common/page_id');
  });
});

describe('D-06 判别性：自建 HTTP 接收端（T30 核心路径用同一个实现）', () => {
  test('注入 D-01 形态（common.page_id = null）必须 400 拒收；恢复后 202', async () => {
    const receiver = await startBatchIngestReceiver();
    try {
      const valid = await captureRealBatch();

      expect(await postBatch(receiver.url, valid), '基线：合法批次必须被接受').toBe(202);
      expect(receiver.rejected).toHaveLength(0);

      expect(
        await postBatch(receiver.url, withNullPageId(valid)),
        '按 batch.schema.json 校验的接收端必须拒收 common.page_id = null',
      ).toBe(400);
      expect(receiver.rejected).toHaveLength(1);
      expect(receiver.rejected[0]?.errors.join('\n')).toContain('/common/page_id');
      expect(receiver.accepted).toHaveLength(1);

      expect(await postBatch(receiver.url, valid), '恢复合法批次后必须重新接受').toBe(202);
      expect(receiver.rejected, '恢复后不得新增拒收').toHaveLength(1);
      expect(receiver.accepted).toHaveLength(2);
    } finally {
      await receiver.close();
    }
  });

  test('注入"删掉 required 字段"（batch_id）同样必须 400 拒收', async () => {
    const receiver = await startBatchIngestReceiver();
    try {
      const valid = await captureRealBatch();
      expect(await postBatch(receiver.url, valid)).toBe(202);
      expect(await postBatch(receiver.url, withoutRequiredField(valid))).toBe(400);
      expect(receiver.rejected).toHaveLength(1);
      // Ajv 对"缺 required 字段"报在根上（instancePath 为空）。
      expect(receiver.rejected[0]?.errors.join('\n')).toContain(
        "must have required property 'batch_id'",
      );
    } finally {
      await receiver.close();
    }
  });
});

describe('D-06 判别性：examples/webpack 沙箱用的传输接收替身（真实工厂）', () => {
  test('注入违约批次必须 400 且进 rejections；恢复后 200', async () => {
    const stub = createUploadStub();
    const valid = await captureRealBatch();

    expect((await stub.port.send(requestOf(valid))).status, '基线：合法批次必须 200').toBe(200);
    expect(stub.rejections).toHaveLength(0);
    expect(stub.allAccepted()).toBe(true);

    const rejected = await stub.port.send(requestOf(withNullPageId(valid)));
    expect(rejected.status, '违约批次必须被拒收').toBe(400);
    expect(stub.rejections).toHaveLength(1);
    expect(stub.rejections[0]?.errors.join('\n')).toContain('/common/page_id');
    expect(stub.allAccepted()).toBe(false);

    expect((await stub.port.send(requestOf(valid))).status, '恢复后必须重新接受').toBe(200);
    expect(stub.rejections).toHaveLength(1);
  });
});

describe('D-06 端到端：webpack 生产产物沙箱走完最小路径后的批次必须过契约', () => {
  test('真实 bundle 产出批次 → 校验门通过', async () => {
    const distPath = fileURLToPath(new URL('../../examples/webpack/dist/main.js', import.meta.url));
    expect(
      existsSync(distPath),
      '需要先跑 `pnpm examples:build`（或 `node examples/webpack/scripts/build-production.mjs`）',
    ).toBe(true);
    const sandbox = await runBundleInSandbox(readFileSync(distPath, 'utf8'), distPath);
    expect(sandbox.checks['minimalPathRan']).toBe(true);
    expect(sandbox.checks['batchPassesContractSchema']).toBe(true);
    expect(sandbox.checks['batchContainsProbeEvent']).toBe(true);
  });
});
