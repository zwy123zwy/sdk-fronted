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

---

# T17（C08 自监控与调试模式）

- 合入：`51a1c56`（实现提交 + 体积预算调整 `36f8767`）
- 门禁（实测）：**`pnpm gates` exit 0，73 个测试文件 / 806 个测试**（T16 收口时 61 / 700；本任务净增 12 个文件 / 106 个用例）
- 覆盖率（门禁口径）：`packages/transport/src/**` 行 91.21% / 分支 83.65%；新目录 `monitor` 97.23 / 92.3、`debug` 98.36 / 95.65
- 体积：transport **14.82 kB / 18 kB**（C07 基线 11.32 kB，C08 净增约 3.5 kB）

## 交付内容

新增（均在授权范围内，未改他人代码）：

- `packages/transport/src/monitor/`：`types`、`reason-codes`、`metrics`、`events`、`latency`、`instrument`、`adapters`、`reporter`、`traffic`、`index` + `fixtures` + 10 个测试
- `packages/transport/src/debug/`：`types`、`gate`、`format`、`tracer`、`index` + 2 个测试
- 已批准的三处越界：`src/index.ts`（两个 `export`）、`etc/transport.api.md`、`README.md` 第 7 节

能力：计数映射（`drop_*`/`count_*`/8 个固定计数/暴露窗口/三个 p99，0 值不上报、契约外键不上报、**>50 自动分片**）；1% 会话采样 + nearest-rank P99；60 秒 reporter（注入 `now`/`timer`）；装饰器（`createCallCounter`/`wrapCalls`/`wrapPipeline`）；调试门禁（URL 参数 + 非生产/白名单）与逐条去向输出。

## 契约自证（本任务最值得记的一条）

`monitor/contract.test.ts` **直接 import `docs/contracts/schemas/` 下的真实 Schema**（不是副本），用 Ajv 校验**每一条真实产出**的 `sdk_health` 事件（同时用 `batch.schema.json#/$defs/event` 校验），并含 **10+ 条负向对照**（计数为 0、契约外指标键、`state` 非枚举、`priority` 非 `normal`、metrics 超 50、缺 `window_ms`、`exposure_window_events:0`、`exposure_window_ms:0`）与一条**「校验器非空转」**对照。

`dependentRequired` 四方向实测：ms 单独→**拒绝**、ms+events→合法、仅 events→合法、events=0→**拒绝**（`minimum`）。映射层另有独立断言——**规则先由映射层保证、Schema 兜底，两层都有证据**。

## 编排方独立复核

| 复核项 | 结果 |
|---|---|
| 范围 | 仅 `monitor/`、`debug/` + 已批准 3 处越界；未碰 `queue/sender/offline/leader/**` 与 `packages/core/**` |
| 禁用写法 | `any` / `@ts-ignore` / `eslint-disable` / `skip` / `.only` **全 0**；**无直接 `console`**（编排方先前一次 grep 报「11 处」系未转义 `.` 的假象，已用 `console\.` 与 eslint 双重确认） |
| 契约测试读的是 | **真实 Schema 文件路径**，非副本 |
| 调试模式不泄漏令牌 | **机制上成立**：`DebugDiagnosticsRecord` 类型只有 `reason_code`/`kind`/`event_name`/`dropped`/`field`，**没有任何令牌/请求头/用户数据字段**；格式化只读白名单，多带的字段不序列化；有泄漏对照用例；另做控制字符与超长值清洗 |
| 门禁 | 编排方在其工作树跑**完整 `pnpm gates` → exit 0** |

## 与 T16 的接口口径（避免错误映射）

1. **双计风险已规避**：`DeliveryMetrics.offlineEvicted` 与原因码 `offline_evicted` 同源 → **只取 `drop_offline_evicted`**，`offlineEvicted` 不进契约计数。
2. `offline_written` / `offline_replayed` 用 T16 修正后的**批次计数**做窗口差分（事件数用 `*Events` 字段，不映射成契约指标）。
3. `batches_sent` / `batches_failed` 采用 T16 的审计口径（离开通道不计、413 子批次不重复计），因此 **`sent + failed` 与 C06 的 submit 次数并不互补**，对账时不可相加。

## 非功能目标（按仓库既定政策落地）

- **计数操作**：任务卡写「不超过 0.001 ms」（绝对墙钟目标）。按既定政策改为**整窗映射（56 个指标）的同步中位数护栏 0.06 ms**，实测空闲 0.00425 ms、4 路负载 ≤0.00500 ms（**≈12× 余量**且 <1 ms）；**0.001 ms 的权威验证归 T20**，已写入代码注释与 README。
- **自监控流量 ≤1%**：确定性测量（无墙钟）——1 条 `sdk_health`（12 指标 / 480 B）对 1000 条业务事件（467,000 B）→ 计数比 **0.100%**、体积比 **0.1028%**。

## 未执行 / 未验证（如实声明）

