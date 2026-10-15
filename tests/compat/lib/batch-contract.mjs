/**
 * **冻结契约的批次校验门（唯一实现）**——D-06 的固化点。
 *
 * ## 为什么必须有它
 *
 * 既有"端到端送达"验证的接收端只解析、不按 `docs/contracts/schemas/batch.schema.json`
 * 校验结构，于是 D-01（`common.page_id: null`）逃过了 45 格兼容矩阵 + T29 + 全部 examples，
 * 只在真的按契约校验的接收方（M01）面前暴露。
 *
 * **"端到端通过" ≠ "端到端按契约通过"。** 任何**声称端到端送达**的接收端（自建 HTTP 端点、
 * 传输替身、沙箱上传桩）都必须过这道门：
 *
 * - `validateBatchAgainstContract(batch)`：对**已解析**的批次对象做 Ajv（2020-12 + formats）校验；
 * - `inspectBatchText(text)`：先解析再校验，把"JSON 都解析不了"与"结构违约"分开报（前者只是
 *   传输层噪声，后者才是契约违反）；
 * - `rejectionFromOutcome(...)`：把判决压成接收方记录的形状。
 *
 * Ajv 实例与 `tests/contract/lib/schemas.ts` 的口径一致（`allErrors` + `strictRequired: false`，
 * 后者只因冻结 Schema 的 `required` 用了条件分支）。**Schema 直接读 `docs/contracts/`**，
 * 不在本文件里复制字段清单——契约改了，这道门跟着改。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * 解析冻结 Schema 的绝对路径。
 *
 * 不能只写 `fileURLToPath(new URL(..., import.meta.url))`：本文件会被 `apm-coexistence.test.ts`
 * 在 happy-dom 下加载，那里 `new URL(...)` 造出来的 href 会被沙箱改写成 `http://localhost:3000/…`，
 * `fileURLToPath` 随即报 "The URL must be of scheme file"（根因的完整证据见 `lib/matrix.ts`）。
 * 这里直接用 `import.meta.url` 的**字符串**形态（happy-dom 下也不经过 `new URL`，实测可用），
 * 失败再从 cwd 向上找（examples 脚本的 cwd 是 `examples/webpack`，不是仓库根）。
 */
function resolveBatchSchemaPath() {
  const relative = '../../../docs/contracts/schemas/batch.schema.json';
  try {
    const fromModule = join(dirname(fileURLToPath(import.meta.url)), relative);
    if (existsSync(fromModule)) return fromModule;
  } catch {
    // 非 file: 的 import.meta.url 走下面的 cwd 回退
  }
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, 'docs/contracts/schemas/batch.schema.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('找不到 docs/contracts/schemas/batch.schema.json（批次契约校验门的唯一依据）');
}

/** 冻结契约的批次 Schema（唯一依据）。 */
export const BATCH_SCHEMA_PATH = resolveBatchSchemaPath();

/** Ajv 校验函数（进程内编译一次；Schema 是冻结文件，不热更）。 */
let compiled;

function validator() {
  if (compiled !== undefined) return compiled;
  const schema = JSON.parse(readFileSync(BATCH_SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  compiled = ajv.compile(schema);
  return compiled;
}

/** 把 Ajv 错误压成人读的一行一条（与契约测试的报错口径一致）。 */
export function formatContractErrors(errors) {
  return (errors ?? []).map((error) => {
    const path = error.instancePath === '' ? '/' : error.instancePath;
    return `${path} ${error.keyword}: ${error.message ?? ''}`.trim();
  });
}

/** 对已解析的批次做契约校验。 */
export function validateBatchAgainstContract(value) {
  const validate = validator();
  if (validate(value)) return { ok: true, errors: [] };
  return { ok: false, errors: formatContractErrors(validate.errors) };
}

/** 先解析再校验；`code` 区分 `invalid_json`（传输层）与 `invalid_structure`（契约违反）。 */
export function inspectBatchText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_json', errors: ['正文不是合法 JSON'] };
  }
  const outcome = validateBatchAgainstContract(parsed);
  if (outcome.ok) return { ok: true, code: 'accepted', errors: [] };
  return { ok: false, code: 'invalid_structure', errors: outcome.errors };
}
