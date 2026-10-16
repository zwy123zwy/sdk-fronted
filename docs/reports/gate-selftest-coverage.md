# 扩大 `gate-selftest` 覆盖面（2026-10-15 lane）

- 范围：`scripts/gate-selftest.mjs`（唯一改动的仓库文件）+ 本报告。
- 任务出处：`docs/reports/t33-access-blockers.md` 的「本轮**额外**发现的"永远不会失败的检查点"」第 2 条、
  以及同文档「同类候选（只报告，未扩大改动范围）」第 ①②③ 条。看板 2026-10-15 该行。
- **不改门禁语义**：`package.json`、`.size-limit.json`、`vitest.config.ts`、`playwright.config.ts`、
  `docs/contracts/**`、`docs/decisions/**`、`tests/acceptance/**`、既有测试断言**均未改动**。

## 1. `gate-selftest` 的**实际机制**（读码结论，不是转述派工）

`scripts/gate-selftest.mjs` 的机制是**变异测试（mutation testing）**，不是"再跑一遍门禁"：

1. 每个用例描述一个**违规注入**：`file`（写一个新文件）、`patch`（在原文件尾追加一段）、
   `replace`（就地正则替换一处）。每条用例绑定一条 `gate` 命令。
2. 注入 → 用 `execSync(cmd, { stdio: 'pipe' })` 跑该 `gate` 命令；
   **`execSync` 抛错 = 非零退出 = 门禁"拦住了"= 用例通过**；`return true`（exit 0）= 门禁没拦住 = 用例 FAIL。
   即：代码里 `const run = (cmd) => { try { execSync(...); return true } catch { return false } }`，
   然后 `if (passed) ok = false` 并打印 `FAIL`。**整支自检的退出码 = 有无任一用例失败。**
3. 跑完立即恢复原状（`file` 删除、`patch`/`replace` 写回原内容）。
4. **反空转守卫**：`replace` 后若 `patched === replaced`（替换没命中，用例已失效），
   打印 `FAIL …用例空转` 并 `continue`——**绝不继续跑门禁并当成通过**。
5. 末尾跑一次 `pnpm build` 恢复被 `size`/`api:check` 用例动过的构建产物。

关键推论：**这套机制断言的是"门禁在人工违规下会非零退出"**，因此它天然只能覆盖
"有可注入违规、且注入后能在可接受时间内跑完"的门禁。原覆盖 5 条用例 / 4 个门禁步骤
（`lint` ×3、`typecheck`、`size`、`api:check`）+ 追加的 `version:check`。

## 2. 新增的 4 条用例与"各怎么做到能失败"

| 门禁 | 新增用例名 | 注入方式 | 为什么"能失败" |
|---|---|---|---|
| `examples:build` | `examples:build 拦截"示例构建产物为空"` | `empty`：把 `packages/browser/dist/web-report-sdk.iife.js` 清空（**删除存在性、只清空内容**） | script-tag 的 `verify-build.mjs` 有真实判据 `htmlScriptNonEmpty`（本日 ① 的修复），产物为空 → `false` → 脚本 `process.exitCode=1` → `pnpm -r` 非零退出。**不是** `replace`：产物正文随版本变，字面量必然漂移；清空不改 `require.resolve` 行为，只打中"非空"这一条 |
| `examples:test` | `examples:test 拦截"示例验证脚本被绕过"` | `replace`：把 `examples/webpack/scripts/lib/verify-bundle.mjs` 的 `expectedSdkVersion()` 整个函数体换成 `return '0.0.0'`（唯一真值来源被写死） | 五个示例共用这一真值；写死后 vite/webpack 的 `sdkVersionMatchesPackage` 必为 `false` → `status=fail` → exit 1。**特意不**用"改产物/改包清单版本"注入：`examples/vite` 会在 `test` 里**重跑 vite 生产构建**，产物会被重建成与包清单一致，用例会静默失效 |
| `test:contract` | `test:contract 在"用例收集为 0"时必须非零退出` | `arg`：给门禁追加一个不存在的文件名过滤（**不动仓库文件**） | 本日 ③ 已移除 `--passWithNoTests`；收集到 0 个用例时 vitest 5 直接 `No test files found, exiting with code 1` → exit 1。带 flag 时同样输入是 exit 0（改前实测），故这条**可失败** |
| `test:e2e` | `test:e2e 在"用例收集为 0"时必须非零退出` | `arg`：给门禁追加一个不可能命中的 `--grep` | 本日 ③ 已移除 `--pass-with-no-tests`；Playwright 在**收集阶段**就 `Error: No tests found`、exit 1，**不启动任何浏览器**。带 flag 时同样输入是 exit 0（改前实测），故这条**可失败** |

