# Wave 1 交付报告：T15 / T10 / T22 / T12 / 门禁加固

- 日期：2026-10-12
- 编排：编排会话（代 A00）；执行：并行子 Agent（分别承担 A04、A09、A06、A02、A09 角色）
- 隔离方式：一任务一分支 + 独立 git worktree（`temp/wt-T15`、`temp/wt-T10`、`temp/wt-T22`、`temp/wt-T12`、`temp/wt-fix-guards`）
- 范围依据：`docs/tasks/board.md` 中 T06/T11/T09 验收后解锁的可领取任务

## 0. 本波范围与授权

Wave 0（T06/T11/T09）验收后，看板解锁 T10、T12、T13、T14、T15、T22。本波取其中 4 个，另加一项跨切面缺陷修复：

| 编号 | 任务 | 角色 | 说明 |
|---|---|---|---|
| T15 | C06 队列与调度 | A04 | 关键路径（T16 的前置） |
| T10 | 契约测试框架与双向校验 | A09 | 为全仓库提供契约门禁 |
| T22 | K01 事件注册表与类型生成 CLI | A06 | P3，解锁 T34 |
| T12 | C01 公共 API、命令队列、加载桩 | A02 | 接入方直接使用的接口 |
| — | 门禁加固（跨切面） | A09 | 修复两处「用墙钟目标值当单元门禁」的必现/高频失败 |

**T13、T14 未纳入本波**：两者都属安全相关任务，任务卡要求实施计划先经负责人与安全负责人确认；且它们与 T12 争用 `packages/core/src/index.ts`，排在 T12 之后。

**本波获得的两项负责人批准**（2026-10-12）：
1. 门禁脚本由 `ci` 改名为 **`gates`**（`pnpm ci` 会被 pnpm 11 内置 `clean-install` 抢占，不执行任何门禁却返回 0），并同步修订 `AGENTS.md`、`README.md`、指南第 6 节（升为 0.6 版）。
2. 新增开发依赖 **`ajv@8.20.0` + `ajv-formats@3.0.1`**（此前已作为传递依赖存在于锁文件中，无新下载），用于 T10 的契约双向校验与 T22 的事件定义校验；并为调试输出加**唯一一条精确 eslint 豁免**（`packages/core/src/api/console-sink.ts`）。

## 1. 逐任务交付

### 1.1 T15 C06 队列与调度（A04）

- 分支 `T15-queue-scheduler`；提交 `fab40d1`、`77e67c9`；合并 `74e2a1a`、`fbfccf5`
- 需求 C06-F1 至 C06-F5；验收 C06-AC-01 至 C06-AC-11（52 个测试）

| 交付物 | 内容 |
|---|---|
| `packages/transport/src/queue/` | 双上限内存队列（500 条 + 512 KB）、冲刷触发（20 条 / 32 KB / 静默 1s / 最长等待 5s / `visibilitychange`·`pagehide` / 业务 `flush`）、在途控制、弱网自适应、页面离开信号 |
| `packages/transport/src/batch/` | 批次组装与 `common` 字段提升 |
| `packages/transport/README.md` | **给 T16 的五组交接接口**（提交批次 / 在途状态 / 熔断信号 / 批次头来源 / 溢出转离线），已由前端负责人确认冻结 |
| `etc/transport.api.md` | 经 `api:update` 登记新增公共导出 |

**契约对齐的强化**：AC-09 的批次校验使用 **Ajv 2020-12 真实编译 `docs/contracts/schemas/batch.schema.json`**，并用**反例对照**（缺 `clock_offset`、批次/事件多未声明字段必须判 false）证明校验不是空转。交付前该测试曾自写「JSON Schema 关键字子集校验器」，经复核属「自证代替真证」，已删除并改为真校验。

**一次设计缺陷的修复（重要）**：该任务的 `perf.test.ts` 最初把**契约目标值**（入队 P99 ≤ 0.01 ms）直接当作单元门禁阈值，空闲实测仅 3.5 倍余量。编排方在有负载条件下连续 3 次全量 `pnpm test` **均失败在同一条**——实现达标，是门禁设计错。返工后的做法：
- 护栏锚定**中位数（P50）**并留 ≥10 倍余量（入队 0.1 ms ≈13.7 倍；组装 0.6 ms ≈12.3 倍），测试名与注释写明「非契约目标值」；
- 契约目标值与空闲实测值写进 `packages/transport/README.md`，**权威验证归 T20 的受控基准**；
- 执行 Agent 用**实测数据推翻**了编排方原定的锚点方案（「有负载 P99 × 10」会得到 4.3 ms / 517 ms 这种失去意义的护栏），编排方接受该偏离。

