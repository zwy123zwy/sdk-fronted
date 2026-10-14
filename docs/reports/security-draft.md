# T31 安全与隐私测试报告（草稿 · 未经签发）

> **状态：草稿，不构成可签发的安全测试报告。** 本文件只记录**已实测到的事实与出处**，未完成项一律显式标注为「未验证」。
> 任务卡 T31 的交接产物要求「安全测试报告（由安全负责人签发）」——**签发权不在编排方**，本文件是给签发人的输入材料。

- 任务：T31（阶段 P5 / 角色 A11 / 对接：安全负责人）
- 依赖：T13（C03 配置与缓存）、T14（C04 上下文/脱敏/同意）、T16（C07 发送/离线/选主）——**三者均已合入 main**
- 基线：`main` = `28d70ab`；`pnpm gates` exit 0（**111 个测试文件 / 1172 个测试**，其中本任务的 `security` project 13 条；2026-10-13 增补撤回同意清除 4 条后为 **17 条**；同日再固化两条仓库级机器守卫共 **10 条**，`security` project 合计 **27 条**）
- 所有权：本任务可写 `docs/reports/security-*.md` 与 `tests/security/`；**禁止修改实现代码**（本报告未改任何实现）
- 非功能：只在本地与测试环境进行（本报告全部结论来自本地仓库与本地构建）

## 1. 逐条验收项的证据状态

任务卡的验收项共 5 组。下表逐条给出**已实测的事实**或**未验证的原因**。

### 1.1 供应链：运行时依赖为零 ✅ 已验证

| 检查 | 结果 | 出处 |
|---|---|---|
| 是否存在第三方（非 workspace）运行时依赖 | **无** | 遍历 `packages/*/package.json` + `tools/*/package.json` 的 `dependencies`：仅 `packages/browser` 有 3 条，全部是 `workspace:*` 的内部包（`@web-report-sdk/{core,plugins,transport}`）；其余包与三个工具 `dependencies` 均为空 |
| 构建产物是否含令牌/私钥形态 | **无命中** | 对 `packages/*/dist`、`tools/*/dist`（共 14 个文件）扫 `eyJ…`/`AKIA…`/`-----BEGIN`/`ghp_…` 形态：0 命中 |
| 实现代码是否硬编码令牌 | **无** | 扫 `packages/*/src`、`tools/*/src` 中 `write_token`/`token` 后跟 16 位以上字面量的写法：0 命中 |

**注意口径**：任务卡写「运行时依赖为零」，准确表述应是**零第三方运行时依赖**；`browser` 依赖它自己的三个内部包是装配所需，不应记为违反。另据 T18 的挂账义务，后续会再给 `packages/plugins` 补一条 `@web-report-sdk/core` 的 workspace 依赖——**这同样不算引入第三方依赖**，请签发人按此口径复核。

### 1.2 令牌：不出现在 URL、调试输出、离线存储明文之外 ✅ 部分已验证

| 检查 | 结果 | 说明 |
|---|---|---|
| 令牌不出现在 URL | ✅ **已由本任务独立复验** | `sanitizeUrl` 按 `url_query_allowlist` 过滤，白名单为空时**删除全部查询参数**；本任务用自己的假令牌独立复验（4 条，含精确相等断言）。**端到端**（真实请求里 URL 的实际形态）仍归 T29 |
| 令牌不出现在调试输出 | **类型级保证 + 泄漏控制用例** | T17 交付的 debug 输出**按类型不含令牌字段**，并有专门的泄漏控制测试 |
| 信标通道符合 `ingest-protocol.md` 2.2 | **未验证** | 需 T29 的真实浏览器 E2E（真实 `sendBeacon`/`keepalive`） |

### 1.3 隐私：脱敏、URL 白名单、撤回同意后的清除 ⚠️ 部分已验证

