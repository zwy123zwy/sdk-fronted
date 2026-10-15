# T35 发布检查表（可复跑）

- 任务：T35 正式发布与灰度放量（3 人日 / A10 本 lane）
- 日期：2026-10-15；工作目录 `/Users/spirit-ai/Desktop/sdk`（直接在 main）
- 依据：`docs/tasks/T35.md`、指南第 6/7/8/13 节、`docs/reports/handover.md` 第 2/4 节、
  `docs/reports/reliability-reconciliation.md`（T32）、`docs/reports/compat-matrix.md`（T30）、
  `docs/contracts/receiver-requirements.md`、`docs/contracts/remote-config.md`、根 `package.json`、
  `.github/workflows/ci.yml`、`docs/decisions/Q2-pilot-apps.md`
- 配套文件：灰度方案 `docs/reports/release-grayscale-plan.md`、运维手册 `docs/runbooks/sdk-operations.md`
- **本文件的纪律**：每条命令都给**可复跑命令**与**通过判据**；**未实跑的一律写"未运行"并写清原因**。
  标 `✅ 实跑` 的行是本次在 main 上真的跑过的，附 exit code。

## 0. 状态取值与本次实跑汇总

| 标记 | 含义 |
|---|---|
| ✅ 实跑通过 | 本次在 main 上实跑，exit 0 |
| ⛔ 实跑失败 | 本次实跑非 0，已写清 |
| 🚫 沙箱内不可跑 | 需要非沙箱会话（真实浏览器 / Firefox / WebKit 复跑） |
| ⏳ 待 Q2/试点 | 需要业务事实（试点应用名、对接人、预发布环境）或真实生产数据 |
| 🧑 人工执行 | 包发布、放量配置发布、审批——**Agent 不得执行**（T35 禁止事项） |

### 0.1 本次实跑汇总（2026-10-15）

| # | 命令 | 结果 |
|---|---|---|
| A1 | `pnpm gates` | ✅ **exit 0**（159 文件 / 1544 用例全绿；详见 §1） |
| A2 | `pnpm exec vitest run --coverage.enabled=false --project security` | ✅ exit 0（5 文件 / 33 用例） |
| A3 | `pnpm exec vitest run --coverage.enabled=false --project contract` | ✅ exit 0（9 文件 / 191 用例） |
| A4 | `pnpm exec vitest run --coverage.enabled=false --project compat` | ✅ exit 0（见 §6） |
| A5 | `node tests/reliability/reconcile.mjs` | ✅ exit 0（三类分列现算；见 §7；**并发现报告 §3 已过期**，§7.2） |
| A5b | `diff <(报告生成区) <(现算输出)` | ⚠ **有差异**（`tests/e2e/results/d004-chromium.json` 已被刷新为 `88ca1e9c49dc0f61` @ 2026-10-15T02:12:53Z，报告仍写 `454fbb9008176f86` @ 2026-10-14T09:27:33Z） |
| A6 | 反证 1：`pnpm exec size-limit --limit 1kB` | ✅ 实跑**变红**（故意收紧判据）——证明体积判据能失败（§9.1） |
| A7 | 反证 2：往 `packages/browser/dist/index.d.ts` 追加一个假导出后 `node scripts/api-check.mjs` | ✅ 实跑**变红**（`apiReportChanged`）——证明 API 判据能失败（§9.2） |
| A8 | 反证 3：版本号一致性自检（本表 §5.3 的判据） | ✅ 实跑**变红**（喂入过期版本号即红）——证明该判据能失败（§9.3） |
| A9 | `node tests/reliability/reconcile.mjs --compare tests/e2e/results/d004-chromium.json tests/reliability/results/d004-chromium-rerun.json` | ✅ exit 0，9 格守恒；**但脚本判定"同一份被测实现：否"** —— 官方产物已被后续提交刷新（见 §7.2） |
| A13 | 反证 2b：把 `packages/core/package.json` 的 `version` 临时改成 `9.9.9` 后再跑 `node scripts/api-check.mjs` | ⚠ **exit 0（没红！）** —— 证明 `api:check` **不是版本号门禁**（§9.2） |
| A10 | `pnpm test:e2e --project=chromium --project=webkit` | 🚫 **未运行**：沙箱内 WebKit 存储测量不可靠（见 §5） |
| A11 | `pnpm test:e2e --project=firefox` | 🚫 **未运行**：Firefox 主进程无法在 DSH 沙箱内嵌套启动 |
| A12 | `pnpm gates:selftest` | ⚠ **未运行**（见 §1.3：它注入违规样例，与"不改门禁配置"和并发 lane 有冲突，交人工负责人决定时机） |

> 门禁日志留存：`/tmp/t35-gates.log`（本次 `pnpm gates` 全文，含体积实测与覆盖率表）。
> 按 `handover.md` 第 4 节第 10.6 条，门禁日志应长期留存，便于日后比对"曾红/曾绿"。

---

## 1. 全量门禁（发布前必须全绿）

### 1.1 G1：全量门禁

**⚠ 本次门禁是在一个"脏"工作树上跑的（必须写明）**：HEAD = `e0bd651`，工作树里有**其他 lane 的
17 个未提交修改**（`tests/compat/**` 9 个 + `tests/e2e/leave-slice.spec.mjs` 与 5 个 `probes/*.js` +
根 `vitest.config.ts`），加上本 lane 的新增文档。也就是说，**下面的绿色包含了他人在途的
`vitest.config.ts`（compat project 的加入）与 `tests/e2e/**` 改动**。
→ 发布判定必须在一个**明确基线（clean HEAD 或已冻结的提交）**上重跑 `pnpm gates`，
本次结果只能证明"当前工作树是绿的"。

```bash
pnpm gates
```

**通过判据**：exit 0；且日志里 8 步（`lint → build → typecheck → test → size → api:check → examples:build → examples:test`）
**逐步**都出现且无 `ELIFECYCLE`/`Failed`。**不得使用 `pnpm ci`**：pnpm 11 的内置 `clean-install`
会抢占该名字，只做干净安装、不跑任何门禁却返回 0（指南第 6 节、`AGENTS.md`）。

**注意顺序**：`build` 必须先于 `typecheck`（新工作树/新克隆先跑 `pnpm build`），否则 `examples/vite`
的 typecheck 因解析不到 `packages/browser/dist` 类型而 `TS2307`（指南 0.7 版）。

本次结果：✅ **exit 0**，`/tmp/t35-gates.log` 末尾 `GATES_EXIT=0`；测试结论 `Test Files 159 passed (159)` / `Tests 1544 passed (1544)`。

**一个必须知道的对齐偏差**：`pnpm gates` 与 CI（`.github/workflows/ci.yml` 的 gates job）**并非同一集合**：

