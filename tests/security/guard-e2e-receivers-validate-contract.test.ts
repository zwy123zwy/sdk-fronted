/**
 * 仓库级守卫三：**声称"端到端送达"的接收端必须按冻结契约校验结构**（D-06 的防复发装置）。
 *
 * ## 依据
 *
 * D-06（`docs/reports/t33-access-blockers.md`）：T30/T29/examples 的"端到端送达"验证里，接收端
 * **都不按 `docs/contracts/schemas/batch.schema.json` 校验结构**（`browser-core-path.mjs` 是自建
 * 端点，只解析不校验）。后果：D-01（`common.page_id: null` 违反冻结契约）**逃过了 45 格兼容矩阵
 * + T29 多个 spec + 全部 examples 验证**，只在真的按契约校验的接收方（M01）面前暴露。
 *
 * **"端到端通过" ≠ "端到端按契约通过"。**
 *
 * ## 这个守卫断言什么
 *
 * 扫描 `tests/compat/**`、`tests/e2e/**`、`examples/**` 里所有"会接收上报批次"的实现面
 * （`createServer(` + 读**请求**正文；或自实现的传输 `send(request)` 碰 `request.body`），
 * 然后要求它们**逐个**出现在下面带理由的清单里，二选一：
 *
 * 1. `contract-gated`：声称端到端送达 → **必须**接上唯一校验门 `tests/compat/lib/batch-contract.mjs`
 *    （Ajv 2020-12 直接编译冻结 Schema），静态核对（本守卫）+ 行为核对
 *    （`tests/compat/receiver-contract-gate.test.ts` 注入违约批次，必须 400 拒收）；
 * 2. `transport-probe`：**不**声称按契约送达（只做传输层探针 / 只是注入夹具）→ 必须写明
 *    "为什么它拿不到完整批次、为什么加校验只会校验夹具"。**不许为了过守卫加空校验。**
 *
 * ## 反空转（本守卫最容易静默失效的地方）
 *
 * - 断言**扫到的接收端数量** ≥ 5、自建 http 接收端 ≥ 2、传输替身 ≥ 3；
 * - 断言三棵目录（`tests/compat`、`tests/e2e`、`examples`）**各自**至少贡献一个接收端；
 * - 断言点名文件（T30 的 `/ingest` 实现、T29 的接收端、examples 的上传替身）确实在扫描结果里。
 *   正则/glob 写错或识别器失效时立刻红，而不是"扫了 0 个所以通过"。
 *
 * ## 双向清单
 *
 * 扫到但未登记 → 红（新增未归类）；登记了但扫不到 → 也红（文件改名/清单过期，或扫描器失灵）。
 * 两侧都断言，"清单"不可能悄悄失真。
 *
 * ## 变异验证（本会话实测）
 *
 * - 把 `batch-contract.mjs` 的 Ajv 校验去掉（改成恒 `ok:true`）→
 *   `receiver-contract-gate.test.ts` 的判别性用例 4 条转红（接收端把 `page_id: null` 当 202 收下）；
 * - 把本守卫的数量阈值改高 / 在扫描面里临时新增一个未登记接收端 → 本守卫红；
 * - 删掉清单里的一条 `transport-probe`（扫描面仍有它）→ 本守卫红。
 *
 * 本文件**只读**其它目录的文本，不修改实现。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { repoRoot } from '../contract/lib/fs-json';
import {
  discoverReceiverCandidates,
  readRepoText,
  SCAN_ROOTS,
  type ReceiverScanKind,
} from './lib/e2e-receiver-inventory';

/** 唯一校验门（所有"声称端到端送达"的接收端都必须用它，不许各写各的）。 */
const GATE_MODULE = 'tests/compat/lib/batch-contract.mjs';

/** 校验门对外暴露的校验 API（清单项必须真的调用其中之一）。 */
const GATE_APIS: readonly string[] = ['validateBatchAgainstContract', 'inspectBatchText'];

/** 静态核对：接收端必须以 `import { … } from '…/batch-contract.mjs'` 接上校验门。 */
const GATE_IMPORT = /import\s*\{[^}]*\}\s*from\s*['"][^'"]*batch-contract\.mjs['"]/u;

interface ContractGatedEntry {
  readonly kind: 'contract-gated';
  readonly file: string;
  readonly scan: ReceiverScanKind;
  readonly note: string;
}

