# K01 事件注册表与类型生成 CLI

`@web-report-sdk/event-registry`（任务 T22，需求 K01-F1 至 K01-F6）。

接入方在自己仓库的 `events/*.json` 中维护事件定义；本工具在接入方 CI 中做格式与兼容性检查，
生成 TypeScript 类型声明（含投递等级），并导出可供接收方使用的运行期校验规则。
K01 只读注册表，不修改任何接入方仓库，也不访问网络。

- 元模型：`docs/contracts/schemas/event-definition.schema.json`（契约 0.2，冻结）
- 兼容性判定表：`docs/contracts/dictionary-compat.md`（契约 0.2，冻结）
- 验收用例：`tests/acceptance/K01.md`（K01-AC-01 至 K01-AC-12）
- 样例注册表：`examples/event-registry/`

## 1. 运行方式

包内 `bin`：`web-report-event-registry`（构建产物 `dist/cli.js`）。

```bash
pnpm --filter @web-report-sdk/event-registry run build
node tools/event-registry/dist/cli.js --help

# 接入方以 npm 依赖方式引入后：
web-report-event-registry check --registry events/*.json
```

## 2. 子命令

| 子命令 | 需求 | 作用 | 退出码 |
|---|---|---|---|
| `check` | K01-F1、F2、F3 | 按契约 Schema 校验、critical 配额检查、可选兼容性对比 | 0 / 1 / 2 |
| `generate` | K01-F4 | 生成 TypeScript 类型声明（只含 `active` 事件的最新版本） | 0 / 1 / 2 |
| `export-rules` | K01-F5 | 导出接收方运行期校验规则 JSON（每个事件保留最近 3 个版本） | 0 / 1 / 2 |
| `report-unregistered` | K01-F6 | 报告清单中未登记的事件及出现次数 | 0 / 1 / 2 |

### 2.1 check

```bash
# 只做校验 + 配额检查
web-report-event-registry check --registry events/*.json

# 在 CI 中对比 git 基线（破坏性变更默认拦截）
web-report-event-registry check --registry events/*.json --baseline-git origin/main

# 已获数据负责人批准时放行"已递增版本的破坏性变更"
web-report-event-registry check --registry events/*.json --baseline-git origin/main --allow-breaking
```

check 会做四类判定：

1. **Schema 校验**：按 `event-definition.schema.json` 0.2，用 Ajv 2020 校验每个 `.json` 文件。
   失败时退出码 1，错误信息包含**文件路径与字段路径**（JSON 指针，如 `/fields/0/enum_values`）。
2. **注册表级检查**：同名同版本重复定义（K01-AC-07）、metric 字段名后缀与 `unit` 一致
   （契约 `unit` 描述：`_ms`、`_bytes`、`_ratio`）。
3. **critical 配额**：`critical` 事件名数 ≤ 事件名总数 × 10%（K01-F3、Q3 结论）。
   分母按**事件名去重**，多版本不重复计数。
4. **兼容性**：提供基线时，按 `dictionary-compat.md` 判定表逐行判定；报出规则表行号。

### 2.2 generate

```bash
web-report-event-registry generate --registry events/*.json --out src/generated/events.ts
```

省略 `--out` 时写到标准输出。生成物只含类型声明与一份纯字面量注册表常量，运行时零逻辑。

### 2.3 export-rules

```bash
web-report-event-registry export-rules --registry events/*.json \
  --out dist/rules.json --registry-name demo-app --keep-versions 3
```

输出符合工具自带的规则 Schema（`schema_id = urn:web-report-sdk:k01:runtime-validation-rules:1`，
JSON Schema 2020-12）。默认每个事件保留最近 3 个 `schema_version`，保证未升级的客户端仍能入库
（`dictionary-compat.md` 运行期校验）。

### 2.4 report-unregistered

```bash
web-report-event-registry report-unregistered \
  --registry events/*.json --events observed-events.jsonl
```