| 步骤 | `pnpm gates` | CI gates job |
|---|---|---|
| lint / build / typecheck / test / size / api:check / examples:build / examples:test | ✅ | ✅ |
| `pnpm test:contract` | ✅（`pnpm test` 的 vitest 配置含 `contract` project） | ✅（额外单独一步，冗余但无害） |
| `pnpm test:e2e` | ❌ **不在 gates 里** | ✅ 由独立 `e2e` job 跑（`needs: gates`） |
| CI 的 `build` 位置 | 第 2 步（先于 typecheck） | 第 **4** 步（在 `typecheck`/`test` **之后**） |

> **发布判定口径**：以 `pnpm gates` + 单独跑 E2E 为准；**不要**用 CI 的步骤顺序推断本地顺序。
> CI 的 gates job 把 `typecheck` 排在 `build` 之前 —— 与指南第 6 节"build 必须先于 typecheck"相反，
> 这是一个**待负责人确认的 CI 配置不一致**（本次未改门禁配置）。

### 1.2 G2：门禁自检（能失败才算门禁）

```bash
pnpm gates:selftest
```

**通过判据**：exit 0。它逐个注入违规样例，确认 `lint`、`typecheck`、`size`、`api:check` 都会失败。

**本次未运行**。原因（如实登记）：① 它临时写入违规样例，与"不改门禁配置/不改实现"的边界和
并发 lane 的工作树有冲突风险；② T33 已核实它**只覆盖 4 个门禁**，`examples:build`/`examples:test`/
`test:contract`/`test:e2e` **没有自检**（`t33-access-blockers.md` 第 549 节"本轮额外发现"第 2 条）；
③ `handover.md` 第 3 节义务 #5 仍记着"`pnpm gates:selftest` 未跑"。→ **交人工负责人在空闲工作树上执行**。

### 1.3 G3：覆盖率（门槛在 vitest 配置里，不是单独命令）

```bash
pnpm test          # = vitest run --coverage，G1 已含
```

**通过判据**：`packages/core` / `packages/transport` 行 ≥90%、分支 ≥80%；`packages/plugins` / `tools/*`
行 ≥80%、分支 ≥70%。本次已由 G1 覆盖，exit 0。

### 1.4 G4：只跑契约 project（CI 里单列的那一步）

```bash
pnpm test:contract
```

**通过判据**：exit 0，收集到用例数 > 0。**注意**：`test:contract` 的 `--passWithNoTests` 已被移除
（2026-10-15），"收集到 0 个用例"现在是**失败**——这是对的，不要把它加回来。

本次结果：✅ exit 0（9 文件 / 191 用例，见 A3）。

---

## 2. 体积（budget）

```bash
pnpm size          # = size-limit，读根 .size-limit.json
```

**通过判据**：4 条全部 `Size ≤ Size limit`。**口径**：`import: "*"` + minify + brotli；
**不要用 tsup 原样产物比**（handover 第 4 节第 4 条）。

本次实测（`/tmp/t35-gates.log`，2026-10-15）：

| 条目 | 实测 | 预算 | 余量 |
|---|---|---|---|
| `browser`（实际发货装配产物） | **35.19 kB** | 37 kB | 1.81 kB |
| `core` | **19.02 kB** | 21 kB | 1.98 kB |
| `plugins`（全量） | **5.97 kB** | 20 kB | 14.03 kB |
| `transport` | **15.90 kB** | 18 kB | 2.10 kB |

**⚠ 两条必须在发布前由负责人处理的偏差（本次只报告，未改任何配置）**：

1. **指南第 6 节与 `.size-limit.json` 已经不一致**：指南第 6 节写 `browser` 入口"不超过 **13 KB**"
   （并注明"该条目当前量的是 core 全导出面的 re-export 壳，不是接入方实际发货的 bundle——装配根
   T18 落地后必须改为量实际 bundle"），而 `.size-limit.json` 的 browser 条目已按**真实 bundle**
   重推为 **37 KB**（`.size-limit.json` 条目文字自己写明"本次按真实 bundle 重推为 35 KB：实测 33.47 kB"）。
   → **指南第 6 节那一行是过期的**，T35 交付前必须同步（指南属 T34/负责人范围，本 lane 不改）。
2. **`handover.md` 第 2 节明确写着"发布前必须完成整张预算表的重新推导"**（第 6 节第 4 条：
   "发布前整张预算表的重新推导（需负责人参与定案）"）。`.size-limit.json` 的条目文字声称
   "经负责人批准……本次按真实 bundle 重推为 35 KB"，但**指南正文没有同步**，且本次实测是 35.19 kB。
   → **发布前必须由负责人确认整张表（4 条）的口径与数字**，本 lane 不动 `.size-limit.json`。

**余量提示**：`browser` 只剩 1.81 kB，且它是四包并集（core+transport+plugins）；任何后续特性都会
直接压到它。发布前若还有改动，**先看 browser 条目**。

---

## 3. API 兼容（`api:check`）

### 3.1 G5：公共 API 审计

```bash
pnpm api:check      # = node scripts/api-check.mjs → API Extractor 与 packages/*/etc/*.api.md 比对
```

**通过判据**：exit 0，且 4 个包都是 `ok`。**前提**：`packages/*/dist/index.d.ts` 必须存在（先 `pnpm build`），
否则 `scripts/api-check.mjs:18` 会直接以"缺少 dist/index.d.ts"判失败。

本次结果：✅ exit 0 —— `[api:check] browser: ok` / `core: ok` / `plugins: ok` / `transport: ok`（A1 日志）。

**有意变更 API 时的正确动作**：`pnpm api:update`（写入 `etc/*.api.md`）→ 同步 `CHANGELOG.md` 与
`docs/guides/` → 合入请求里说明。**发布前 `api:check` 必须是"已登记"的绿，不是"刚 update 过"的绿。**

### 3.2 G6：契约测试（协议/ Schema 层面）

```bash
pnpm test:contract
```

**通过判据**：exit 0；含"用 Ajv 校验 SDK **真实产出**批次"的用例（`tests/contract/sdk-batch-output.test.ts`）。

### 3.3 G7：版本号一致性（**当前无门禁——本次新增判据，见 §9.3**）

现状核查（本次实跑）：

```bash
node -e "for (const p of ['browser','core','plugins','transport']) console.log(p, require('./packages/'+p+'/package.json').version)"
```

**通过判据**：① 4 个包版本号一致；② 等于 `packages/core` 的 `SDK_VERSION` 常量；③ 等于
`CHANGELOG.md` 最上面那个版本的版本号；④ 不再有 `private: true`（发布物不能是 private）。