**已裁定的解释性事项**（记录在 README）：弱网放大倍率**不进远程配置**（`transport` 组是 `additionalProperties: false`，加字段属契约变更）；AC-03 的语义是「**新到的** critical 转离线、内存队列已有 critical 不变」；复用 `storage_unavailable` / `processor_error`，**不新增原因码**。

### 1.2 T10 契约测试框架与双向校验（A09）

- 分支 `T10-contract-tests`；提交 `52f7ec5`；合并 `31b05f3`
- 契约测试从 **12 条扩到 169 条**（6 个文件）

| 验收要求 | 实现 |
|---|---|
| 所有 `*.valid.json` 通过、每个 `*.invalid.json` 的每个 case 失败 | 11 份合法样例实例必须通过；23 个非法 case 逐个必须失败，且**与样例声明的失败原因逐一对应** |
| 现场生成签名配置，签名通过、篡改 1 字节失败 | `node:crypto` 运行时生成 P-256 密钥对（私钥不落盘），P1363 签名 + Node 24 全局 WebCrypto 验签；覆盖 payload 改 1 字节、signature 篡改、`key_id` 未配置/换成另一把公钥、payload 重新格式化五类失败路径 |
| 改 Schema 不更新样例时 CI 失败 | 测试自身从文件系统枚举 `schemas/**`，要求每个 Schema 都有成对的合法/非法样例，**不依赖人工清单**；另含机制自检与孤儿样例检查 |
| 接收方可复用的样例包 | `tests/contract/sample-pack/`（`manifest.json` + `README.md`），把 `receiver-requirements.md` 全部 **11 条「必须」**映射到具体样例与自查步骤，**只引用不复制**样例 |

另覆盖 T06 新增的 6 个内置事件 Schema 与 `compat-pairs` 的 22 对事件定义，并断言 `event-standard.md` 第 3 节要求的三种字段提升形态齐全。

**非功能**：`pnpm test:contract` 实测 wall ≈1.9 s（冷缓存最差 8.1 s），满足 30 s 目标。

### 1.3 T22 K01 事件注册表与类型生成 CLI（A06）

- 分支 `T22-event-registry`；提交 `7c3af31`；合并 `407f871`
- 需求 K01-F1 至 K01-F6；验收 K01-AC-01 至 K01-AC-12（52 个测试）

| 需求 | 实现要点 |
|---|---|
| K01-F1 事件定义校验 | 用 **Ajv 2020-12**（非手写校验器）按 `event-definition.schema.json` 校验；错误信息含文件路径与字段路径（JSON 指针） |
| K01-F2 兼容性检查 | 按 `dictionary-compat.md` **逐行判定**，支持 `--baseline-git` / `--baseline-dir` / `--allow-breaking` |
| K01-F3 critical 配额 | `critical ≤ floor(事件名去重总数 × 0.1)`；20/2 通过、21/3 拦截，与验收用例一致 |
| K01-F4 类型生成 | **纯类型声明**（生成文件里 `export const/let/var/function/class` 计数为 **0**）；只含 active 最新版本；enum → 字面量联合、boolean 维度 → `boolean`、指标 → `number`、`priority`/`schema_version` 为字面量 |
| K01-F5 导出运行期校验规则 | 每个事件保留最近 3 个版本；规则文件自带 Schema 并用 Ajv 自校验 |
| K01-F6 未登记事件报告 | 支持 JSON 数组 / JSONL / 裸事件名三种清单，退出码 0 |

**编排方独立复核（不采信汇报）**：用构建出的 CLI 直接跑兼容性判定——
- 兼容行（新增可选字段）→ **exit 0**
- 破坏性行（新增必填字段）→ **exit 1**，加 `--allow-breaking` → **exit 0**
- **「破坏性但未递增版本」→ exit 1，且加 `--allow-breaking` 仍 exit 1**（K01-AC-04 的关键区分成立）

这证明判定不是空转。另确认 `examples/event-registry/` 无 `package.json`，pnpm 不视其为 workspace 项目，`pnpm examples:*` 门禁不受影响。

**跨任务接口约定（编排方裁定，双方已对齐）**：K01 生成的事件字典形状与 C01 的消费侧契约。执行中执行 Agent 用数据指出编排方原约定的一处错误——`required` 若写成**可选属性**，在 `noUncheckedIndexedAccess` 下被索引会带上 `| undefined`，导致可选字段被误判为必填、负载类型退化成 `never`。最终约定：
- `required` 是**必需的字面量布尔**（`FieldSpec<T, true|false>`）；
- 可选性**同时**体现在属性位置的 `?` 上；
- 消费侧**必须用属性可选性投影**（`{} extends Pick<T, K>` 惯用法或导出的 `PickRequired` 等辅助类型），**不得直接索引 `required`**；
- 「必填字段为必需属性」的落点是**负载类型**，不再加第二套必填标记。
该约定已写入 `tools/event-registry/README.md` 第 5.2/5.3 节，并**纳入 AC-08 的编译自证**（README 给的写法确实能编译，不是纸面约定）。

