# `tests/pilot/` —— T33 试点的**前置就绪验证**（不是验收替代品）

> **定位（务必先读）**：本目录验证的是「**接入模板、对账口径、接收方自查清单本身是可执行的**」。
> 它**不是** T33 的验收替代品。T33 的验收标准仍是「**2 个试点应用在预发布环境完成接入与双写，
> 并连续 7 天完成三方对账（偏差 ≤1%）**」—— 那**需要 Q2**（真实应用名、对接人、预发布环境、
> 现有埋点清单）。**本目录里的任何绿色输出都不能当作「T33 已验收」的证据。**

- 任务：T33 中**不依赖 Q2** 的部分（Q2 未确认，T33 仍为「未就绪」）。
- 口径来源：`docs/decisions/Q2-pilot-apps.md`、`docs/decisions/Q6-migration.md`、
  `docs/contracts/receiver-requirements.md`、`docs/contracts/ingest-protocol.md`、
  `docs/reports/reliability-reconciliation.md`（T32 三类分列）。
- 事实清单：`docs/reports/t33-readiness.md`（验收项盘点）、
  `docs/reports/t33-access-blockers.md`（**阻塞点与文档缺陷**）、
  `docs/reports/t33-pilot-onboarding-kit.md`（接入方清单/模板 + Q2 交接函）。
- **本目录不在任何门禁 project 里**（根 `vitest.config.ts` 只含 `unit`/`contract`/`security`），
  故不影响 `pnpm gates`；用下面的命令直接跑。

## 脚本

| 脚本 | 作用 | 命令 | 本任务实测 |
|---|---|---|---|
| `00-connectivity.mjs` | 最小接入自检：装配 → init → setPage → track → flush → 查接收方计数 | `node tests/pilot/00-connectivity.mjs` | **exit 0**，7 项全 PASS |
| `10-three-leg-reconcile.mjs` | 三腿对账机械（腿①SDK 发送 / 腿②接收方去重后入库 / 腿③双写转发=未接入） | `node tests/pilot/10-three-leg-reconcile.mjs --repeat 3` | **exit 0**，偏差 `0.0000%` |
| `20-receiver-selfcheck.mjs` | 接收方自查（从 `receiver-requirements.md` 机械推导的可执行探针） | `node tests/pilot/20-receiver-selfcheck.mjs [--base-url … --token … --app-id … --config-path …]` | **exit 0**，PASS 7 / FAIL 0 / SKIP 4 |

前置：需要 `packages/browser/dist` 与 `tools/mock-receiver/dist`（新工作树先 `pnpm build`）。

## 三条**实测到的**硬约束（不遵守就会白折腾）

1. **端点路径是 `/v1/batch`**，不是指南第 8.3 节写的 `/ingest`（后者实测 404）。见阻塞点 **D-03**。
2. **必须 `client.setPage(...)`**：否则 SDK 产出 `common.page_id: null`，违反冻结契约
   （`commonFields.page_id` 是 `{type: string}`），严格接收方整批 400 拒收 → 入库恒为 0。见 **D-01**。
3. **不要在装配根上调 `client.onEvent()`**：它会让内部事件出口被替换，此后投递**全部静默失效**。
   见 **D-02**。

## 两条口径禁写规则

- **不得把空白读成达标**（T32 教训）：任一腿为 0 时，`10-three-leg-reconcile.mjs` 输出
  `不可判定` 且 **exit 1**，**不得**宣称「偏差 0% / 在 1% 内」。
- **三类分列不得合并**（D004）：脚本只演示「腿①↔腿②」的对账机械，**不产出任何丢失率结论**。

## 副作用提示

`pnpm examples:build` / `pnpm examples:test` 会**覆写** `tests/compat/results/webpack-*.json`
（T30 的已提交证据），变更仅限 `generatedAt` / 端口 / bundle 字节数等易变字段。
如需保持工作树干净，跑完后从 git 恢复这两个文件。

## 隐私与安全

本目录**只监听 127.0.0.1**、**只用明显假的占位值**
（`placeholder-write-token-0000`、`pilot-*` 应用名、`00000000-0000-4000-8000-…` 形态的占位 UUID），
**不含任何真实个人信息、令牌或密钥**。令牌一律从命令行传入，不得写进仓库。