**⚠ 当前事实**：4 个包都是 `0.0.0`、都是 `private: true`；`CHANGELOG.md` 最新条目是
`## [0.0.0] — 未发布`。**"首个对外发布版本号由 T35 决定"**（CHANGELOG 首行与 `handover.md` 第 2 节），
**但版本号的定案是负责人的决定，不是 Agent 的**；而且仓库**没有任何自动化门禁**校验
`SDK_VERSION` / `package.json.version` / CHANGELOG 三者一致（`scripts/api-check.mjs` 只比导出面，
**不比版本号**——§9.2/§9.3 的反证证明了这一点）。→ 这是 §10 的发布阻塞点之一。

---

## 4. 接入方式与 Examples（`examples:*`）

```bash
pnpm examples:build
pnpm examples:test
```

**通过判据**：两条都 exit 0，且不是"空脚本通过"。`examples/` 4 个例子（`node-import`、`script-tag`、
`vite`、`webpack`）的 `build`/`test` **现已各自有真实验证脚本**（2026-10-15 由 T33 lane 把原来的
`node -e "process.exit(0)"` 换掉），形态是：`SDK_VERSION` 与包清单一致 → `createAssembly` 是函数 →
`init/track/flush` → 接收方真收到**通过 `batch.schema.json` Ajv 校验**的批次。

**已知落差（发布前必须知道，不要读成"所有 example 都被验过"）**：
- `examples/event-registry` **没有 `package.json`**，`pnpm -r --filter "./examples/**"` 对它**零覆盖**
  （它是纯样例/数据目录）；`docs/guides` 里那节"文档中的示例代码都能在 `examples/` 中运行"仍**无法由
  现有 examples 证明**——`examples/quickstart` **缺失**（handover 第 2 节 T34 小节第 3 条）。
- 两个 webpack 脚本的 Chromium 复核探测的是**写死的 macOS 缓存路径**；CI 的 gates job 不装浏览器，
  因此"Chromium 复核"在 CI 上**永远是 skipped**（现已显式记账为 `browser.status=skipped` + `accounted=true`）。

本次结果：✅ 两条都由 G1 覆盖，exit 0（A1 日志中 `examples/*` 各自 `Done`）。

---

## 5. E2E（端到端，真实浏览器）

```bash
# 沙箱内可跑的两条（本仓库当前实测可用；驱动走树外 playwright-core@1.60.0 + chromium-1223/webkit-2287）
pnpm test:e2e --project=chromium

# 发布判定用的真实浏览器集合（🚫 需非沙箱会话）
pnpm test:e2e --project=chromium --project=webkit
pnpm test:e2e --project=firefox        # 不得设置任何 MOZ_* 变量
```

**通过判据**：exit 0，且**不带** `--grep`/`--grep-invert` 之类缩小集合的参数；
用例数应为 `playwright test --list` 实测的固定值（T33 实测 **45 tests in 4 files**）。

**🚫 硬性环境约束（本次未运行，如实登记）**：

1. **`pnpm test:e2e` 不带 `--project` 在 DSH 沙箱内必然有一条红**：配置里有 chromium/firefox/webkit
   三个 project，而 Firefox 主进程 `sandbox_init()` 无法嵌套（`tests/e2e/README.md` 已写明）。
   → **发布判定时不要用不带 `--project` 的 e2e 结果**（T32 缺口 6）。
2. **WebKit** 需非沙箱：沙箱会静默阻塞 WebKit 写 `~/Library/WebKit`（T29/T30 反复踩过），
   存储测量必失败；且 Playwright WebKit ≠ 真实 Safari。
3. **Firefox** 需非沙箱，且**不得设任何 `MOZ_*` 变量**（会破坏 juggler 握手，表现为
   `launchPersistentContext` 超时）。

**WebKit 的账面缺口（必须在发布记录里写明，不得记为"通过"）**：T32 逐格核对后，`d004-webkit.json`
9 格里只有 **6 格** `exposureReconciles === true`，另 3 格（`pending-d0`、`preflush-d0`、
`preflush-small`）是**对象而非 `true`**（`windowCaptured=false`、`nothingCommitted=true`）——
**是空白，不是 0 丢失**。复跑 `pnpm test:e2e --project=webkit` 使两引擎同基线，**归 T29/需非沙箱会话**。

**同一条铁律**：`pnpm test:e2e` 的 `--pass-with-no-tests` 已于 2026-10-15 移除，现在"收集到 0 个用例"
是**失败**（`Error: No tests found`）。不要为了"让它绿"加回来。

---

## 6. 兼容矩阵回归（**灰度前的门禁**）

### 6.1 G8：矩阵登记守卫（已在门禁内，2026-10-15 起）

```bash
pnpm exec vitest run --coverage.enabled=false --project compat
```

**通过判据**：exit 0。该 project 于 2026-10-15 经负责人批准加入根 `vitest.config.ts`，
因此 `pnpm test`/`pnpm gates` 现在**真的会执行** `tests/compat/**`——此前的状况是
"`tests/compat/**` 5 个守卫文件**从未被任何门禁执行过**"（T33 核实并报备，见
`t33-access-blockers.md` 第 549 节第 1 条）。

本次结果：✅ exit 0（A4）。

### 6.2 矩阵证据重算

```bash
node tests/compat/scripts/summarize.mjs          # 汇总 results/*.json → results/matrix.json
pnpm examples:build && pnpm examples:test        # 接入方式 6 格里的 Vite/webpack/IIFE/Vitest/Jest
node tests/compat/scripts/browser-core-path.mjs  # 真实 Chromium 核心路径 11 项
```

**通过判据**：`tests/compat/results/matrix.json` 的 45 格分布为
**38 pass / 1 by-design / 6 blocked**，且：
- **不得出现新的 `fail`**（出现即阻断灰度）；
- 那 1 条 `by-design` 必须是 `import.cjs.require`（`ERR_PACKAGE_PATH_NOT_EXPORTED`，ESM-only 口径
  已写进指南 4.2）；
- 6 条 `blocked` 保持"写清缺什么 + 归 T29"的状态，**不得改写成 pass**。

**发布记录必须写明的一句话**：本期分发形态是 **ESM-only**（`exports` 只有 `source`/`types`/`import`），
CJS `require("@web-report-sdk/browser")` **不支持**；Jest 接入需 `--experimental-vm-modules` + `.mjs`。

### 6.3 灰度前的解读口径

兼容矩阵的 `pass` 是**灰度准入的必要条件，不是充分条件**：`blocked` 的 6 格里有
Firefox/WebKit/Edge/最低版本/iOS 真机/Android 真机——这些**恰好是灰度要覆盖的浏览器**。
所以「1% 放量」之前必须先有 §5 的非沙箱 E2E 结论，否则灰度是在**未验证的浏览器**上放量。

---

## 7. 可靠性对账口径（灰度判据的来源）

```bash
node tests/reliability/reconcile.mjs              # 打印第 3 节全部表格（只读 JSON，秒级，无浏览器）
node tests/reliability/reconcile.mjs --compare <A.json> <B.json>
```

