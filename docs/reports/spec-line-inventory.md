# 规格线清单（从 `tests/acceptance/*.md` 逐条提取）

> 本清单是 [`spec-line-ledger.md`](spec-line-ledger.md) 的输入。**先有清单，再有台账**：清单只做客观提取（文档 / 行号 / 原文 / 类型），不判断有没有人验证；台账才记录「验证落点」。

## 0. 口径

- **范围**：`tests/acceptance/` 下 11 份**现行**验收文档（C01–C08、K01、K02、M01）。`S01`–`S07` 已按 D001 废弃，只保留历史、不再作为验收依据（各文件第 3 行原文写明），**不建账**；其行数见 §3。
- **一条规格线 = 验收表的一行**（`<模块>-AC-<两位序号>`）。本文档的“原文”列取该行的「预期结果」单元格原文；「前置 / 操作」另列，便于核对判据。
- **类型**：
  - **数值**：判定依赖可度量门限（时延 / 吞吐 / 体积 / 内存 / 比例 / 数量上限），例如 `≤2 s`、`≥500 批/秒`、`<50 MB`、`p95 < 100 ms`、`≤5 s`、`≤1 KB`、`16 KB`、`0.28–0.32`。
  - **功能**：判定为行为 / 状态 / 返回码 / 精确计数 / 拒绝或接受等非门限结论。
- **行号**：1-based，指向该行在文件中的实际行（`C07.md` 的 CR-010 注记插在表格中间，行号因此不连续，这是正常的）。

## 1. 汇总

| 文档 | 模块 | 规格线总数 | 其中数值规格线 |
|---|---|---:|---:|
| [C01.md](../../tests/acceptance/C01.md) | 公共 API 与加载器 | 12 | 2 |
| [C02.md](../../tests/acceptance/C02.md) | 内核与插件宿主 | 14 | 1 |
| [C03.md](../../tests/acceptance/C03.md) | 配置与采样 | 24 | 1 |
| [C04.md](../../tests/acceptance/C04.md) | 上下文与隐私守卫 | 20 | 5 |
| [C05.md](../../tests/acceptance/C05.md) | 采集插件与双写适配器 | 20 | 3 |
| [C06.md](../../tests/acceptance/C06.md) | 队列与调度 | 11 | 5 |
| [C07.md](../../tests/acceptance/C07.md) | 传输与可靠投递 | 28 | 7 |
| [C08.md](../../tests/acceptance/C08.md) | 自监控与调试 | 9 | 4 |
| [K01.md](../../tests/acceptance/K01.md) | 事件注册表与类型生成 CLI | 12 | 2 |
| [K02.md](../../tests/acceptance/K02.md) | 配置签名 CLI | 9 | 1 |
| [M01.md](../../tests/acceptance/M01.md) | 本地 mock 接收服务 | 15 | 4 |
| **合计** | **11 份现行文档** | **174** | **35** |

## 2. 逐条清单

### C01（12 条，数值 2 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C01.md](../../tests/acceptance/C01.md) | 7 | C01-AC-01 | C01-F1 | 依次调用全部公共方法，参数合法 | 每个方法同步返回 `undefined`；对应能力生效 | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 8 | C01-AC-02 | C01-F1 | 让内部任意一个处理器抛错后再调用 `track` | `track` 不抛错；计数 `processor_error` 加 1 | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 9 | C01-AC-03 | C01-F1 | 销毁后调用全部公共方法 | 不抛错；计数 `destroyed` | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 10 | C01-AC-04 | C01-F2 | SDK 未初始化时调用 `track` 3 次、`setUser` 1 次，然后初始化并启动 | 按调用顺序回放；事件的 `occurred_at`、`page_id`、`url` 为调用当时的值 | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 11 | C01-AC-05 | C01-F2 | 未就绪时调用 250 次 | 只保留前 200 次；计数 `command_queue_overflow` 为 50 | 数值 |
| [C01.md](../../tests/acceptance/C01.md) | 12 | C01-AC-06 | C01-F3 | 页面头部内联加载桩，主包延迟 3 秒加载，期间抛出一个 JS 错误并调用 `track` | 主包加载后两者都被上报 | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 13 | C01-AC-07 | C01-F3 | 主包加载失败（404） | 加载桩不抛错，不影响页面；命令队列不超过上限 | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 14 | C01-AC-08 | C01-F3 | 构建产物检查 | 加载桩 gzip 后不超过 1 KB | 数值 |
| [C01.md](../../tests/acceptance/C01.md) | 15 | C01-AC-09 | C01-F4 | 用测试类型包，以未登记事件名、缺失必填字段、错误字段类型调用 `track` | `tsc` 报错；以正确参数调用时编译通过 | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 16 | C01-AC-10 | C01-F5 | 同一页面创建两个使用不同 `app_id` 的实例 | 上下文、队列、配置互相隔离；全局注册表只注册一次原生监听 | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 17 | C01-AC-11 | C01-F6 | 用非法事件名、非对象维度、`NaN` 指标调用 `track` | 静默丢弃或丢弃该字段；计数 `invalid_event_name`、`invalid_args`、`non_finite_metric` | 功能 |
| [C01.md](../../tests/acceptance/C01.md) | 18 | C01-AC-12 | C01-F6 | 开启调试模式后重复 AC-11 | 控制台输出警告，内容包含原因码，不包含令牌 | 功能 |