| 检查 | 结果 | 说明 |
|---|---|---|
| 注入手机号/邮箱/身份证号/令牌样本后**端上脱敏生效** | **已有实现与用例，待本任务以独立样本复验** | 7 条内置规则（预编译）+ 远程只能追加；已由**变异验证**证明不可被配置整体关闭（注入"有追加规则时不装内置 7 条" → 6 条哨兵用例变红）；`registry.test.ts` 曾抓到内置 `bearer_token` 用 `(?i)`（JS 不支持内联标志）导致构造期 `SyntaxError` 的真实缺陷 |
| URL 查询参数白名单生效 | ✅ **已由本任务独立复验**（2026-10-13，`tests/security/t31-security.test.ts`）| 本任务自造假令牌 `tok_live_9f8e7d6c5b4a3210`，用公开 API `sanitizeUrl` 断言：不在白名单内的参数被删除（**精确相等**）、白名单为空时删除全部查询参数、URL 路径中的手机号被掩码、`#` 片段不进入上报 URL（4 条用例） |
| **撤回同意后**设备标识、离线数据、会话随机数被清除 | ✅ **已验证**（2026-10-13，`tests/security/t31-consent-withdrawal.test.ts`）| `ErasePort` 已不再是死类型：`api/client.ts` 的 `setConsent('denied')` 依次触发 `deviceId → offlineData → sessionRandom`；`browser/assembly.ts` 把后两腿接到 `delivery.clearOffline()` 与 `config.resetSessionRandom()`。本任务用**公开 API** `client.setConsent('denied')` 触发一次撤回，三腿各自**观测到值变化**（不是「调用过某函数」）：① 设备标识从注入的持久化存储里消失、`device_id_persistent` 转 `false`、旧 `device_id` 不再出现；② 离线记录数 **1→0**，并用另一个索引同一 IndexedDB 的离线存储复读为空（证明落盘副本被清，而非只清内存索引）；③ 会话随机数换值且重复读取稳定。**变异验证**：三腿各临时改回「不生效」，对应用例分别变红，详见 1.3.1。 |

#### 1.3.1 撤回同意后清除：变异验证记录（2026-10-13）

三腿各做一次「临时改回不生效 → 对应用例必须红 → 恢复后全绿」。三条腿的实现改动均已恢复（`git diff -- packages` 为空），core/browser 产物哈希与改动前一致。**未发现「没真正生效」的腿。**

| 腿 | 临时改动（改了哪一行） | 变红的用例与断言 | 恢复后 |
|---|---|---|---|
| 设备标识（C04 `purge()` 的落盘删除） | `packages/core/src/context/session.ts` 的 `dropDevice()` 注释掉 `options.persistentStorage?.remove(DEVICE_ID_KEY);`（改后重建 core 产物） | 设备标识腿用例：`expected true to be false`（`recorder.values.has(DEVICE_ID_KEY)`，测试第 121 行） | 全绿 |
| 离线数据（C07 `clearOffline`） | `packages/browser/src/assembly.ts` 的 `offlineCleanup.run` 注释掉 `void delivery.clearOffline();`（改后重建 browser 产物） | 离线数据腿用例：`expected 1 to be +0`（`storedBatches`，测试第 146 行） | 全绿 |
| 会话随机数（C03 `resetSessionRandom`） | `packages/browser/src/assembly.ts` 的 `sessionRandomCleanup.run` 注释掉 `config.resetSessionRandom();`（改后重建 browser 产物） | 会话随机数腿用例：`expected +0 not to be +0`（测试第 173 行） | 全绿 |

补充说明：会话随机数另有一条**确定性随机源**用例（`tests/security/t31-consent-withdrawal.test.ts` 第二组：`sessionRandom: 0.05` + `random: () => 0.95`），断言 `denied` 恰好触发一次重置且值 0.05→0.95，并含负向对照（`granted`/`buffer` 不触发重置）。该用例自行注入 `ErasePort.sessionRandom`，所以只对「重置是否发生」有判别力，不覆盖装配根接线；装配根接线由上面那一行变异负责。

#### 1.3.2 守卫一：截断/切片不得早于脱敏（2026-10-13 新增，机器守卫）

背景：**同一根因在本会话被独立发现三次**（`attachment`、`client.ts` 的预截断、dimensions 的 5 处 + 处理器侧 `url`），每次都是人读或人测发现。形状完全一样：先 `truncate`/`slice`/`substring`/`padEnd`，**再**交给 `masker.apply` —— 截断把敏感值从中间切开，片段不再匹配规则，以残片原样上线（实测残留 `1380`）。

