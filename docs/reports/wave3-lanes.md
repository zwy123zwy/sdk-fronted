# Wave 3 交付报告（T16 / C07 传输与可靠投递）

- 日期：2026-10-13
- 范围：T16（C07 传输、重试、熔断、离线存储、补发、多标签页协调）
- 合入：`005a038`（实现提交 `63229a6`；其前置的体积预算调整 `10537cf`）
- 门禁（实测）：**`pnpm gates` exit 0，61 个测试文件 / 698 个测试**（Wave 2 收口时为 44 / 581；本任务净增 17 个测试文件 / 117 个用例）；size-limit transport **11.32 kB / 15 kB**、browser 6.14 kB、core 6.3 kB、plugins 642 B；api:check 四包 ok；examples 全过
- 覆盖率（门禁口径，`packages/transport/src/**`）：lines **92.54%**（阈值 90）、branch **80.16%**（阈值 80）

## 交付内容

新增（全部在任务卡授权的 `packages/transport/src/{sender,offline,leader}/` 内）：

- `offline/`：`types`、`constants`、`format`、`idb-backend`、`offline-store`、`index` + 8 个测试
- `sender/`：`types`、`constants`、`native`、`compress`、`policy`、`sender`、`page-leave`、`delivery`、`index`、`fixtures` + 8 个测试
- `leader/`：`leader`、`replay`、`index` + 2 个测试
- 装配层 `createDelivery`：把 C06 的 `BatchSubmitPort`、熔断信号、离线存储、补发、选主接起来

修改（均属开工前批准的 3 处越界）：`src/index.ts`（新增导出）、`etc/transport.api.md`（`api:update` 重新生成）、`README.md`（新增第 6 节：D004 落盘语义、原生引用调用点归 T18、非功能口径）

## 关键设计（依据 D004 与两份 POC 报告）

1. **离线副本用 IndexedDB，`IDBTransaction.oncomplete` 是唯一落盘点**：`runTransaction` 只在 `oncomplete` 里 resolve，`onerror` / `onabort` 一律 reject；`PrewriteHandle.settled` 在此之前保持 pending。**实现中零 `localStorage` 引用**（编排方独立 grep 确认：非注释出现 0 次）。
2. 双 store（`records` 全量 + `summaries` 摘要，避免启动读回全文）+ `meta`；100 条 / 200 ms 取先到者；**四上限同时生效**（5000 条 + 2000 批 + 5 MB + 7 天）且先淘汰 normal；配额失败先激进淘汰再重试一次，仍失败计 `storage_unavailable` 且不抛错；格式不兼容静默清理。
3. 发送器：`fetch` keepalive → XHR 降级；202 / 4xx / 413 / 429 / 5xx / 网络 / 超时分类；退避 1/2/4 s ±20%（429 取 `max(Retry-After, 本地)`）；连续 5 批失败熔断 5 分钟 + 半开单探测；401/403 独立暂停状态机（令牌或端点 revision 变化才恢复）；413 二分拆分（`event_id` 不变、`batch_id` 重生成）；>4 KB 才 gzip；终态丢弃用 `terminal` 标记让装配层删副本（否则 4xx 批次会无限补发）。
4. 离开通道：48 KB / 200 条 / 4 批预算 + 60 KB 切片 + `text/plain` + 令牌在 body `auth`；**beacon 的 `true` 与 keepalive 的 Promise 都不当送达信号**（POC 实测），只在常规 202 后删副本。
5. 补发：单批 ≤100 / 单轮 ≤500 / ≤2 批每秒 / 事件级 `replayed: true` / 失败指数退避并保留副本。
6. 选主：Web Locks 优先；BC 降级 **两轮 claim**（每轮 settle 钳到 ≥50 ms，两轮之间无额外延迟，合计 ≥100 ms）。
7. **CR-001 暴露窗口**：`intent` + `live` 心跳判定死亡会话，重启后对账出 `drop_prewrite_commit_lost` 与 `exposure_window_events` / `exposure_window_ms`；`events === 0` 时 `windowMs` 为 `null`（符合 Schema 的 `minimum: 1` 与「仅事件数 ≥1 时上报」）。

## 实现期发现并修掉的真问题

1. **离线存储的 `list/read/remove/markAttempt/clear` 未先 `await openInternal()`** → **重启后第一次 `list()` 返回空，补发会静默不工作**（由 AC-12 抓到）。这是「静默失效」类缺陷，若不修会表现为「补发功能上线后从不生效」。
2. **补发轮在最后一批之后白等一个限速间隔** → 一轮被拖长 1 秒。
3. **BC 选主单轮 claim 的真实缺陷**：单轮时「在开窗之后才加入」的标签页收不到更早的 claim，会误判自己当选（假总线测试直接抓到 3 个 leader）。真实 `BroadcastChannel` 没有历史消息，**该缺陷在生产同样存在** → 改为两轮 claim。这**不算偏差，属正确性修复**。

