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

**守卫覆盖不到的同族路径（2026-10-14：已裁定「补一次脱敏」并修复）**：`packages/core/src/privacy/constraints.ts` 的 `clampAllStringValues()`（原第 274–284 行）只做 `truncateUtf16Safe(value, 256)`，**从不过 masker**；而 `collectStringSlots()` 收集的是**全部顶层字符串字段**。声明字段里 `page_id`/`view_id`/`level` 等既不被 `clampUrl`/`clampAttachment` 覆盖，也不在 `dimensions`/`context` 里 → 属于「只截断、从不脱敏」，与本次根因**同族但形状不同**（没有 `masker.apply`，守卫一按定义抓不到）。可达性有限：公开 API 只产出 Schema 允许的键，`readLocation().pageId` 恒为 `undefined`（核心不从 URL 推导 `page_id`），未声明字段须由插件/内核直接写入。**裁定：处理器是唯一脱敏权威，不得把「当前调用方都写对」当作安全前提 → 补一次脱敏，已修，证据见 1.3.3。**

#### 1.3.3 顶层字符串字段过同一个 masker（2026-10-14 修复，承接 1.3.2 上报的同族缺口）

| 项 | 内容 |
|---|---|
| 缺口 | `clampAllStringValues()` 把**全部顶层字符串字段**截到 256，却从不调用 masker；且该函数**只在事件体 > 16 KB 时**才跑 → 长度不足 256 的敏感值此前原样上线 |
| 修法 | 新增 `maskTopLevelStringValues(event, masker)`：对顶层**载荷/自由文本**字符串值（`page_id`/`view_id` + 未声明额外字段）用**与 `dimensions`/`context`/`attachment`/`url` 同一个** masker 脱敏；在 `constrainEvent` 里**无条件**先于所有截断路径执行（**先脱敏、再截断**）。`url`/`attachment` 已由各自函数用同一 masker 处理，本通道**跳过**（避免接入方追加规则被叠加施加两次）。未命中规则的值不写入（保持「已合规事件零写入」；脱敏不是截断，不计数、不写 `truncated`）。 |
| 协议字段排除清单（2026-10-14 收口） | 上一版把「已知权衡」留给签发人（接入方追加规则命中标识符 → 去重失效 / 必要事件判定错乱 / 离开枚举）。**裁定：这不是权衡，是让接入方配置破坏协议语义，必须收口** → 新增 `packages/core/src/privacy/protocol-fields.ts` 的 `PROTOCOL_STRING_FIELDS`，把 Schema 关死取值的协议字段排除在脱敏之外：`event_id`/`event_name`/`event_type`/`priority`/`level`。`page_id`/`view_id` 与未声明字段**继续脱敏**。 |
| 清单的取法（从 Schema 推导） | 权威 `docs/contracts/schemas/batch.schema.json#/$defs/event`；取「**`required`（协议信封）∪ 有 `enum`（闭集词汇表）**」且「解析 `$ref` 后产出**字符串**」的属性名。取法**刻意不用**「凡有 `pattern`/`format` 的都算」：`view_id` 与 `event_id` 同为 `$ref uuid`，但 `view_id` 是**非必填的路由/上下文载荷** → 必须继续脱敏；判别力正来自「必填 ∪ 枚举」（同一 uuid 形态，`event_id` 排除、`view_id` 脱敏）。数值/布尔受控字段（`schema_version`/`occurred_at`/`sample_rate`/`retry_count`/`replayed`）不经过字符串脱敏通道；`app_id` 属批次头、不在事件体。 |
| 漂移检测 | `packages/core/src/privacy/protocol-fields.test.ts`（4 条）：**不手写期望值**，直接 `import` **真实** Schema 按同一取法重算，与源码常量**两侧相等**（少了新增的必填/枚举字符串字段 → 红；多了 Schema 已删/改名 → 也红），并含反空转（推导非空）、需求钉子（`page_id`/`view_id`/`url`/`attachment` **必须不在**清单里）、非字符串受控字段不进清单。形态对齐 `packages/transport/src/monitor/reason-codes.test.ts` 对 `sdk_health.schema.json` 的做法。**判别力实测**：临时从常量删掉 `level` → 漂移用例红（`+ "level"`），恢复后全绿。 |
| 测试先行（fail-first） | 新增 `packages/core/src/privacy/constraints-toplevel-mask.test.ts`（16 条）。**第一轮**（旧实现）修复前：`Tests 10 failed | 2 passed`，原文如 `AssertionError: expected '/task/13800138000' not to contain '13800138000'`、`expected 'aaaaaaaa…138001' not to match /\d{4}/`（截断在前才会留下的手机号残片）。**第二轮**（协议收口）实现前：协议钉子红，原文 `AssertionError: expected '***' to be '00000000-0000-4000-8000-000000000001'`。两轮里常绿的都是**不得回归**的语义钉（零写入、`dimensions`/`context` 不被二次施加）。 |
| 变异验证 | ① 把 `constrainEvent` 里那一行调用 `maskTopLevelStringValues(event, input.masker);` 注释掉 → 同文件 **10 条断言级变红**；② 把 `maskTopLevelStringValues` 里的协议跳过改回只跳 `url`/`attachment` → **2 条红**（`expected '***' to be '00000000-…-0001'`、`expected '***' to be 'info'`）；③ 漂移检测删 `level` → **1 条红**。三处均恢复后全绿（`grep MUTATION_PROBE` 无命中）。 |
| 守卫一 | `pnpm exec vitest run --coverage.enabled=false --project security tests/security/guard-truncate-before-mask.test.ts` → **3 passed（0 命中）**（两轮修复后各复跑一次）；修复只新增「脱敏在截断之前」的调用点，未引入守卫一所判模式 |
| 顺序证据 | 用例「顺序为先脱敏、再截断：跨 256 边界的敏感值不留下可识别残片」用 250 字符 + 伪造手机号 + 50 字符的 `page_id`（311 字符，手机号正好跨 256 边界）并顶到 16 KB 以上触发真实截断：断言截断后长度 256、不含手机号、不匹配 `/\d{4}/` |
| 协议不可被配置破坏（行为钉子） | 同文件新增 4 条：用会命中协议字段取值的追加规则（`(custom|normal|info|task_complete|sdk_health)`）与会命中 UUID 形态的追加规则 → 断言 `event_id` **完好**、`event_name`/`event_type`/`priority`/`level` **仍在枚举内**；同一 UUID 规则下 `view_id` 仍被脱敏（`'***'`，证明判别力来自协议语义而非形态）；同一规则下 `page_id` 的伪造手机号仍被脱敏、未声明字段仍被脱敏。 |
| 既有语义 | 8 KB/256 字节上限、16 KB 阶梯、`dimensions`/`context`/`attachment`/`url` 的既有脱敏与截断、内置规则不可整体关闭、追加规则语义均未改（`url`/`attachment` 的「只施加一次」另有专门断言）；`pnpm exec vitest run --coverage.enabled=false --project unit packages/core`：**58 文件 / 545 条全绿**；`pnpm exec tsc -p packages/core`、`pnpm exec eslint packages/core/src/privacy` 均 **0 错误** |
| 影响面 | 脱敏只作用于载荷/自由文本字段，协议字段一律不改写 → **接入方的任何配置都不可能再破坏去重键、必要事件判定或枚举合法性**；`level` 由「脱敏」改为「排除」（枚举字段，改写即离开契约词汇表）。仍登记一条既有取舍（非本次引入）：`view_id` 受 Schema `$ref uuid` 形态校验，而被脱敏后的值可能离开 uuid 形态 —— 这是「载荷必须脱敏」压过「形态校验」的刻意选择（签发人 2026-10-14 明确要求 `view_id` 继续脱敏）。 |

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
- 本任务**未修改任何实现代码**：两次变异验证的临时改动均已恢复（`git diff -- packages` 为空，`tests/security/t31-security.test.ts` 无改动）。（**例外说明**：1.3.3 是 2026-10-14 承接本报告上报缺口所做的实现修复，属另一次改动，不在本句范围内。）
- 报告**未经签发**，也**不代表安全评审已通过**。