| 项 | 内容 |
|---|---|
| 文件 | `tests/security/guard-truncate-before-mask.test.ts`（3 条）+ `tests/security/lib/truncate-before-mask.ts`（扫描器） |
| 覆盖 | `packages/core/src/**` + `packages/plugins/src/**` 的**非测试** `.ts`（**85 个文件**；TypeScript AST，注释与字符串不计） |
| 判定 | 对**同一个值**做值传递解析（标识符 / 成员访问 / 条件 / `??` / `||` / `&&` / `+` / 模板串），若先出现截断调用、后出现脱敏调用（`X.apply`（X 名含 mask）、`X.mask/scrub/redact/sanitize`、裸 `sanitizeXxx`/`maskXxx`）即判违规，并输出值传递链 |
| 反空转 | 扫描文件数 ≥70（实 **85**）、**识别到的脱敏调用点 ≥5（实 8）**、截断/切片调用点 ≥10（实 **31**）——识别器失效或 glob 写错都会红，而不是"扫了 0 个所以通过" |
| 判别力 | **8 个合成反例**逐个断言被抓：slice→变量、`truncate`→变量、直接嵌套、`event['attachment']`、`padEnd`、条件分支、跨赋值链、裸 `sanitizeUrl`；**6 个正确写法**断言一条都不报：`truncate(masker.apply(value), max)`、先脱敏再按其长度截断、attachment/url 的正向顺序、同名形参遮蔽、先脱敏后 slice |
| 变异验证 | 在 `packages/core/src/privacy/constraints.ts` 第 147 行临时插入 `const MUTATION_PROBE = truncateUtf16Safe(entry, …); const masked = input.masker.apply(MUTATION_PROBE);` → 守卫**红**，精确报出 `constraints.ts:148` 与值传递链；**恢复后全绿**（`git diff -- packages` 为空） |
| 实测结论 | 当前 core + plugins 源码中**不存在**该模式（0 命中）——三次事故的修复都仍处于正确顺序 |

**守卫覆盖不到的同族路径（本任务上报、未改实现）**：`packages/core/src/privacy/constraints.ts` 的 `clampAllStringValues()`（第 274–284 行）只做 `truncateUtf16Safe(value, 256)`，**从不过 masker**；而 `collectStringSlots()` 收集的是**全部顶层字符串字段**。声明字段里 `page_id`/`view_id`/`level` 等既不被 `clampUrl`/`clampAttachment` 覆盖，也不在 `dimensions`/`context` 里 → 属于「只截断、从不脱敏」，与本次根因**同族但形状不同**（没有 `masker.apply`，守卫一按定义抓不到）。可达性有限：公开 API 只产出 Schema 允许的键，`readLocation().pageId` 恒为 `undefined`（核心不从 URL 推导 `page_id`），未声明字段须由插件/内核直接写入。因此记为**纵深防御缺口**，请签发人裁定是否补一次脱敏。

### 1.6 守卫二：`tests/**` 不得 import `packages/*/src/**`（2026-10-13 新增，机器守卫）

背景：根 `tsconfig.json` 的 `lib` 只有 `ES2022`（**无 DOM**），而它 typecheck 的正是 `tests/**`。测试一旦 import 包**源码**，`packages/*/src` 就被拉进这个无 DOM 程序 → **成片虚假类型错误**（本会话实测 64 条 `IDBFactory`/`SubtleCrypto`）。踩过**两次**：编排方自己写 `t31-security.test.ts` 时；以及 T31 撤回同意用例 import 了 `packages/browser/dist/index.js`，而该 `.d.ts` 用**裸包名**引用 `@web-report-sdk/core`，在根 `customConditions: ["source"]` 下解析回源码。