**通过判据（必须按 T32 的三类分列，逐类判定；不得合并成一个"总丢失率"）**：

| 类别 | 判据（本表必须给出的字段） | 本次现算结果（A5） |
|---|---|---|
| ① 优雅退出路径 | critical 丢失率 ≤0.1%、normal ≤1% | **无数据源 → 不可判定**（T32 缺口 1，归 T29/需非沙箱会话） |
| ② 硬杀「已确认落盘」 | 存活率 = 1 且 `reopenCommitLoss.events === 0` | ✅ Chromium/WebKit `durable` 各 1000/1000、计 0 |
| ③ 硬杀「暴露窗口内未提交」 | `survived + uncommitted === expected`（逐格），且**该格必须 `windowCaptured === true`** | Chromium **9/9 成立**；WebKit 6/9 成立，3 格**空白** |
| ③-D1 锚点子窗口 | 同③（`preflush-*`） | Chromium `preflush-d0`=1000、`preflush-small`=100 成立；WebKit 2 格空白 |

**"窗口真的被捕获"的判据**（T29 方法学教训第 3 条）：重启后 `prewrite_commit_lost > 0`。
没有它，"未 `oncomplete` 也读得回"只说明"没在 `oncomplete` 前杀掉"。**JSON 里的 0 是初值，不得读成窗口 0 ms。**

**暴露窗口时长必须成对引用**（CR-007/CR-008）：`observedWindowMs ≤ W ≤ windowMs`；
`exposure_window_ms` / `exposure_window_upper_bound_ms` 是**上界**（含重启开销，实测 923–1712 ms），
下界 `exposure_window_lower_bound_ms` 是"最后一次会话存活证据"（实测 1–7 ms）。**两个端点都不是 W，
不得相加或平均，上界不得用于 SLA/容量判定**（`receiver-requirements.md` A.3 第 3/7/8 条）。

### 7.1 M01 侧计数（对账的权威一侧）

```bash
node tools/mock-receiver/dist/cli.js --port 8787 &
curl -s http://127.0.0.1:8787/__mock/counters          # 别名 /__mock/stats
curl -s http://127.0.0.1:8787/__mock/events           # 入库数据（X-App-Id 可过滤）
curl -s -X POST http://127.0.0.1:8787/__mock/counters/reset
curl -s http://127.0.0.1:8787/__mock/health
```

**通过判据（恒等式）**：`received_events - stored_events === duplicate_events`；
`stored_*` 是**去重后入库量，对账以它为准**（RR-05，去重键 `app_id + event_id`，窗口默认 7 天）。

**⚠ 两套计数不要混用（本次核实）**：

| 装置 | 字段 | 位置 |
|---|---|---|
| **M01**（`tools/mock-receiver`） | `received_batches/events`、`stored_batches/events`、`duplicate_events`、`rejected_<code>`（9 类）、`injected_*` | `tools/mock-receiver/src/counters.ts` |
| **T32 的 e2e 接收端**（`tests/e2e/lib/receiver.mjs`） | 上述 + `duplicate_rate`、`dedupe_window_ms`、`expired_dedupe_keys`、`unparsable_batches`、**`by_event_name`**、**`by_batch`** | 只存在于 `tests/e2e/**`，是本地测量装置 |

T33 文档把两者合并描述为"M01 侧计数（新计数器口径）"；**严格说 `duplicate_rate`/`by_event_name`/`by_batch`
只在 e2e 接收端里，M01 的 HTTP `/__mock/counters` 不提供**。灰度看板的"重复送达率"字段**由生产接收方实现**
（RR-05/RR-15 + 容量建议第 4 节），**不是 M01 的产出**。

### 7.2 **T32 报告 §3 的生成区已与数据源脱节**（本次发现，发布前必须重新生成）

本次实跑发现：**`tests/e2e/results/d004-chromium.json` 在 T32 报告写就之后被刷新过两次以上**。

| 来源 | 被测实现 `sha256` 前缀 | `generatedAt` |
|---|---|---|
| T32 报告 §3.1 记的（报告生成时） | `454fbb9008176f86` | 2026-10-14T09:27:33.471Z |
| **当前仓库里实际的文件** | **`88ca1e9c49dc0f61`** | **2026-10-15T02:12:53.315Z** |

证据：`git log --oneline -- tests/e2e/results/d004-chromium.json` 显示该产物最后一次提交在
`90f7141`（CR-008 第 2 步，**晚于** T32 的合入提交）；而报告 §3.2 的散文仍写着
「同一份被测实现：**是**」——现在跑 `--compare` 得到的判定是
「**否**（`88ca1e9c49dc0f61` vs `454fbb9008176f86`）—— 两次运行不可直接比较」。

**影响**：
- **结论未变**：现算输出与报告 §3 的**判定列**逐格相同（Chromium 9/9 对账成立；WebKit 仍是
  6 格 `true` + 3 格对象；`durable` 两引擎 1000/1000）。差异只出现在**绝对值**（窗口时长
  1213→1334 ms 等）与**指纹行**上。
- **但发布记录不能引用过期指纹**：发布检查表要求"可靠性对账口径"有据可依，
  报告里 `454fbb9008176f86` 这个数字**已经无法回指任何现存文件**。

**处理动作（不在本 lane 可写范围）**：
```bash
node tests/reliability/reconcile.mjs --write     # 重新生成报告 §3（会改写 docs/reports/reliability-reconciliation.md）
```
→ 该文件不在本 lane 的可写范围（只能写 `release-*.md`／`runbooks/**`），
**请负责人指派 T32 执行方（A10 的上一任务）或授权本 lane 追加执行**。
在此之前，一切引用 T32 §3 数字的发布记录都必须注明"指纹已过期（见 release-checklist §7.2）"。

**附带一条通用教训（建议写进发布流程）**：`tests/e2e/results/*.json` 是**会被 e2e 运行覆写的活产物**，
而 T32 报告是**快照**。任何"报告数字 vs 落盘证据"的一致性都必须在发布前**重新生成**一次，
不能假设上次生成过就永久成立（本仓库恰好就是这么过期的）。



### 7.3 试点三方对账（T33 工具，腿③未接）

```bash
node tests/pilot/10-three-leg-reconcile.mjs --repeat 3
node tests/pilot/20-receiver-selfcheck.mjs
```

**通过判据**：偏差 ≤1%（A2b），且**不可判定时必须 exit 1**（防"空白当达标"，该守卫已单元级验证）。
**现状**：腿①③② 中**腿③（双写转发）未接入**，脚本显式标注不伪造（`t33-readiness.md` 第 3.2 节）。

---

## 8. 安全与隐私项（T31 已签发）