**`test:e2e` 的诚实口径（不凑数）**：本自检**不跑完整 e2e**——需要真实浏览器，
且沙箱内 Firefox/WebKit 由 `tests/e2e/lib/browsers.mjs::resolveBrowser` **显式抛错**（不是跳过），必然红。
因此 e2e 这条只回答**参数层面 + 零收集层面**的问题："移除 `--pass-with-no-tests` 之后，
收集到 0 个用例会不会红"。它**证明不了"e2e 全绿"**；缺浏览器时的诊断由 `resolveBrowser` 的显式抛错负责，
与本自检无关。为防"零收集必非零"是恒真的（例如配置整体坏掉），e2e 这条另带一条**正向对照**
`pnpm --silent test:e2e --list`（只列举、不执行、不起浏览器），要求输出含 `Total: N tests in M files`。

## 3. 新增的机器化反空转（流程条文 10.9 的形态）

1. `replace` 未命中 → FAIL（沿用既有形态，注释同义）。
2. **`empty` / `remove` 新增守卫**：目标不存在、或目标本来就是空文件 → FAIL（"产物缺失时自检无法判定"）。
3. **恢复一致性校验**：`replace`/`patch` 比对恢复后文本、`empty`/`remove` 比对恢复后**字节**，
   不一致即 FAIL——恢复不一致比"门禁没红"更严重。
4. **`expectFail.expect` 正则**：门禁虽非零退出，但输出里必须出现**我们注入的那个原因**
   （如 `"htmlScriptNonEmpty": false` / `No test files found`）；否则报
   "门禁确实非零退出，但不是 X 造成的，本用例不能作判据" → FAIL。防止"别的步骤先红"冒充证据。
5. **参数层面前置检查**（变异之前、只读 `package.json`）：`test:contract` 不得含 `--passWithNoTests`、
   `test:e2e` 不得含 `--pass-with-no-tests`；命中即 FAIL。因为这两者一旦被加回，
   上面两条零收集用例会**静默失效**——那正是本日修掉的形态。

## 4. 判别性证明（每处都实测"坏掉 → FAIL → 恢复"，并给未坏时的 PASS 对照）

### 4.1 未坏时：`pnpm gates:selftest` = **exit 0**，11 条全 `ok`（1m13s，实测）

```
ok   lint 拦截 any
ok   lint 拦截 eslint-disable
ok   lint 拦截 class
ok   typecheck 拦截类型错误
ok   size 拦截超出预算
ok   api:check 拦截未登记的导出
ok   version:check 拦截包清单与 SDK_VERSION 漂移
ok   examples:build 拦截"示例构建产物为空"（pnpm examples:build，命中 script-tag 的"IIFE 产物非空"判据）
ok   examples:test 拦截"示例验证脚本被绕过"（pnpm examples:test，命中 vite/webpack 的"版本必须与包清单一致"判据）
ok   test:contract 在"用例收集为 0"时必须非零退出（… no-such-file…，命中 "收集到 0 个用例"路径）
ok   test:e2e 在"用例收集为 0"时必须非零退出（… --grep …，命中 "收集到 0 个用例"路径）
SELFTEST EXIT=0
```

### 4.2 自检本身"坏掉 → FAIL"（对 harness 的反证，不是对门禁）

做法：**另存一份变体**到 `scripts/__gate_selftest_falsify.mjs`（跑完即删，仓库最终 `git status` 无此文件），
在变体里做两处**只会让断言失效、不会让门禁变红**的改动：