| 项 | 内容 |
|---|---|
| 文件 | `tests/security/guard-test-source-imports.test.ts`（7 条）+ `tests/security/lib/test-source-imports.ts`（扫描器） |
| 覆盖 | `tests/**` 全部 `.ts`（**35 个文件 / ≥60 个模块说明符**；TypeScript AST） |
| 硬断言 | `import` / `export … from` / 字面量 `import()` / 字面量 `require()` / `vi.mock()` 的说明符解析进 `packages/*/src` → 失败。相对路径按**仓库根**解析（不依赖机器路径，用 `import.meta.dirname` 求仓库根）；同时覆盖 `@web-report-sdk/<pkg>/src/…` 别名与含 `packages/<pkg>/src` 的文本。报错直接给出 `文件:行 形式 '说明符'` 与修复方向（改 import `../packages/<pkg>/dist/index.js`） |
| 需允许清单 | 「声明指向源码的入口常量」（`const ENTRY = '…/packages/core/src/index.ts'` 这类**变量说明符逃生舱**）必须与**带理由的 5 条清单两侧相等**：新增未登记 → 红；清单出现失效条目 → 也红。现存 5 处：`tests/bench/lib/entries.ts` 3 处、`tests/contract/lib/sdk-runtime.ts` 2 处（刻意的运行期真实入口加载；说明符是变量，TS 不静态解析，**不污染根程序**） |
| 裸包名 | `@web-report-sdk/<pkg>` 这类裸包名单独识别，给出**明确可读报错**：说明「`customConditions` 含 `source` 时会解析到 `packages/*/src`（无 DOM 程序）→ 成片虚假类型错误」，并给出两条修复（改 import dist / 移除 `source` 条件）。当前根 tsconfig 的 `customConditions: []` → 解析到 `dist`，安全 |
| 反空转 | 扫描文件数 ≥25（实 **35**）、说明符 ≥60；「声明常量」用**清单两侧相等**，即使观察集为空也会红 |
| 判别力 | **8 个合成反例**：静态 import、`export … from`、`import type`、字面量 `import()`、字面量 `require()`、`vi.mock()`、`@web-report-sdk/x/src/…` 别名、常量+变量说明符；另**不误报** 6 类：dist 产物（含 `import type`）、`node:` 内置、第三方、`tests/contract/lib` 相对路径、模板串与纯字符串里的路径 |
| 变异验证 | 在 `tests/security/t31-security.test.ts` 第 26 行临时插入 `import '../../packages/core/src/index';` → 守卫**红**，精确报出 `tests/security/t31-security.test.ts:26`；**恢复后全绿**（该文件 `git diff` 为空） |

### 1.4 配置：篡改、回放旧版本、错误 `key_id`、未知 `format_version` 被拒绝并降级 ✅ 已验证（由 T13）

| 攻击 | 结果 |
|---|---|
| 篡改缓存（payload / signature） | 拒绝 + 计 `config_signature_invalid` + 删除该条目 + 按 CR-004 通则处理；**编排方独立复现过判别力**（旁路缓存验签 → 4 条篡改用例全红、正向对照仍绿） |
| 304 路径篡改 | **不是绕过验签的旁路**：与拉取共用同一 `processEnvelope`，全仓 `verifyEnvelope` 只有一处调用 |
| 错误 `key_id` | 精确查表，不命中即拒绝 |
| 不认识的 `format_version` | 计一次 `format_version` 并拒绝；失败求值有固定顺序、只计首个原因码 |
| 回放旧版本 | 拉取路径要求版本严格递增（相等视为 stale）；缓存路径允许相等 |

### 1.5 结论项：无高危与中危问题 ⏳ **不可下结论**

已知的**预防性控制**（不是"未发现问题"，而是"问题被结构性地挡住"）：

- `tests/contract/localstorage-guard.test.ts`：D004 的仓库级守卫（**用 TypeScript AST 检测标识符**，注释与字符串自动排除），禁止源码引用 `localStorage`。判别力已在真实仓库实测（植入一处用法 → 精确报出文件与行号）。**该守卫在 T14 交付时真的抓到了一处**：`client.ts` 直接读 `globalThis.localStorage` 当默认存储，与它自己 `ports.ts` 的声明（"由装配根注入"）矛盾；经负责人裁定改为内存默认。
- `ConsentState` 缺省由 `'granted'` 修正为 `'unknown'`（Q5 一致性修正）：原缺省可被读作"未经同意即采集"，由 T14 与 T34 **各自独立发现**。

**但在以下项完成前，本任务不能给出"无高危与中危"的结论**：1.2 的信标通道（依赖 T29 的真实浏览器 E2E）、以及**审计式复查**（`ingest-protocol.md` 2.2 逐行攻防对照，见第 2 节）。1.3 的撤回同意后清除已于 2026-10-13 验证通过（见 1.3.1），不再阻塞结论。

## 2. 尚未开展的工作（阻塞或待办）