清单支持三种写法：JSON 数组、JSONL（每行 `{"event_name":"..."}`）、每行一个事件名。
这是报告类命令，**始终返回退出码 0**（除用法/文件错误）：未登记事件照常入库，由接收方决定处理方式
（`event-standard.md`）。

## 3. 选项

| 选项 | 适用命令 | 说明 |
|---|---|---|
| `--registry <路径>` | 全部 | 目录、glob（`events/*.json`）或单个文件；默认 `events/*.json` |
| `--cwd <目录>` | 全部 | 工作目录；`--registry`、`--baseline-dir` 与 git 仓库都相对它解析 |
| `--baseline-dir <目录>` | check | 兼容性基线：一份基线注册表快照目录 |
| `--baseline-git <引用>` | check | 兼容性基线：git 引用（`HEAD`、`main`、commit-ish）。只执行只读 git 命令 |
| `--allow-breaking` | check | 放行"已递增版本的破坏性变更"；**不放过**未递增版本（K01-AC-05） |
| `--schema <文件>` | check | 用自带的 JSON Schema 2020-12 文件替换内置元模型 |
| `--out <文件>` | generate、export-rules | 输出文件；自动创建父目录 |
| `--events <文件>` | report-unregistered | 事件名清单 |
| `--keep-versions <数量>` | export-rules、report-unregistered | 保留版本数，1–10，默认 3 |
| `--registry-name <名称>` | export-rules、report-unregistered | 写入报告的注册表名称，默认 `workspace` |
| `--help` | 全部 | 用法 |

`--baseline-dir` 与 `--baseline-git` 互斥。

## 4. 退出码约定

| 退出码 | 含义 |
|---|---|
| `0` | 命令成功（含 `report-unregistered` 的报告结果、`check` 未发现问题） |
| `1` | 检查未通过：Schema 校验失败、同名同版本、critical 配额超限、兼容性破坏性变更、未递增 `schema_version` |
| `2` | 用法或运行环境错误：未知子命令/参数、缺参数、注册表或基线或清单不可读、`--baseline-git` 不在 git 仓库内 |

CI 里建议只判断"非 0 即失败"；需要区分时按上表处理。

错误信息格式：

```
K01 check 失败：2 个问题
  - schema_not：events/web_custom_click.json 字段路径 /event_name —— /event_name 取值不符合约束：{"pattern":"^(sdk|web)_"}
  - no_version_bump：events/checkout_order_complete.v2.json（事件 checkout_order_complete） —— 事件 checkout_order_complete 的定义相比基线发生变化，但 schema_version 仍是 1；修改了字段就必须递增 schema_version（dictionary-compat.md、K01-AC-04）
```

## 5. 生成类型的接入方式（T12 / T34 交接约定）

生成的 `.ts` **只含类型声明**，没有任何运行期值导出、表达式或副作用，可以被完全擦除。
接入方自己提交或发布这个文件（契约不要求本项目发布类型包）。

```bash
web-report-event-registry generate --registry events/*.json --out src/generated/events.ts
```

本节的形状与约定是与 T12（C01 公共 API）对齐的接口约定，改动前需先汇报。

### 5.1 生成物的确切形状

`EventDefinitions`（事件名 → 事件定义）是给 `createClient<TDefinitions>()` 的字典；
每个事件定义含**字面量** `priority`、**字面量** `schema_version`，以及 `dimensions` / `metrics`
两个「字段名 → `FieldSpec`」的映射。

