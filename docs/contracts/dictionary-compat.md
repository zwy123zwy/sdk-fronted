# 埋点字典兼容性规则（S03-F2）

- 版本：0.1（草案，未冻结）
- 对应任务：T06、T22

发布新的事件定义版本时，S03 按下表判断兼容性。破坏性变更必须递增 `schema_version`，并经数据负责人审批（S03-F3）；兼容变更也要递增 `schema_version`，但可以由应用负责人自行发布。

| 变更 | 判定 |
|---|---|
| 新增可选字段 | 兼容 |
| 新增必填字段 | 破坏性 |
| 删除字段 | 破坏性 |
| 修改字段 `type` 或 `kind` | 破坏性 |
| 可选改为必填 | 破坏性 |
| 必填改为可选 | 兼容 |
| `enum_values` 增加取值 | 兼容 |
| `enum_values` 删除取值 | 破坏性 |
| 放宽 `max_length`、`minimum`、`maximum` | 兼容 |
| 收紧 `max_length`、`minimum`、`maximum` | 破坏性 |
| 修改 `unit` | 破坏性 |
| 修改 `sensitivity` 为更严格的值（none → mask → hash → drop） | 兼容 |
| 修改 `sensitivity` 为更宽松的值 | 破坏性，另需安全负责人审批 |
| `priority` 由 normal 改为 critical | 兼容，需满足 Q3 的判定标准和配额 |
| `priority` 由 critical 改为 normal | 兼容 |
| 只修改 `description`、`trigger`、`owner` | 不递增版本 |

## 运行期校验（S04-F1）

- S04 按事件的 `event_name` + `schema_version` 查找定义，查不到时打 `unregistered` 标签后入库，并计入 S03 未登记事件清单（S03-F6）。
- 能查到定义时逐字段校验。必填字段缺失、类型不符、枚举值不在列表中，事件进入死信，原因码见 `reason-codes.md` 第 3 节。
- 定义中没有的字段：不进死信，丢弃该字段并计数 `unknown_field`。
- `status` 为 `retired` 的版本：事件进入死信，原因码 `schema_retired`；`deprecated` 照常入库并计数。
- 服务端至少保留每个事件最近 3 个 `schema_version` 的校验规则，保证未升级的客户端仍能入库。

## 类型包生成（S03-F4）

- 包名由 T08 决定，每次字典发布生成一个新的 semver 版本：兼容变更递增次版本号，破坏性变更递增主版本号。
- 对每个 `active` 状态的事件，生成其最新版本的类型：必填字段为必需属性，`enum` 生成字面量联合类型，`boolean` 维度生成 `boolean` 并由 SDK 序列化为字符串。
- 类型包只包含类型声明，运行时零代码。
