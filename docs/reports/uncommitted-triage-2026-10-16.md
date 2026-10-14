# 工作区未提交产物 · 接手分诊（2026-10-16）

> **这份记录存在的唯一目的**：让接手者**不必猜**这些未提交产物是什么、属于谁、能不能用。
> **不要在看到这份记录前执行 `git checkout` / `git stash` / `git clean`** —— 那会把判定依据一起清掉。

## 背景

- **CR-008（`sdk_health` 夹逼指标 + 观测发出点）连续两个 agent 失败**（`1590a718`、`a48b3be0`），
  **均无收尾报告** → 树里留下**两轮半成品**，**未经任何验证**。
- **AC-03 修复 lane（`85949b47`）也结束时没有报告** → 它留下的产物**同样未经验证**。
- **两个失败 + 一个无报告，出现在同一段时间里**，同期还有多条重测试 lane 并行 →
  **接手前请先确认机器空闲**（见 `docs/reports/handover.md` 第 10.6 条）。

## 未提交产物清单（`git status` 原样）

### A. 疑似 CR-008（**两轮叠加，未验证**）
契约：`docs/contracts/reason-codes.md`、`docs/contracts/receiver-requirements.md`、
`docs/contracts/schemas/builtin-events/sdk_health.schema.json`、
新增 `docs/contracts/changes/CR-008-squeeze-bounds-and-observables.md`
实现：`packages/transport/src/monitor/{adapters.ts,adapters.test.ts,index.ts,metrics.ts,reporter.ts,types.ts}`、
`tests/reliability/reconcile.mjs`
新增：`packages/transport/src/monitor/{observables.ts,cr008-emission.test.ts,cr008-observables.test.ts}`

### B. 疑似 AC-03 修复（**无报告，未验证**）
`packages/transport/src/sender/page-leave.ts`、`packages/transport/src/leader/leader.ts`、
`tests/e2e/beacon-quota.spec.mjs`、`tests/e2e/lib/beacon-receiver.mjs`、
`tests/e2e/probes/beacon-quota-{driver.js,html}`、`tests/e2e/results/beacon-quota-{chromium,webkit}.json`

### C. 变异残留（**不是产品代码，勿提交**）
`tests/e2e/probes/mutant-transport.js` —— 变异测试产物，会让 `eslint` 报空块/`DOMException`/未用变量。

## 已知的门禁红（**原因已判定，不要误判为真缺陷**）

1. `tests/e2e/probes/mutant-transport.js` 的 lint 错 → **C 类残留**，不属任何任务交付；
2. `tests/security/guard-e2e-receivers-validate-contract.test.ts` 红 →
   **D-06 那条守卫按设计在工作**：AC-03 新增的 `tests/e2e/lib/beacon-receiver.mjs` **是会接收批次的接收端但未登记**。
   **修法**：给它**加契约校验**，或**如实降级为"传输探针"并写进守卫清单的理由栏**（**不许加空校验糊过去**）。
3. `tests/e2e/beacon-quota.spec.mjs:62` 的 `no-useless-assignment` → B 类产物的 lint 问题。

## 接手建议顺序

1. **先确认机器空闲**；2. **逐项判定 A/B 的真伪与归属**（`page-leave.ts`/`leader.ts` 可能同时被两条 lane 碰过）；
3. **先处理第 2 条守卫红**（它是"新接收端未登记"，属于流程闭环，不是缺陷）；
4. **CR-008 请重新评估任务规模**——两轮失败提示它可能过大：建议**拆成两步**
   （先只做"契约追加 + 漂移锁定"，再做"实现发出点"），**每步单独设验收**；
5. **不要**把 B 类产物与 CR-008 混为一次交付。
