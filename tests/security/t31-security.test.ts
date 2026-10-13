/**
 * T31 安全与隐私测试（可执行部分）。
 *
 * 所有权：本目录（`tests/security/`）是 T31 任务卡指定的可写面；本文件**只读实现代码，不修改任何实现**。
 *
 * 设计原则：**断言安全属性本身，而不是实现细节。**
 * 例如脱敏，断言的是「注入的敏感值不再出现在输出里」，而不是断言某个具体的替换串——
 * 后者会把测试绑死在实现上，实现改了替换文案测试就红（而安全属性其实没变）；
 * 反过来，替换文案没改但漏掉了某类样本时，前者才会红。
 *
 * 本文件覆盖 T31 验收项中**机械可验**的部分（供应链、秘密泄漏、端上脱敏）；
 * 需要真实浏览器或需要 T18 接线的部分（信标通道、撤回同意后的清除）不在此文件，
 * 其状态见 `docs/reports/security-draft.md`。
 *
 * **为什么要 import 构建产物而不是源码**：① 安全测试的对象应当是**发布出去的产物**，
 * 而不是源码；② 根 `tsconfig.json` 的 `lib` 只有 `ES2022`（不含 DOM），而 core 的源码用到
 * `IDBFactory`/`SubtleCrypto` 等 DOM 类型——`import` 源码会把 core 拉进根编译程序并引发成片
 * 类型错误；改 import 产物即可（`skipLibCheck: true`，且 `pnpm gates` 的顺序是 build 在 test 之前）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createMasker } from '../../packages/core/dist/index.js';
import { repoRoot, repoPath } from '../contract/lib/fs-json';

/** 本仓库的 SDK 包与工具清单（供应链检查的对象）。 */
const MANIFESTS = [
  'packages/core/package.json',
  'packages/transport/package.json',
  'packages/plugins/package.json',
  'packages/browser/package.json',
  'tools/event-registry/package.json',
  'tools/config-signer/package.json',
  'tools/mock-receiver/package.json',
];

/** 需要扫描秘密形态的源码根目录。 */
const SOURCE_ROOTS = ['packages/core/src', 'packages/transport/src', 'packages/plugins/src', 'packages/browser/src', 'tools'];