### 1.4 门禁加固（跨切面，A09）

**背景**：本波完成了 T15 的耗时门禁修复，但同一类缺陷还留在两处——它们把**绝对墙钟目标值**当成共享单元门禁的断言阈值。

| 位置 | 现象 |
|---|---|
| `tools/mock-receiver/src/hosting.acceptance.test.ts` M01-AC-14 | 6 秒压测断言 `perSecond >= 500` **与** `>= 1000`；有负载时实测 334.8 与 536.5 批次/秒，12 次全量运行红 3 次。其 `>=1000` 以「抬门槛」冒充「留余量」，方向与注释意图相反 |
| `packages/core/src/kernel/perf.test.ts`（T11） | 直接把「初始化 ≤5 ms」「管线 P99 ≤0.05 ms」当门禁阈值；同类风险成立（有负载实测 P99 可被进程抢占放大 80 倍以上） |

**已确立的仓库策略（系统性结论，记入看板）**：

> **单元门禁不得断言微秒/毫秒级的墙钟目标值。** 功能与确定性行为进单元门禁；P99 / 吞吐 / 内存等绝对值进 T20 的 `tests/bench/` 受控基准；单元门禁只保留**带文档余量的回归护栏**。

修复由 `fix-timing-guards` lane 执行（参考 T15 的中位数护栏写法）；规格线移交受控基准（M01 的吞吐规格由 T32 在真实规模下行使、T20 负责基准口径）。

### 1.5 T12 C01 公共 API、命令队列、加载桩（A02）

- 分支 `T12-public-api`
- 状态：**首轮交付后经编排方复核发现 5 处契约违反，返工中**；详情见第 5 节 D-1

## 2. 门禁结果

全量门禁命令为 **`pnpm gates`**（`pnpm ci` 不是门禁命令，见第 0 节）。

| 时点 | 结果 |
|---|---|
| Wave 1 开工前基线 | `pnpm gates` exit 0 |
| T15 合入后 | 见第 5 节 D-2：负载下 M01-AC-14 必现失败，门禁加固后修复 |
| T10 合入后 | `pnpm test` 契约 169 条通过 |
| T22 合入后 | `tools/event-registry` 覆盖率 行 90.9% / 分支 77.16%（阈值 80/70），exit 0 |
| 全部合入后（最终） | 见第 2.1 节 |

### 2.1 最终门禁明细

（待 T12 返工与门禁加固合入后补齐）

## 3. 契约与公共 API

- **契约**：文档版本仍为 0.2，本波**未修改任何契约文件**。T10 在复核中发现 4 处契约/样例不一致，**如实上报而未自行修改**（见第 6 节）。
- **公共 API**：`@web-report-sdk/transport` 新增公共导出并登记 `etc/transport.api.md`；`@web-report-sdk/core` 的 C01 导出待 T12 返工完成后登记。
- **工具**：`tools/event-registry` 与 `tools/mock-receiver` 不参与 API 审计（`api:check` 只扫 `packages/`）。

## 4. 对接入方的影响

**暂无。** 所有包仍为 `private: true`、版本 `0.0.0`、尚未发布。本波新增的两个工具（K01）与 T12 的公共 API 都还没有对外发布；`packages/browser` 的 IIFE 产物仍在体积预算内（T12 实测 browser 5.32 kB / core 5.43 kB，预算各 10 kB）。

## 5. 偏差登记

