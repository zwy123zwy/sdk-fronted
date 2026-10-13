# Wave 2 交付报告

- 日期：2026-10-12 至 2026-10-13
- 范围：T19（C05-F5 APM 双写）、T25（K02 配置签名 CLI）、T10 追加项（用 Ajv 校验 SDK 真实产出）、T02（POC-1 投递可靠性）+ T02 追加轮（IndexedDB/OPFS 落盘窗口）
- 合入方式：每条 lane 一个 git worktree + 分支，由编排方复核后 `--no-ff` 合入 `main`
- 交付时 `main`：`b631ae9`（T02 追加轮合入后）→ 本文档随看板更新一起提交
- 门禁（实测）：**`pnpm gates` exit 0，44 个测试文件 / 581 个测试全部通过**；size-limit browser 6.14 kB / core 6.3 kB / plugins 642 B / transport 3.12 kB（均在预算内）；api:check 4 个包 ok；examples 全部通过

## 逐项交付

### T19 第三方 APM 双写适配器（C05-F5）

- 合入：`62dec1d`
- 交付：`packages/plugins/src/apm-dual-write/`（`createApmDualWritePlugin`）、`scripts/measure-apm-adapter.mjs`、`packages/plugins/README.md`（T33/T34 交接）
- 验收：C05-AC-15 至 AC-18 共 10 个测试通过
- 硬约束落实：**不 import 任何第三方包**（能力由接入方注入）、单向转发、零运行时依赖、顶层无副作用、未新增原因码（复用 `processor_error`）
- AC-18 实测：压缩 ESM + gzip(level 9) = **705 B** ≤ 1536 B；产物无裸模块说明符
- 编排方复核：范围合规；`vitest` / `tsc` / `eslint` 复跑通过；体积测量复现一致；`grep` 确认实现无第三方 import

### T25 K02 配置签名 CLI（K02-F1..F6）

- 合入：`f18355c`（首轮）+ 返工后同一提交序列
- 交付：`tools/config-signer/src/`（schema/validate/version/sign/verify/keys/signer-source/token-scan/errors/payload/cli）、`README.md`
- 验收：K02-AC-01 至 AC-09 共 **100 个测试**通过（注：任务卡只写到 AC-08，验收用例文件有 AC-09，按 9 条全做）
- 安全设计：私钥接触面收窄到 `signer-source.ts` 的 `local-file` 唯一分支；`Problem` 类型不含原始取值；`AC-08` 三层泄漏扫描（真实密钥材料字节扫描输出、`createPrivateKey` 实际解析判定仓库、`git ls-files -o` 差集）命中 0
- 编排方独立验证（用 build 产物跑真进程）：keygen 私钥权限实测 **600**、stdout/stderr 无任何私钥 PEM、envelope 结构正确且签名 **86 字符**、正确验签 exit 0、**篡改 payload exit 1**、`consent_mode: full` 输出含 **D002** 且 exit 1
- 编排方发现并追回一处对安全验收项的偏离：`32 位纯十六进制` 被当作「UUID 紧凑写法」放行（K02-AC-07 字面要求拦截）。返工后实测：无白名单 **exit 1**、加 `--allow-token-path` **exit 0 且 stdout 留痕**
- 另一处返工：`--previous` 需接受 `{decoded_payload}` 包装层（否则用仓库自带契约样例做基线会误报用法错误）

### T10 追加项：用 Ajv 校验 SDK 真实产出

- 合入：`19e441d`
- 交付：`tests/contract/lib/sdk-runtime.ts`、`sdk-core-output.test.ts`（14 用例）、`sdk-batch-output.test.ts`（5 用例）、`lib/schemas.ts` 增 `validateFragment`
- 契约测试 **169 → 188 条**；C01 事件产出过 `batch.schema.json#/$defs/event`（`web_js_error` 另过内置 Schema），C06 真实批次过完整 Schema
- **反向对照 9 处**（含把 T12 的历史违反注入真实产出）证明门禁会变红、不是空转
- 边界如实记录：批次层抓不到顶层 `app_id`（C06 投影会丢弃未声明字段）；`$defs/event` 抓不到 `web_js_error` 的语义缺失

### T02 POC-1 投递可靠性（+ 追加轮）

- 合入：`0e5d22d`（POC-1）+ `b631ae9`（追加轮）
- 交付：`docs/poc/POC-1.md`、`docs/poc/POC-1-storage.md`、`poc/poc-1/`（原型、复现命令、原始 JSON）
- **POC-1 结论触发 R02 升级**：`critical ≤0.1%` 在强杀场景下达不成——Chromium 与 Firefox 的 critical 预写在 SIGKILL 后 0–4000 ms **100% 未落盘**（Firefox 连 5000 ms 仍丢 20%），只有 WebKit 存活；其余场景（页面离开、断网、多标签页、优雅关闭）critical 丢失率均为 0%
- 处置：`docs/decisions/D003-critical-reliability-tiered-target.md`（负责人 2026-10-12 裁定：**目标分层 + 改设计**）
- **追加轮结论（决定性）**：把离线副本换成 **IndexedDB（显式事务，`oncomplete` 为落盘点）** 后，三引擎在 **Δt = 0 即 100% 存活**（每格 1000 条样本 × 3 次独立运行）→ **硬杀窗口消失**。OPFS 同样 Δt=0 即 100%（持久点是 `flush()` 而非 `close()`）；localStorage 基线复现 0–5 秒窗口。跨标签页并发写：IndexedDB 被覆盖 **0/1800**，localStorage 与「共享单文件 OPFS」各被覆盖 600–1200/1800
- **建议修订 D003 第 2 条**（硬杀不再只是 best-effort，改为按毫秒级暴露窗口计量 + 要求 T16 用 IndexedDB），待负责人批准