### C02（14 条，数值 1 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C02.md](../../tests/acceptance/C02.md) | 7 | C02-AC-01 | C02-F1 | 依次调用初始化、启动、销毁 | 状态依次为已初始化、运行中、已销毁 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 8 | C02-AC-02 | C02-F1 | 未初始化时调用启动；已销毁后调用初始化 | 都被忽略，状态不变，不抛错 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 9 | C02-AC-03 | C02-F1 | 运行中触发暂停（撤回同意），再恢复 | 状态为暂停 → 运行中；暂停期间按原因不采集或不发送 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 10 | C02-AC-04 | C02-F2 | 注册六段处理器，各自给事件加一个标记 | 事件按校验、富化、过滤、采样、构建、发送前的顺序经过，标记顺序正确 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 11 | C02-AC-05 | C02-F2 | 过滤段处理器返回“终止，原因 `filtered_by_plugin`” | 事件不进入后续段；计数 `filtered_by_plugin` 加 1 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 12 | C02-AC-06 | C02-F3 | 富化段的一个处理器抛错 | 跳过该处理器，事件继续；计数 `processor_error` 加 1；错误不出现在 `window.onerror` | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 13 | C02-AC-07 | C02-F4 | 注册一个依赖不存在插件的插件 | 该插件不安装，计数 `plugin_dependency_missing`；其他插件正常安装 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 14 | C02-AC-08 | C02-F4 | 插件安装函数抛错 | 计数 `plugin_install_failed`；其他插件不受影响；SDK 继续运行 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 15 | C02-AC-09 | C02-F4 | 配置关闭一个已安装的插件 | 插件卸载，它注册的监听和 hook 全部释放 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 16 | C02-AC-10 | C02-F5 | 配置就绪前上报 600 条 normal 事件 | 预启动队列保留最新 500 条；计数 `prestart_queue_overflow` 为 100；配置就绪后按顺序回放 | 数值 |
| [C02.md](../../tests/acceptance/C02.md) | 17 | C02-AC-11 | C02-F5 | 配置就绪前上报 critical 事件导致溢出 | critical 事件不被淘汰，淘汰的是最早的 normal 事件 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 18 | C02-AC-12 | C02-F6 | 两个插件都订阅 `error` 事件 | `window.addEventListener('error')` 只被调用一次；两个插件都收到事件 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 19 | C02-AC-13 | C02-F6 | 业务先 hook `history.pushState`，SDK 再 hook，然后 SDK 销毁 | 销毁后 `pushState` 恢复为业务的包装函数，而不是原生函数 | 功能 |
| [C02.md](../../tests/acceptance/C02.md) | 20 | C02-AC-14 | C02-F1、C02-F6 | 销毁后检查 | 没有残留的监听、定时器、hook；之后调用任何公共方法都计数 `destroyed`，不抛错 | 功能 |

### C03（24 条，数值 1 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C03.md](../../tests/acceptance/C03.md) | 7 | C03-AC-01 | C03-F1 | 内置默认、远程配置、运行时覆盖都设置了 `transport.max_batch_events` | 生效值取运行时覆盖；生效配置带远程配置的 `config_version` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 8 | C03-AC-02 | C03-F1 | 运行时覆盖试图开启远程已关闭的插件、修改采样率 | 被忽略；生效配置保持远程值 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 9 | C03-AC-03 | C03-F2 | 首次启动，配置接口返回 200 | 初始化不等待拉取；拉取完成后生效 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 10 | C03-AC-04 | C03-F2 | 第二次拉取带 `If-None-Match`，接口返回 304 | 不重新解析；继续使用缓存 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 11 | C03-AC-05 | C03-F2 | 接口返回 500，有未过期缓存 | 使用缓存；计数 `config_fetch_failed` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 12 | C03-AC-06 | C03-F2 | 接口失败且无缓存 | 使用保守默认：只保留 critical 与 JS 错误，其他插件关闭 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 13 | C03-AC-07 | C03-F2、C03 安全 | 发布物签名被篡改一个字节 | 拒绝本次配置；计数 `config_signature_invalid` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 14 | C03-AC-08 | C03-F2 | 收到的 `config_version` 小于当前生效版本 | 拒绝（防回放），保持当前配置 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 15 | C03-AC-09 | C03-F2 | `format_version` 为 2 | 使用缓存或保守默认；计数 `config_format_unsupported` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 16 | C03-AC-10 | C03-F3 | `session_rate` 0.3，同一会话内刷新页面 10 次 | 每次命中结果相同 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 17 | C03-AC-11 | C03-F3 | 10,000 个模拟会话，`session_rate` 0.3 | 命中比例在 0.28–0.32 之间 | 数值 |
| [C03.md](../../tests/acceptance/C03.md) | 18 | C03-AC-12 | C03-F3 | 白名单用户所在会话的随机数未命中 | 仍全量采集 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 19 | C03-AC-13 | C03-F4 | 规则 `editor_*` 采样 0.1、`legacy_click_track` 采样 0；critical 事件命中 0 规则 | 前缀匹配生效，未命中 0.1 的事件计数 `sampled_out_rule`；禁用事件计数 `disabled_by_rule`；critical 事件仍上报；事件 `sample_rate` 等于会话率乘规则率 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 20 | C03-AC-14 | C03-F5 | 下发 `kill_switch.sdk_versions` 命中当前版本；另测 `plugins: ["http"]` | 前者进入已销毁状态，之后的事件计数 `killed`；后者只卸载 HTTP 插件并恢复其 hook | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 21 | C03-AC-15 | C03-F6 | 会话未命中采样 | 错误、性能、路由、HTTP 插件的监听被拆除；critical 事件仍可上报；normal 事件计数 `sampled_out_session` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 22 | C03-AC-16 | C03-F2、C03 安全 | 发布物 `key_id` 不在 `config_public_keys` 中 | 拒绝本次配置；计数 `config_signature_invalid` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 23 | C03-AC-17 | C03-F2 | 正文 `app_id` 或 `env` 与请求路径不一致（签名正确） | 拒绝本次配置；计数 `config_scope_mismatch` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 24 | C03-AC-18 | C03-F2 | 响应体不是合法 JSON；另测 `payload` 不是合法 JSON（签名正确） | 都拒绝；计数 `config_parse_failed`；不抛错 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 25 | C03-AC-19 | C03-F2 | 本地缓存写入时间为 25 小时前，拉取失败 | 不使用该缓存，使用保守默认；计数 `config_cache_expired` 与 `config_fetch_failed` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 26 | C03-AC-20 | C03-F2 | 删除 `crypto.subtle` 后初始化 | 不发起验签；生效配置等于保守默认；计数 `config_signature_unavailable` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 27 | C03-AC-21 | C03-F1、D002 | 初始化参数 `consent_mode: buffer`，远程配置（签名正确）带 `consent_mode: full` | 生效值为 `buffer`；计数 `config_consent_mode_rejected`；配置的其他字段照常生效 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 28 | C03-AC-22 | C03-F1、D002 | 初始化参数 `consent_mode: full`，远程配置带 `essential_only` | 生效值为 `essential_only` | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 29 | C03-AC-23 | C03-F2 | 未传 `config_endpoint` | 不发起配置请求；使用内置默认值 | 功能 |
| [C03.md](../../tests/acceptance/C03.md) | 30 | C03-AC-24 | C03-F2 | 发布物/正文是**合法 JSON 但不符合 `remote-config.schema.json`**（另测：`sdk_versions` 用了 `remote-config.md` 5.1 节未列出的语法，如 `1.2.3 - 2.0.0`）（2026-10-13 经 CR-003 新增；同日修正措辞，见下） | **整份配置被拒绝**并计数 `config_schema_invalid`；**不得静默忽略该字段后继续使用其余配置**（否则一条无法求值的 kill switch 规则会被当作不命中）。被拒之后的生效配置按 `remote-config.md` 失败表的既有模式：**已有当前生效配置时保持该配置不变**；**没有可用配置时才退回保守默认**。—— 原先写作"退回保守默认"，与失败表其它拒绝行的语义不一致，且会造成**降级面**：推送一份非法配置即可把 SDK 打回最保守模式、停掉上报（对数据管道构成拒绝服务）。 | 功能 |