interface TransportProbeEntry {
  readonly kind: 'transport-probe';
  readonly file: string;
  readonly scan: ReceiverScanKind;
  readonly reason: string;
}

type ReceiverDisposition = ContractGatedEntry | TransportProbeEntry;

/**
 * 带理由的清单：**扫描面里的每一个接收端都必须在这里。**
 *
 * `contract-gated` = 声称端到端送达并接上校验门；`transport-probe` = 如实降级并说明为什么
 * 它不算端到端送达。新增接收端而不登记，或登记项被删除/改名，守卫都会红。
 */
const RECEIVER_DISPOSITIONS: readonly ReceiverDisposition[] = [
  {
    kind: 'contract-gated',
    file: 'tests/compat/lib/ingest-receiver.mjs',
    scan: 'http-body-receiver',
    note:
      'T30 核心路径脚本（tests/compat/scripts/browser-core-path.mjs）与判别性用例共用的自建 ' +
      '`/ingest` 端点；经 batch-contract.mjs 的 Ajv 门校验，结构违约一律 400 并记录 Ajv 错误。',
  },
  {
    kind: 'contract-gated',
    file: 'examples/webpack/scripts/lib/verify-bundle.mjs',
    scan: 'transport-stub-receiver',
    note:
      'examples/webpack 生产构建与开发服务器共用的沙箱上传替身；它声称"接收方真收到批次"，' +
      '因此按契约校验，任一批被拒 → checks.batchPassesContractSchema=false → status=fail。',
  },
  {
    kind: 'contract-gated',
    file: 'tests/compat/apm-coexistence.test.ts',
    scan: 'transport-stub-receiver',
    note:
      'APM 共存用例的上传替身；用例声称"双方数据都正确、SDK 数据送达"，违约批次返回 400 并' +
      '登记到 contractViolations，afterEach 断言为空。',
  },
  {
    kind: 'contract-gated',
    file: 'tests/compat/degradation.test.ts',
    scan: 'transport-stub-receiver',
    note:
      '降级矩阵的上传替身；用例声称"能力缺失时批次仍送达"，同样过校验门，afterEach 断言无拒收。',
  },
  {
    kind: 'transport-probe',
    file: 'tests/e2e/lib/receiver.mjs',
    scan: 'http-body-receiver',
    reason:
      '传输探针，不声称按契约送达：它收到的是探针**手写信封**（tests/e2e/probes/real-browser-driver.js ' +
      '的 envelope()，device_id/session_id/batch_id 刻意不是契约 uuid）与 sendBeacon 的随机字节哨兵' +
      '（1 KB / 80 KB）。它服务的是传输层行为（信标字节上限、XHR 真超时、401 暂停、字节计数），' +
      '拿不到 SDK 装配根产出的完整批次，所以加 Ajv 只会校验夹具本身。',
  },
  {
    kind: 'transport-probe',
    file: 'tests/e2e/leave-slice.spec.mjs',
    scan: 'http-body-receiver',
    reason:
      '传输探针，不声称按契约送达：C07-AC-03 的信标切片端点，收到的是 leave-slice-driver.js ' +
      '手写信封（event_id 形如 ac03-0000、batch_id=ac03-batch，刻意不是契约 uuid）。判定对象是' +
      '片大小 / Content-Type / 令牌位置 / 顺序无重复无丢失，属于传输层与请求口径，不是批次结构。',
  },
  {
    kind: 'transport-probe',
    file: 'tests/compat/receiver-contract-gate.test.ts',
    scan: 'transport-stub-receiver',
    reason:
      '不是接收端，是**判别性注入夹具**：本文件里的捕获替身只用来取一份"真实 SDK 产出批次"的' +
      '正文，再把它改坏后交给被测接收端（http 端点 / examples 上传替身）去拒收；它自己不声称送达。',
  },
];

/** 扫描一次（守卫内只读）。 */
const discovered = discoverReceiverCandidates();

function filesOf(candidates: readonly { readonly file: string }[]): readonly string[] {
  return candidates.map((candidate) => candidate.file);
}