```bash
pnpm exec vitest run --coverage.enabled=false --project security
```

**通过判据**：exit 0；且 `docs/reports/security-draft.md` 顶部签发区为「**已签发（2026-10-15）**」，
签署依据包含 5 文件/33 用例全绿 + 两条机器守卫 0 命中。

本次结果：✅ exit 0（A2）；`security` project **5 文件 / 33 用例**。

**⚠ 三处必须在发布记录里写明的安全侧事实（本次核实）**：

1. **报告正文有 2 处与签发区自相矛盾（过期未清）**：`docs/reports/security-draft.md` 第 1/3 行已改为
   「已签发（2026-10-15）」，但**第 149 行仍写"报告**未经签发**，也不代表安全评审已通过"**、
   **第 158 行仍写"……完成前，本任务保持'未完成'，不签发"**。签发结论以顶部签发区为准，
   **但这两处过期文字会让审计/签发人误判**——发布前应由 T31 执行方或负责人清掉（本 lane 不改 `security-draft.md`，
   它不在可写范围内）。
2. **未修缺陷 1（已登记待立项）**：`touch()` 在生产路径**零调用点** ⇒ `session_id` 的 **30 分钟空闲轮换
   实际上从不发生**（`security-draft.md` 末尾"另记一条未修"）。
3. **未修缺陷 2（D-09 同类残留）**：这些"声明了但没读"的字段会**静默失效**——
   `createClient({ appId })`、`init({ endpoint / token / env / release / extra_mask_rules })`
   （`t33-access-blockers.md` D-09 节末表）。**接入方照 API 参考写会不报错地不生效**，
   属于发布前必须裁定"修 / 或写进接入指南的已知限制"的项。

**T31 的遗留（不影响签发，但影响发布话术）**：WebKit/Firefox 的安全项补测需非沙箱会话。

---

## 9. 判据的判别性反证（"能失败"的证明）

> 要求：**至少 2 条判据做反证**。本节做 **3 条**，每条都写清"注入什么 → 应当怎么红 → 实际怎么红 → 如何恢复"。
> 纪律：注入只碰**构建产物**或**命令行参数**，不碰 `packages/*/src/**`、不改任何跟踪文件的内容（用完按 sha256 还原）。

### 9.1 反证 1（体积判据）：收紧 limit → 必然红

```bash
pnpm exec size-limit --limit 1kB      # 只改命令行参数，不碰 .size-limit.json
```

**预期**：红（4 条全部超 1 kB）。
**实际**：✅ 变红 —— 见 §9.4 结果表；证明 §2 的 `Size ≤ Size limit` 判据**不是恒真**。
**注意**：这条反证故意用**比契约更严**的 limit，**恢复不需要任何动作**（没改文件）。
它证明的是"size-limit 的判定会随判据变化而失败"，不是"当前预算不合理"。

### 9.2 反证 2（API 判据）：注入一个未登记的公共导出 → `api:check` 必然红

```bash
# 0) 记下 sha256（恢复用）
shasum -a 256 packages/browser/dist/index.d.ts
# 1) 往构建产物（不是 src！）追加一个未登记导出
printf '\nexport declare const t35ProbeExport: number;\n' >> packages/browser/dist/index.d.ts
# 2) 应当红
node scripts/api-check.mjs; echo "exit=$?"
# 3) 按 sha256 还原（先备份）
cp packages/browser/dist/index.d.ts /tmp/t35-browser-dts.bak   # 在步骤 1 之前做
cp /tmp/t35-browser-dts.bak packages/browser/dist/index.d.ts
shasum -a 256 packages/browser/dist/index.d.ts   # 必须与步骤 0 一致
```

**预期**：`[api:check] browser: 失败（错误 N，警告 M）；公共 API 与 etc/ 中的报告不一致，有意变更时运行 pnpm api:update`，exit 1。
**要点**：注入点必须是 **`dist/index.d.ts`（构建产物）**，不是 `packages/browser/src/**`（本 lane 禁止改），
也不改 `packages/browser/etc/browser.api.md`（属于跟踪文件）。运行结束后必须按 sha256 校验还原。

### 9.2b 反证 2b（"过期版本号 → `api:check` 应当红"这个直觉**不成立**）

任务派工里的例子是"故意用一个过期版本号，`api:check` 应当红"。**本次实测证明它不成立**：

```bash
# 把 core 的包版本号临时改成 9.9.9（明显的过期/错误版本），再跑 api:check
cp packages/core/package.json /tmp/t35-core-pkg.bak
node -e "const fs=require('fs');const p='packages/core/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='9.9.9';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
node scripts/api-check.mjs; echo "exit=$?"
cp /tmp/t35-core-pkg.bak packages/core/package.json
```

**实测**：`exit=0`（4 个包全部 `ok`）——**`api:check` 没有红**。
原因在机制上很清楚：`scripts/api-check.mjs` 做的是 **API Extractor 的导出面 diff**（`etc/*.api.md` vs
`dist/index.d.ts` 生成的报告），**版本字符串不在比对范围内**。
→ 所以"版本号一致性"**必须单独设门禁**（§3.3），不能指望 `api:check` 兜住。

### 9.3 反证 3（版本号一致性判据，§3.3）：喂一个过期版本号 → 自检必然红

§3.3 的判据当前**没有官方门禁**，所以本节给出**最小可复跑的替代检查**（只读仓库文件，不写仓库）：

```bash
cat > /tmp/t35-version-check.mjs <<'EOF'
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(p, 'utf8');
const pkgs = ['browser', 'core', 'plugins', 'transport'].map(
  (p) => [p, JSON.parse(read(`packages/${p}/package.json`)).version],
);
const sdk = read('packages/core/src/version.ts').match(/SDK_VERSION\s*=\s*'([^']+)'/)[1];
const changelog = read('CHANGELOG.md').match(/^## \[([^\]]+)\]/m)[1];
const expect = process.argv[2] ?? sdk;          // 允许注入一个"自以为是的期望版本号"
const bad = [];
for (const [p, v] of pkgs) if (v !== expect) bad.push(`${p}: ${v} != ${expect}`);
if (sdk !== expect) bad.push(`SDK_VERSION: ${sdk} != ${expect}`);
if (changelog !== expect) bad.push(`CHANGELOG: ${changelog} != ${expect}`);
if (bad.length) { console.error('版本号不一致:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`版本号一致: ${expect}`);
EOF

node /tmp/t35-version-check.mjs        # 正向：应当 exit 0
node /tmp/t35-version-check.mjs 0.0.1  # 反证：过期版本号 → 应当 exit 1
```

**预期**：正常时 exit 0 且打印三个来源一致的版本号；喂 `0.0.1`（过期/错误期望值）时必须 exit 1 并列出不符项。
**实际**：见 §9.4。