### C04（20 条，数值 5 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C04.md](../../tests/acceptance/C04.md) | 7 | C04-AC-01 | C04-F1 | 上报一条事件 | 批次头包含 `device_id`、`session_id`、`release`、`env`、`sdk_version`；事件包含 `page_id`、`view_id`、`url` | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 8 | C04-AC-02 | C04-F1 | 模拟 31 分钟无活动后再上报 | `session_id` 变化；29 分钟时不变 | 数值 |
| [C04.md](../../tests/acceptance/C04.md) | 9 | C04-AC-03 | C04-F2 | 在页面 A 上报后立即切换路由到 B，再发送批次 | 该事件的 `page_id`、`view_id` 仍为 A 的值；B 的事件使用新的 `view_id` | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 10 | C04-AC-04 | C04-F2 | 路由 `/task/123` | `page_id` 为路由模板 `/task/:id` | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 11 | C04-AC-05 | C04-F3 | 设置自定义上下文 `k1`，上报，删除 `k1`，上报 | 第一条事件 `context.k1` 存在，第二条不存在 | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 12 | C04-AC-06 | C04-F4 | URL 带查询参数 `tab`、`token`、`phone`，白名单只有 `tab` | 上报的 `url` 只保留 `tab` | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 13 | C04-AC-07 | C04-F4 | 错误信息与维度中包含伪造的手机号、邮箱、身份证号 | 全部被掩码；计数不影响事件上报 | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 14 | C04-AC-08 | C04-F4 | 远程配置追加一条规则 `ORD\d{12}` | 匹配内容被替换为配置的 `replacement` | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 15 | C04-AC-09 | C04-F4、C04 安全 | 远程配置或运行时覆盖试图关闭内置脱敏规则 | 内置规则仍然生效 | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 16 | C04-AC-10 | C04-F5 | 同意状态 `unknown`，`consent_mode` 为 `essential_only` | 只发送必要事件，其他事件计数 `consent_denied`；不写入持久化设备标识；批次 `device_id_persistent` 为 false | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 17 | C04-AC-11 | C04-F5 | `consent_mode` 为 `buffer`，先上报 10 条，再设置 `granted` | 10 条事件在同意后发送；同意前没有网络请求 | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 18 | C04-AC-12 | C04-F5 | 设置 `denied` | 清除设备标识、离线数据、会话随机数；之后只发送必要事件，其他事件计数 `consent_denied` | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 19 | C04-AC-13 | C04-F6 | 维度值 300 字符、60 个维度键、10 KB 附件 | 截断到 256 字符、50 个键、8 KB；`truncated` 列出路径；计数对应原因码 | 数值 |
| [C04.md](../../tests/acceptance/C04.md) | 20 | C04-AC-14 | C04-F6 | 截断位置落在表情符号（代理对）中间 | 不产生孤立代理项 | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 21 | C04-AC-15 | C04-F6 | 单条事件截断后仍超过 16 KB | 整条丢弃，计数 `event_too_large` | 数值 |
| [C04.md](../../tests/acceptance/C04.md) | 22 | C04-AC-16 | C04-F7 | 接收方响应头 `X-Server-Time` 比本地快 5 秒，往返 100 ms；另测往返 3 秒 | 前者 `clock_offset` 约为 5000 且 `clock_calibrated: true`；后者放弃校准 | 数值 |
| [C04.md](../../tests/acceptance/C04.md) | 23 | C04-AC-17 | C04-F6 | 维度键 `Title`、`1abc`；60 个指标键 | 两个非法键被丢弃并计数 `invalid_field_key`；指标保留 50 个并计数 `truncated_metric_keys` | 数值 |
| [C04.md](../../tests/acceptance/C04.md) | 24 | C04-AC-18 | C04-F5 | `consent_mode` 为 `buffer`，先上报 10 条，再设置 `denied` | 缓存的 10 条被清空，计数 `consent_buffer_cleared` 为 10；全程没有业务事件的网络请求 | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 25 | C04-AC-19 | C04-F5、D002 | 初始化参数 `consent_mode: full`，同意状态 `unknown` | 全部事件采集并发送；生成持久化设备标识；批次 `consent` 为 `unknown` | 功能 |
| [C04.md](../../tests/acceptance/C04.md) | 26 | C04-AC-20 | C04-F4 | 检查内置敏感请求头与内置脱敏规则 | 与 `remote-config.md` 5.4 的清单逐项一致 | 功能 |