## 4. 建议

1. 负责人批准新增 `security` vitest project（门禁配置变更），使 `tests/security/**` 可执行；→ **已完成**（2026-10-13）；
2. ~~T18 完成 `ErasePort` 等接线后，本任务补做 1.3 的"撤回同意后清除"验证~~ → **已完成**（2026-10-13，见 1.3.1）；
3. T29 完成后补 1.2 的信标通道验证；
4. 把两条机器守卫纳入日常改动面：新增脱敏调用点（1.3.2）或新增 `tests/**` 的 import（1.6）时，先看守卫报错；1.6 的允许清单**只减不增**，新增必须写明理由；
5. ~~裁定 1.3.2 上报的同族路径（`clampAllStringValues` 只截断、从不脱敏）是否需要补一次脱敏~~ → **已裁定并修复**（2026-10-14）：补一次脱敏，证据见 1.3.3；
6. 剩余项（第 3 条、以及第 2 节的审计式复查与低危处置计划）完成前，本任务保持"未完成"，不签发。

## 5. 2026-10-15 定向诊断：T31「设备标识腿」红是**实现缺陷**，不是测试前提失效

（本节只报告，**未改实现、未改测试**。）

现象：`tests/security/t31-consent-withdrawal.test.ts:115` 红——批头声称 `device_id_persistent === true`（:114 绿），而注入的持久化存储里没有 `DEVICE_ID_KEY`。

### 5.1 性质判定：**实现缺陷**（声称与实际不符）；该用例的前提是正确的

`session.ts` 文件头口径 + `context/header.test.ts` 的 AC-19 都写明：**只有确定已授权才持久化设备标识**，已授权时 `device_id_persistent` 为 `true`。因此「`consent:'granted'` + 注入持久化存储 ⇒ `DEVICE_ID_KEY` 必须已落盘」是**契约要求的前提**，不是过时断言。**未修改 `tests/security/**`**，未回退任何隐私/校验修复。

### 5.2 三条最小探针（`node` 直打 `packages/core/dist`，与用例同一产物）