```ts
/** 一个字段的规格：值类型 + 是否必填。 */
export interface FieldSpec<TValue, TRequired extends boolean> {
  readonly type: TValue;
  readonly required: TRequired;
}

/** 事件名 -> 事件定义（给 createClient<TDefinitions>() 的字典形状）。 */
export type EventDefinitions = EventRegistry;

/** 事件名 -> 类型条目。 */
export type EventEntry<Name extends EventName> = EventRegistry[Name];

/** 已登记的事件名（active 事件的最新版本）。 */
export type EventName = keyof EventRegistry;

/** 某个事件的负载类型（直接从字典推导，供 track<TName>(name, input) 用）。 */
export type EventPayload<Name extends EventName> = EventPayloadShape<
  DimensionsPayload<Name>,
  MetricsPayload<Name>
>;

/** 每个事件一个条目接口，事件名是接口里的字面量键。 */
export interface EventRegistry {
  'checkout_order_complete': CheckoutOrderCompleteEntry;
  // ...
}

export interface CheckoutOrderCompleteEntry {
  readonly priority: 'critical';        // 投递等级字面量（Q3：调用时不能改）
  readonly schema_version: 3;           // 事件定义版本字面量
  readonly dimensions: {
    order_type: FieldSpec<'normal' | 'group' | 'presale', true>;  // enum -> 字面量联合
    channel: FieldSpec<string, true>;                              // 必填
    buyer_ref?: FieldSpec<string, false>;                          // 可选
  };
  readonly metrics: {
    amount_ratio: FieldSpec<number, true>;                         // 指标 -> number
    item_count?: FieldSpec<number, false>;
  };
}
```

字段规格与 `event-definition.schema.json` 的对应关系：

| 事件定义里的字段 | 生成物 |
|---|---|
| `kind: dimension` | 进入 `dimensions` |
| `kind: metric` | 进入 `metrics` |
| `type: string` | `FieldSpec<string, ...>` |
| `type: enum` + `enum_values` | `FieldSpec<'a' \| 'b', ...>`（字面量联合，取值集合不外泄） |
| `type: boolean` | `FieldSpec<boolean, ...>`（SDK 序列化时写成字符串） |
| `type: integer` / `number` | `FieldSpec<number, ...>`（指标） |
| `required: true` | `FieldSpec<..., true>`，且属性本身为必需属性 |
| `required: false` | `FieldSpec<..., false>`，且属性带 `?` |
| `priority` | 条目上的 `'normal' \| 'critical'` 字面量 |
| `schema_version` | 条目上的数值字面量 |

`sensitivity`、`unit`、`min/max`、`max_length` 不进入字典类型（它们是接收方脱敏与运行期校验用的），
完整信息在 `export-rules` 的 JSON 里。

### 5.2 可选性约定（消费侧必读）

| 事件定义 | 生成物 | 语义 |
|---|---|---|
| `required: true` | `字段名: FieldSpec<T, true>`（**没有 `?`**） | 属性必需 + `required` 元数据为 `true` |
| `required: false` | `字段名?: FieldSpec<T, false>`（**带 `?`**） | 属性可选 + `required` 元数据为 `false` |

**消费侧投影必填/可选时，请用 TypeScript 标准的属性可选性探测，不要直接索引 `required`。**
原因：本项目与 T12 都开启 `noUncheckedIndexedAccess`，可选属性被索引后会带上 `| undefined`，
`TFields[K]['required'] extends true` 这类判断会失真（可选字段被误判成必填，负载字段类型被推成 `never`）。
正确写法任选其一：

```ts
// 写法 A：属性可选性投影（推荐，不依赖索引）
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];

// 写法 B：直接用生成文件导出的辅助类型（已处理 NonNullable）
type Required = PickRequired<EventEntry<'checkout_order_complete'>['dimensions']>;
type Optional = PickOptional<EventEntry<'checkout_order_complete'>['dimensions']>;
```

### 5.3 生成文件导出的类型与用途