### C05（20 条，数值 3 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C05.md](../../tests/acceptance/C05.md) | 7 | C05-AC-01 | C05-F1 | 页面抛出未捕获异常 | 上报 `web_js_error`，`source` 为 `window_error`，附带脱敏后的错误栈 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 8 | C05-AC-02 | C05-F1 | 未处理的 Promise 拒绝，拒绝值分别为 Error 对象和字符串 | 都上报，`source` 为 `unhandled_rejection` | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 9 | C05-AC-03 | C05-F1 | 同一错误 1 秒内抛出 100 次 | 按 `fingerprint` 去重，上报次数受控，`count` 记录总次数；计数 `filtered_by_plugin` | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 10 | C05-AC-04 | C05-F1 | 错误前用户做了 25 次点击和路由跳转 | 附带最近 20 条面包屑；面包屑中没有输入框内容 | 数值 |
| [C05.md](../../tests/acceptance/C05.md) | 11 | C05-AC-05 | C05-F2 | 正常加载页面 | 上报 FCP、LCP、TTFB；交互后上报 INP；页面隐藏时上报 CLS | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 12 | C05-AC-06 | C05-F2 | 页面上制造一个 120 ms 的长任务 | 上报 `web_long_task`，`duration_ms` 约为 120 | 数值 |
| [C05.md](../../tests/acceptance/C05.md) | 13 | C05-AC-07 | C05-F2 | 浏览器不支持某个性能条目类型 | 不抛错，跳过该指标 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 14 | C05-AC-08 | C05-F3 | History 模式下 `pushState`、`replaceState`、后退 | 每次路由变化上报 `web_pageview`，`page_id` 为路由模板 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 15 | C05-AC-09 | C05-F3 | Hash 模式；另测手动模式 | Hash 变化上报；手动模式只在业务调用时上报 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 16 | C05-AC-10 | C05-F4 | 发出成功、404、超时三个请求（fetch 与 XHR 各一组） | 上报 `web_http`，状态码与失败原因正确；SDK 自己的上报请求不被采集 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 17 | C05-AC-11 | C05-F4、C05 安全 | 请求带 `Authorization` 头和含令牌的查询参数 | 上报中不出现这两项 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 18 | C05-AC-12 | C05-F4 | 配置追踪白名单只含同源，分别请求同源与第三方 | 只有同源请求被注入链路追踪头 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 19 | C05-AC-13 | C05-F6 | 只引入错误插件构建 | 产物中不包含其他插件代码 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 20 | C05-AC-14 | C05-F6 | 远程配置关闭性能插件 | 性能观察器断开，之后不再上报性能事件 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 21 | C05-AC-15 | C05-F5 | 注入一个模拟的第三方 APM 接口，开启双写 | 每条自定义事件按映射配置转发一次 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 22 | C05-AC-16 | C05-F5 | 第三方接口抛错或不存在 | 本 SDK 正常上报；计数 `processor_error` | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 23 | C05-AC-17 | C05-F5 | 关闭双写 | 不再转发 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 24 | C05-AC-18 | C05-F5 | 适配器构建产物检查 | 不包含任何第三方包的代码；gzip 后不超过 1.5 KB | 数值 |
| [C05.md](../../tests/acceptance/C05.md) | 25 | C05-AC-19 | Q7 共存 | 第三方 APM 先于本 SDK 初始化，两边都 hook `fetch` 与 `onerror`；然后反过来再测一次 | 两边都采集到数据；本 SDK 销毁后，第三方的 hook 仍然生效 | 功能 |
| [C05.md](../../tests/acceptance/C05.md) | 26 | C05-AC-20 | Q7 共存 | 共存模式下的默认配置 | 错误、性能、HTTP 插件默认关闭；可通过远程配置逐个开启 | 功能 |