1. **真实浏览器项全部归 T29**：真实 `location.search` 解析、真实引擎的 `crypto.randomUUID` 与回退路径、真实 60 秒节奏、真实控制台接线、1% 命中的统计性。
2. **待 T18 装配根接线**：未接线前 `calls_total` / `events_enqueued` / `queue_length_max` / 三个 p99 为 0 且不上报（装饰器与适配器已在模块内实现并测试，接线是装配根的活）。
3. **流程偏差**：先写了 12 个测试文件但**未即时执行**，fail-first 证据是事后把实现文件移出目录补跑的（`12 failed / 0 tests`，全部 `Failed to resolve import`）。这属**「模块不存在」式失败**，弱于**「断言失败」式失败**——后者能证明断言本身有判别力（T16 的单位缺陷修复就是因为有「注入旧语义即变红」的验证才可信）。本任务的主要断言有 Ajv 负向对照兜底，故风险可控，但该偏差如实记录。
4. `wr_debug` 这个 URL 参数名由执行方自定（契约未指定）；`resolveDebugMode({ paramName })` 可配置，T34 若要改名无需改逻辑。

## 体积预算（本任务触发）

C08 落地后门禁口径实测 **14.82 kB / 15 kB，余量仅 0.18 kB（1.2%）** —— 工程上过紧。负责人裁定：提到 **18 KB**（余量约 3.2 kB / 21%），**不裁功能**（有界裁剪如把 47 个原因码编码成单字符串，收益不确定且损害可维护性）。

同时立下**硬约束**（已进指南第 6 节）：**C07+C08 装配进浏览器包时必须重新推导整张预算表（含 `browser` 的 10 KB）** —— 预算表是在 C07/C08 存在之前定的，今天已被迫两次抬高（10 → 15 → 18 KB），逐次抬高不是长久办法。

## 遗留交接义务

1. **T18**：装配根接线（C08 的计数/计时装饰器与 reporter 的 `emit`/`timer`/`dimensions`）+ 调用 `captureNativeHttpRefs()`。
2. **T29**：真实浏览器项（见上）。
3. **CR-002**：把 `sdk_health` 字段清单写入 `receiver-requirements.md` 附录 A（任务卡原指派给无契约写权限的 T17，改由 A01 起草）。
4. **T31**：「离线实现不得引用 `localStorage`」的永久源级扫描守卫（承自 T16）。
5. **接收方看板**：CR-001 的新原因码与指标需接收方同步（不在本项目内）。

---

# T13（C03 配置合并、缓存、采样、kill switch）

- 合入：`62f70f8`（实现提交 `36b85c9`；前置：core 体积预算提高到 16 KB `6f7de98`、CR-003、CR-004）
- 门禁（实测）：**`pnpm gates` exit 0，94 个测试文件 / 969 个测试**（T17 收口时 73 / 806；本任务净增 21 个文件 / 163 个用例）
- 覆盖率（门禁口径，`packages/core/src/**`）：行 **91.61%** / 分支 **81.34%**（阈值 90/80）
- 体积：core **13.32 kB / 16 kB**（C03 净增约 6.8 kB；返工 +0.23 kB）

## 交付内容

新增（均在授权范围内）：

- `packages/core/src/config/`：`types`、`constants`、`reason-codes`、`defaults`、`signature`、`validate`、`merge`、`fetch`、`cache`、`kill-switch`、`store`、`index` + 11 个测试
- `packages/core/src/sampling/`：`types`、`session`、`rules`、`processor`、`teardown`、`index` + 5 个测试
- 已批准的三处越界：`src/index.ts`（导出）、`etc/core.api.md`（`api:update`）、`README.md` 第 21–27 节（订阅接口、**C03 内建默认表**、失败原因码顺序、缓存/会话、采样/kill switch、护栏、自检）

## 关键实现

1. **三级合并**：builtin < remote（含 `overrides.patch` 深合并）< runtime（只能 `transport`/`debug`，且只能**关**插件）；产物为不可变 `EffectiveConfig`。
2. **不阻塞初始化**：`start()` 同步返回、内部异步拉取；5 分钟定时 + `visibilitychange`。
3. **签名**：ES256/IEEE P1363/base64url；公钥仅来自 `config_public_keys`、`key_id` 精确查表、**JWK 含私钥 `d` 则拒绝**（额外成员忽略）、公钥数上限 16、**无任何豁免分支**。
4. **安全项 8（缓存读回必须重新验签）**：缓存只存**发布物本体**；拉取 / 网络失败降级 / **304 路径**三处共用同一 `processEnvelope()`——**全仓 `verifyEnvelope` 只有一处调用**；验签失败计 `config_signature_invalid` + 按 CR-004 通则 + 删除该条目。
5. **WebCrypto 不可用 = 唯一例外**：直接保守默认，**不使用缓存**（契约第 54 行）。
6. **失败求值**：固定顺序、**只计首个原因码**；缓存路径版本允许相等、拉取严格递增。
7. **CR-003 的 semver 子集**严格按 `remote-config.md` 5.1 实现；未列出语法 → 整份 `config_schema_invalid`。
8. **完全不用 `localStorage`**（缓存 IDB 主 + 内存回退；会话随机数 `sessionStorage`，同意前仅内存）。

