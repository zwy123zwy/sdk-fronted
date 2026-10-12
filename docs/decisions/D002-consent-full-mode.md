# D002 `consent_mode: full` 的设置位置

- 状态：已确认
- 确认人：wenye.zhang（项目负责人，2026-10-09 对话中授权 A01 决定）
- 确认日期：2026-10-10

## 问题

Q5 原方案中 `full` 模式“需要在控制台中由应用负责人确认”。D001 取消控制台后，这个确认环节没有落点。备选：

1. K02 签名时，配置中出现 `full` 必须带显式确认参数，否则拒绝签名；
2. `full` 只允许在初始化参数中设置，远程配置不接受 `full`。

## 结论

采用方案 2。

- `full` 只能写在接入方页面代码的初始化参数里；远程配置只能取 `essential_only` 或 `buffer`。
- SDK 收到远程配置中的 `full` 时忽略该字段并计数 `config_consent_mode_rejected`（`remote-config.md` 2.1）。
- `remote-config.schema.json` 中 `privacy.consent_mode` 去掉 `full`，K02 校验时自然拒绝。

## 理由

- 放宽采集范围是接入方的合规决定，应当出现在接入方自己评审、自己发布的代码里，留下代码评审记录；远程配置可以被少数人在发布流程外快速改动，不适合做放宽。
- 方案 1 的确认参数在 CI 里很容易被固定写进脚本，形同虚设；而且 SDK 无法从发布物判断签名时是否真的确认过。
- 远程配置仍然可以把 `full` 收紧为 `buffer` 或 `essential_only`，紧急情况下的收紧能力不受影响。

## 需要改的文档

- `docs/contracts/remote-config.md` 2.1、第 7 节；`schemas/remote-config.schema.json`；`examples/remote-config.invalid.json`（已完成）
- `docs/decisions/Q5-consent.md` 第 5 条加注“已被 D002 修订”（已完成）
- `tests/acceptance/C03.md`、`C04.md`、`K02.md` 对应用例（已完成）
- T34 接入指南：`full` 的说明中写明“只能在初始化参数中设置，需要接入方的法务确认”