### C06（11 条，数值 5 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C06.md](../../tests/acceptance/C06.md) | 7 | C06-AC-01 | C06-F1 | 发送暂停时入队 600 条 normal 事件 | 队列保留最新 500 条；计数 `queue_evicted` 为 100 | 数值 |
| [C06.md](../../tests/acceptance/C06.md) | 8 | C06-AC-02 | C06-F1 | 入队总体积超过 512 KB | 按体积上限淘汰最早的 normal 事件 | 数值 |
| [C06.md](../../tests/acceptance/C06.md) | 9 | C06-AC-03 | C06-F1 | 队列已满时入队 critical 事件 | critical 事件不被淘汰；被挤出的是 normal 事件；全是 critical 时转入离线存储 | 功能 |
| [C06.md](../../tests/acceptance/C06.md) | 10 | C06-AC-04 | C06-F2 | 连续入队 20 条 | 立即冲刷一个批次 | 数值 |
| [C06.md](../../tests/acceptance/C06.md) | 11 | C06-AC-05 | C06-F2 | 入队体积达到 32 KB（不足 20 条） | 立即冲刷 | 数值 |
| [C06.md](../../tests/acceptance/C06.md) | 12 | C06-AC-06 | C06-F2 | 入队 1 条后静默 1 秒；另测每 500 ms 入队一条持续 6 秒 | 前者 1 秒后冲刷；后者在第 5 秒因最长等待冲刷 | 数值 |
| [C06.md](../../tests/acceptance/C06.md) | 13 | C06-AC-07 | C06-F2 | 页面触发 `visibilitychange` 为 hidden；另测 `pagehide` | 同步冲刷，并使用页面离开通道 | 功能 |
| [C06.md](../../tests/acceptance/C06.md) | 14 | C06-AC-08 | C06-F2 | 业务调用 `flush` | 立即冲刷 | 功能 |
| [C06.md](../../tests/acceptance/C06.md) | 15 | C06-AC-09 | C06-F3 | 批次内所有事件的 `page_id` 相同、`url` 不同 | `page_id` 提升到 `common`，`url` 保留在事件体；批次通过 `batch.schema.json` 校验 | 功能 |
| [C06.md](../../tests/acceptance/C06.md) | 16 | C06-AC-10 | C06-F4 | 一个批次在途时又满足冲刷条件 | 不发出第二个常规批次；新事件继续入队；在途批次完成后再冲刷 | 功能 |
| [C06.md](../../tests/acceptance/C06.md) | 17 | C06-AC-11 | C06-F5 | 模拟 `effectiveType` 为 `2g` 或 `saveData` 为 true | 批次条数上限和静默时间按配置放大 | 功能 |

### C07（28 条，数值 7 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C07.md](../../tests/acceptance/C07.md) | 7 | C07-AC-01 | C07-F1 | 常规冲刷 | 使用 `fetch` keepalive；请求头含 `X-App-Id`、`X-Write-Token`；令牌不出现在 URL | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 8 | C07-AC-02 | C07-F1 | 浏览器不支持 keepalive | 降级为 `XMLHttpRequest` | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 9 | C07-AC-03 | C07-F1 | 页面离开时冲刷 80 KB 数据 | 使用信标通道，拆成至少两个不超过 60 KB 的请求；`Content-Type` 为 `text/plain`；令牌在 `auth` 字段 | 数值 |
| [C07.md](../../tests/acceptance/C07.md) | 17 | C07-AC-04 | C07-F2 | 接收方返回 202 | 视为成功；删除离线副本 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 18 | C07-AC-05 | C07-F2 | 返回 400 | 丢弃并计数 `rejected_400`；不重试 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 19 | C07-AC-06 | C07-F2 | 返回 401；之后配置更新了令牌 | 暂停发送；配置更新后恢复；暂停期间事件入队不丢 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 20 | C07-AC-07 | C07-F2 | 返回 413 | 拆成两半重发并计数 `split_413`，`event_id` 不变、`batch_id` 重新生成；单条仍超限时丢弃该条并计数 `rejected_413` | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 21 | C07-AC-08 | C07-F3 | 返回 429，`Retry-After: 7` | 7 秒后重试（取与本地退避的较大值）；计数 `retry_429` | 数值 |
| [C07.md](../../tests/acceptance/C07.md) | 22 | C07-AC-09 | C07-F3 | 连续返回 503 | 按 1、2、4 秒（±20% 抖动）重试 3 次，之后落盘；`batch_id` 保持不变；计数 `retry_5xx` 为 3 | 数值 |
| [C07.md](../../tests/acceptance/C07.md) | 23 | C07-AC-10 | C07-F4 | 连续 5 个批次失败 | 熔断 5 分钟，期间只入队不发送，计数 `circuit_open`；之后放行一个探测批次 | 数值 |
| [C07.md](../../tests/acceptance/C07.md) | 24 | C07-AC-11 | C07-F4 | 401、403 不计入熔断 | 连续 5 次 401 不触发熔断，走暂停逻辑 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 25 | C07-AC-12 | C07-F5 | 发送含 critical 事件的批次，在响应前模拟页面强杀 | 离线存储中保留该批次；下次启动后补发，M01 去重后只入库一次 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 26 | C07-AC-13 | C07-F5 | 页面离开时用信标发送 critical 批次，`sendBeacon` 返回 true | 离线副本不删除，下次启动由常规通道补发确认 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 27 | C07-AC-14 | C07-F6 | 断网 10 分钟期间上报 3 个 critical 事件，然后恢复联网 | 恢复后补发，`replayed: true`，计数 `replayed`，补发速率不超过每秒 2 个批次 | 数值 |
| [C07.md](../../tests/acceptance/C07.md) | 28 | C07-AC-15 | C07-F6 | 页面从隐藏变为可见；另测重新打开页面 | 都触发补发 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 29 | C07-AC-16 | C07-F6 | 离线存储超过 2,000 批或 5 MB；另测超过 7 天 | 淘汰最早的批次，计数 `offline_evicted` | 数值 |
| [C07.md](../../tests/acceptance/C07.md) | 30 | C07-AC-17 | C07-F7 | 同一应用打开 3 个标签页，各有离线数据 | 只有主标签页补发；主标签页关闭后另一个接替 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 31 | C07-AC-18 | C07-F7 | 浏览器不支持 Web Locks | 降级为广播通道选主；仍不支持时各自补发，依靠接收方去重（M01 验证只入库一次） | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 32 | C07-AC-19 | C07-F8 | 批次 3 KB 与 6 KB 各一个，浏览器支持 `CompressionStream` | 3 KB 不压缩；6 KB 压缩并带 `Content-Encoding: gzip` | 数值 |
| [C07.md](../../tests/acceptance/C07.md) | 33 | C07-AC-20 | C07-F9 | 注入自定义传输与存储适配器 | 使用注入的适配器发送与存储 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 34 | C07-AC-21 | C07 安全 | 撤回同意或注销 | 离线数据清空；离线数据中从未出现未脱敏内容 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 35 | C07-AC-22 | C07 安全 | 离线数据的格式版本与当前 SDK 不兼容 | 清理旧数据，不抛错；计数 `offline_incompatible` | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 36 | C07-AC-23 | C07-F5 | IndexedDB 与 localStorage 都不可用，连续返回 503 直到重试用完 | 计数 `storage_unavailable`；重试用完后丢弃并计数 `retry_exhausted`；不抛错 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 37 | C07-AC-24 | C07-F2 | 返回 403 | 与 C07-AC-06 相同的暂停逻辑；计数 `rejected_403` | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 38 | C07-AC-25 | C07-F3 | 请求超时；另测连接被重置 | 按退避重试；计数 `retry_network` | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 39 | C07-AC-26 | C07-F2 | 返回 202 时响应头缺少 `X-Server-Time`；返回 429 时 `Retry-After` 为非数字 | 不抛错；前者不校准时钟，后者按本地退避 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 40 | C07-AC-27 | C07-F2 | 返回 418；另测返回 204 | 418 按 400 处理（计数 `rejected_400`）；204 按 202 处理 | 功能 |
| [C07.md](../../tests/acceptance/C07.md) | 41 | C07-AC-28 | C07-F5 | critical 事件**已发起 IndexedDB 预写、事务尚未 `oncomplete`** 时强杀页面/进程（2026-10-13 经 CR-001 新增，依据 D004） | 重启后该事件记为 `drop_prewrite_commit_lost`，并计入 `exposure_window_events`；`exposure_window_ms` 上报为正值；**不得**把它计入优雅路径（页面离开/隐藏、断网恢复、多标签页、优雅关闭）的丢失率统计 | 功能 |