describe('守卫三：声称端到端送达的接收端必须按冻结契约校验结构', () => {
  test('反空转：扫描面覆盖三棵目录，且点名的接收端确实被识别到', () => {
    expect(discovered.length, '扫到的接收端数量').toBeGreaterThanOrEqual(5);

    const httpReceivers = discovered.filter((candidate) =>
      candidate.scans.includes('http-body-receiver'),
    );
    const stubReceivers = discovered.filter((candidate) =>
      candidate.scans.includes('transport-stub-receiver'),
    );
    expect(httpReceivers.length, '自建 http 接收端数量').toBeGreaterThanOrEqual(2);
    expect(stubReceivers.length, '传输替身接收端数量').toBeGreaterThanOrEqual(3);

    const files = filesOf(discovered);
    // 点名断言：识别器/正则写错时立刻红，而不是"什么都没扫到所以通过"。
    expect(files).toContain('tests/compat/lib/ingest-receiver.mjs');
    expect(files).toContain('tests/e2e/lib/receiver.mjs');
    expect(files).toContain('examples/webpack/scripts/lib/verify-bundle.mjs');

    for (const root of SCAN_ROOTS) {
      expect(
        files.some((file) => file.startsWith(`${root}/`)),
        `扫描面必须覆盖 ${root}`,
      ).toBe(true);
    }
  });

  test('双向清单：扫到但未登记 → 红；登记了但扫不到 → 也红', () => {
    const registered = RECEIVER_DISPOSITIONS.map((entry) => entry.file);
    const discoveredFiles = filesOf(discovered);

    expect(
      discoveredFiles.filter((file) => !registered.includes(file)),
      '这些文件会接收上报批次，但没在守卫清单里登记（新增未归类）→ 要么接上校验门，要么如实降级并写理由',
    ).toEqual([]);

    expect(
      registered.filter((file) => !discoveredFiles.includes(file)),
      '守卫清单里的条目已经扫不到（文件移动/改名，或扫描器失灵）→ 清单失真',
    ).toEqual([]);

    expect(new Set(registered).size, '同一个文件不得重复登记').toBe(registered.length);

    // 形态标注也必须与扫描结果一致（防止把 http 端点写成传输替身而绕过检查）。
    const byFile = new Map<string, (typeof discovered)[number]>(
      discovered.map((candidate): [string, (typeof discovered)[number]] => [
        candidate.file,
        candidate,
      ]),
    );
    for (const entry of RECEIVER_DISPOSITIONS) {
      const candidate = byFile.get(entry.file);
      expect(candidate, `${entry.file} 不在扫描结果里`).toBeDefined();
      expect(
        candidate?.scans,
        `${entry.file} 的形态标注（${entry.scan}）与扫描结果不一致`,
      ).toContain(entry.scan);
    }
  });

  test('contract-gated 项必须真的接上唯一校验门', () => {
    const gated = RECEIVER_DISPOSITIONS.filter(
      (entry): entry is ContractGatedEntry => entry.kind === 'contract-gated',
    );
    expect(gated.length, '带契约校验的接收端数量').toBeGreaterThanOrEqual(3);

    for (const entry of gated) {
      const text = readRepoText(entry.file);
      expect(
        GATE_IMPORT.test(text),
        `${entry.file} 必须以 import … from '…/batch-contract.mjs' 接上唯一校验门`,
      ).toBe(true);
      expect(
        GATE_APIS.some((api) => text.includes(api)),
        `${entry.file} 必须调用校验门的校验 API（${GATE_APIS.join(' / ')}）`,
      ).toBe(true);
    }
  });

  test('transport-probe 例外必须给出实质性降级理由', () => {
    const probes = RECEIVER_DISPOSITIONS.filter(
      (entry): entry is TransportProbeEntry => entry.kind === 'transport-probe',
    );
    expect(probes.length, '如实降级的传输探针数量').toBeGreaterThanOrEqual(1);

    for (const entry of probes) {
      // 理由必须说清"收到的是什么、为什么加不了契约校验"，不是一句"探针，略"。
      expect(entry.reason.length, `${entry.file} 的降级理由太短（说不清为什么不算端到端送达）`)
        .toBeGreaterThanOrEqual(80);
    }
  });

  test('校验门本身：Ajv 2020-12 + 直接编译冻结 Schema，而不是手写字段清单', () => {
    expect(existsSync(join(repoRoot, GATE_MODULE)), `${GATE_MODULE} 必须存在`).toBe(true);
    const text = readRepoText(GATE_MODULE);
    expect(text, '必须用 Ajv 2020-12').toContain('ajv/dist/2020');
    expect(text, '必须启用 format 关键字').toContain('addFormats');
    expect(text, '必须直接读冻结 Schema').toContain('docs/contracts/schemas/batch.schema.json');
    expect(text, '与 tests/contract 的编译口径一致').toContain('strictRequired: false');
  });
});