| 导出 | 用途 |
|---|---|
| `EventRegistry` | 事件名 → 事件条目的接口（字面量键）；字典的事实来源 |
| `EventDefinitions` | `EventRegistry` 的别名，语义化名字，直接传给 `createClient<TDefinitions>()` |
| `EventName` | 已登记事件名的字面量联合（`keyof EventRegistry`）；拼错 / 未登记 / 保留前缀都会编译失败 |
| `EventEntry<Name>` | 某个事件的条目类型；读 `priority`、`schema_version`、`dimensions`、`metrics` |
| `FieldSpec<TValue, TRequired>` | 单个字段的规格：`readonly type: TValue` + `readonly required: TRequired` |
| `EventPayloadShape<Dimensions, Metrics>` | 负载的通用外形（`dimensions` + `metrics`） |
| `EventPayload<Name>` | 某个事件**可直接传给 SDK** 的负载类型（必填字段必需、可选字段带 `?`）——`dictionary-compat.md`「必填字段为必需属性」的落点 |
| `RequiredFieldNames<TFields>` | 从字段规格映射里取出必填字段名（已用 `NonNullable` 处理可选属性） |
| `OptionalFieldNames<TFields>` | 取出可选字段名 |
| `PickRequired<TFields>` | 只保留必填字段并去掉 `FieldSpec` 包装，得到可直接写值的形状 |
| `PickOptional<TFields>` | 只保留可选字段（带 `?`）并去掉 `FieldSpec` 包装 |
| `DimensionsPayload<Name>` / `MetricsPayload<Name>` | `PickRequired & PickOptional` 的组合，供 `EventPayload` 与消费侧复用 |
| `FieldSpecMap` | `Record<string, FieldSpec<unknown, boolean>>`，上面几个工具类型的约束 |

生成文件里**没有任何运行期值导出**（可自行 `grep -c "export const\|export function" generated/events.ts`）。

### 5.4 被 `createClient<TDefinitions>()` 消费

```ts
import type {
  EventDefinitions,   // 传给 createClient 的字典
  EventName,
  EventEntry,
  EventPayload,
} from './generated/events.js';

// T12 的消费侧契约：createClient<TDefinitions>() / track<TName>(name, input)
const client = createClient<EventDefinitions>({ appId: 'demo-app' });

// 事件名是字面量联合：拼错、未登记、保留前缀（sdk_/web_）都会编译失败
client.track('checkout_order_complete', {
  dimensions: { order_type: 'normal', channel: 'wallet' },
  metrics: { amount_ratio: 1 },
});

// 投递等级与 schema_version 是字面量，业务代码不能在调用时改变等级（Q3）
type Entry = EventEntry<'checkout_order_complete'>;
type Priority = Entry['priority'];          // 'critical'
type Version = Entry['schema_version'];     // 3
type Payload = EventPayload<'checkout_order_complete'>;

const bad: EventName = 'checkout_order_completed';        // 编译错误：未登记
const missing = { dimensions: { order_type: 'normal' } }; // 编译错误：缺 channel / amount_ratio
const wrongEnum: Payload = {                              // 编译错误：enum 取值不在列表
  dimensions: { order_type: 'refund', channel: 'wallet' },
  metrics: { amount_ratio: 1 },
};
```

这些"正确编译通过 / 错误必须报错"的样例就是 K01-AC-08 的自证：见
`src/__tests__/generate.test.ts` 的 `ADMISSIBLE_TYPES` 与 `REJECTED_TYPES`（每一项只违反一条规则），
测试会起子进程用 `tsc --noEmit` 编译并断言退出码。

## 6. 兼容性判定（K01-F2）

判定表来自 `dictionary-compat.md` 0.2，工具逐行实现，**不自行放宽**；判定与契约不一致时必须升级给 A01。

