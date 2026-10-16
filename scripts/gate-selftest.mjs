// 门禁自检（T08 验收）：确认每个门禁都能拦住对应的违规样例。
// 每个用例临时写入一个违规文件（`file`）、追加一段（`patch`）、就地替换一处（`replace`）、
// 清空一个产物（`empty`）或移走一个配置（`remove`），运行对应门禁，断言失败后恢复原状。
//
// 扩大覆盖面（2026-10-15，本条 lane）：此前只覆盖 `lint` / `typecheck` / `size` / `api:check` /
// `version:check`。**本日修掉的 3 处"门禁里的永远绿"恰好都藏在它不覆盖的 4 个门禁步骤里**
// （`examples:build` / `examples:test` / `test:contract` / `test:e2e`，出处
// `docs/reports/t33-access-blockers.md` 的"同类候选"第 ①②③ 条）。本条 lane 为这四个门禁
// 各加一条用例，**每条都先实测过"能失败"**（判别性证明见各用例注释与
// `docs/reports/gate-selftest-coverage.md`）。
//
// 两类用例（机制不同，每条都显式标注）：
//   1. **违规样例型**（`file` / `patch` / `replace` / `empty` / `remove`）：往仓库里塞一个真实
//      违规，门禁必须**非零退出**。这直接回答"这个门禁真的在拦东西吗"。
//   2. **零收集型**（`arg` + `expectFail`，可带 `positiveControl`）：不动仓库，只给门禁加一个
//      **不可能命中**的参数（不存在的文件 / 不存在的标题），断言"收集到 0 个用例"时门禁
//      **非零退出**。这回答的是另一个问题："这个门禁会不会绿着什么都没测"——正是
//      `--passWithNoTests` / `--pass-with-no-tests` 曾经掩盖的那件事。
//      **为什么 e2e 只能用这一类**：`test:e2e` 需要真实浏览器，本沙箱内 Firefox/WebKit 必红
//      （`tests/e2e/lib/browsers.mjs::resolveBrowser` 是**显式抛错**，不是跳过），所以本自检
//      **不跑完整 e2e**；零收集路径在**收集阶段就退出、不启动任何浏览器**（实测输出只有
//      `Error: No tests found`、exit 1、无 `Running … tests using …` 行）。代价：它**证明不了
//      "e2e 全绿"**，只证明"0 用例必红"；缺浏览器的环境诊断是另一件事，不在本自检承诺范围内。
//
// 反空转（流程条文 10.9）：替换未命中、待清空/移除的目标不存在或是空文件、恢复后内容/大小与
// 原件不符，一律**不得继续跑门禁并算通过**，而是直接 FAIL 并说明原因。`expectFail.expect`
// 同理：门禁虽然非零退出了，但如果不是我们注入的那个原因（例如正好是别的步骤先红），
// 本用例作废、报 FAIL。
import { Buffer } from 'node:buffer';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/** 跑一条命令；返回退出码与 stdout+stderr（门禁"失败" = 非零退出）。 */
const run = (cmd) => {
  try {
    return { code: 0, output: execSync(cmd, { cwd: root, stdio: 'pipe', encoding: 'utf8' }) };
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
};

const readBuffer = (file) => readFileSync(join(root, file));
const read = (file) => readFileSync(join(root, file), 'utf8');
const write = (file, content) => writeFileSync(join(root, file), content);

/**
 * 注入违规，返回 `restore()` 需要的句柄。
 * 抛错 = 违规样例没命中（用例空转）→ 调用方必须报 FAIL，**不得**继续跑门禁。
 */
function injectViolation(c) {
  if (c.file !== undefined) {
    write(c.file, c.content);
    return { op: 'file', file: c.file };
  }
  if (c.patch !== undefined) {
    const original = read(c.patch.file);
    write(c.patch.file, original + c.patch.append);
    return { op: 'restore-text', file: c.patch.file, original };
  }
  if (c.replace !== undefined) {
    const { file, from, to } = c.replace;
    const original = read(file);
    const mutated = original.replace(from, to);
    // 空转守卫：替换没命中说明用例已经失效（典型原因是版本号 / 脚本文本变了）。**不得**继续跑门禁
    // 并把它当成"通过"——那正是本仓库反复出现的"验证声称比结论弱"。
    if (mutated === original) throw new Error(`替换没有命中：${file} 中找不到 /${from.source}/u`);
    write(file, mutated);
    return { op: 'restore-text', file, original };
  }
  if (c.empty !== undefined) {
    const { file } = c.empty;
    if (!existsSync(join(root, file))) {
      throw new Error(`待清空的产物不存在：${file}（产物缺失时自检无法判定，绝不静默继续）`);
    }
    const original = readBuffer(file);
    if (original.length === 0) throw new Error(`待清空的产物本来就是空的：${file}（用例失效）`);
    writeFileSync(join(root, file), '');
    return { op: 'restore-buffer', file, original };
  }
  if (c.remove !== undefined) {
    const { file } = c.remove;
    if (!existsSync(join(root, file))) throw new Error(`待移除的文件不存在：${file}（用例失效）`);
    const original = readBuffer(file);
    rmSync(join(root, file));
    return { op: 'restore-buffer', file, original };
  }
  return { op: 'none' };
}

/**
 * 恢复违规注入。返回 `null` = 已还原；返回字符串 = 还原失败/不一致（必须 FAIL，不能带脏树继续）。
 */
function restore(violation) {
  try {
    if (violation.op === 'none') return null;
    if (violation.op === 'file') {
      if (existsSync(join(root, violation.file))) rmSync(join(root, violation.file));
      return null;
    }
    if (violation.op === 'restore-text') {
      write(violation.file, violation.original);
      return read(violation.file) === violation.original
        ? null
        : `恢复后内容与原件不一致：${violation.file}`;
    }
    if (violation.op === 'restore-buffer') {
      writeFileSync(join(root, violation.file), violation.original);
      return Buffer.compare(readBuffer(violation.file), violation.original) === 0
        ? null
        : `恢复后字节与原件不一致：${violation.file}`;
    }
    return `未知的恢复操作：${violation.op}`;
  } catch (error) {
    return `恢复失败：${String(error)}`;
  }
}

const cases = [
  {
    name: 'lint 拦截 any',
    file: 'packages/core/src/__gate_any.ts',
    content: 'export const leak = (value: any): any => value;\n',
    gate: 'pnpm lint',
  },
  {
    name: 'lint 拦截 eslint-disable',
    file: 'packages/core/src/__gate_disable.ts',
    content: '// eslint-disable-next-line\nexport const x: number = 1;\n',
    gate: 'pnpm lint',
  },
  {
    name: 'lint 拦截 class',
    file: 'packages/core/src/__gate_class.ts',
    content: 'export class Tracker {}\n',
    gate: 'pnpm lint',
  },
  {
    name: 'typecheck 拦截类型错误',
    file: 'packages/core/src/__gate_type.ts',
    content: 'export const n: number = "x";\n',
    gate: 'pnpm typecheck',
  },
  {
    name: 'size 拦截超出预算',
    patch: {
      file: 'packages/core/src/index.ts',
      append: `\nexport const BLOAT = ${JSON.stringify(Array.from({ length: 4000 }, (_, i) => `k${i}-${Math.random().toString(36)}`))};\n`,
    },
    gate: 'pnpm build && pnpm size',
  },
  {
    name: 'api:check 拦截未登记的导出',
    patch: {
      file: 'packages/core/src/index.ts',
      append: '\n/** 未登记的公共 API。 */\nexport const UNREGISTERED_EXPORT = 1;\n',
    },
    gate: 'pnpm build && pnpm api:check',
  },
  {
    name: 'version:check 拦截包清单与 SDK_VERSION 漂移',
    replace: {
      file: 'packages/core/package.json',
      // 用正则而不是字面量：版本号每次发布都会变，字面量会让本用例**静默空转**
      // （替换不命中 → 门禁照常通过 → 自检报"门禁没拦住"或更糟：改成恒绿的假通过）。
      from: /"version": "\d+\.\d+\.\d+"/u,
      to: '"version": "9.9.9"',
    },
    gate: 'pnpm version:check',
  },

  // ============ 2026-10-15 扩面：4 个此前没有自检的门禁步骤 ============
  {
    name: 'examples:build 拦截"示例构建产物为空"',
    // 针对本日修的 ①：`examples/node-import` 与 `script-tag` 的 build 曾是
    // `node -e "process.exit(0)"`（空脚本），现在两个脚本都要求 `@web-report-sdk/browser` 的
    // **dist 产物**存在且非空（`entryNonEmpty` / `htmlScriptNonEmpty`）。
    //
    // 注入方式选 `empty` 而不是 `replace`：产物是构建输出，正文随版本变，字面量必然漂移；
    // **清空而不是删除**——不改文件存在性，因此不会改变 `require.resolve` 的解析行为，
    // 只精确打中"非空"这一条判据。`pnpm build`（本脚本末尾）会重建它。
    //
    // 判别性证明（实测）：清空后 `pnpm examples:build` → exit 1，script-tag 打印
    // `"htmlScriptNonEmpty": false` / `"status": "fail"`；恢复后 exit 0。
    empty: { file: 'packages/browser/dist/web-report-sdk.iife.js' },
    gate: 'pnpm examples:build',
    expectFail: {
      what: 'script-tag 的"IIFE 产物非空"判据',
      expect: /"htmlScriptNonEmpty": false/u,
    },
  },
  {
    name: 'examples:test 拦截"示例验证脚本被绕过"',
    // 针对本日修的 ①（test 侧）。"验证脚本被绕过"最真实的形态是**真值被写死**：脚本不再拿包
    // 清单去比对，于是产物里放什么版本它都认。`expectedSdkVersion()` 是五个示例共用的唯一真值
    // 来源；把它改成常量 `'0.0.0'`，vite / webpack 的 `sdkVersionMatchesPackage` 立即转 false。
    //
    // 为什么**不**用"改产物 / 改包清单版本"注入：`examples/vite` 的验证脚本会在同一步里
    // **重跑 vite 生产构建**，产物会被重建成与包清单一致，用例会静默失效。
    //
    // 判别性证明（实测）：替换后 `pnpm examples:test` → exit 1，vite 打印
    // `"sdkVersionMatchesPackage": false` / `"status": "fail"`；恢复后 exit 0。
    replace: {
      file: 'examples/webpack/scripts/lib/verify-bundle.mjs',
      // 匹配整个函数体再断言：任何"把真值来源换成常量"的写法都能命中；命中不了会 FAIL，
      // 不会因为无关的格式调整静默空转（**不做**逐字匹配，避免与 10.9 同型的脆性）。
      from: /export function expectedSdkVersion\(\) \{[\s\S]*?\n\}/u,
      to: "export function expectedSdkVersion() {\n  return '0.0.0';\n}",
    },
    gate: 'pnpm examples:test',
    expectFail: {
      what: 'vite/webpack 的"版本必须与包清单一致"判据',
      expect: /"sdkVersionMatchesPackage": false/u,
    },
  },
  {
    name: 'test:contract 在"用例收集为 0"时必须非零退出',
    // 针对本日修的 ③（contract 半边，`--passWithNoTests` 已移除）。
    //
    // 手法：给门禁加一个**不可能命中**的文件过滤（`vitest run --project contract <不存在的文件>`），
    // **不动仓库里任何文件**；这与真实损坏形态同构（include/project/testDir 被改坏 → 收集为 0），
    // 且不必真跑维护成本更高的全量契约用例。
    //
    // 判别性证明：带 flag 时 exit 0（改前实测，见 t33-access-blockers.md）→ 去掉 flag 后
    // **exit 1**（本用例断言的就是这个非零）；对照：`pnpm test:contract` = 9 文件 / 191 用例 / exit 0。
    arg: ['no-such-file-gate-selftest-collected-zero.test.ts'],
    gate: 'pnpm test:contract',
    expectFail: { what: '"收集到 0 个用例"路径', expect: /No test files found/u },
  },
  {
    name: 'test:e2e 在"用例收集为 0"时必须非零退出',
    // 针对本日修的 ③（e2e 半边，`--pass-with-no-tests` 已移除）。
    //
    // **本自检不在沙箱内跑完整 e2e**（Firefox/WebKit 缺浏览器必红）。这里只测**零收集路径**：
    // 给门禁加一个不可能命中的 `--grep`，Playwright 在收集阶段就退出，**不启动任何浏览器**。
    // 去掉 `--pass-with-no-tests` 之后这条路径才会红，所以它**可失败**、不是恒真的凑数自检。
    //
    // 它**证明不了**"完整 e2e 全绿"（需要真实浏览器 + 非沙箱会话）；缺浏览器时的诊断由
    // `tests/e2e/lib/browsers.mjs::resolveBrowser` 的显式抛错负责，与本自检无关。
    //
    // 判别性证明：带 flag 时 exit 0（改前实测）→ 去掉 flag 后 **exit 1**；
    // 对照：`pnpm --silent test:e2e --list` exit 0（证明"收集不到"不是恒真）。
    arg: ['--grep', 'gate-selftest-zero-collected-xyz-标题不存在'],
    gate: 'pnpm test:e2e',
    expectFail: { what: '"收集到 0 个用例"路径', expect: /No tests found/u },
    // 正向对照：同一门禁正常调用时**能收集到用例**。缺了它，"零收集必非零"可能是恒真的
    // （例如配置整体坏掉、什么都收集不到）。`--list` 只列举不执行，不装/不起浏览器。
    positiveControl: {
      cmd: 'pnpm --silent test:e2e --list',
      expect: /Total: \d+ tests? in \d+ files?/u,
    },
  },
];

/**
 * 结构性前置检查（在**任何变异之前**跑）：这两处"参数层面的永远绿"是自检的**前提**，不是被测
 * 对象。只读 `package.json`，不动仓库。命中即 FAIL——有人把 `--passWithNoTests` /
 * `--pass-with-no-tests` 加回来，上面两条零收集用例就会**静默失效**（那正是本日修掉的形态）。
 */
function checkZeroCollectedFlags() {
  const manifest = JSON.parse(read('package.json'));
  const failures = [];
  for (const [script, forbidden] of [
    ['test:contract', '--passWithNoTests'],
    ['test:e2e', '--pass-with-no-tests'],
  ]) {
    const value = manifest.scripts?.[script];
    if (typeof value !== 'string') {
      failures.push(`${script} 脚本不存在（门禁链路已变，须同步本自检）`);
    } else if (value.includes(forbidden)) {
      failures.push(`${script} 又带上了 ${forbidden}（0 用例将 exit 0，两条零收集用例会静默失效）`);
    }
  }
  return failures;
}

let ok = true;
for (const failure of checkZeroCollectedFlags()) {
  console.log(`FAIL 参数层面前置检查：${failure}`);
  ok = false;
}

for (const c of cases) {
  const command = `${c.gate}${c.arg === undefined ? '' : ` ${c.arg.join(' ')}`}`;

  let violation;
  try {
    violation = injectViolation(c);
  } catch (error) {
    console.log(`FAIL ${c.name}：违规样例没有命中（用例空转）——${String(error)}`);
    ok = false;
    continue;
  }

  const result = run(command);
  const restored = restore(violation);

  if (restored !== null) {
    // 恢复不一致比"门禁没红"更严重：绝不能带着脏工作树继续。
    console.log(`FAIL ${c.name}：${restored}`);
    ok = false;
    continue;
  }
  if (result.code === 0) {
    console.log(`FAIL ${c.name}（${command}）：门禁没有拦住违规样例（exit 0）`);
    ok = false;
    continue;
  }
  if (c.expectFail !== undefined && !c.expectFail.expect.test(result.output)) {
    console.log(
      `FAIL ${c.name}（${command}）：门禁确实非零退出（exit ${result.code}），但**不是**` +
        `${c.expectFail.what}造成的（输出里找不到 /${c.expectFail.expect.source}/u），本用例不能作判据`,
    );
    ok = false;
    continue;
  }
  if (c.positiveControl !== undefined) {
    const control = run(c.positiveControl.cmd);
    if (control.code !== 0 || !c.positiveControl.expect.test(control.output)) {
      console.log(
        `FAIL ${c.name}：正向对照失败——\`${c.positiveControl.cmd}\` exit ${control.code}，` +
          `输出里找不到 /${c.positiveControl.expect.source}/u，说明"收集不到"不是本用例注入的`,
      );
      ok = false;
      continue;
    }
  }
  const detail = c.expectFail === undefined ? '' : `（${command}，命中 ${c.expectFail.what}）`;
  console.log(`ok   ${c.name}${detail}`);
}

// 恢复构建产物，避免影响后续门禁（`examples:build` 的清空用例也依赖这一步重建 IIFE）。
run('pnpm build');
process.exitCode = ok ? 0 : 1;