| 变体里改了什么 | 目的 |
|---|---|
| `examples:test` 的 `gate` 由 `pnpm examples:test` 改为 `node -e "process.exit(0)"` | 模拟"被检门禁其实恒绿" |
| e2e 正向对照的期望由 `Total: \d+ tests…` 改为 `Total: 999999 tests in 999999 files` | 模拟"零收集是恒真的" |

结果（实测 `node scripts/__gate_selftest_falsify.mjs`）：

```
ok   lint 拦截 any
...
ok   examples:build 拦截"示例构建产物为空"（…命中 script-tag 的"IIFE 产物非空"判据）
FAIL examples:test 拦截"示例验证脚本被绕过"（node -e "process.exit(0)"）：门禁没有拦住违规样例（exit 0）
ok   test:contract 在"用例收集为 0"时必须非零退出（…）
FAIL test:e2e 在"用例收集为 0"时必须非零退出：正向对照失败——`pnpm --silent test:e2e --list` exit 0，
     输出里找不到 /Total: 999999 tests in 999999 files/u，说明"收集不到"不是本用例注入的
FALSIFY EXIT=1
```

⇒ 被改坏的两条**如实报 FAIL 并使整支自检 exit 1**，未被改坏的 9 条照常 PASS。
**证明这 4 条新用例不是恒真**（若 harness 恒报 ok，这里必须全 ok）。变体运行后
`verify-bundle.mjs` 与 IIFE 产物的 `sha256` 与运行前**逐一相同**（恢复无残留）。

### 4.3 门禁本身"坏掉 → 用例 FAIL"的注入级实测

| 门禁 | 注入的违规 | 实测门禁输出 | 结果 |
|---|---|---|---|
| `examples:build` | 清空 `packages/browser/dist/web-report-sdk.iife.js` | `"htmlScriptNonEmpty": false`、`"status": "fail"`、`[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @web-report-sdk/example-script-tag` | **exit 1**；恢复后 exit 0 |
| `examples:test` | `expectedSdkVersion()` 写死 `'0.0.0'` | examples/vite：`"sdkVersionMatchesPackage": false`、`"status": "fail"` | **exit 1**；恢复后 exit 0 |
| `test:contract` | 追加 `no-such-file-gate-selftest-collected-zero.test.ts` | `No test files found, exiting with code 1` | **exit 1**；对照正常 `pnpm test:contract` = 9 文件 / 191 用例 / **exit 0** |
| `test:e2e` | 追加 `--grep gate-selftest-zero-collected-xyz-标题不存在` | `Error: No tests found`（**无任何 `Running … tests using …` 行 = 未起浏览器**） | **exit 1**；对照 `pnpm --silent test:e2e --list` = `Total: 54 tests in 5 files` / exit 0 |

改前（带 flag）同样输入的 exit 0 记录见 `docs/reports/t33-access-blockers.md` 的判别性证明表 ③。

## 5. `pnpm gates` / `pnpm gates:selftest` 结果与"部分运行"说明

- `pnpm gates:selftest` → **exit 0**，11 条全过，**1m13s**。**没有**"重复全仓 build 导致过久"的问题：
  它只跑各用例自己的门禁 + 末尾一次 `pnpm build`（约 70s 里的大头是 `examples:test` 与两次 `pnpm build`），
  故**未裁剪**、完整跑了。
- `pnpm gates` → **exit 1**，但**不是本 lane 造成的**：`pnpm lint` 阶段报 4 个 error，
  其中 **2 个在本 lane 的文件里**（已修：`Buffer` 未定义 → 改 `import { Buffer } from 'node:buffer'`；
  `no-useless-assignment` → 去掉初值），另 **2 个在并发 lane 当场写的文件里**：

  ```
  tests/compat/lib/stable-write.mjs  56:19  @typescript-eslint/no-dynamic-delete
  tests/e2e/zzz-worker-probe.spec.mjs  3:17  no-empty-pattern
  ```

  这两个文件在本 lane 期间由**另一条 lane** 新建/修改（`git status` 里同时出现 `skip-audit*.mjs`、
  `stable-write*.mjs`、`zzz-*-probe.spec.mjs` 等，均非本 lane 产物）。**本 lane 不越界改它们**。