| 探针 | 前提 | 结果 |
|---|---|---|
| A | 空存储 + 默认同意（`unknown` + `essential_only`） | **不落盘**（正确）✅ |
| A2 | 空存储 + `unknown` + `consent_mode:'full'` | **不落盘**，而 `device_id_persistent: true` ❌ 同型不一致 |
| B | 空存储 + `consent:'granted'`（**用例夹具**） | **不落盘**、`device_id_persistent: true` ❌ ← 本次红 |
| B2 | 空存储 + 同意**只经 `init({consent:'granted'})`** | **落盘**（`wr_device_id`）✅ ← 与 B 只差“同意在哪一步传入” |
| C | 非法（非 uuid）存储值 + `granted` | **未写回**（存储里仍是 `not-a-uuid`）❌ `ddfccaf3` 的写回路径**在生产路径不可达** |
| D | **合法**存储 uuid + `granted` | 存储值未被读取：批头 `device_id` 是**另一个**新造的 uuid ❌ |

### 5.3 根因（两处叠加；`device_id_persistent` 与实际写入**确实可能不一致**——这条最重要）

1. **`device_id_persistent` 的来源是「授权意图」，不是「已落盘事实」**。`context/header.ts:43` 取 `session.deviceIdPersistent`；`session.ts` 里它就是 `persistent` 变量，只由 `isAuthorized(state, mode)`（构造时）与 `onConsentChange` 赋值，**从不检查是否真的 read/write 过**。因此「已授权但从未落盘」时它照样是 `true`。
2. **`device_id` 与它来自不同来源**：`header.ts:29-30` 在 `session.deviceId === ''` 时**现场 `createUuid()` 兜底**。而 `sessionTracker.current()`（`client.ts:323` 唯一接线）**既不生成也不落盘**——生成/落盘的 `ensureDevice()` 只在 `touch()` 与 `onConsentChange→persistDevice()` 里被调用，而 **`touch()` 在全仓 `packages/*/src` 无任何调用点**（只有测试调用）。⇒ 从未 `touch()` 的实例：存储空、`current()` 返回空串 ⇒ 批头**每调一次就换一个 uuid**（实测连续 3 次 `header()` 得到 **3 个不同** `device_id`），同时挂着 `device_id_persistent: true`。**这是本次回归暴露的、影响面比该用例更大的正确性问题**：已授权接入方的批次设备标识逐批漂移，T31 的「清除」腿与任何设备级归因/去重都建立在假前提上。
3. **触发回归的是 `d941e76`（D-09 修复）**：该修复让 `let consent` 在构造时读 `options.consent`；装配根把 `consent` 放进 `clientOptions` 并 `init({...clientOptions})`，于是 `performInit` 里 `previousConsent === consent`，那句 `if (consent !== previousConsent) sessionTracker.onConsentChange(...)` **被跳过** → `persistDevice()` 不再执行。修 D-09 前构造态恒为 `'unknown'`，该守卫必然触发，所以此前是绿的——**这是 D-09 的副作用，不是 D-09 修错了**（P4 证：`init` 传同意仍落盘；P3 证：运行期 `setConsent('granted')` 落盘且 `stored === header.device_id`）。

### 5.4 最小修法建议（属实现缺陷，**本任务未改** `packages/*/src`，交另派）

- **根治（首选）**：让批头路径真正执行一次 `ensureDevice()`——把 `client.ts:323` 的 `session: () => sessionTracker.current()` 改为 `touch(...)`，或让 `current()` 惰性补 `ensureDevice()`（授权时顺带落盘）。改完后 `header.ts` 的 `createUuid()` 兜底成为不可达代码，`device_id` 稳定、`device_id_persistent` 与实际一致。
- **同时修守卫**：`performInit` 里 `if (consent !== previousConsent)` 改为**无条件**（或按「本次是否提供了 consent/consent_mode」）调用 `onConsentChange`——该方法幂等（`granted` → 补写、`denied` → 清除、`unknown` → 仅置 `persistent=false`）。
- **加固**：`header.ts` 不应在 `session.deviceId === ''` 时声称 `device_id_persistent: true`（两个字段必须同源），否则「声称」永远可能强于「事实」。

### 5.5 验证与顺带核实

- `pnpm exec vitest run --coverage.enabled=false --project security` → **1 failed | 31 passed**（仅本腿红）；`--project unit packages/core` → **61 files / 603 tests 全绿**（core 无回退）。
- **其他 security 用例是否依赖同一前提**：`tests/security/**` 里只有本用例引用 `DEVICE_ID_KEY`/`device_id_persistent`（`guard-e2e-receivers-validate-contract.test.ts` 的提及只是说明文字）。`t31-security.test.ts` 13 条**全绿**是因为它**不注入持久化存储、也不断言已授权下的落盘**（只覆盖未授权方向），因此**结构上无法发现**本缺陷——**这个区别本身是「永远绿」的线索**，建议后续为它补一条「已授权 ⇒ 落盘」的对照。
- 纪律：本任务**未改任何实现**（`packages/*/src` 未动）、**未改任何测试**（`tests/security/**` 的 `git diff` 为空）。