### C08（9 条，数值 4 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [C08.md](../../tests/acceptance/C08.md) | 7 | C08-AC-01 | C08-F1 | 依次触发 `reason-codes.md` 第 1 节的每一种丢弃 | 每个原因码的计数都正确 | 功能 |
| [C08.md](../../tests/acceptance/C08.md) | 8 | C08-AC-02 | C08-F1 | 正常上报 100 条并发送成功 | `calls_total`、`events_enqueued`、`events_sent` 与实际一致 | 功能 |
| [C08.md](../../tests/acceptance/C08.md) | 9 | C08-AC-03 | C08-F2 | 会话命中 1% 耗时采样；另测未命中 | 命中时 `sdk_health` 带 `track_p99_ms` 等字段；未命中时不带 | 数值 |
| [C08.md](../../tests/acceptance/C08.md) | 10 | C08-AC-04 | C08-F3 | 运行 60 秒 | 上报一条 `sdk_health`，`window_ms` 约为 60000；值为 0 的计数不出现 | 数值 |
| [C08.md](../../tests/acceptance/C08.md) | 11 | C08-AC-05 | C08-F3 | `sdk_health` 本身被发送、重试 | 不计入下一个窗口的计数 | 功能 |
| [C08.md](../../tests/acceptance/C08.md) | 12 | C08-AC-06 | C08-F3 | 一个窗口内非零指标超过 50 个 | 拆成多条 `sdk_health`，每条不超过 50 个指标 | 数值 |
| [C08.md](../../tests/acceptance/C08.md) | 13 | C08-AC-07 | C08-F3 | 1,000 条业务事件期间的自监控流量 | 自监控事件体积不超过业务事件体积的 1% | 数值 |
| [C08.md](../../tests/acceptance/C08.md) | 14 | C08-AC-08 | C08-F4 | 非生产环境通过 URL 参数开启调试模式 | 控制台逐条显示事件去向与原因码；不显示令牌 | 功能 |
| [C08.md](../../tests/acceptance/C08.md) | 15 | C08-AC-09 | C08-F4 | 生产环境、非白名单用户使用同样的 URL 参数 | 调试模式不开启 | 功能 |