**这条反证同时暴露了一个真实缺口**：`api:check` **不会**发现版本号错误（§9.2b 已直接实测），
需要**新增一条版本号一致性门禁**（属门禁配置变更 → 需负责人批准，本 lane 未做）。

### 9.4 反证结果（本次实跑）

| 反证 | 注入 | 期望 | 实测 exit | 恢复 | 恢复后复跑 |
|---|---|---|---|---|---|
| 1 体积 | `size-limit --limit 1kB` | 红 | **1** | 无需（未改文件） | `pnpm size` → 0（本次 G1 已含） |
| 2 API | `packages/browser/dist/index.d.ts` 追加假导出 | 红 | **1** | `cp` 回备份，sha256 `7d115cc7…4c62` 前后一致 | `node scripts/api-check.mjs` → **0** |
| 2b 版本号 vs `api:check` | `packages/core/package.json` 的 `version` 改成 `9.9.9` | —— | **0（没红）** | `cp` 回备份，sha256 一致 | 见 §9.2b |
| 3 版本号自检 | 期望值 `0.0.1` | 红 | **1** | 无需（只读检查） | 正常期望值 → **0**（打印 `版本号一致: 0.0.0`） |

**3 条"能失败"的判据**：体积（反证 1）、API 导出面（反证 2）、版本号一致性（反证 3）。
**1 条"加不进去的判据"**：反证 2b 证明 `api:check` **不是**版本号门禁——这不是失败，而是本表 §13 的阻塞点 4。

### 9.5 反证输出原文（实跑，逐字）

```
=== FALSIFY-1: size-limit --limit 1kB ===
  Package size limit has exceeded by 34.19 kB
  Size limit: 1 kB
  Size:       35.19 kB with all dependencies, minified and brotlied
  ...（core 超 18.02 kB、plugins 超 4.97 kB、transport 超 14.9 kB）
  Try to reduce size or increase limit at .size-limit.json
EXIT_SIZE_LIMIT=1

=== FALSIFY-2a: 注入未登记导出到 dist/index.d.ts（构建产物）===
sha256(before)=7d115cc75731f896660296da970f073911d44736c73d5da478a5d919a8ff4c62
[api:check] browser: 失败（错误 0，警告 1）；公共 API 与 etc/ 中的报告不一致，有意变更时运行 pnpm api:update
EXIT_API_INJECTED=1
sha256(after)=7d115cc75731f896660296da970f073911d44736c73d5da478a5d919a8ff4c62
RESTORE_OK
EXIT_API_RESTORED=0

=== FALSIFY-2b: 改 packages/core/package.json 的 version → api:check 是否红？ ===
  "version": "9.9.9",
EXIT_API_WITH_STALE_PKG_VERSION=0        ← 没红！api:check 不是版本号门禁
[api:check] transport: ok
RESTORE_OK

=== FALSIFY-3: 版本号一致性自检 ===
=== positive ===
版本号一致: 0.0.0
EXIT_POS=0
=== FALSIFY-3: stale version 0.0.1 ===
版本号不一致:
  browser: 0.0.0 != 0.0.1
  core: 0.0.0 != 0.0.1
  plugins: 0.0.0 != 0.0.1
  transport: 0.0.0 != 0.0.1
  SDK_VERSION: 0.0.0 != 0.0.1
  CHANGELOG: 0.0.0 != 0.0.1
EXIT_STALE=1
```

**恢复证明**：`git status --porcelain` 里**没有** `packages/browser/dist/index.d.ts`（该路径在 `.gitignore` 的
`dist/` 里，且 sha256 已核对一致）；`packages/core/package.json` 的 sha256 前后一致。
本 lane **未**修改任何 `packages/*/src/**` 文件，**未**做任何 git 写操作。


---

## 10. 回滚方案（怎么退回上一版本 + 数据/离线副本怎么处理）

> 本节是**发布检查表的一部分**；完整演练步骤见 `docs/runbooks/sdk-operations.md`。
> **所有"回滚"动作都是人工执行**（T35 禁止事项：配置发布由人工审批并由人执行）。

### 10.1 版本回滚（代码/产物）

分发形态（D001 + 指南 4.1）：SDK **不通过 npm 公网分发**给接入方，接入方以 `link:` 联调或
自托管静态产物引用 `@web-report-sdk/browser` 的 `dist/**`。因此"退回上一版本"= **重新发布上一版产物
+ 接入方改回上一个引用**（无中心化 CDN 可一键回滚）。

| 步骤 | 动作 | 通过判据 |
|---|---|---|
| R1 | 用上一版的**构建产物 + 同一份 `etc/*.api.md`** 重新构建 | `node scripts/api-check.mjs` exit 0（不能出现"上一版比当前版少了已发布符号"） |
| R2 | 按 §1–§8 全量门禁复跑上一版 | `pnpm gates` exit 0 |
| R3 | 接入方灰度批次回退（人工） | 接入方侧 `web-report-sdk` 版本号回到上一版（批头 `sdk_version` 可见） |
| R4 | 观察 48h（见灰度方案的回滚阈值） | `sdk_health.dimensions.sdk_version` 全部回到上一版；无新增 `sdk_health` 异常码 |

**不允许的"回滚"**：把 `packages/*/etc/*.api.md` 改回旧内容来让 `api:check` 变绿（那会把已发布的
公共 API 从报告里抹掉，等于隐瞒破坏性变更）。

### 10.2 配置回滚（kill switch / 远程配置）

**关键机制（本次核实，最容易被写错的一点）**：`config_version` 是**单调递增**的，SDK **拒绝**不大于当前
生效版本的配置（原因码 `config_version_stale`，`remote-config.md` §3）。
→ **把旧配置原样重新发布回去不会生效**。正确做法是**发布一个 `config_version` 更大、内容等于旧配置
（或更保守）的新发布物**。

| 手段 | 怎么用 | 生效时间 | 通过判据 |
|---|---|---|---|
| `kill_switch.all: true` | 完全停采：SDK 进入"已销毁"、释放所有监听，**同一页面生命周期内不恢复**；丢弃的事件计 `killed` | P95 ≤10 分钟（缓存 5 min + 拉取 5 min） | 新窗口 `sdk_health` 停止上报；接收方 `received_events` 落到 0 |
| `kill_switch.sdk_versions: [">=X.Y.Z <X.Y.W"]` | **按 SDK 版本关闭**（精确/比较符/合取/析取/`^`/`~`/通配；**不支持连字符区间与带预发布的比较式**，出现即整份配置 `config_schema_invalid` 退回保守默认） | 同上 | 命中版本停止上报；未命中版本不受影响（必须有一格对照） |
| `kill_switch.plugins: [...]` | 卸载指定插件并恢复它装的 hook | 同上 | 该插件的事件不再产生；`killed` 计数 |
| `overrides`（灰度） | 按 `sdk_versions` + `session_bucket: [from,to)` 打补丁，**只能改 `sampling`/`plugins`/`transport`**，**不能改 `kill_switch`/`privacy`** | 同上 | 目标桶放量、其余桶不变 |
| 配置回滚 | 发布 `config_version` 更高的"旧值"发布物 | 同上 | `sdk_health.dimensions.config_version` 变为新号 |
| 配置公钥轮换 | 先发布**新旧公钥并存**的接入方页面 → 再切签名私钥；旧公钥至少保留 **30 天** | 随接入方发版 | 新旧 `key_id` 都能验签成功；篡改 1 字节仍 `config_signature_invalid` |