| 行 | 变更 | 判定 | 工具输出 |
|---|---|---|---|
| 1 | 新增可选字段 | 兼容 | `field_added_optional`，compatible |
| 2 | 新增必填字段 | 破坏性 | `field_added_required`，breaking |
| 3 | 删除字段 | 破坏性 | `field_deleted`，breaking |
| 4 | 修改字段 `type` 或 `kind` | 破坏性 | `field_type_or_kind_changed`，breaking |
| 5 | 可选改为必填 | 破坏性 | `optional_to_required`，breaking |
| 6 | 必填改为可选 | 兼容 | `required_to_optional`，compatible |
| 7 | `enum_values` 增加取值 | 兼容 | `enum_values_added`，compatible |
| 8 | `enum_values` 删除取值 | 破坏性 | `enum_values_removed`，breaking |
| 9 | 放宽 `max_length`/`minimum`/`maximum` | 兼容 | `bound_widened`，compatible |
| 10 | 收紧 `max_length`/`minimum`/`maximum` | 破坏性 | `bound_tightened`，breaking |
| 11 | 修改 `unit` | 破坏性 | `unit_changed`，breaking |
| 12 | `sensitivity` 改为更严格（none → mask → hash → drop） | 兼容 | `sensitivity_stricter`，compatible |
| 13 | `sensitivity` 改为更宽松 | 破坏性（另需安全负责人批准） | `sensitivity_looser`，breaking |
| 14 | `priority` 由 normal 改为 critical | 兼容（需满足 Q3 与配额） | `priority_changed`，compatible |
| 15 | `priority` 由 critical 改为 normal | 兼容 | `priority_changed`，compatible |
| 16 | 只修改 `description`、`trigger`、`owner` | 不递增版本 | `metadata_*`，info |

版本规则（契约正文）：

- 破坏性变更必须递增 `schema_version`，并由接入方数据负责人在代码评审中批准；
  `check` 默认返回退出码 1，`--allow-breaking` 只放行这种情况。
- 兼容变更**也要**递增 `schema_version`。
- 只修改 `description`/`trigger`/`owner` 不需要递增版本。
- 改了字段却没有递增 `schema_version`：**`--allow-breaking` 也不放行**（K01-AC-04）。

对比口径：以事件在"新快照"中的最高版本与"基线快照"中的最高版本做行级对比；新快照里保留的历史版本
不参与判定（K01 要能同时服务未升级的客户端）。

## 7. 目录结构

```
tools/event-registry/
  README.md                      本文件
  package.json                   bin: web-report-event-registry（dist/cli.js）
  src/
    index.ts                     对外导出（纯函数与类型）
    cli.ts                       子命令、参数解析、输出与退出码
    definitions.ts               元模型（与契约 0.2 一致）、Ajv 2020 校验、配额、语义规则
    registry.ts                  注册表加载、glob 展开、同名同版本检查
    compat.ts                    兼容性判定表实现与报告渲染
    generate.ts                  TypeScript 类型声明生成
    rules.ts                     运行期校验规则导出 + 自带规则 Schema
    unregistered.ts              未登记事件报告
    snapshot.ts                  基线快照（--baseline-dir / --baseline-git）
    __tests__/                   K01-AC-01…AC-12 用例与示例注册表回归用例
```

## 8. 依赖与约束

- 只用 Node 内置模块，加一个**已批准**的根开发依赖 `ajv`（8.20.0，`ajv/dist/2020` 的 `Ajv2020`）。
  校验走真正的 JSON Schema 校验器，没有手写关键字子集。
- 工具不依赖 git 之外的网络能力；`--baseline-git` 只执行 `git rev-parse`、`git ls-tree`、`git show`。
- 不使用 `class`、`any`、`@ts-ignore`、`eslint-disable`。
- 代码、样例、日志中不写真实个人信息、令牌或密钥；示例注册表全部使用占位值。
- 与契约 0.2 的一致性由 `src/__tests__/definitions.test.ts` 与兼容样例对用例守护。

## 9. 测试

```bash
pnpm exec vitest run --coverage.enabled=false tools/event-registry
pnpm exec tsc -p tools/event-registry/tsconfig.json
pnpm exec eslint tools/event-registry
```

用例编号与需求对应：`K01-AC-01`、`02`、`06`、`07` 见 `definitions.test.ts`；
`K01-AC-03`、`04`、`05` 见 `compat.test.ts`；`K01-AC-08`、`09`、`10` 见 `generate.test.ts`；
`K01-AC-11`、`12` 与全部子命令的退出码见 `cli.test.ts`；示例注册表回归见 `examples.test.ts`。