### K01（12 条，数值 2 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [K01.md](../../tests/acceptance/K01.md) | 7 | K01-AC-01 | K01-F1 | 校验只含 `event-definition.valid.json` 的注册表 | 退出码 0 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 8 | K01-AC-02 | K01-F1 | 逐个校验 `event-definition.invalid.json` 中的 case | 每个都返回非零退出码，错误信息包含字段路径 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 9 | K01-AC-03 | K01-F2 | 对兼容性规则表每一行准备“基线 / 新版本”样例对，运行检查 | 判定结果（兼容 / 破坏性 / 不递增版本）与规则表逐行一致 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 10 | K01-AC-04 | K01-F2 | 修改字段而不递增 `schema_version` | 非零退出码，提示需要递增版本 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 11 | K01-AC-05 | K01-F2 | 提交破坏性变更（递增了版本） | 非零退出码，除非传入 `--allow-breaking`；输出列出每一处破坏性变更 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 12 | K01-AC-06 | K01-F3、Q3 | 20 个事件中 2 个 critical；再加 1 个 critical | 前者通过；后者（3/21 > 10%）非零退出码 | 数值 |
| [K01.md](../../tests/acceptance/K01.md) | 13 | K01-AC-07 | K01-F1 | 两个文件定义同名同版本的事件；事件名使用 `web_` 前缀 | 都返回非零退出码 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 14 | K01-AC-08 | K01-F4 | 生成类型声明，用 `tsc --noEmit` 编译一组正确与错误的调用样例 | 正确样例编译通过；未登记事件名、缺必填字段、类型错误、枚举值错误都报错；生成文件不含运行时代码 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 15 | K01-AC-09 | K01-F4 | 检查生成的类型 | 每个事件名携带 `priority` 与 `schema_version` 字面量类型；只包含 `active` 事件的最新版本 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 16 | K01-AC-10 | K01-F5 | 导出校验规则 JSON | 输出符合工具自带的规则 Schema；每个事件保留最近 3 个版本 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 17 | K01-AC-11 | K01-F6 | 输入 M01 导出的事件名清单，含 2 个注册表中没有的事件 | 报告列出这 2 个事件及出现次数；退出码 0 | 功能 |
| [K01.md](../../tests/acceptance/K01.md) | 18 | K01-AC-12 | K01 非功能 | 500 个事件定义的检查与生成 | 总耗时不超过 5 秒 | 数值 |

### K02（9 条，数值 1 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [K02.md](../../tests/acceptance/K02.md) | 7 | K02-AC-01 | K02-F1 | 校验 `remote-config.valid.json` 的 `decoded_payload`；逐个校验 `remote-config.invalid.json` 的 case | 前者退出码 0；后者每个都非零退出码，错误信息含字段路径；含 `consent_mode: full` 的 case 提示 D002 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 8 | K02-AC-02 | K02-F2 | 上一份发布物 `config_version` 为 42，新正文分别为 42、41、43 | 42、41 非零退出码；43 通过 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 9 | K02-AC-03 | K02-F3 | 用测试私钥签名 | 输出符合 `$defs/envelope`；`signature` 为 86 字符 base64url；用 WebCrypto（Playwright Chromium）验签通过 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 10 | K02-AC-04 | K02-F3、K02-F4 | 签名后篡改 `payload` 任意一个字节；另测篡改 `signature`、改 `key_id` | `verify` 子命令都返回非零退出码 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 11 | K02-AC-05 | K02-F5 | 生成测试密钥对 | 输出私钥 PEM 文件（权限 0600）与公钥 JWK；终端输出与日志中不含私钥内容 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 12 | K02-AC-06 | K02-F6 | 使用外部签名命令（测试中用一个调用 Node `crypto` 的脚本代替 KMS） | 产出的发布物与 AC-03 一样能验签通过；K02 进程不接触私钥 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 13 | K02-AC-07 | K02 安全 | 正文任意字符串字段中填入疑似令牌或密钥（JWT、PEM 头、32 位以上随机十六进制串） | 非零退出码，指出字段路径；不打印该字符串原文 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 14 | K02-AC-08 | K02 安全 | 运行全部用例后扫描仓库和 K02 的标准输出、错误输出 | 未出现私钥内容；仓库中没有新增私钥文件 | 功能 |
| [K02.md](../../tests/acceptance/K02.md) | 15 | K02-AC-09 | K02 非功能 | 签名与验签各执行 100 次 | 单次不超过 100 ms | 数值 |

### M01（15 条，数值 4 条）