**本节已于 2026-10-13 更新**：原先列出的 4 项中，有 4 项已完成（见下），剩余项均**被外部依赖阻塞**。

1. ~~`tests/security/` 目前为空~~ → **已完成**（2026-10-13）：负责人批准新增 `security` vitest project（门禁配置变更），`tests/security/t31-security.test.ts` 已落地 **13 条**可执行用例并纳入 `pnpm gates`；同日新增 `tests/security/t31-consent-withdrawal.test.ts` **4 条**（1.3 的撤回同意后清除），`security` project 合计 **17 条**；同日再固化两条**仓库级机器守卫**（1.3.2「截断不得早于脱敏」3 条 + 1.6「tests 不得 import 包源码」7 条，共 **10 条**），合计 **27 条**。
2. **独立注入式复验（脱敏部分）** → **已完成**：本任务用**自己构造的**伪造样本（手机号/邮箱/身份证号/Bearer 令牌）在公开 API `createMasker()` 上复验，断言**原始敏感值不再出现在输出中**（而非断言具体替换串，避免把测试绑死在实现上）；另含两条安全属性（追加远程规则不削弱内置规则、内置脱敏默认开启）。
3. **撤回同意后清除（1.3）** → **已完成**（2026-10-13）：新增 `tests/security/t31-consent-withdrawal.test.ts`（4 条：公开 API 触发 + 三腿值变化断言 + 三腿变异验证，见 1.3.1）。
4. **构建产物与源码的秘密形态扫描** → **已完成**：带理由的允许清单（只登记经人工确认的假值），**新的命中一律失败**；判别力经实测（在 `url.ts` 植入一个 JWT → 精确报出该文件；恢复后全绿）。
5. **供应链零第三方依赖** → **已完成**：遍历 7 份 package.json 断言不存在第三方运行时依赖。
6. **审计式复查** → **待办（被 T29 阻塞）**：对 `ingest-protocol.md` 2.2 的信标通道约束逐行做攻防对照（T29 完成后才有意义）；`remote-config.md` 的失败表 T13 已逐行核对一次，本任务应独立再做一次。
7. **低危问题的处置计划** → **待办**：任务卡要求低危问题有处置计划——需要先把问题列出来。

## 3. 环境与限制（如实声明）

- 本报告的一切结论来自**本地仓库与本地构建**；未访问任何预发布或生产环境（符合任务卡的非功能目标）。
- 真实浏览器行为（信标、`localStorage`/IndexedDB 的真实持久化、`crypto` 差异）**未在本任务验证**，归 T29。
- **两条守卫的已知边界（如实声明）**：守卫一**不做跨函数分析**（`masker.apply(build(value.slice(0,8)))` 抓不到）、**不传播对象字面量/数组**（`masker.apply(parts.pathname)` 这种"先解析结构、再整体脱敏"的正确写法因此不会误报）；守卫二只对**静态可解析**的说明符硬失败，变量说明符走允许清单。两条守卫都只覆盖 `core`/`plugins` 源码与 `tests/**`，不覆盖 `browser`/`transport` 源码。
- 本任务**未修改任何实现代码**：两次变异验证的临时改动均已恢复（`git diff -- packages` 为空，`tests/security/t31-security.test.ts` 无改动）。
- 报告**未经签发**，也**不代表安全评审已通过**。

## 4. 建议

1. 负责人批准新增 `security` vitest project（门禁配置变更），使 `tests/security/**` 可执行；→ **已完成**（2026-10-13）；
2. ~~T18 完成 `ErasePort` 等接线后，本任务补做 1.3 的"撤回同意后清除"验证~~ → **已完成**（2026-10-13，见 1.3.1）；
3. T29 完成后补 1.2 的信标通道验证；
4. 把两条机器守卫纳入日常改动面：新增脱敏调用点（1.3.2）或新增 `tests/**` 的 import（1.6）时，先看守卫报错；1.6 的允许清单**只减不增**，新增必须写明理由；
5. 裁定 1.3.2 上报的同族路径（`clampAllStringValues` 只截断、从不脱敏）是否需要补一次脱敏；
6. 剩余项（第 3 条、以及第 2 节的审计式复查与低危处置计划）完成前，本任务保持"未完成"，不签发。