/** 秘密/密钥形态（与 K02 的泄漏扫描同口径，本任务是独立复核）。 */
const SECRET_PATTERNS: readonly { readonly label: string; readonly regex: RegExp }[] = [
  { label: 'JWT 形态', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { label: 'GitHub Token', regex: /ghp_[A-Za-z0-9]{20,}/ },
  { label: 'OpenAI Token', regex: /sk-[A-Za-z0-9]{20,}/ },
  { label: '私钥 PEM', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * 已知的**故意夹具**允许清单（文件相对路径 → 标签 → 理由）。
 *
 * 真实秘密扫描器都带允许清单：否则扫描器自身的规则定义、或为规则准备的示例值会被判成泄漏。
 * 这里**只登记经人工确认的假值**，并且任何**新的**命中都会失败——这正是该清单存在的意义。
 * 目前只有一条：脱敏规则的 JWT 示例（用于说明该规则匹配什么，是文档性夹具，非任何真实令牌）。
 */
const FIXTURE_ALLOWLIST: readonly { readonly file: string; readonly label: string; readonly reason: string }[] = [
  {
    file: 'packages/core/src/privacy/mask-rules.ts',
    label: 'JWT 形态',
    reason: '内置脱敏规则 jwt 的 `sample` 字段：用于说明该规则匹配什么形态，是人工确认的假值',
  },
];

/** 递归列出目录下的文本文件（跳过 node_modules/dist 的可选性由调用方控制）。 */
function listFiles(repoRelativePath: string, options: { readonly includeDist: boolean }): string[] {
  const root = join(repoRoot, repoRelativePath);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => {
      if (file.includes('node_modules')) return false;
      if (!options.includeDist && file.includes('/dist/')) return false;
      // 排除测试文件：测试夹具**故意**包含 JWT/AWS Key 等形态的**假值**，用于验证扫描器本身
      // （例如 K02 的 `token-scan.test.ts`）。把它们算作泄漏是范围错误——本任务要保证的是
      // **发货代码与构建产物**里没有秘密。K02 自身的密钥泄漏由它的 `leak-scan.test.ts` 负责。
      if (/\.test\.ts$/.test(file)) return false;
      return /\.(ts|js|mjs|cjs|json|map)$/.test(file);
    });
}

describe('T31 供应链：不存在第三方运行时依赖', () => {
  test('全部包的 dependencies 只能是 workspace 内部包（零第三方运行时依赖）', () => {
    const violations: string[] = [];
    for (const manifest of MANIFESTS) {
      const parsed = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      for (const [name, spec] of Object.entries(parsed.dependencies ?? {})) {
        const isWorkspace = spec.startsWith('workspace:');
        const isInternal = name.startsWith('@web-report-sdk/');
        if (!isWorkspace && !isInternal) violations.push(`${manifest}: ${name}@${spec}`);
      }
    }

    // 反空转：确认清单真的读了（否则"没有违规"可能只是因为一个清单都没读到）。
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(7);
    expect(
      violations,
      `以下第三方运行时依赖违反「零第三方运行时依赖」硬约束：\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});

describe('T31 供应链：源码与构建产物不含秘密形态', () => {
  test('源码树中不存在令牌/私钥形态', () => {
    const files = SOURCE_ROOTS.flatMap((root) => listFiles(root, { includeDist: false }));
    // 反空转：源码文件数应远大于 0。
    expect(files.length).toBeGreaterThanOrEqual(80);

    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const relative = repoPath(file);
      for (const { label, regex } of SECRET_PATTERNS) {
        if (!regex.test(text)) continue;
        const allowed = FIXTURE_ALLOWLIST.some((entry) => entry.file === relative && entry.label === label);
        if (!allowed) hits.push(`${relative}（${label}）`);
      }
    }
    expect(hits, `源码中出现疑似秘密：\n${hits.join('\n')}`).toEqual([]);
  });

  test('构建产物（若存在）中不存在令牌/私钥形态', () => {
    const files = SOURCE_ROOTS.flatMap((root) => listFiles(root, { includeDist: true })).filter((file) =>
      file.includes('/dist/'),
    );
    // 未构建时本用例不做无意义断言（`pnpm gates` 的顺序是 build 在 test 之前，届时产物存在）。
    if (files.length === 0) {
      expect(files.length, '本次运行未发现构建产物（先跑 pnpm build 才会检查 dist）').toBe(0);
      return;
    }
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { label, regex } of SECRET_PATTERNS) {
        if (regex.test(text)) hits.push(`${repoPath(file)}（${label}）`);
      }
    }
    expect(hits, `构建产物中出现疑似秘密：\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('T31 隐私：端上脱敏（独立样本，断言敏感值不再出现）', () => {
  /** 独立构造的伪造样本（格式合法、非真实个人信息）。 */
  const SAMPLES: readonly { readonly label: string; readonly secret: string; readonly text: string }[] = [
    { label: '手机号', secret: '13800138000', text: '用户手机号 13800138000 已登记' },
    { label: '邮箱', secret: 'zhang.san@example.com', text: '联系方式：zhang.san@example.com' },
    { label: '身份证号', secret: '110101199003071234', text: '证件号 110101199003071234' },
    {
      label: 'Bearer 令牌',
      secret: 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl',
      text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl',
    },
  ];

  test.each(SAMPLES)('内置规则会掩码$label，且原始值不再出现在输出中', ({ secret, text }) => {
    const output = createMasker().apply(text);

    // 安全属性：原始敏感值不得残留。
    expect(output.includes(secret), `脱敏后仍能读到原始值：${output}`).toBe(false);
    // 同时确认确实发生了替换（避免"整段删掉"或"输入即输出"都被当成通过）。
    expect(output).not.toBe(text);
  });

  test('追加远程规则不会削弱内置规则（AC-09 的安全属性：脱敏不可被配置整体关闭）', () => {
    const phone = '13800138000';
    const text = `手机号 ${phone}`;
    // 追加一条与内置规则无关的规则；内置规则必须仍然生效。
    const output = createMasker([{ name: 'custom', pattern: 'zzz-never-matches', replacement: '', builtin: false }]).apply(text);

    expect(output.includes(phone), `追加规则后内置脱敏失效：${output}`).toBe(false);
    // 这条用例是对「追加规则存在时不装内置 7 条」这一变异行为的**独立**回归防线：
    // 该变异曾使实现方的 6 条哨兵用例变红，本用例从公开 API 层面再钉一次。
  });

  test('无规则注入时也默认启用内置脱敏（脱敏默认开启）', () => {
    const output = createMasker().apply('13800138000');
    expect(output.includes('13800138000')).toBe(false);
  });
});
