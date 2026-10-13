# CR-003 新增原因码 `config_schema_invalid` 与明确 `sdk_versions` 的 semver 语法子集

- 状态：**已批准（2026-10-13）**，已应用到 `reason-codes.md`、`schemas/builtin-events/sdk_health.schema.json`、`remote-config.md`、`tests/acceptance/C03.md`
- 起草人：A01（编排方代行）；起草日期：2026-10-13
- 来源：T13（C03 配置合并/采样/kill switch）实施计划的契约疑问 Q1 与 Q13（均被 T13 标为**硬阻塞**）
- 流程依据：`docs/contracts/README.md`「契约冻结后，修改走契约变更请求：A01 起草，架构负责人批准」

## 1. 两个契约空白

### Q1：「合法 JSON 但不符合 Schema」没有原因码

`reason-codes.md` 第 2 节的 `config_parse_failed` 定义是「发布物或正文**不是合法 JSON**」。而实际失败形态有两种，修法完全不同：

| 失败形态 | 真实原因 | 修法 |
|---|---|---|
| 不是合法 JSON | 发布流水线坏了（截断、编码错） | 修流水线 |
| 合法 JSON 但不符合 `remote-config.schema.json` | 字段名/类型/取值写错 | 修配置内容 |

用同一个码会让接收方看板无法区分，也会让 `config_parse_failed` 的描述变成假话。

### Q13：`sdk_versions` 的 semver 语法边界未定义

`remote-config.md` 5.1 节只给了 `>=2.3.0 <2.3.2` 一个例子，未列支持范围。而 SDK 是**零依赖实现**，必须自己解析：边界不明确则配置作者不知道能写什么、实现者不知道要支持什么；更危险的是**遇到无法求值的规则时若静默忽略，一条 kill switch 会被当作"不命中"**——那正是 kill switch 最不能出错的方向。

## 2. 精确改动

### 2.1 `reason-codes.md` 第 2 节新增一行（只计数）

| 原因码 | 环节 | 说明 | 验收用例 |
|---|---|---|---|
| `config_schema_invalid` | C03 | 发布物或正文是合法 JSON 但不符合 `schemas/remote-config.schema.json`（含使用了 `remote-config.md` 5.1 节未列出的 semver 范围语法） | **C03-AC-24（新增）** |

计数形态按第 2 节既有约定：`count_config_schema_invalid`。置于第 2 节（只计数）而非第 1 节，因为配置被拒后事件仍照常走保守默认，**没有任何事件被丢弃**。

### 2.2 `schemas/builtin-events/sdk_health.schema.json`

把 `config_schema_invalid` 加入 `metrics` 的 `^count_(…)$` 的 `patternProperties`（该 Schema 的 `metrics` 是 `additionalProperties: false`，不同步扩充会导致 SDK 自监控事件被自己的契约拒绝——与 CR-001 同一坑）。

### 2.3 `remote-config.md` 5.1 节新增「`sdk_versions` 支持的 semver 语法子集」

明确支持：精确版本、比较符（`>` `>=` `<` `<=`）、合取（空格）、析取（`||`）、脱字符 `^`、波浪号 `~`、通配（`1.2.x` / `1.x` / `*`）。版本字符串为 `major.minor.patch` + 可选 `-prerelease`（按 semver §11 优先级），`+build` 忽略。

明确**不支持**：连字符区间（`1.2.3 - 2.0.0`）、范围表达式中的预发布标识（`>=1.2.3-beta.1`）、以及表外任何语法。**出现即整份配置计 `config_schema_invalid` 并退回保守默认，不得静默忽略**。该子集同样适用于 `overrides[].sdk_versions`。

### 2.4 `tests/acceptance/C03.md` 新增 `C03-AC-24`

> 发布物/正文是合法 JSON 但不符合 `remote-config.schema.json`（另测 `sdk_versions` 用了不支持的语法）→ 整份配置被拒绝并退回保守默认；计数 `config_schema_invalid`；**不得静默忽略该字段后继续使用其余配置**。

同时把 `docs/tasks/T13.md` 的验收范围更新为 AC-01..AC-24。

### 2.5 版本记录

按「原因码：新增原因码 = 兼容变更」处理，标注「0.2（兼容追加）」、**不递增文档版本号**（沿用 CR-001/CR-002 先例）。

## 3. 兼容性判定

| 判据 | 本次改动 | 结论 |
|---|---|---|
| 原因码 | 新增 1 个，未删除、未改既有码语义（`config_parse_failed` 保持"非合法 JSON"） | 兼容 |
| 事件 Schema | `metrics` 的 `count_` 模式新增 1 项 | 兼容 |
| 接收方 | 新增一个只计数原因码 + 一个 `sdk_versions` 语法边界说明；不改变任何既有字段语义 | 兼容，但**接收方看板可选增加一列** |
| 配置作者（发布侧） | 明确了能写与不能写的语法；**不支持语法的配置今后会被整份拒绝**（此前行为未定义，无既有配置受影响） | 兼容 |

## 4. 备选方案与取舍

| 方案 | 优点 | 代价 |
|---|---|---|
| **新增码 + 明确语法**（采纳） | 看板可区分两种失败，修法明确；kill switch 的不可求值语法**响亮失败**而非静默不命中 | 契约多一个码，需新增一条验收用例 |
| 放宽 `config_parse_failed` 的描述 | 少一个码 | 诊断粒度降低；且仍要改契约（描述是冻结文本），省不下流程成本 |
| 不改契约、由 C03 自定 | 零流程成本 | 契约与实现不一致；配置作者无法从契约得知 semver 边界，而这正是 kill switch 最不能含混的地方 |

## 5. 批准记录

| 角色 | 姓名 | 结论 | 日期 |
|---|---|---|---|
| 起草 | A01（编排方代行） | 提交草案（来源：T13 计划的 Q1/Q13） | 2026-10-13 |
| 架构负责人 | wenye.zhang | **批准**（按兼容变更处理，不递增文档版本号） | 2026-10-13 |

批准后的落地情况：

- [x] `reason-codes.md` 第 2 节新增 `config_schema_invalid`；变更记录新增一行；
- [x] `schemas/builtin-events/sdk_health.schema.json` 的 `count_` 模式同步扩充；
- [x] `remote-config.md` 5.1 节新增 semver 语法子集表与「不支持即整份拒绝」的规则；
- [x] `tests/acceptance/C03.md` 新增 `C03-AC-24`；`docs/tasks/T13.md` 验收范围更新为 AC-24；
- [x] `docs/contracts/README.md` 状态表标注；`docs/review-log.md` R-015 留档；
- [ ] 接收方看板可选增加 `config_schema_invalid` 一列（不在本项目内）。