## 编排方独立复核（不只信汇报）

| 复核项 | 结果 |
|---|---|
| 范围合规 | 仅 `src/{sender,offline,leader}/` + 已批准的 3 处越界；未动 T15 的 `src/queue/**`、`tests/acceptance/**`、门禁配置、契约 |
| D004 硬要求：离线实现不得用 `localStorage` | 非注释引用 **0 次**（我自行 grep 验证，未依赖其自述） |
| 落盘点是否唯一 | `runTransaction` 只在 `tx.oncomplete` 中 resolve；`onerror`/`onabort` 均 reject |
| 禁用写法 | `: any`、`as any`、`@ts-ignore`、`@ts-expect-error`、`eslint-disable`、`skip`、`.only(` **全为 0** |
| 负向对照是否为真对照 | `neverCommitting()` **装饰真实 IndexedDB 后端**，只把 `commit` 换成永不 resolve 的 Promise；文件头写明真实浏览器版（延迟提交 + SIGKILL + 重启）归 T29 |
| 门禁 | 我在其工作树内跑**完整 `pnpm gates`** → exit 0（含 contract project、其它包、size、api:check、examples） |

## 体积预算决定（需记录的口径问题）

- **我先纠正了报告口径**：任务执行方报的「15.81 KB」是 **tsup 未压缩原样产物**，与门禁口径（`import: "*"` + minify + brotli）不可比。用真正的门禁实测为 **11.32 kB / 10 kB，超 1.32 kB**（不是 5.8 kB）。
- 负责人裁定：**transport 预算由 10 KB 提到 15 KB**（为 C08/T17 留余量），**不砍功能**（暴露窗口可观测性由 D004 要求，重试/熔断/暂停/双通道/选主由契约与 AC 要求）。已落到 `.size-limit.json` 与指南第 6 节（顺带补上指南原本缺失的 transport 一行与口径说明）。
- **待重定（触发条件已登记看板）**：C07 装配进浏览器包后，必须重新测 **`browser` 的 10 KB 预算**——最终面向接入方的是 browser 包，它目前 6.14 kB 且尚未包含 C07。

## 未执行 / 未验证（如实声明）

**全部真实浏览器行为归 T29**，本任务未在单测中冒充：

1. AC-03（真实 80 KB 信标）、AC-13（真实 `sendBeacon`）、AC-15（真实 `visibilitychange`）、AC-17（真实 3 标签页接管）、AC-18（真实无 Web Locks）；
2. **真机 IndexedDB 的 `oncomplete` 持久性与 SIGKILL 后的读回**（D004 的核心承诺；POC 追加轮已在真实浏览器上验证「Δt=0 即持久」，但**未在 `packages/transport` 的实现上复测**）；
3. 真实 `QuotaExceededError`（POC 与本次均未构造出来，配额 ~19.6 GB）；
4. `versionchange` / 连接被更高版本关闭；`bfcache` 恢复；令牌吊销的真实链路；
5. 真实 XHR 与真实超时（`AbortController` 触发）；`fetch keepalive` 的真实约 6 批上限；
6. `split_413` 的 8 层深度上限只有守卫代码、无用例。

**`fake-indexeddb` 的边界**：它只用于**逻辑**验证（`oncomplete` 才 resolve、`abort` 不可见、`VersionError`），不得作为真实持久化证据；该分工已写入 `offline/prewrite.test.ts` 文件头。

## 遗留交接义务

1. **T18（C05）**：在装配根、安装任何插件之前调用一次 `captureNativeHttpRefs()`（幂等、只捕获一次、捕获后冻结）；**C05 插件不得在自己 `install()` 里捕获**。T16 已提供该函数并定义冻结注入契约。
2. **T29**：上列 6 项真实浏览器验证；并把「真机 IndexedDB 上 `oncomplete` 是唯一落盘点」作为 D004 承诺的复测项。
3. **T31 或后续仓库级守卫**：把「离线实现不得引用 `localStorage`」做成 `tests/` 下的**永久自动化守卫**（编排方本轮用 grep 人工验证过一次，但尚未固化为测试）。注意 `packages/transport/tsconfig.json` 是 `types: []`（纯浏览器包），`node:fs` 在该包内无类型，因此该守卫只能放在 `tests/` 下。
4. **T17（C08）**：承接 `DeliveryMetrics.lastReplayReason` 与 CR-001 的两个指标上报。
5. **接收方看板**：CR-001 的新原因码与指标需接收方同步（不在本项目内）。