## 编排方在复核中纠正的问题

| # | 问题 | 处置 |
|---|---|---|
| 1 | T10 追加项报告称「`pnpm gates` 不含契约门禁」并据此推断 T12 的违反为何漏过 | **误报，无需改动**：`pnpm test` 跑 `unit` 与 `contract` 两个 vitest project，契约测试一直在 gates 内。T12 漏过的真因是当时契约测试**只校验样例、不校验产出**（已由本次追加项堵上） |
| 2 | `packages/browser/src/loading-stub.ts` 用 `root['console']` 间接访问规避 `no-console` | 经负责人批准，把已批准豁免由 1 个文件扩到 2 个（显式、可审计），并改回直接 `console.warn`（`try/catch` 保证沙箱无 console 时不抛错）。main `2bf074c` |
| 3 | T25 把 32 位纯十六进制当良性放行 | 要求返工为必须拦截（见上），白名单走 `--allow-token-path` |
| 4 | T02 追加轮首次把 WebKit 的 OPFS 写入失败误判为「OPFS 在 WebKit 上不可用」 | 查出根因是**沙箱阻塞了 WebKit 的写路径**（每次写入 `resolved=false`）；结论撤回，三引擎全部改为非沙箱重跑 |
| 5 | Firefox 一栏缺失，且 T02 判断「放开沙箱也不一定能解决」 | 编排方亲自在非沙箱 shell 跑出 Firefox 全部格子；并查出真因是 `run-firefox.sh` 导出的 `MOZ_FORCE_DISABLE_E10S` 等变量**破坏了 juggler 握手**（脚本已修正） |

## 偏差与待落实义务（已登记在 `docs/tasks/board.md`）

1. **T19 未给 `packages/plugins` 加 `@web-report-sdk/core` 依赖**，适配器依赖 C02 的结构子集（只有测试里的编译期结构赋值检查守护）。**T18 必须**加依赖并把 C05-AC-15..17 改为真实 `createKernel` 驱动，同时注册 `measure:apm-adapter` 脚本。
2. **K02-AC-03 的浏览器侧验签（Playwright Chromium）属部分实现**：K02 单测用 Node 24 全局 `crypto.subtle`（同一 W3C 路径）通过，浏览器侧已移交 **T29 的 E2E**，README 明确写「这一条不算通过」。
3. **POC 的环境口径偏离**：仓库锁定 `@playwright/test` 1.64.0，其要求的浏览器构建本机不存在；实际使用树外只读 `playwright-core@1.60.0` + chromium-1223 / firefox-1522 / webkit-2287。**T29 应在锁定版本上复测关键结论**（信标队列上限、IndexedDB 落盘窗口）。
4. **浏览器存储测量必须在非沙箱环境做**；本 harness 在 WebKit 上会泄漏辅助进程（随每个 profile 重启累积，实测一度数百个，导致一次运行卡死）。**T16/T29 复用该 harness 时应逐格清理浏览器进程**。
5. **未验证项（如实标注）**：`QuotaExceededError` 未构造出来（配额 ~19.6 GB）；POC-1 的页面离开/断网/多标签页选主场景**未用 IndexedDB 复测**；无痕模式、存储驱逐、真机 Safari 未覆盖。
6. **任务卡与验收用例不一致**：`docs/tasks/T25.md` 只列 AC-01..08，`tests/acceptance/K02.md` 有 AC-09；**A00 待修订**。
7. **契约变更请求未提交**：POC 建议新增的 C08 原因码（`beacon_rejected`、`flush_skipped_due_to_budget`、`prewrite_commit_lost`、`leader_lost`、`recovery_duplicate`）属 `reason-codes.md` 的兼容变更，**尚未提交请求**，报告中已标注为「未确定」。

## Wave 2 之后的建议范围

- **T16（C07）已解锁**（其唯一阻塞项 T02 已交付）。建议先由负责人就 D003 第 2 条的修订表态，再开 T16——存储层的选择会直接决定 T16 的离线副本设计与验收口径。
- T13 / T14 仍为「可领取」，两者都争用 `packages/core/src/index.ts`，建议串行。
- T18（内置采集插件）落地时一并完成上面第 1 条义务。
- T20 可承接 POC 给出的离开预算（≤48KB/≤200 条/≤4 批）与「重复 ≈1 倍 critical 流量」作为基准输入。