**保守默认**：`kill_switch` 不能"把 SDK 打回保守默认"来达到停止采集——CR-004 明确：除 WebCrypto
不可用这一唯一例外，**"拒绝本次配置"一律保持当前生效配置**；保守默认只在"本来就没有任何可用配置"时用。
所以**停采必须用 `kill_switch.all`，不能靠推送坏配置**。

### 10.3 令牌轮换 / 吊销

| 情况 | SDK 行为 | 回滚/恢复 |
|---|---|---|
| 令牌被吊销 → 接收方 401 | 投递进入 `paused`（实测 401→paused） | 换回有效令牌（新令牌发布 + 接入方发版）；离线副本**不丢**，恢复后补发 |
| 令牌轮换（新旧并存窗口） | 旧令牌只要未被吊销就继续可用 | 轮换期间**不要同时**吊销旧令牌，否则出现采集空洞 |
| 重复送达 | 离开时刻拿不到 202 ⇒ 下次进入补发一次（≈1× critical 流量） | **靠接收方 RR-05 去重（`app_id`+`event_id`，≥7 天）**；容量按 §7.1 的恒等式核 |

### 10.4 数据与离线副本（回滚时怎么处理）

| 数据 | 位置 | 回滚时怎么处理 |
|---|---|---|
| critical 事件离线副本 | IndexedDB（**禁用 localStorage 存 critical 副本**，D003/追加轮结论） | **不要手动清库**：回滚到旧版 SDK 后，旧版仍会读同一 store 并补发；去重由接收方完成 |
| 未提交的暴露窗口事件 | 事务在途，SIGKILL 时物理丢失（③ 类） | 这是**物理下界不是缺陷**；看板按条数 + 窗口时长（成对端点）计量 |
| 已 `oncomplete` 的副本 | IndexedDB 事务已提交 | 硬杀**不丢**（②类 1000/1000）；回滚不改这一点 |
| 设备标识/会话随机数 | 持久化存储（同意授权后） | **撤回同意会清除**（T31 已验证：设备标识消失 + 落盘副本被清 + 会话随机数重置）；回滚**不得**用旧版写回已清除的标识 |
| `sdk_health` 自监控事件 | 与业务事件同通道同去重键 | 回滚后按 `dimensions.sdk_version` 分列对比，**不要把两个版本混成一行** |

**回滚前的数据冻结要求**：回滚判定必须基于**分列对账**（§7），不得用"总体丢失率"或
"`exposure_window_ms`"做数据判定（CR-007/CR-008 明确禁止后者用于 SLA/容量判定）。

**🚫 未验证的部分**：版本回滚方案**尚未在任何环境演练过**（T35 验收用例要求"版本回滚方案经过验证"）。
演练需要 M01 或预发布环境 → **⏳ 待 Q2/预发布环境**。演练步骤已写在 `docs/runbooks/sdk-operations.md`。

---

## 11. 发布动作清单（**全部人工执行**）

> T35 禁止事项：「包发布、每一级放量的配置发布都由**人工审批并由人执行**；Agent 只准备发布清单、变更单和观察报告。」
> 本 lane **没有**执行任何 `npm publish`、任何 git 写操作、任何配置发布。

| # | 动作 | 执行人 | 前置 | 记录 |
|---|---|---|---|---|
| P1 | 定版本号（首个对外版本） | 负责人 | CHANGELOG 首页 + `handover.md` 第 6 节第 4 条 | 版本号写进 CHANGELOG |
| P2 | 重推整张体积预算表（4 条） | 负责人 + A01 | `handover.md` 第 2 节 | `.size-limit.json` + 指南第 6 节同步 |
| P3 | 同步 `docs/guides/`（T34 的 3 项待办 + 过期表述） | A14 | handover 第 2 节 T34 小节；本表 §4/§8/§10 | 指南版本记录 |
| P4 | 把 `private: true` 去掉、`version` 改为正式号 | 负责人 | P1 | `pnpm gates` exit 0 + 版本一致性检查（§3.3） |
| P5 | 发布产物到 T08 确定的渠道 | 负责人 | P4 + §1–§8 全绿 | 发布记录（交接产物） |
| P6 | 灰度配置发布（每一级单独审批） | 负责人 | 灰度方案的进入判据 | 放量记录（交接产物） |
| P7 | 48h 观察报告 | Agent 出报告、负责人审 | 灰度方案观测点 | 观察报告 |
| P8 | 运维手册演练记录（6 项） | 负责人在 M01/预发布 | `docs/runbooks/sdk-operations.md` | 演练记录（T35 交接产物） |

---

## 12. 待 Q2 / 待试点结果的步骤（明确"缺什么"）

> Q2（首期试点应用与对接人）状态：**待确认**，结论栏为空（`docs/decisions/Q2-pilot-apps.md`）。
> **这些是业务事实，不得编造**。下面的每一项都写清"缺什么、拿到后跑什么命令"。

| # | 步骤 | 缺什么（业务事实） | 拿到后的命令 / 判据 |
|---|---|---|---|
| Q1 | T33 A1「2 个试点应用在预发布环境完成接入与双写」 | 应用名 + `app_id`、应用负责人、前端对接人、预发布环境地址 | `node tests/pilot/00-connectivity.mjs`（需把端点/令牌换成试点值）→ 7 项 PASS |
| Q2 | T33 A2b「连续 7 天三方对账，偏差 ≤1%」 | 上述 + 双写转发腿（腿③）的接入 | `node tests/pilot/10-three-leg-reconcile.mjs --repeat 3` → 偏差 ≤1%；**腿③未接时脚本显式不伪造** |
| Q3 | T33 N1「LCP / INP P75 劣化 ≤2%（A/B）」 | 真实站点 + 流量 | 判据模板见 `docs/reports/t33-pilot-onboarding-kit.md` 第 5 节 |
| Q4 | 灰度 1%/10%/50%/100% 的**真实**进入/退出判据 | 试点应用的业务性能基线（错误率、核心接口耗时、LCP/INP） | 见 `release-grayscale-plan.md` §3 |
| Q5 | 重复送达率 `duplicate_rate` 的真实值 | **生产接收方**实现 RR-05/RR-15 并暴露去重前/后计数 | 按 §7.1 恒等式核；M01 的数字只是本地装置数字 |
| Q6 | 运维手册 6 项演练记录 | M01 或预发布环境 | `docs/runbooks/sdk-operations.md` 的演练登记表 |
| Q7 | `pnpm test:e2e --project=webkit/firefox` | **非沙箱会话**（不是业务事实，是环境权限） | §5 |
| Q8 | ①「优雅退出路径 critical ≤0.1%」的证据 | 测量 harness（T29 未交付）+ 非沙箱会话 | T32 缺口 1：现有数据只有 5–7 事件的**功能验证**，分辨率远粗于 0.1% |