| 文档 | 行号 | 用例 ID | 需求 | 前置 / 操作 | 原文（预期结果） | 类型 |
|---|---:|---|---|---|---|---|
| [M01.md](../../tests/acceptance/M01.md) | 7 | M01-AC-01 | M01-F1、RR-01 | 常规通道发送 `batch.valid.json`、`batch-promoted.valid.json`，令牌正确 | 都返回 202；响应带 `X-Server-Time`、`X-Request-Id` | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 8 | M01-AC-02 | M01-F1、RR-01、RR-12 | 令牌错误；调用吊销接口后再用原令牌 | 401，`error` 分别为 `invalid_token`、`token_revoked` | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 9 | M01-AC-03 | M01-F1、RR-03 | 信标通道（`text/plain`，令牌在 `auth`）；另测常规通道请求体带正确 `auth`、请求头令牌错误 | 前者 202；后者 401（只认请求头） | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 10 | M01-AC-04 | M01-F1、RR-01、RR-04 | `batch.invalid.json` 每个 case；请求头 `X-App-Id` 与请求体不一致；`Content-Encoding: br`；解压后 1.2 MB；501 条事件；压缩后 100 KB、解压后 1 GB 的 gzip 炸弹 | 前三类 400（`invalid_structure`、`app_id_mismatch`、`unsupported_encoding`）；后三类 413，炸弹在解压到 1 MB 时中止，进程 RSS 增长不超过 50 MB | 数值 |
| [M01.md](../../tests/acceptance/M01.md) | 11 | M01-AC-05 | M01-F3、RR-02 | 开启“存储失败”故障注入后发送批次 | 返回 503（`storage_unavailable`），从不返回 2xx；计数接口中入库数不变 | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 12 | M01-AC-06 | M01-F2、RR-05、RR-23 | 同一批次重发 3 次；拆分后的两个批次含相同 `event_id`；批次含一条 `sdk_health` | 每个 `event_id` 只入库一次；计数接口 `received` 与 `stored` 的差等于重复数；`sdk_health` 入库 | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 13 | M01-AC-07 | M01-F2、RR-06 | 发送 `batch-promoted.valid.json` | 查询接口返回的每条事件与未提升写法完全一致；事件体中的值优先于 `common` | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 14 | M01-AC-08 | M01-F1、RR-08 | 发送 CORS 预检请求 | 允许 `POST` 与 RR-08 列出的请求头；`Access-Control-Expose-Headers` 含 `Retry-After`、`X-Server-Time` | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 15 | M01-AC-09 | M01-F3 | 按序列注入 `[429, 503, 413, 401, timeout, reset, 202]`；另测按比例注入 30% 的 503 | 响应依次与序列一致，429 与 503 带整数 `Retry-After`；比例注入 1,000 次的 503 占比在 25%–35% | 数值 |
| [M01.md](../../tests/acceptance/M01.md) | 16 | M01-AC-10 | M01-F4 | 发送合法、重复、被拒绝的批次各若干后查询计数接口 | 按 `received`、`stored`、`duplicate`、`rejected_<error>` 分类，数值与发送情况一致；提供清零接口 | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 17 | M01-AC-11 | RR-13 | 运行 AC-01 至 AC-04 后检查 M01 的全部日志输出和入库数据 | 不出现令牌占位值、`auth` 字段和请求方 IP 的末段 | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 18 | M01-AC-12 | M01-F5 | 托管一份 K02 生成的发布物，先后两次 GET，第二次带 `If-None-Match` | 第一次 200 带 `ETag`；第二次 304；替换发布物后再次请求返回 200 和新 `ETag` | 功能 |
| [M01.md](../../tests/acceptance/M01.md) | 19 | M01-AC-13 | M01-F6 | 在 Vitest 中以编程方式启动、发请求、停止，重复 3 次 | 每次启动不超过 2 秒；停止后端口释放；未指定端口时自动分配空闲端口 | 数值 |
| [M01.md](../../tests/acceptance/M01.md) | 20 | M01-AC-14 | M01 非功能 | 本地压测 30 秒，每批 15 条事件 | 每秒处理不少于 500 个批次，无错误响应 | 数值 |
| [M01.md](../../tests/acceptance/M01.md) | 21 | M01-AC-15 | M01 安全 | 尝试监听 `0.0.0.0` | 启动失败并返回非零退出码；README 中有“不得用于生产”的说明 | 功能 |

## 3. 废弃文档（不建账）

以下文件第 3 行均写明「已废弃（D001，2026-10-10）……只保留历史，不再作为验收依据；用例编号不复用」。它们**不是**本台账的规格线来源；列出行数只为说明“为什么总数是 174 而不是更多”。

| 文档 | 行数 | 替代关系 |
|---|---:|---|
| [S01.md](../../tests/acceptance/S01.md) | 15 | 由 M01 与 `docs/contracts/receiver-requirements.md` 取代 |
| [S02.md](../../tests/acceptance/S02.md) | 9 | 由 K02 取代 |
| [S03.md](../../tests/acceptance/S03.md) | 10 | 由 K01 取代 |
| [S04.md](../../tests/acceptance/S04.md) | 14 | 无替代；接收方去重与校验要求见 `receiver-requirements.md` |
| [S05.md](../../tests/acceptance/S05.md) | 10 | 无替代 |
| [S06.md](../../tests/acceptance/S06.md) | 8 | 无替代；对账数据由 `sdk_health` 提供（Q6） |
| [S07.md](../../tests/acceptance/S07.md) | 10 | 无替代 |

## 4. 数值规格线索引（按文档）

本表只列**数值**规格线；它们的「验证落点」在台账里逐条给出。**“有落点”不等于“达标”**：落点只回答“有人真的跑这条判据吗”，达标数据要看该检查的输出。

| 文档 | 数值规格线 | 其中门禁风险较高的（本台账重点） |
|---|---|---|
| C01 | C01-AC-05、C01-AC-08 | C01-AC-08 |
| C02 | C02-AC-10 | — |
| C03 | C03-AC-11 | — |
| C04 | C04-AC-02、C04-AC-13、C04-AC-15、C04-AC-16、C04-AC-17 | — |
| C05 | C05-AC-04、C05-AC-06、C05-AC-18 | C05-AC-18 |
| C06 | C06-AC-01、C06-AC-02、C06-AC-04、C06-AC-05、C06-AC-06 | — |
| C07 | C07-AC-03、C07-AC-08、C07-AC-09、C07-AC-10、C07-AC-14、C07-AC-16、C07-AC-19 | C07-AC-03 |
| C08 | C08-AC-03、C08-AC-04、C08-AC-06、C08-AC-07 | C08-AC-07 |
| K01 | K01-AC-06、K01-AC-12 | K01-AC-12 |
| K02 | K02-AC-09 | K02-AC-09 |
| M01 | M01-AC-04、M01-AC-09、M01-AC-13、M01-AC-14 | M01-AC-04、M01-AC-13、M01-AC-14 |

## 5. 与台账的关系

- 清单是**提取**（规格线是什么），台账是**对账**（每条规格线在哪条可执行检查里被验证、那条检查是否进 `pnpm gates`）。
- 台账的**机器校验** `scripts/spec-line-check.mjs` 会重新读本清单引用的源文件行号，确认「来源」仍指向同一条用例；源文件改行也会红。
- 本清单不修改任何验收用例；`tests/acceptance/**` 对本 lane 只读。