## 测试先行证据（本会话最强的一次）

先落接口桩再写用例、**立即执行**：**`44 failed | 6 passed`，全部是断言级失败**（`expected undefined to be 5`、`expected 'builtin' to be 'remote'` …），**不是 `Failed to resolve import`**；6 条通过均为负/中性对照（验签负向、Ajv 拒绝真实非法样例、采样率组合）。对照 T16（138 个 lint 错误）与 T17（事后补跑得到 import 失败），这一次的取证形态是达标的。

## 安全返工（编排方读代码复核发现）

**问题**：初版 `CachedConfig` 只存 `{config_version, published_at, body, etag, stored_at}`（**不含签名/发布物**），`buildFromCache()` 直接采用 `body`，`degrade()` 与 `handleNotModified()`（304）读缓存后**都不验签**——实现的是"写入时验过一次即信任"。而 **IndexedDB 对同源脚本可读写**，缓存是可篡改输入；且当时**连重新验签所需的原料都没存**。该条属批准的**安全裁定 #8**，但未出现在其 M6 一致性核对范围内（那份核对只覆盖了 CR-004 的失败表）。

**返工**：缓存改为只存 `envelope`；补 `remove()`；抽出唯一入口 `processEnvelope(envelope, mode)` 供三路共用；补 5 条 `cache-verify` 用例（正向对照、篡改 payload、篡改 signature、**304 旁路**、篡改后再拉到合法新版本）。

**编排方独立复现判别力**：把缓存路径验签旁路（模拟旧行为）→ **4 条篡改用例全红、正向对照仍绿**（证明不是"一律拒绝缓存"）；恢复后 5/5 绿。

## 契约自证

直接 import **真实** `remote-config.schema.json` 与样例（非副本），Ajv 2020-12 正/负向 + **运行时手写校验器 ↔ Ajv 的同语料交叉验证 20 条**（含 D002 归一化例外）+ **非空转对照** + **CR-003 超集用例**（`1.2.3 - 2.0.0`、`>=1.2.3-beta.1`：Ajv 接受、C03 必须拒）+ 发布物负向（`alg=ES384`、缺 `signature`）。

## 逐模块体积明细（tsup metafile 口径，供将来重推预算表）

bundle 源码合计 195,827 B；**C03 共 85,574 B（43.7%）** = config 72,027 B + sampling 13,547 B。

| config 模块 | 字节 | 占 bundle | | sampling 模块 | 字节 | 占 bundle |
|---|---|---|---|---|---|---|
| `validate`（手写 Schema 校验器 + semver 支持性） | 13,787 | 7.0% | | `session` | 4,727 | 2.4% |
| `merge` | 12,587 | 6.4% | | `types` | 2,601 | 1.3% |
| `store`（编排） | 12,533 | 6.4% | | `processor` | 2,093 | 1.1% |
| `kill-switch`（semver） | 8,355 | 4.3% | | `rules` | 2,032 | 1.0% |
| `types` | 6,770 | 3.5% | | `teardown` | 1,480 | 0.8% |
| `signature` | 4,654 | 2.4% | | `index` | 614 | 0.3% |
| `cache`（IDB + 内存） | 4,317 | 2.2% | | | | |
| `defaults` / `fetch` / `constants` / `index` | 3,065 / 2,315 / 1,824 / 1,820 | 1.6 / 1.2 / 0.9 / 0.9% | | | | |

口径提醒：这是**源码字节占比**，不等于 brotli 占比（C03 源码 43.7%、brotli 净增约 52%）。严格 brotli 归因需把 `config/` 拆成独立入口包（会改变公共导出面），**建议另立任务**。

## 未执行 / 未验证（如实声明）

1. **真实浏览器项归 T29**：真实 IDB/`sessionStorage` 持久化与刷新、真实 `visibilitychange` 与 5 分钟节奏、真实网络/超时/ETag、**Chromium 验签**（`fake-indexeddb` 只做逻辑验证）。
2. **P99/吞吐与异步白名单哈希耗时归 T20**（任务卡的「采样判定 P99 ≤ 0.01 ms」按既定政策改为中位数护栏，权威验证归 T20）。
3. `pnpm size` / 全量 `pnpm gates` 未由执行方运行（按派工约束，由编排方在工作树与 main 上跑）。

## 与 T13 相关的契约变更（同日）

| CR | 内容 | 触发者 |
|---|---|---|
| **CR-003** | 新增原因码 `config_schema_invalid`（区分"合法 JSON 但违反 Schema"与"非合法 JSON"）+ 明确 `sdk_versions` 的 semver 语法子集（不支持语法须**整份拒绝**，不得静默当作不命中） | T13 的 Q1/Q13 |
| **CR-004** | 统一失败表的"生效配置"语义（有当前配置则保持、无则保守默认）+ **把 WebCrypto 不可用显式化为唯一例外** + 失败表第一行（有未过期缓存）纳入同一口径 | T13 的失败表逐行核对 |

**这两次契约修改都源于执行 agent 逐条对照契约时发现的问题**，而非测试发现——测试只能验证"我已经想到的东西"。