---

## 13. 发布阻塞点（最重要）

按严重度排序。**前 3 条是"发布判定不能被写成通过"的硬阻断**。

1. **①「优雅退出路径 critical ≤0.1% / normal ≤1%」零数据**（T32 缺口 1，归 T29）。
   T29 只做了 5–7 事件的**功能验证**，`tests/e2e/results/*.json` 里**没有任何 `lost`/`lossRate` 字段**。
   → 发布记录**不得**声称达成了 D003/D004 的 ① 类目标；`CHANGELOG` 与 `docs/guides` 已有
   "critical ≤0.1% 只在有优雅退出路径的场景成立"的口径，但它**目前没有证据**。
   **需要**：`tests/e2e/lib/d004-run.mjs` 不能复用（每格都以 SIGKILL 结束）→ 需**新写**一个
   N≥10⁵ 事件的优雅路径测量 harness（T29）+ 非沙箱会话。

2. **WebKit 3 格「空白」不是「0 丢失」**（T32 缺口 3，归 T29）。`pending-d0`/`preflush-d0`/`preflush-small`
   `windowCaptured=false`、`nothingCommitted=true`。→ 灰度覆盖 Safari/WebKit 之前必须复跑
   `pnpm test:e2e --project=webkit`，否则 WebKit 的 ③ 类结论在账面上是空的。

3. **Firefox / Edge / 最低版本 / iOS 真机 / Android 真机 6 格 `blocked`**（T30）。
   它们正是灰度要覆盖的浏览器；且在沙箱内 `pnpm test:e2e`（不带 `--project`）**必然红**。
   → 灰度**不能**在"未验证浏览器"上放量；发布判定必须显式声明本期**已验证浏览器集合**。

4. **版本号一致性没有任何自动化门禁，且首个发布版本号未定**（§3.3、§9.3）。
   `api:check` 只比导出面、**不比版本号**（反证 2/3 证明了这一点）。→ 建议：新增一条
   "`SDK_VERSION` == 各包 `version` == CHANGELOG 顶部版本号"的门禁（属门禁配置变更，**需负责人批准**）。

5. **体积预算表未定案 + 指南正文与 `.size-limit.json` 不一致**（§2）。指南第 6 节仍写 browser **13 KB**
   （re-export 壳口径），实际已按真实 bundle 重推为 **37 KB**（实测 35.19 kB，余量仅 1.81 kB）。
   `handover.md` 明确"发布前必须完成整张预算表的重新推导（需负责人参与定案）"。→ **未定案前不得发布**。

6. **T31 报告正文与签发结论自相矛盾**（§8 第 1 条）：第 149/158 行仍写"未经签发/不签发"。
   签发区已写"已签发（2026-10-15）"。→ 审计口径风险，发布前清掉过期行。

7. **D-09 同类残留会让接入方静默失效**（§8 第 3 条）：`createClient({ appId })` 与
   `init({ endpoint / token / env / release / extra_mask_rules })` 都被静默忽略。
   `endpoint`/`token` 尤其危险——接入方按 API 参考在 `init` 里传端点，会得到"零上报且不报错"。
   → 发布前必须裁定"修"或"在接入指南写死正确用法"（后者属 T34）。

8. **`touch()` 生产零调用 ⇒ `session_id` 30 分钟空闲轮换从不发生**（T31 未修项，已登记待立项）。

9. **门禁自检缺口**：`pnpm gates:selftest` 只覆盖 4 个门禁（`lint`/`typecheck`/`size`/`api:check`），
   `examples:build`/`examples:test`/`test:contract`/`test:e2e` **无自检**；且本次**未运行** `gates:selftest`。
   另有 CI 配置的 `build` 顺序与指南/`gates` 相反（§1.1）。→ 交负责人。

10. **T33 的 3 项残余 + Q2 未确认**：腿③（双写转发）未接入；`examples/quickstart` 缺失；
    `docs/guides` 的 3 项待办（handover 第 2 节 T34 小节）。→ 见 §12。

11. **T32 报告 §3 的生成区已与已提交产物脱节**（§7.2）：报告指纹 `454fbb9008176f86`
    @ 2026-10-14T09:27:33Z，当前文件 `88ca1e9c49dc0f61` @ 2026-10-15T02:12:53Z；
    报告 §3.2 仍写"同一份被测实现：**是**"，实际 `--compare` 判定为"**否**"。
    **结论未变**（判定列逐格相同），但**发布记录不得引用已无法回指的指纹**。
    → 需 `node tests/reliability/reconcile.mjs --write` 重新生成（该文件不在本 lane 可写范围）。

12. **发布基线未冻结**：本次全部门禁是在**含其他 lane 17 个未提交修改**的工作树上跑的
    （HEAD `e0bd651`，脏文件见 §1.1）。→ 发布判定必须在**明确的 clean 基线**上重跑 `pnpm gates`，
    否则"绿"包含了他人在途改动，无法作为发布证据。

---

## 附录 A：反证原始输出

见 **§9.5**（已按实跑结果逐字粘贴，含 4 条注入的 exit code 与恢复证明）。

## 附录 B：本任务新增文件

| 文件 | 作用 |
|---|---|
| `docs/reports/release-checklist.md` | 本文件：发布检查表（命令 + 通过判据 + 实跑结果 + 反证 + 回滚 + 待 Q2 清单 + 阻塞点） |
| `docs/reports/release-grayscale-plan.md` | 灰度方案：分阶段放量、每阶段进入/退出判据（T32 三类分列）、观测点、回滚阈值 |
| `docs/runbooks/sdk-operations.md` | SDK 运维手册：kill switch / 配置回滚 / 按版本关闭 / 令牌轮换 / 公钥轮换 / 紧急补丁版本，6 项演练步骤与演练登记表（⏳ 待 M01/预发布） |

**未新增/未修改**：`packages/*/src/**`、`docs/contracts/**`、`docs/decisions/**`、`tests/**` 断言、
门禁配置、`.size-limit.json`、既有报告。本 lane **未做任何 git 写操作**，**未执行任何包发布**。