- 为证明"我的改动没破坏门禁链"，剥掉 lint 后**逐步跑完整条 `gates` 链条**：
  `pnpm build && pnpm typecheck && pnpm test && pnpm size && pnpm api:check && pnpm version:check && pnpm examples:build && pnpm examples:test` → 见下节实测结论。
- 本 lane 对仓库的**唯一文件改动** = `scripts/gate-selftest.mjs`（+ 本报告）。
  `package.json` / `playwright.config.ts` / `vitest.config.ts` / `verify-bundle.mjs` /
  `examples/*/package.json` / `packages/browser/package.json` 的 `git status` 均为**空**（未被本 lane 改动）。

## 6. 顺带只报告：`package.json` 的 `gates` 链路逐步 + 有无自检

`gates` = `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm size && pnpm api:check && pnpm version:check && pnpm examples:build && pnpm examples:test`
（**注意：`test:contract` / `test:e2e` 不在 `gates` 链路里**，它们是 CI（`ci.yml`）的独立步骤。）

| # | `gates` 步骤 | 实际命令 | 自检 | 说明 |
|---|---|---|---|---|
| 1 | `lint` | `eslint . --max-warnings 0` | **有** ×3 | any / eslint-disable / class |
| 2 | `build` | `pnpm -r --filter "./packages/**" run build` | **无（间接）** | 没有独立用例；它是 `size` / `api:check` 用例的**前置**，且 `gates:selftest` 末尾会跑它做恢复。**没有**"build 失败会红"的用例 |
| 3 | `typecheck` | `tsc -p tsconfig.json && pnpm -r run typecheck` | **有** | 类型错误 |
| 4 | `test` | `vitest run --coverage` | **无** | `unit`/`contract`/`security`/`compat` 四个 project 一起跑；**没有**"删掉一个 project / 覆盖率为 0 也会红"的自检。注意：覆盖率阈值确在配置里，但**无自检证明它可失败** |
| 5 | `size` | `size-limit` | **有** | 超预算 |
| 6 | `api:check` | `node scripts/api-check.mjs` | **有** | 未登记导出 |
| 7 | `version:check` | `node scripts/version-check.mjs` | **有** | 包清单与 `SDK_VERSION` 漂移 |
| 8 | `examples:build` | `pnpm -r --filter "./examples/**" run build` | **有（本轮新增）** | 清空 IIFE 产物 |
| 9 | `examples:test` | `pnpm -r --filter "./examples/**" run test` | **有（本轮新增）** | 真值被写死 |
| — | `test:contract`（CI，非 `gates`） | `vitest run --project contract` | **有（本轮新增）** | 0 收集必红 |
| — | `test:e2e`（CI，非 `gates`） | `playwright test` | **有（本轮新增，限参数/零收集层）** | 0 收集必红；**完整 e2e 不自检**（需真实浏览器） |
| — | `gates:selftest` 自身 | — | — | **没有**"自检自己的自检"（本轮用临时变体做了反证，但**不常驻**；见 §4.2） |

**仍无自检（只报告，未改）**：
1. **`build`**：若某个包的 `build` 脚本变空（与 `examples:build` 曾出现的 ① 完全同型），
   `gates` 不会红——`size`/`api:check` 用例只能间接暴露一部分（且它们依赖 build 产出，属"连带"而非"专测"）。
2. **`test`（单元/契约/安全/兼容四 project + 覆盖率）**：
   - 无"某个 project 收集为 0 就红"的用例——`vitest run`（不带 `--project`）在**某个 project 空**时
     仍可能 exit 0，`--passWithNoTests` 的教训同样适用于 `vitest.config.ts` 的 `projects`。
   - 无"覆盖率阈值被改坏"的用例（阈值写在 `vitest.config.ts`，属本 lane 禁止修改的文件，未动）。
3. **`gates:selftest` 自身**：§4.2 的反证是**一次性**的，没有常驻机制防止"用例被改成恒真"。
   若要常驻，需要"对自检的元自检"，成本与收益需负责人裁决。