| 编号 | 偏差 | 原因与处置 |
|---|---|---|
| D-1 | **T12 首轮交付的 5 处契约违反**（经编排方逐行复核发现，其 105 条单测全绿） | ① `makeEvent` 在**事件体**加了顶层 `app_id`（`batch.schema.json` 的 event 是 `additionalProperties: false`，`app_id` 只属批次头）；② 缺必填 `event_id`；③ 缺必填 `schema_version`；④ `log` 把 `message` 放在事件顶层（Schema 无此字段）；⑤ `captureError` 的 `web_js_error` 缺必填 `source`/`fingerprint` 与 `metrics.count`。已下发返工，并要求以 Ajv 对**真实产出**校验自证 |
| D-2 | **系统性缺口：契约测试只校验样例，不校验 SDK 真实产出** | T10 交付时明确遗留（当时无实现可校验）。后果已经发生——D-1 的 5 处违反未被子任何门禁拦下。已记入看板：T10 后续必须补 SDK 输出校验；各 lane 交付前须以 Ajv 对 `batch.schema.json`（及对应内置事件 Schema）自证 |
| D-3 | 单元门禁断言微秒级墙钟目标值 | T15 已修复（中位数护栏）；M01-AC-14 与 T11 `perf.test.ts` 由门禁加固 lane 修复。已确立上述仓库策略 |
| D-4 | 验收用例由**执行 Agent** 转成可执行测试，而非 A09 | 本会话没有 A09 实体，`tests/acceptance/` 仍是不可执行规格稿。执行 Agent 只在自己任务卡可写范围内新建可执行用例（测试名以用例编号开头），**未修改 `tests/acceptance/` 任何文件**。与 Wave 0 的 D-2 同类 |
| D-5 | T22 需要两处文件所有权扩展：`examples/event-registry/`、`tools/event-registry/README.md` | 前者是任务卡「交接产物：`examples/` 中的示例注册表」的必然产物，后者是交接说明。已由编排方授权，需负责人追认 |
| D-6 | T12 需要一处所有权扩展：最小、向后兼容的内核改动 | C01-AC-10 要求「两实例的全局注册表只注册一次原生监听」，而 `createKernel` 不接受注入注册表。授权其让 `KernelConfig` 接受**可选共享全局注册表**；**计数器绝不共享**（否则两个 app_id 的计数会串）。需负责人追认 |
| D-7 | T15 偏离编排方指定的护栏锚点 | 编排方原定「有负载 P99 × ≥10」，实测该锚点会产出 4.3 ms / 517 ms 的无效护栏。执行 Agent 用数据改为锚定 P50（≥10 倍余量）并获编排方接受 |
| D-8 | T22 校验器用 `Ajv2020({ strict: false })` | 另以断言保证内嵌 Schema **去掉 `description` 后与契约文件深度相等**（比 strict 模式更强的保证），故接受 |
| D-9 | T15 返工与 T10 都需关闭 Ajv 的部分 strict 检查 | T15 未关闭（`batch.schema.json` 在默认 strict 下可编译）；T10 仅关闭 `strictRequired`（冻结 Schema 用 `allOf/if-then` + `required` 而 `then` 内不重复声明 `properties`，契约只读无法改）。校验语义不变，均已在代码注释说明 |
| D-10 | 看板与 `docs/reports/` 由编排方代 A00 更新 | 本会话没有独立的 A00 实体 |

## 6. 阻塞与待人工确认

（待 T12 返工与门禁加固合入后补齐；当前已知项：）

| 事项 | 需要的决定 |
|---|---|
| 契约样例补充的归属 | `docs/contracts/README.md` 第 33 行把「`batch.invalid.json` 信标 `auth` 非法样例」指派给 T10，但 T10 无权写契约。需决定由 A01 补（编排方可代行）还是授权执行 Agent 写契约文件 |
| `batch.invalid.json` case[4] 的 `_why` 与数据不符 | T10 复核发现：`_why` 称「维度值超过 256 字符」，实际该值为 1 字符，真实失败原因是键含大写 + 顶层未声明字段。属契约文件，需 A01 修正 |
| `export-rules` 规则文件的 Schema 未冻结 | K01-F5 导出的运行期校验规则（`schema_id`/`export_version`/`keep_versions`/`retention`）目前由工具自带并自校验，契约未规定。RR-22 是「可以」级且尚无接收方消费，建议暂不固化，等有接收方接入时走兼容追加 |
| `compat-pairs/index.json` 第 13 行 `verdict_zh` 措辞 | 未含判定表该行的附加说明（追加要求放在 `additional_requirements`）；T10 按 `startsWith` 归一化断言。属契约样例措辞，可由 A01 统一 |
| `remote-config.valid.json` 的 `_note` 措辞 | 称 `payload` 是「节选」，实为完整合法正文。属契约样例措辞 |
| T06/T22 的所有权扩展追认 | 见 D-5、D-6 |

## 7. 未执行项

以下检查本波**未执行**，不得视为通过：

- `pnpm test:e2e`（Playwright）：尚无用例，T29 才启用
- `pnpm gates:selftest`：本波未运行
- CI（`.github/workflows/ci.yml`）：本波未推送，首次流水线运行仍未验证
- K01 的 `--baseline-git` **未在真实多提交历史**（含 tag / 分支名 / 浅克隆）上验证：只用了临时 git 仓库 + `HEAD`；`snapshot.ts` 分支覆盖率 37.5%（git 失败等错误分支未构造用例）
- K01 `export-rules` 的规则文件格式未进契约（见第 6 节）
- M01 的 30 秒吞吐规格线未在门禁内断言（按第 1.4 节策略移交受控基准）
- T12 的 `api:update` / `api:check`：待其返工完成、公共 API 签名确认后一次性登记
- 飞书总体设计方案：本地无副本，未读；按指南第 1 节以契约与验收用例为准
